const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const TAG = 'image###a girl walking into the forest, cinematic###';
const TAG2 = 'image###close-up of her hand###';
const P1 = 'images/user/sdg_1760000000000_aaaaaa.png';
const P2 = 'images/user/sdg_1760000001111_bbbbbb.png';
const MINE = 'images/user/her_own_photo.png';          /* 她自己传的图：没有 sdg_<ts>_ 文件名 */

/* 一条 AI 楼 + 真的 mes_text 容器；fetch 记录删文件请求；saveChat 记录落盘 */
function fixture(t, mes) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', (error) => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = (fn) => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    const deleted = [];
    let saves = 0;
    w.fetch = async (url, opts) => {
        if (String(url).indexOf('/api/images/delete') >= 0) {
            try { deleted.push(JSON.parse(opts.body).path); } catch (e) { deleted.push('(unparsable)'); }
            return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
        }
        return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    };
    const msg = { mes: mes, is_user: false, extra: {}, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }] };
    const context = {
        chat: [msg], extensionSettings: { 'st-drawgen': { sdgBuiltinSeeded17: true } },
        saveSettingsDebounced() {}, saveChat() { saves++; return Promise.resolve(); },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    w.SillyTavern = { getContext: () => context };
    const textEl = w.document.querySelector('.mes_text');
    textEl.textContent = mes;
    w.eval(source);
    tasks.shift()();
    const flush = async () => { while (tasks.length) { const fn = tasks.shift(); try { fn(); } catch (e) {} } await Promise.resolve(); await Promise.resolve(); };
    return {
        w, msg, textEl, debug: w.__sdgDebug, deleted, flush,
        saves: () => saves,
        /* 她在酒馆里编辑这楼：正文改了，酒馆重渲染 mes_text 并发 MESSAGE_UPDATED */
        edit: (next) => { msg.mes = next; msg.swipes[0] = next; textEl.textContent = next; },
        imgs: () => textEl.querySelectorAll('img.sdg-img').length,
        gal: () => (msg.extra.sdg_gal && msg.extra.sdg_gal['0']) || null,
    };
}

test('删掉整条标记，图跟着清：楼里没了、图库记录没了、服务器文件也删了', async (t) => {
    const f = fixture(t, '她推开木门。\n\n' + TAG + '\n\n风从林间穿过。');
    f.debug.setImage(f.msg, 0, P1);
    f.debug.renderFloorImage(0);
    assert.equal(f.imgs(), 1, '生成完：图在槽里');

    /* 复现用的反面：修之前这里图会被贴到楼尾（orphan），图库记录原样留着 */
    f.edit('她推开木门。\n\n风从林间穿过。');
    f.debug.renderFloorImage(0);
    assert.equal(f.imgs(), 0, '标记删了，楼里不许再有图');
    assert.equal(f.gal(), null, '图库记录跟着清');
    await f.flush();
    assert.deepEqual(f.deleted, [P1], '服务器文件一起删');
    assert.ok(f.saves() >= 1, '清完要落盘');

    /* 观察器下一次重绘不许把图贴回来 */
    f.debug.renderFloorImage(0);
    assert.equal(f.imgs(), 0);
});

test('清图同步到 swipe_info，切走再切回来图不会复活', async (t) => {
    const f = fixture(t, TAG);
    f.debug.setImage(f.msg, 0, P1);
    f.debug.syncSwipeExtra(f.msg);
    assert.ok(f.msg.swipe_info[0].extra.sdg_gal, '生成后 swipe_info 里有一份');
    f.edit('标记被我删了');
    f.debug.renderFloorImage(0);
    const snap = f.msg.swipe_info[0].extra.sdg_gal;
    assert.ok(!snap || !snap['0'], 'swipe_info 里的那份也清了');
    /* 酒馆切 swipe 会用 swipe_info 覆盖 extra，再走 restoreSwipeExtra 补回 —— 不该把图补回来 */
    f.msg.extra = JSON.parse(JSON.stringify(f.msg.swipe_info[0].extra));
    f.debug.restoreSwipeExtra(f.msg);
    assert.equal(f.debug.hasAnyImage(f.msg), false);
});

test('正文里没标记就一律清图（没有「没标记也留图」这种情况）', async (t) => {
    const f = fixture(t, '这楼从头到尾没有标记。');
    f.debug.setImage(f.msg, 0, P1);
    f.debug.renderFloorImage(0);
    await f.flush();
    assert.equal(f.imgs(), 0);
    assert.equal(f.gal(), null);
    assert.deepEqual(f.deleted, [P1]);
});

test('正文暂时为空（流式刚开始 / 切 swipe 那一瞬间）不许清图', async (t) => {
    const f = fixture(t, TAG);
    f.debug.setImage(f.msg, 0, P1);
    f.debug.renderFloorImage(0);
    f.edit('');
    f.debug.renderFloorImage(0);
    await f.flush();
    assert.ok(f.gal(), '图库记录必须还在');
    assert.deepEqual(f.deleted, []);
    /* 正文回来了，图照常显示 */
    f.edit(TAG);
    f.debug.renderFloorImage(0);
    assert.equal(f.imgs(), 1);
});

test('一楼两条标记删掉一条：只清尾巴上多出来的那张', async (t) => {
    const f = fixture(t, '甲\n\n' + TAG + '\n\n乙\n\n' + TAG2 + '\n\n丙');
    f.debug.setImage(f.msg, 0, P1);
    f.debug.setImage(f.msg, 1, P2);
    f.debug.renderFloorImage(0);
    assert.equal(f.imgs(), 2);

    f.edit('甲\n\n' + TAG + '\n\n乙\n\n丙');
    f.debug.renderFloorImage(0);
    await f.flush();
    assert.equal(f.imgs(), 1, '剩一条标记就剩一张图');
    assert.equal(f.debug.getImage(f.msg, 0), P1, '留下的那张不动');
    assert.equal(f.debug.getImage(f.msg, 1), '', '多出来的槽记录清了');
    assert.deepEqual(f.deleted, [P2]);
});

test('只删插件自己生成的文件，她自己传的图不碰', async (t) => {
    const f = fixture(t, TAG);
    f.debug.setImage(f.msg, 0, MINE);
    f.debug.renderFloorImage(0);
    f.edit('标记删了');
    f.debug.renderFloorImage(0);
    await f.flush();
    assert.equal(f.gal(), null, '引用照样摘掉（楼里不显示了）');
    assert.deepEqual(f.deleted, [], '但不许去删她的文件');
});

test('标记还在的时候一张图都不许动（最常见的那条路）', async (t) => {
    const f = fixture(t, '前文\n\n' + TAG + '\n\n后文');
    f.debug.setImage(f.msg, 0, P1);
    for (let i = 0; i < 5; i++) f.debug.renderFloorImage(0);
    await f.flush();
    assert.equal(f.imgs(), 1);
    assert.equal(f.debug.getImage(f.msg, 0), P1);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.saves(), 0, '什么都没变就不该落盘');
});

test('翻图历史：清的时候整槽的历史都摘掉，文件逐张删', async (t) => {
    const f = fixture(t, TAG);
    f.debug.setImage(f.msg, 0, P1);
    f.debug.setImage(f.msg, 0, P2);          /* 重画一次，槽里两张历史 */
    assert.equal(f.debug.getImageCount(f.msg, 0), 2);
    f.edit('没有标记了');
    f.debug.renderFloorImage(0);
    await f.flush();
    assert.equal(f.gal(), null);
    assert.deepEqual(f.deleted.slice().sort(), [P1, P2].sort());
});

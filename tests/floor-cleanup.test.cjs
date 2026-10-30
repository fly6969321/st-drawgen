const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const TAG = 'image###a girl walking into the forest, cinematic###';
const TAG2 = 'image###close-up of her hand###';
/* 文件名里的时间戳要用「刚刚」——「保留张数」清理会按这个时间戳摘掉超限的图，
   写死一个老时间戳的话测试会被那个功能清掉，跟这里要测的东西无关 */
const TS = Date.now();
const P1 = 'images/user/sdg_' + TS + '_aaaaaa.png';
const P2 = 'images/user/sdg_' + (TS + 1) + '_bbbbbb.png';
const P3 = 'images/user/sdg_' + (TS + 2) + '_cccccc.png';

/* 多楼夹具：真的 .mes 容器 + 真的事件源，fetch 记录所有请求（用来证明没去删文件） */
function fixture(t, bodies, opts) {
    opts = opts || {};
    const mesHtml = bodies.map((b, i) => '<div class="mes" mesid="' + i + '"><div class="mes_text"></div><div class="mes_buttons"></div></div>').join('');
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat">' + mesHtml + '</div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', (error) => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = (fn) => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    const posted = [];
    w.fetch = async (url, o) => {
        posted.push(String(url));
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
    };
    const chat = bodies.map((b) => ({ mes: b, is_user: false, extra: {}, swipe_id: 0, swipes: [b], swipe_info: [{ extra: {} }] }));
    const handlers = {};
    const names = ['MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'CHAT_CHANGED', 'APP_READY'];
    const event_types = {};
    names.forEach((n) => { event_types[n] = n; });
    let saves = 0;
    const context = {
        chat, extensionSettings: { 'st-drawgen': { sdgBuiltinSeeded17: true } },
        saveSettingsDebounced() {}, saveChat() { saves++; return Promise.resolve(); },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        eventSource: { on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); } },
        event_types,
    };
    w.SillyTavern = { getContext: () => context };
    const cells = Array.from(w.document.querySelectorAll('.mes_text'));
    bodies.forEach((b, i) => { cells[i].textContent = b; });
    w.eval(source);
    tasks.shift()();                                   // init
    const flush = async () => {
        for (let guard = 0; guard < 50 && tasks.length; guard++) { const fn = tasks.shift(); try { fn(); } catch (e) {} }
        await Promise.resolve(); await Promise.resolve();
    };
    const debug = w.__sdgDebug;
    return {
        w, chat, debug, posted, flush,
        saves: () => saves,
        imgs: (i) => cells[i].querySelectorAll('img.sdg-img').length,
        gal: (i) => (chat[i].extra.sdg_gal && chat[i].extra.sdg_gal['0']) || null,
        draw: (i) => debug.renderFloorImage(i),
        drawAll: () => debug.renderAllImages(),
        /* 她在酒馆里编辑这一楼：正文改掉，酒馆重渲染正文并发事件 */
        edit: (i, next, evName) => {
            chat[i].mes = next; chat[i].swipes[0] = next; cells[i].textContent = next;
            (handlers[evName || 'MESSAGE_EDITED'] || []).forEach((fn) => fn(i));
        },
        emit: (ev, arg) => (handlers[ev] || []).forEach((fn) => fn(arg)),
    };
}

test('删掉这一楼的标记：只有这一楼的图跟着清，别的楼一张都不动', async (t) => {
    const f = fixture(t, ['甲楼\n\n' + TAG, '乙楼\n\n' + TAG, '丙楼（本来就没有标记）']);
    f.debug.setImage(f.chat[0], 0, P1);
    f.debug.setImage(f.chat[1], 0, P2);
    f.debug.setImage(f.chat[2], 0, P3);
    f.drawAll();
    assert.equal(f.imgs(0), 1);
    assert.equal(f.imgs(1), 1);
    assert.equal(f.imgs(2), 1, '没标记的楼，图贴在楼尾');

    f.edit(0, '甲楼');                                  /* 只删 0 楼的标记 */
    await f.flush();
    assert.equal(f.gal(0), null, '0 楼的图清了');
    assert.equal(f.imgs(0), 0);
    assert.ok(f.gal(1), '1 楼不许受影响');
    assert.equal(f.imgs(1), 1);
    assert.ok(f.gal(2), '2 楼不许受影响');
    assert.equal(f.imgs(2), 1);
});

test('本来就没标记的楼：全楼重绘、切聊天、反复刷都不许动它的图', async (t) => {
    const f = fixture(t, ['这楼没有标记', '这楼也没有', '第三楼也没有']);
    f.chat.forEach((m, i) => f.debug.setImage(m, 0, [P1, P2, P3][i]));
    for (let round = 0; round < 3; round++) {
        f.drawAll();
        f.emit('CHAT_CHANGED');
        f.emit('APP_READY');
        await f.flush();
    }
    f.chat.forEach((m, i) => {
        assert.ok(f.gal(i), '第 ' + i + ' 楼的图库记录必须还在');
        assert.equal(f.imgs(i), 1, '第 ' + i + ' 楼的图照常贴在楼尾');
    });
    assert.equal(f.saves(), 0, '什么都没改，不许落盘');
});

test('没重绘过的楼（隐藏楼不进 DOM）：编辑它也不许清图', async (t) => {
    const f = fixture(t, ['藏起来的楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    /* 隐藏楼不在 DOM 里 → 从没重绘过 → 插件没见过它有标记 */
    f.w.document.querySelector('.mes').remove();
    f.edit(0, '藏起来的楼');
    await f.flush();
    assert.ok(f.gal(0), '没亲眼见过标记，就不许判成「她删了」');
});

test('一楼多条标记删掉一条：图一张都不动（图可能写在最后那个槽上）', async (t) => {
    const f = fixture(t, ['甲\n\n' + TAG + '\n\n乙\n\n' + TAG2 + '\n\n丙']);
    /* 自动生图的槽位是 tags.length-1，所以唯一那张图在 1 号槽，不是 0 号 */
    f.debug.setImage(f.chat[0], 1, P1);
    f.draw(0);
    f.edit(0, '甲\n\n' + TAG + '\n\n乙\n\n丙');
    await f.flush();
    assert.ok(f.gal(0), '还剩标记就一张都不许清');
    assert.equal(f.debug.getImage(f.chat[0], 1), P1);
});

test('清图只摘聊天里的引用，不去删服务器上的文件', async (t) => {
    const f = fixture(t, ['这楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    f.debug.setImage(f.chat[0], 0, P2);                 /* 重画过，槽里两张历史 */
    f.draw(0);
    f.edit(0, '这楼');
    await f.flush();
    assert.equal(f.gal(0), null);
    assert.deepEqual(f.posted.filter((u) => u.indexOf('/api/images/delete') >= 0), [], '一个删除请求都不许发');
});

test('清图同步 swipe_info 并落盘，切 swipe 回来图不会复活', async (t) => {
    const f = fixture(t, ['这楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    f.debug.syncSwipeExtra(f.chat[0]);
    f.draw(0);
    f.edit(0, '这楼');
    await f.flush();
    const snap = f.chat[0].swipe_info[0].extra.sdg_gal;
    assert.ok(!snap || !snap['0'], 'swipe_info 里那份也清了');
    f.chat[0].extra = JSON.parse(JSON.stringify(f.chat[0].swipe_info[0].extra));
    f.debug.restoreSwipeExtra(f.chat[0]);
    assert.equal(f.debug.hasAnyImage(f.chat[0]), false);
    assert.ok(f.saves() >= 1, '清完要落盘');
});

test('切 swipe 不算删标记', async (t) => {
    const f = fixture(t, ['这楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    f.draw(0);
    f.chat[0].mes = '另一条回复，没有标记';
    f.emit('MESSAGE_SWIPED', 0);
    await f.flush();
    assert.ok(f.gal(0), '切 swipe 不许清图');
});

test('编辑框打开时不按临时正文清图，保存后再按最终正文清理', async (t) => {
    const f = fixture(t, ['这楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    f.draw(0);
    const editor = f.w.document.createElement('textarea');
    editor.className = 'edit_textarea';
    f.w.document.querySelector('.mes').appendChild(editor);
    f.edit(0, '这楼（编辑中的临时正文）', 'MESSAGE_UPDATED');
    await f.flush();
    assert.ok(f.gal(0), '编辑过程中图片引用保留');
    editor.remove();
    f.emit('MESSAGE_EDITED', 0);
    await f.flush();
    assert.equal(f.gal(0), null, '保存后确认最终正文已删标记，再清图');
});

test('正文暂时为空（流式刚开始）不许清图', async (t) => {
    const f = fixture(t, ['这楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    f.draw(0);
    f.edit(0, '', 'MESSAGE_UPDATED');
    await f.flush();
    assert.ok(f.gal(0), '空正文不是她删了标记');
    f.edit(0, '这楼\n\n' + TAG, 'MESSAGE_UPDATED');
    await f.flush();
    assert.equal(f.imgs(0), 1, '正文回来了图照常显示');
});

test('删标记之后再也不会二次触发（图库已经空了）', async (t) => {
    const f = fixture(t, ['这楼\n\n' + TAG]);
    f.debug.setImage(f.chat[0], 0, P1);
    f.draw(0);
    f.edit(0, '这楼');
    await f.flush();
    const saves1 = f.saves();
    f.edit(0, '这楼改了点别的字');
    f.edit(0, '再改一次');
    await f.flush();
    assert.equal(f.saves(), saves1, '没有图可清就不该再落盘');
});

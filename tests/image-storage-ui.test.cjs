const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const REMOTE_A = 'https://temporary.test/a.png?expires=short';
const REMOTE_B = 'https://temporary.test/b.png?expires=short';
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const DATA = 'data:image/png;base64,' + BASE64;

function fixture(t, { urls = [REMOTE_A], orphan = false, keepDays = 7 } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map(), calls = [];
    let timerId = 0, saves = 0, settingsSaves = 0, uploads = 0;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    if (!w.Blob.prototype.arrayBuffer) w.Blob.prototype.arrayBuffer = function () {
        const blob = this;
        return new Promise((resolve, reject) => {
            const reader = new w.FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    };
    const msg = { mes: orphan ? 'No marker' : 'Before image###a cat### after', is_user: false, extra: {} };
    const settings = { imageKeepDays: keepDays, autoExtract: false, autoGenerate: false, sdgBuiltinSeeded17: true, genTimeout: 300 };
    const ctx = {
        chat: [msg], extensionSettings: { 'st-drawgen': settings },
        saveSettingsDebounced() { settingsSaves++; }, saveChat() { saves++; },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
    };
    w.SillyTavern = { getContext: () => ctx };
    const response = (body, type = 'image/png', status = 200) => ({
        ok: status >= 200 && status < 300, status,
        headers: { get: key => key.toLowerCase() === 'content-type' ? type : null },
        blob: async () => new w.Blob([body], { type }),
        text: async () => String(body), json: async () => JSON.parse(String(body)),
    });
    let failDownloads = false, downloadGate = null;
    w.fetch = async (url, options = {}) => {
        const address = String(url);
        assert.doesNotMatch(address, /chat\/completions|images\/generations|images\/edits|chat-completions\/generate/,
            '保存已有图片不能发起生图请求');
        calls.push({ url: address, options });
        if (address === '/api/images/upload') return response(JSON.stringify({ path: '/images/user/saved-' + (++uploads) + '.png' }), 'application/json');
        if (downloadGate) { const gate = downloadGate; downloadGate = null; await gate; }
        return failDownloads ? response('Expired', 'text/plain', 403) : response(Uint8Array.from(Buffer.from(BASE64, 'base64')));
    };
    const text = w.document.querySelector('.mes_text');
    text.textContent = msg.mes;
    w.eval(source);
    const [initId, init] = timers.entries().next().value;
    timers.delete(initId); init.fn();
    const debug = w.__sdgDebug;
    urls.forEach(url => debug.setImage(msg, 0, url));
    debug.renderFloorImage(0);
    const until = async predicate => {
        for (let attempt = 0; attempt < 150; attempt++) {
            if (predicate()) return;
            await new Promise(resolve => setImmediate(resolve));
            for (const [id, timer] of Array.from(timers.entries())) if (timer.ms <= 60 && timers.delete(id)) timer.fn();
            for (let n = 0; n < 8; n++) await Promise.resolve();
        }
        assert.ok(predicate(), '保存按钮没有完成预期异步操作');
    };
    return {
        w, msg, settings, calls, debug, text, until,
        note: () => text.querySelector('.sdg-storage-note'), image: () => text.querySelector('img.sdg-img'),
        click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
        saves: () => saves, settingsSaves: () => settingsSaves, failDownloads: () => { failDownloads = true; },
        holdDownload() { let release; downloadGate = new Promise(resolve => { release = resolve; }); return release; },
    };
}

test('only temporary remote images show a storage warning and retry button', t => {
    for (const orphan of [false, true]) {
        const remote = fixture(t, { orphan });
        assert.match(remote.note().textContent, /尚未保存/);
        assert.equal(remote.note().dataset.src, REMOTE_A);
        assert.equal(remote.note().querySelector('button').textContent, '重试保存');
        for (const url of ['images/user/local.png', '/images/user/local.png', 'https://tavern.test/images/user/local.png', DATA]) {
            const local = fixture(t, { orphan, urls: [url] });
            assert.equal(local.note(), null, '已保存在本地或聊天内的数据不显示临时链接警告');
        }
    }
});

test('history paging updates the retry target and removes the warning on a local image', async t => {
    const f = fixture(t, { urls: ['images/user/local.png', REMOTE_A, REMOTE_B] });
    const image = f.image();
    assert.equal(f.note().dataset.src, REMOTE_B);
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    assert.equal(f.note().dataset.src, REMOTE_A, '按钮跟随当前展示的历史图');
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    assert.equal(f.note(), null);
    f.click(f.text.querySelector('.sdg-pg[data-d="1"]'));
    f.click(f.note().querySelector('button'));
    await f.until(() => !f.w.document.querySelector('#sdg-backup-images').disabled);
    assert.deepEqual(f.calls.map(call => call.url), [REMOTE_A, '/api/images/upload'], '只补存点选的图，不保存另一张历史外链');
    assert.equal(f.note(), null, '替换为本地链接后立即移除警告');
    assert.equal(f.image(), image, '补存和翻页均复用当前图片元素');
    assert.match(f.image().getAttribute('src'), /^images\/user\//);
    assert.ok(f.saves() > 0);
    assert.equal(f.msg.extra.sdg_gal['0']['0'].list[2], REMOTE_B);
});

test('a failed retry retains the remote image and warning and re-enables retry controls', async t => {
    const f = fixture(t);
    f.failDownloads();
    const button = f.note().querySelector('button');
    f.click(button);
    assert.equal(button.disabled, true, '保存期间阻止重复点击');
    assert.equal(f.w.document.querySelector('#sdg-backup-images').disabled, true);
    await f.until(() => !button.disabled);
    assert.equal(f.image().getAttribute('src'), REMOTE_A);
    assert.equal(f.note().dataset.src, REMOTE_A);
    assert.equal(f.w.document.querySelector('#sdg-backup-images').disabled, false);
    assert.equal(f.calls.filter(call => call.url === '/api/images/upload').length, 0);
    assert.equal(f.saves(), 0, '失败不保存假本地记录');
});

test('retry buttons created while a backup runs are enabled when that backup finishes', async t => {
    const f = fixture(t, { urls: [REMOTE_A, 'images/user/local.png', REMOTE_B] });
    const release = f.holdDownload();
    f.click(f.note().querySelector('button'));
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    assert.equal(f.note(), null);
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    const newButton = f.note().querySelector('button');
    assert.equal(newButton.disabled, true, '运行期间新创建的提示也不可重复提交');
    release();
    await f.until(() => !f.w.document.querySelector('#sdg-backup-images').disabled);
    assert.equal(f.note().dataset.src, REMOTE_A);
    assert.equal(newButton.disabled, false, '结束后新创建的另一张图的保存按钮也恢复可用');
});

test('a retry control cloned by the chat theme still saves the displayed image', async t => {
    const f = fixture(t);
    const original = f.note();
    original.replaceWith(original.cloneNode(true));
    f.click(f.note().querySelector('button'));
    await f.until(() => !f.w.document.querySelector('#sdg-backup-images').disabled);
    assert.deepEqual(f.calls.map(call => call.url), [REMOTE_A, '/api/images/upload']);
    assert.equal(f.note(), null, '主题重建DOM后保存成功仍移除警告');
    assert.match(f.image().getAttribute('src'), /^images\/user\//);
});

test('the panel backup button saves existing history and removes the active remote warning', async t => {
    const f = fixture(t, { urls: [REMOTE_A, REMOTE_B] });
    const button = f.w.document.querySelector('#sdg-backup-images');
    assert.ok(button, '面板里有补存入口');
    f.click(button);
    await f.until(() => !button.disabled);
    assert.deepEqual(f.calls.map(call => call.url), [REMOTE_A, '/api/images/upload', REMOTE_B, '/api/images/upload']);
    assert.equal(f.note(), null);
    assert.equal(f.msg.extra.sdg_gal['0']['0'].cur, 1, '补存不改变历史选择');
    assert.ok(f.msg.extra.sdg_gal['0']['0'].list.every(url => url.startsWith('images/')));
});

test('keep forever explicitly saves zero days without silently overriding an existing retention setting', t => {
    const f = fixture(t, { urls: ['images/user/local.png'], keepDays: 7 });
    const input = f.w.document.querySelector('#sdg-keepdays');
    assert.equal(f.settings.imageKeepDays, 7, '启动保留已有用户设置');
    assert.equal(input.value, '7');
    const before = f.settingsSaves();
    f.click(f.w.document.querySelector('#sdg-keep-forever'));
    assert.equal(f.settings.imageKeepDays, 0);
    assert.equal(input.value, '0');
    assert.ok(f.settingsSaves() > before, '点击后持久保存0天设置');
    input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(f.settings.imageKeepDays, 0, '输入框的0不会回退为7天');
    assert.equal(f.calls.length, 0, '改变保存期限不会触发下载、生图或删图');
});

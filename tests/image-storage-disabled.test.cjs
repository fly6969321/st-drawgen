const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const DATA = 'data:image/png;base64,' + BASE64;
const SIGNED = 'https://cdn.test/image.png?token=a%2Bb&expires=123&sig=x%2Fy%3D';
const OLD = 'images/user/old.png';
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text">image###a cat###</div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map(), calls = [], saves = [];
    let timerId = 0, anchorClicks = 0;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    w.HTMLAnchorElement.prototype.click = () => { anchorClicks++; };
    const msg = { mes: 'image###a cat###', is_user: false, extra: {}, swipe_id: 0, swipes: ['image###a cat###'], swipe_info: [{ extra: {} }] };
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, genEndpoint: 'https://images.test/v1', genModel: 'test-image', genKey: 'test-only',
        genProxy: false, genTimeout: 300, genFixedPrompt: '', genPostfixPrompt: '',
        autoExtract: false, autoGenerate: false, imageKeepDays: 7,
    }, overrides);
    const ctx = { chat: [msg], extensionSettings: { 'st-drawgen': settings }, saveSettingsDebounced() {},
        saveChat() { saves.push(JSON.stringify(this.chat)); }, getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' }) };
    w.SillyTavern = { getContext: () => ctx };
    const response = (data, status = 200) => ({
        ok: status >= 200 && status < 300, status,
        headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json' : null },
        text: async () => typeof data === 'string' ? data : JSON.stringify(data), json: async () => data,
    });
    let respond = () => response({ choices: [{ message: { content: '![](' + SIGNED + ')' } }] });
    w.fetch = async (url, options = {}) => {
        assert.match(String(url), /^https:\/\/images\.test\/v1\/(chat\/completions|images\/generations)$/, '只允许所需生图请求；不能下载外链、调用CORS代理或上传酒馆');
        const call = { url: String(url), body: JSON.parse(options.body) }; calls.push(call);
        return respond(call);
    };
    w.eval(source);
    const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn();
    const debug = w.__sdgDebug;
    debug.setImage(msg, 0, OLD); debug.syncSwipeExtra(msg); debug.renderFloorImage(0);
    const finish = async promise => {
        let done = false, result, error;
        promise.then(value => { result = value; done = true; }, reason => { error = reason; done = true; });
        for (let n = 0; n < 100 && !done; n++) {
            for (let i = 0; i < 10; i++) await Promise.resolve();
            for (const [id, task] of Array.from(timers)) if (task.ms <= 60 && timers.delete(id)) task.fn();
        }
        assert.equal(done, true, '异步生图和必要的聊天保存应完成');
        if (error) throw error;
        return result;
    };
    return { w, msg, settings, ctx, calls, saves, debug, finish, response,
        respond(fn) { respond = fn; }, anchorClicks: () => anchorClicks,
        click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); } };
}

test('signed image URLs are written unchanged to chat without downloading, proxying or uploading', async t => {
    const f = fixture(t);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), SIGNED);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://images.test/v1/chat/completions');
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED);
    assert.equal(f.w.document.querySelector('.sdg-img').getAttribute('src'), SIGNED);
    assert.ok(f.saves.length > 0);
    const saved = JSON.parse(f.saves.at(-1))[0];
    assert.equal(saved.extra.sdg_gal['0']['0'].list.at(-1), SIGNED, '不重新编码签名URL，不制造base64副本');
    assert.equal(f.w.document.querySelector('#sdg-image-preview'), null);
});

test('base64 results only open a manual-download preview and preserve all chat and swipe records', async t => {
    const f = fixture(t, { convertToJpeg: true }); // An obsolete setting must not re-enable conversion/storage.
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + DATA + ')' } }] }));
    const before = clone(f.msg);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), DATA);
    assert.equal(f.calls.length, 1, '200图片数据响应不会触发重复付费请求');
    assert.equal(f.saves.length, 0, '临时图片不调用聊天保存');
    assert.deepEqual(clone(f.msg), before, '不追加图库、不同步污染swipe记录');
    assert.equal(f.w.document.querySelector('.sdg-img').getAttribute('src'), OLD, '旧图保留');
    const preview = f.w.document.querySelector('#sdg-image-preview');
    assert.equal(preview.querySelector('img').getAttribute('src'), DATA);
    const download = preview.querySelector('a[download]');
    assert.ok(download);
    assert.equal(download.getAttribute('href'), DATA);
    assert.match(download.download, /\.png$/, '旧JPEG开关不转换返回字节');
    assert.match(download.textContent, /下载本次图片/);
    assert.equal(f.anchorClicks(), 0, '没有自动点击下载，用户自行决定');
    assert.doesNotMatch(JSON.stringify(f.msg), /base64|data:image/);
    f.click(preview.querySelector('.sdg-preview-close'));
    assert.equal(f.w.document.querySelector('#sdg-image-preview'), null);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), DATA);
    assert.equal(f.calls.length, 2, '关闭后可再次主动重画，busy锁正常释放');
    assert.equal(f.saves.length, 0);
    assert.deepEqual(clone(f.msg), before);
});

test('base64 results with no old image leave the original generate control usable', async t => {
    const f = fixture(t);
    f.msg.extra = {}; f.msg.swipe_info[0].extra = {};
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + DATA + ')' } }] }));
    const before = clone(f.msg);
    await f.finish(f.debug.generateForFloor(0, '', 0));
    assert.deepEqual(clone(f.msg), before);
    assert.equal(f.saves.length, 0);
    assert.equal(f.w.document.querySelector('.sdg-genbtn').disabled, false);
});

test('storage, JPEG and cache controls are absent while an existing seven-day setting is retained', t => {
    const f = fixture(t, { convertToJpeg: true, imageKeepDays: 7 });
    assert.equal(f.w.document.querySelector('#sdg-backup-images, #sdg-keep-forever, #sdg-jpeg, .sdg-storage-note, .sdg-save-image, .sdg-download-image'), null);
    assert.equal(f.debug.storePendingImage, undefined);
    assert.equal(f.debug.persistGenImage, undefined);
    assert.equal(f.debug.backupChatImages, undefined);
    assert.equal(f.settings.imageKeepDays, 7);
    assert.equal(f.w.document.querySelector('#sdg-keepdays').value, '7');
    assert.equal(f.calls.length, 0);
});

test('the images endpoint asks for a URL first and uses a signed URL unchanged', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ data: [{ url: SIGNED }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), SIGNED);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.response_format, 'url');
    assert.equal(f.calls[0].body.n, 1);
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED);
});

test('a parameter-specific 400 permits one retry with response_format omitted', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.calls.length === 1
        ? f.response({ error: { message: 'Unsupported parameter: response_format' } }, 400)
        : f.response({ data: [{ url: SIGNED }] }));
    const result = await f.debug.genImageUnified('a cat');
    assert.equal(result.image, SIGNED);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.response_format, 'url');
    assert.equal(Object.hasOwn(f.calls[1].body, 'response_format'), false);
    const first = { ...f.calls[0].body }; delete first.response_format;
    assert.deepEqual(f.calls[1].body, first, '仅删除被拒绝的参数，其余请求不变');
});

test('a repeated parameter error stops after one retry and unrelated 400 errors do not retry', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ error: { message: 'Unsupported response_format' } }, 400));
    await assert.rejects(f.debug.genImageUnified('a cat'), /400/);
    assert.equal(f.calls.length, 2, '不循环尝试生图');
    const unrelated = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    unrelated.respond(() => unrelated.response({ error: { message: 'Invalid size' } }, 400));
    await assert.rejects(unrelated.debug.genImageUnified('a cat'), /400/);
    assert.equal(unrelated.calls.length, 1);
});

test('a successful images response containing base64 is previewed without asking the paid endpoint again', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ data: [{ b64_json: BASE64 }] }));
    const before = clone(f.msg);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), DATA);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.response_format, 'url');
    assert.equal(f.saves.length, 0);
    assert.deepEqual(clone(f.msg), before);
    assert.equal(f.w.document.querySelector('#sdg-image-preview a[download]').getAttribute('href'), DATA);
});

test('concurrent generation from another floor does not send a second paid request', async t => {
    const f = fixture(t);
    const second = { mes: 'image###second floor###', is_user: false, extra: {} };
    f.ctx.chat.push(second);
    const before = clone(second);
    let release;
    f.respond(() => new Promise(resolve => { release = resolve; }));
    const first = f.debug.generateForFloor(0, '', 0);
    assert.equal(f.calls.length, 1);
    assert.equal(await f.debug.generateForFloor(1, '', 0), '');
    assert.equal(f.calls.length, 1, '全局已有生成时其他楼层不再付费');
    assert.deepEqual(clone(second), before);
    release(f.response({ choices: [{ message: { content: '![](' + SIGNED + ')' } }] }));
    assert.equal(await f.finish(first), SIGNED);
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + SIGNED + ')' } }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(1, '', 0)), SIGNED, '首个请求完成后正常解锁');
    assert.equal(f.calls.length, 2);
});

test('an unclosed base64 preview blocks another generation and preserves the first download entry', async t => {
    const f = fixture(t);
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + DATA + ')' } }] }));
    await f.finish(f.debug.generateForFloor(0, '', 0));
    const preview = f.w.document.querySelector('#sdg-image-preview');
    const download = preview.querySelector('a[download]');
    const before = clone(f.msg);
    assert.equal(await f.debug.generateForFloor(0, '', 0), '');
    assert.equal(f.calls.length, 1, '上一张尚未关闭时不发送下一次请求');
    assert.equal(f.w.document.querySelector('#sdg-image-preview'), preview);
    assert.equal(preview.querySelector('a[download]'), download, '不覆盖首张图的下载入口');
    assert.equal(download.getAttribute('href'), DATA);
    assert.deepEqual(clone(f.msg), before);
    assert.equal(f.saves.length, 0);
});

test('Tab navigation reaches the temporary image download and cycles back to close', async t => {
    const f = fixture(t);
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + DATA + ')' } }] }));
    await f.finish(f.debug.generateForFloor(0, '', 0));
    const close = f.w.document.querySelector('.sdg-preview-close');
    const download = f.w.document.querySelector('#sdg-image-preview a[download]');
    assert.equal(f.w.document.activeElement, close);
    close.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.w.document.activeElement, download, '下载链接可由键盘进入');
    download.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.w.document.activeElement, close);
    close.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.w.document.activeElement, download, '反向Tab同样包含下载入口');
    assert.equal(f.anchorClicks(), 0, '只移动焦点不自动下载');
});

test('a signed URL arriving after switching chats opens a preview without changing either chat', async t => {
    const f = fixture(t);
    const oldChat = f.ctx.chat, beforeOld = clone(oldChat);
    let release;
    f.respond(() => new Promise(resolve => { release = resolve; }));
    const generation = f.debug.generateForFloor(0, '', 0);
    const newChat = [{ mes: 'image###new chat###', is_user: false, extra: {} }];
    const beforeNew = clone(newChat);
    f.ctx.chat = newChat;
    f.w.document.querySelector('.mes_text').textContent = newChat[0].mes;
    release(f.response({ choices: [{ message: { content: '![](' + SIGNED + ')' } }] }));
    assert.equal(await f.finish(generation), SIGNED);
    assert.equal(f.w.document.querySelector('#sdg-image-preview img').getAttribute('src'), SIGNED, '付费结果仍可在临时预览查看');
    assert.deepEqual(clone(oldChat), beforeOld);
    assert.deepEqual(clone(newChat), beforeNew);
    assert.equal(f.saves.length, 0, '不能把旧请求的结果写入当前聊天');
    assert.equal(f.calls.length, 1);
});

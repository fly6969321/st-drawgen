const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const DATA = 'data:image/png;base64,' + BASE64;
const SIGNED = 'https://cdn.test/image.png?token=a%2Bb&expires=123&sig=x%2Fy%3D';
const LOCAL = 'images/user/sdg_123_abc.png';
const PNG_BYTES = Uint8Array.from(atob(BASE64), c => c.charCodeAt(0));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text">image###a cat###</div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map(), calls = [], saves = [];
    let timerId = 0, downloads = 0, uploads = 0, downloadOk = true, uploadOk = true;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    const msg = { mes: 'image###a cat###', is_user: false, extra: {}, swipe_id: 0, swipes: ['image###a cat###'], swipe_info: [{ extra: {} }] };
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, genEndpoint: 'https://images.test/v1', genModel: 'test-image', genKey: 'test-only',
        genProxy: false, genTimeout: 300, genFixedPrompt: '', genPostfixPrompt: '',
        autoExtract: false, autoGenerate: false, imageKeepDays: 0,
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
        const u = String(url);
        const generation = /^https:\/\/images\.test\/v1\/(chat\/completions|images\/generations)$/.test(u);
        if (generation) { const call = { url: u, body: JSON.parse(options.body) }; calls.push(call); return respond(call); }
        if (u === SIGNED) {
            downloads++;
            if (!downloadOk) return { ok: false, status: 502, text: async () => 'bad gateway' };
            return { ok: true, status: 200, blob: async () => new w.Blob([PNG_BYTES], { type: 'image/png' }) };
        }
        if (u === '/api/images/upload') {
            uploads++;
            if (!uploadOk) return { ok: false, status: 500, text: async () => 'upload failed' };
            return { ok: true, status: 200, json: async () => ({ path: '/' + LOCAL }) };
        }
        throw new Error('unexpected fetch（不得下载其它外链、调用 CORS 代理或上传酒馆）: ' + u);
    };
    w.eval(source);
    const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn();
    const debug = w.__sdgDebug;
    debug.setImage(msg, 0, 'images/user/old.png'); debug.syncSwipeExtra(msg); debug.renderFloorImage(0);
    const finish = async promise => {
        let done = false, result, error;
        promise.then(value => { result = value; done = true; }, reason => { error = reason; done = true; });
        for (let n = 0; n < 200 && !done; n++) {
            for (let i = 0; i < 10; i++) await Promise.resolve();
            await new Promise(resolve => setImmediate(resolve));
            for (const [id, task] of Array.from(timers)) if (task.ms <= 60 && timers.delete(id)) task.fn();
        }
        assert.equal(done, true, '异步生图和必要的聊天保存应完成');
        if (error) throw error;
        return result;
    };
    return { w, msg, settings, ctx, calls, saves, debug, finish, response, respond(fn) { respond = fn; },
        setDownload(v) { downloadOk = v; }, setUpload(v) { uploadOk = v; },
        downloads: () => downloads, uploads: () => uploads };
}

test('接口回外链：先下载、再上传酒馆，聊天里落成本地路径', async t => {
    const f = fixture(t);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), LOCAL);
    assert.equal(f.calls.length, 1, '只发一次生图请求');
    assert.equal(f.downloads(), 1, '外链被下载一次');
    assert.equal(f.uploads(), 1, '上传酒馆一次');
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL, '图库存本地路径，不存会过期的外链');
    assert.ok(f.saves.length > 0);
    const saved = JSON.parse(f.saves.at(-1))[0];
    assert.equal(saved.extra.sdg_gal['0']['0'].list.at(-1), LOCAL);
});

test('接口回图片数据（base64）：上传酒馆、写进聊天，不再只弹预览', async t => {
    const f = fixture(t);
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + DATA + ')' } }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), LOCAL);
    assert.equal(f.calls.length, 1, '200 图片数据响应不会触发重复付费请求');
    assert.equal(f.downloads(), 0, 'base64 无需下载');
    assert.equal(f.uploads(), 1);
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL, 'base64 也落进聊天');
    assert.equal(f.w.document.querySelector('#sdg-image-preview'), null, '不再只弹临时预览');
    assert.equal(f.w.document.querySelector('.sdg-img').getAttribute('src'), LOCAL);
    assert.ok(f.saves.length > 0);
});

test('上传失败：退回内嵌数据，仍写进聊天', async t => {
    const f = fixture(t);
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + DATA + ')' } }] }));
    f.setUpload(false);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), DATA);
    assert.equal(f.uploads(), 1);
    assert.equal(f.debug.getImage(f.msg, 0), DATA, '上传失败保留内嵌数据当兜底');
    assert.ok(f.saves.length > 0);
});

test('外链下载失败：退回原始外链，不假装上传', async t => {
    const f = fixture(t);
    f.setDownload(false);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), SIGNED);
    assert.equal(f.downloads(), 1);
    assert.equal(f.uploads(), 0, '没拿到图片数据就不上传');
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED);
});

test('images 接口返回 url：同样下载 + 上传，落本地路径', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ data: [{ url: SIGNED }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), LOCAL);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.response_format, 'url');
    assert.equal(f.downloads(), 1);
    assert.equal(f.uploads(), 1);
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL);
});

test('并发：全局已有生成时其它楼层不再付费，首个完成后解锁', async t => {
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
    assert.equal(await f.finish(first), LOCAL);
    f.respond(() => f.response({ choices: [{ message: { content: '![](' + SIGNED + ')' } }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(1, '', 0)), LOCAL, '首个请求完成后正常解锁');
    assert.equal(f.calls.length, 2);
});

test('参数类 400 退 images 时只去掉被拒的 response_format，其余请求不变', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.calls.length === 1
        ? f.response({ error: { message: 'Unsupported parameter: response_format' } }, 400)
        : f.response({ data: [{ url: SIGNED }] }));
    const result = await f.finish(f.debug.genImageUnified('a cat'));
    assert.equal(result.image, DATA, '外链被下载成图片数据');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.response_format, 'url');
    assert.equal(Object.hasOwn(f.calls[1].body, 'response_format'), false);
    const first = { ...f.calls[0].body }; delete first.response_format;
    assert.deepEqual(f.calls[1].body, first, '仅删除被拒绝的参数，其余请求不变');
});

test('参数错误反复 400 只重试一次；无关 400 不重试', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ error: { message: 'Unsupported response_format' } }, 400));
    await assert.rejects(f.finish(f.debug.genImageUnified('a cat')), /400/);
    assert.equal(f.calls.length, 2, '不循环尝试生图');
    const g = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    g.respond(() => g.response({ error: { message: 'Invalid size' } }, 400));
    await assert.rejects(g.finish(g.debug.genImageUnified('a cat')), /400/);
    assert.equal(g.calls.length, 1);
});

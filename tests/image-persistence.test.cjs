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
    let timerId = 0, downloads = 0, uploads = 0, proxied = 0, downloadOk = true, uploadOk = true, proxyOk = false;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    const msg = { mes: 'image###a cat###', is_user: false, extra: {}, swipe_id: 0, swipes: ['image###a cat###'], swipe_info: [{ extra: {} }] };
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, genEndpoint: 'https://images.test/v1', genModel: 'test-image', genKey: 'test-only',
        genProxy: false, genTimeout: 300, genFixedPrompt: '', genPostfixPrompt: '',
        autoExtract: false, autoGenerate: false, imageKeepCount: 0,
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
            if (!downloadOk) throw new TypeError('Failed to fetch');   // 跨域被拦就是这个样子
            return { ok: true, status: 200, blob: async () => new w.Blob([PNG_BYTES], { type: 'image/png' }) };
        }
        if (u.indexOf('/proxy/') === 0) {
            proxied++;
            const inner = decodeURIComponent(u.slice('/proxy/'.length));
            assert.equal(options.credentials, 'same-origin', '走酒馆代理要带同源凭据（CSRF）');
            assert.equal(Object.keys(options.headers || {}).some(k => /authorization/i.test(k)), false, '绝不把 API 密钥转发给图片站');
            if (!proxyOk || inner !== SIGNED) return { ok: false, status: 404, text: async () => 'not found' };
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
    const runAllTimers = async () => {
        /* 固定轮数空转（不因当前没有定时器就提前退出）：jsdom 的 FileReader 等
           在好几层微任务/宏任务之后才落地，循环要一直泵到它完成 */
        for (let n = 0; n < 300; n++) {
            for (const [id, task] of Array.from(timers.entries())) { timers.delete(id); task.fn(); }
            for (let i = 0; i < 20; i++) await Promise.resolve();
            await new Promise(resolve => setImmediate(resolve));
        }
    };
    return { w, msg, settings, ctx, calls, saves, debug, finish, runAllTimers, response, respond(fn) { respond = fn; },
        setDownload(v) { downloadOk = v; }, setUpload(v) { uploadOk = v; }, setProxy(v) { proxyOk = v; },
        downloads: () => downloads, uploads: () => uploads, proxied: () => proxied };
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

test('直连和酒馆代理都下不动：退回原始外链，不假装上传', async t => {
    const f = fixture(t);
    f.setDownload(false);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), SIGNED);
    assert.equal(f.downloads(), 1, '先试直连');
    assert.equal(f.proxied(), 1, '直连被拦后试过酒馆代理');
    assert.equal(f.uploads(), 0, '没拿到图片数据就不上传');
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED);
});

test('直连被跨域拦住时改走酒馆 /proxy/ 代下载，仍存成本地文件', async t => {
    const f = fixture(t);
    f.setDownload(false); f.setProxy(true);
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), LOCAL);
    assert.equal(f.downloads(), 1, '先试直连');
    assert.equal(f.proxied(), 1, '直连被拦后走酒馆代理');
    assert.equal(f.uploads(), 1, '代理拿到图片数据后照常上传');
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL, '最终存的是本地路径，不是会过期的外链');
});

test('images 接口返回 url：同样下载 + 上传，落本地路径', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ data: [{ url: SIGNED }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), LOCAL);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.response_format, 'b64_json', '先要图片数据');
    assert.equal(f.downloads(), 1, '站点仍回外链时才需要下载');
    assert.equal(f.uploads(), 1);
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL);
});

test('images 接口回 b64_json：不下载、直接上传存本地', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.response({ data: [{ b64_json: BASE64 }] }));
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), LOCAL);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.response_format, 'b64_json');
    assert.equal(f.downloads(), 0, '拿到图片数据就不用下载，不受跨域影响');
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

test('参数类 400：b64_json 被拒就改要 url 重试一次，其余请求不变', async t => {
    const f = fixture(t, { genEndpoint: 'https://images.test/v1/images/generations' });
    f.respond(() => f.calls.length === 1
        ? f.response({ error: { message: 'Unsupported parameter: response_format' } }, 400)
        : f.response({ data: [{ url: SIGNED }] }));
    const result = await f.finish(f.debug.genImageUnified('a cat'));
    assert.equal(result.image, DATA, '外链被下载成图片数据');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.response_format, 'b64_json', '先要图片数据');
    assert.equal(f.calls[1].body.response_format, 'url', '被拒后改要外链');
    const first = { ...f.calls[1].body }; first.response_format = 'b64_json';
    assert.deepEqual(first, f.calls[0].body, '只有 response_format 变了，其余请求不变');
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

test('网络层失败（Failed to fetch）：不自动补发第二发，报错写明未重试', async t => {
    const f = fixture(t);
    const calls = [];
    f.w.fetch = async url => { calls.push(String(url)); throw new TypeError('Failed to fetch'); };
    globalThis.fetch = f.w.fetch;
    await assert.rejects(f.debug.genImageUnified('a cat'), /未自动重试/);
    assert.equal(calls.length, 1, '连接中断不代表站点没生成，再打一发就是重复扣费');
    assert.match(calls[0], /\/chat\/completions$/);
});

test('站点明确回 404（接口不存在、肯定没扣费）：仍允许唯一一次换 images 兜底', async t => {
    const f = fixture(t);
    f.respond(call => /chat\/completions/.test(call.url)
        ? f.response('not found', 404)
        : f.response({ data: [{ url: SIGNED }] }));
    const result = await f.finish(f.debug.genImageUnified('a cat'));
    assert.equal(f.calls.length, 2, 'chat 一发 + images 一发，共两发');
    assert.match(f.calls[0].url, /chat\/completions$/);
    assert.match(f.calls[1].url, /images\/generations$/);
    assert.equal(result.image, DATA, '兜底拿到外链后下载成图片数据');
});

test('旧的 DrawGenRecovered 引用（少了 user/ 前缀）会被纠正，楼层图裂可恢复', async t => {
    const f = fixture(t);
    const BROKEN = 'images/DrawGenRecovered/sdg_1_abc.png';
    const FIXED = 'user/images/DrawGenRecovered/sdg_1_abc.png';
    f.debug.setImage(f.msg, 0, BROKEN);
    f.msg.swipe_info[0].extra = JSON.parse(JSON.stringify(f.msg.extra));
    assert.equal(f.debug.getImage(f.msg, 0), FIXED, '显示层先纠正（数据还没动）');
    assert.equal(f.msg.extra.sdg_gal['0']['0'].list.at(-1), BROKEN);
    f.debug.healChatRecoveredRefs();
    assert.equal(f.msg.extra.sdg_gal['0']['0'].list.at(-1), FIXED, '数据纠正');
    assert.equal(f.msg.swipe_info[0].extra.sdg_gal['0']['0'].list.at(-1), FIXED, 'swipe 快照同步纠正');
    assert.equal(f.debug.healRecoveredUrl('images/other/x.png'), 'images/other/x.png', '只改这一个前缀，别的路径不碰');
    assert.equal(f.debug.healRecoveredUrl('user/images/DrawGenRecovered/x.png'), 'user/images/DrawGenRecovered/x.png', '已正确的引用不重复处理');
    assert.equal(f.debug.healRecoveredUrl('/images/DrawGenRecovered/y.png'), 'user/images/DrawGenRecovered/y.png', '带斜杠的也纠正');
    assert.equal(f.debug.healRecoveredUrl('http://127.0.0.1:8000/images/DrawGenRecovered/z.png'), 'user/images/DrawGenRecovered/z.png', '带域名的也纠正');
});

test('只存了外链会后台重试补存：下载恢复后把聊天里的外链换成本地路径', async t => {
    const f = fixture(t);
    f.setDownload(false);              // 生成时两条下载路都不通
    assert.equal(await f.finish(f.debug.generateForFloor(0, '', 0)), SIGNED);
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED, '先只存了外链');
    f.setDownload(true);               // 网络恢复
    await f.runAllTimers();            // 跑到 90 秒那次补存
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL, '外链被原地换成本地路径');
    const saved = JSON.parse(f.saves.at(-1))[0];
    assert.equal(saved.extra.sdg_gal['0']['0'].list.at(-1), LOCAL, '补存后落盘');
});

test('打开聊天时扫尾：还能打开的旧外链被补存成本地路径', async t => {
    const f = fixture(t);
    f.debug.setImage(f.msg, 0, SIGNED);      // 模拟 1.8.11 时期留下的外链
    f.debug.syncSwipeExtra(f.msg);
    const saved = await f.finish(f.debug.sweepExternalLinks());
    assert.equal(saved, 1, '补存了一张');
    assert.equal(f.debug.getImage(f.msg, 0), LOCAL, '原地换成本地路径');
    assert.equal(f.uploads(), 1);
    assert.ok(f.saves.length > 0, '补存后落盘');
});

test('扫尾失败的外链：引用不动，且不再立刻重试', async t => {
    const f = fixture(t);
    f.debug.setImage(f.msg, 0, SIGNED);
    f.debug.syncSwipeExtra(f.msg);
    f.setDownload(false);
    assert.equal(await f.finish(f.debug.sweepExternalLinks()), 0, '下不动就跳过');
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED, '失败不动引用');
    const downloadsBefore = f.downloads();
    f.setDownload(true);                      // 网络恢复，但这一轮记住了失败
    assert.equal(await f.finish(f.debug.sweepExternalLinks()), 0, '失败过的先不碰');
    assert.equal(f.downloads(), downloadsBefore, '没有再次请求');
    assert.equal(f.debug.getImage(f.msg, 0), SIGNED);
});

test('扫尾上限：一次打开最多试 3 条外链', async t => {
    const f = fixture(t);
    for (let s = 0; s < 5; s++) f.debug.setImage(f.msg, s, SIGNED + '&n=' + s);
    f.debug.syncSwipeExtra(f.msg);
    f.setDownload(false);
    await f.finish(f.debug.sweepExternalLinks());
    assert.equal(f.proxied(), 3, '最多试 3 条（失败也算次数，死链多也不会拖太久）');
});

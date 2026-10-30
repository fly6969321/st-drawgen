const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

/* GPT 系站点的典型配置：地址不带 /images/generations 后缀 → chat 通道优先 */
const GPT = {
    sdgBuiltinSeeded17: true,
    genEndpoint: 'https://gpt.test/v1',
    genModel: 'gpt-image-2',
    genKey: 'sk-test',
    grokSize: '1024x1536',
    genQuality: 'high',
    genTimeout: 300,
};
const SAFE_BODY = JSON.stringify({ error: { message: 'Your request was rejected as a result of our safety system. Your prompt may contain text that is not allowed by our safety system.', type: 'invalid_request_error', code: 'moderation_blocked' } });
const PARAM_BODY = JSON.stringify({ error: { message: "Unrecognized request argument supplied: size", type: 'invalid_request_error', code: null } });
const DATA_IMG = 'data:image/png;base64,AAAA';

function fixture(t, settings) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', (error) => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = (fn) => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    const context = { chat: [], extensionSettings: { 'st-drawgen': settings || {} }, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    tasks.shift()();
    return { w, debug: w.__sdgDebug, ctx: context };
}

/* 站点应答夹具：按顺序取，用完重复最后一条 */
function stub(w, replies) {
    const calls = [];
    let i = 0;
    w.fetch = async (url, opts) => {
        calls.push({ url: String(url), body: (opts && typeof opts.body === 'string') ? opts.body : '' });
        const r = replies[Math.min(i, replies.length - 1)];
        i++;
        const status = r[0], body = r[1];
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
            text: async () => body,
            json: async () => JSON.parse(body),
        };
    };
    globalThis.fetch = w.fetch;
    return calls;
}

async function gen(debug, prompt) {
    try { return { out: await debug.genImageUnified(prompt || '一个女孩走进森林'), err: '' }; }
    catch (e) { return { out: null, err: String((e && e.message) || e) }; }
}

test('内容审核拒绝（400 moderation_blocked）只发一次，不再退 images 兜底', async (t) => {
    const { w, debug } = fixture(t, GPT);
    const calls = stub(w, [[400, SAFE_BODY]]);
    const { out, err } = await gen(debug);
    assert.equal(out, null);
    /* 这是复现用的反面：修之前这里是 2（chat 被拒 → images 再被拒一次），耗时翻倍、safe 看两遍 */
    assert.equal(calls.length, 1, '只打 chat 一发');
    assert.match(calls[0].url, /\/chat\/completions$/);
    assert.match(err, /内容被站点审核拒了/);
    assert.match(debug.formatGenError(new Error(err)), /^生图失败 400（chat）：Your request was rejected/);
});

test('参数类 400 照旧退 images 兜底（chat 通道真不通的情况没被连坐）', async (t) => {
    const { w, debug } = fixture(t, GPT);
    const calls = stub(w, [[400, PARAM_BODY], [200, JSON.stringify({ data: [{ b64_json: 'AAAA' }] })]]);
    const { out } = await gen(debug);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/chat\/completions$/);
    assert.match(calls[1].url, /\/images\/generations$/);
    assert.ok(out && out.via === 'generations', '兜底拿到图');
});

test('403 + content_policy 同样算审核拒，提示说明为什么没退兜底', async (t) => {
    const { w, debug } = fixture(t, GPT);
    const body = JSON.stringify({ error: { message: 'content_policy_violation', code: 'content_policy_violation' } });
    const calls = stub(w, [[403, body]]);
    const { err } = await gen(debug);
    assert.equal(calls.length, 1);
    assert.match(err, /内容被站点审核拒了/);
});

test('限流 / 服务端错 / 200 无图 的既有行为没动', async (t) => {
    const f1 = fixture(t, GPT);
    const c1 = stub(f1.w, [[429, JSON.stringify({ error: { message: 'no available image quota', code: 'insufficient_quota' } })]]);
    const r1 = await gen(f1.debug);
    assert.equal(c1.length, 1);
    assert.match(r1.err, /这类错误退了也是同样结果/);

    const f2 = fixture(t, GPT);
    const c2 = stub(f2.w, [[500, 'Internal Server Error']]);
    await gen(f2.debug);
    assert.equal(c2.length, 1);

    const f3 = fixture(t, GPT);
    const c3 = stub(f3.w, [[200, JSON.stringify({ choices: [{ message: { content: '抱歉，我无法生成' } }] })]]);
    const r3 = await gen(f3.debug);
    assert.equal(c3.length, 1, '200 但没图：已经计费了，不许再发一发');
    assert.match(r3.err, /可能已计费/);
});

test('成功路径不受影响（chat 直接回 markdown 图链）', async (t) => {
    const { w, debug } = fixture(t, GPT);
    const calls = stub(w, [[200, JSON.stringify({ choices: [{ message: { content: '![](' + DATA_IMG + ')' } }] })]]);
    const { out } = await gen(debug);
    assert.equal(calls.length, 1);
    assert.equal(out.via, 'chat');
    assert.equal(out.image, DATA_IMG);
});

test('chat 返回 200 但 JSON 损坏时不误判网络失败而重复请求', async (t) => {
    const { w, debug } = fixture(t, GPT);
    const calls = stub(w, [[200, '{broken json']]);
    const { err } = await gen(debug);
    assert.equal(calls.length, 1, '200 已经可能计费，不能再退到 images 接口');
    assert.match(err, /可能已计费/);
});

test('地址直指 images 且开了后端代理时仍按直连路径请求 images', async (t) => {
    const settings = Object.assign({}, GPT, {
        genEndpoint: 'https://gpt.test/v1/images/generations',
        genProxy: true,
    });
    const { w, debug, ctx } = fixture(t, settings);
    ctx.getRequestHeaders = () => ({});
    const calls = stub(w, [[200, JSON.stringify({ data: [{ b64_json: 'AAAA' }] })]]);
    const { out, err } = await gen(debug);
    assert.equal(err, '');
    assert.equal(out.via, 'generations');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/images\/generations$/);
});

test('图片 URL：下载成图片数据返回，不再只透传外链', async (t) => {
    const { w, debug, ctx } = fixture(t, GPT);
    ctx.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' });
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const calls = [];
    w.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/chat/completions')) {
            const body = JSON.stringify({ choices: [{ message: { content: '![](https://cdn.test/image.png)' } }] });
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body };
        }
        if (String(url) === 'https://cdn.test/image.png') {
            return { ok: true, status: 200, blob: async () => new w.Blob([png], { type: 'image/png' }) };
        }
        throw new Error('意外请求: ' + url);
    };
    globalThis.fetch = w.fetch;
    const { out, err } = await gen(debug);
    assert.equal(err, '');
    assert.match(out.image, /^data:image\/png;base64,/);
    assert.equal(calls.length, 2, '生图一发 + 下载外链一发');
    assert.ok(calls.includes('https://cdn.test/image.png'));
    assert.ok(!calls.some(url => url.endsWith('/images/generations')));
});

test('地址直指 images 接口时仍只发一发', async (t) => {
    const { w, debug } = fixture(t, Object.assign({}, GPT, { genEndpoint: 'https://gpt.test/v1/images/generations' }));
    const calls = stub(w, [[400, SAFE_BODY]]);
    await gen(debug);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/images\/generations$/);
});

test('isModerationBlock 只认审核拒绝，不把普通参数错误误判成审核', (t) => {
    const { debug } = fixture(t, GPT);
    const yes = [
        SAFE_BODY,
        '{"error":{"code":"content_policy_violation"}}',
        '{"error":{"message":"blocked by content filter"}}',
        '{"error":{"message":"image flagged by safety system"}}',
        '{"error":{"message":"内容违规，已拒绝"}}',
        '{"error":{"message":"检测到敏感内容"}}',
    ];
    yes.forEach((b) => assert.equal(debug.isModerationBlock(b), true, b.slice(0, 40)));
    const no = [
        PARAM_BODY,
        '{"error":{"message":"only response_format=url supported"}}',
        '{"error":{"message":"aspect_ratio 不受支持"}}',
        '{"error":{"message":"model_not_found"}}',
        '{"error":{"message":"invalid size 768x1024"}}',
        'Bad Gateway',
        '',
    ];
    no.forEach((b) => assert.equal(debug.isModerationBlock(b), false, b.slice(0, 40)));
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

const TAVERN_VERTEX_HTML =
    '<select id="vertexai_auth_mode"><option value="express">Express</option><option value="full">Full</option></select>' +
    '<input id="vertexai_region" value="us-central1">' +
    '<input id="vertexai_express_project_id" value="">' +
    '<select id="model_vertexai_select">' +
        '<optgroup label="Gemini 3.7"><option value="gemini-3.7-flash">gemini-3.7-flash</option></optgroup>' +
        '<optgroup label="Gemini 2.5"><option value="gemini-2.5-pro">gemini-2.5-pro</option><option value="gemini-2.5-flash">gemini-2.5-flash</option></optgroup>' +
    '</select>';

/* 酒馆后端 Vertex 通道的应答形状照 src/endpoints/backends/chat-completions.js sendMakerSuiteRequest（release 1.19.0） */
const okReply = text => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }], responseContent: { parts: [{ text }] } }) });

function fixture(t, overrides = {}, opts = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea>' +
        (opts.noTavernVertexUi ? '' : TAVERN_VERTEX_HTML) + '</body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = [], calls = [];
    w.setTimeout = fn => (timers.push(fn), timers.length);
    w.clearTimeout = () => {};
    w.confirm = () => true;
    w.prompt = (_msg, def) => opts.promptAnswer || def;
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, extEndpoint: 'https://extract.test/v1', extModel: 'relay-model',
        extKey: 'PRIVATE_EXTRACT_KEY', autoExtract: false, autoGenerate: false, requestTimeout: 0,
    }, overrides);
    const context = {
        chat: [], extensionSettings: { 'st-drawgen': settings },
        chatCompletionSettings: opts.tavern === undefined
            ? { vertexai_auth_mode: 'express', vertexai_region: 'global', vertexai_express_project_id: 'my-proj-123', vertexai_model: 'gemini-2.5-flash' }
            : opts.tavern,
        saveSettings() {}, saveSettingsDebounced() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test' }),
    };
    if (opts.noRequestHeaders) delete context.getRequestHeaders;
    w.SillyTavern = { getContext: () => context };
    let reply = opts.reply || (() => okReply('a person in a room'));
    w.fetch = async (url, options) => {
        calls.push({ url: String(url), headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
        return reply(String(url));
    };
    w.eval(source);
    timers.shift()();
    const $ = sel => w.document.querySelector(sel);
    const fire = (sel, value, type = 'change') => {
        const el = $(sel);
        assert.ok(el, sel + ' 存在');
        el.value = value;
        el.dispatchEvent(new w.Event(type, { bubbles: true }));
    };
    return {
        w, settings, debug: w.__sdgDebug, calls, $, fire,
        setReply(fn) { reply = fn; },
        status: () => ($('#sdg-status') || {}).textContent || '',
        profile: () => w.__sdgDebug.activeProfile('ext'),
        extract: () => w.__sdgDebug.callSubAI('角色走进房间', '', null),
    };
}

test('默认仍是 OpenAI 兼容：老配置原样直连，Vertex 那组配置框不显示', async t => {
    const f = fixture(t);
    assert.equal(f.$('#sdg-ext-api').value, 'openai');
    assert.equal(f.$('#sdg-ext-box-vertex').style.display, 'none');
    assert.equal(f.$('#sdg-ext-box-openai').style.display, '');
    assert.equal(await f.extract(), 'a person in a room');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://extract.test/v1/chat/completions');
    assert.equal(f.calls[0].body.model, 'relay-model');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer PRIVATE_EXTRACT_KEY');
    assert.equal(f.calls[0].body.chat_completion_source, undefined);
});

test('切到 Vertex 直连：把酒馆当前的 Vertex 配置抄进站点并显示在框里', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    assert.equal(f.settings.extApi, 'vertex');
    assert.equal(f.$('#sdg-ext-box-vertex').style.display, '');
    assert.equal(f.$('#sdg-ext-box-openai').style.display, 'none');
    assert.equal(f.$('#sdg-ext-vx-auth').value, 'express');
    assert.equal(f.$('#sdg-ext-vx-region').value, 'global');
    assert.equal(f.$('#sdg-ext-vx-project').value, 'my-proj-123');
    assert.equal(f.$('#sdg-ext-model-sel').value, 'gemini-2.5-flash');
    const options = Array.from(f.$('#sdg-ext-model-sel').options).map(o => o.value);
    assert.deepEqual(options, ['gemini-3.7-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', '__manual__']);
    const p = f.profile();
    assert.equal(p.api, 'vertex');
    assert.equal(p.vxRegion, 'global');
    assert.equal(p.vxModel, 'gemini-2.5-flash');
    assert.equal(p.model, 'relay-model', 'OpenAI 兼容那份模型不动');
    assert.equal(f.settings.extModel, 'relay-model');
    assert.equal(f.calls.length, 0, '切接口不发任何请求');
});

test('Vertex 提取：只发一次请求，发给酒馆 Vertex 通道，字段与酒馆主聊天一致，不带插件里的 Key', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    assert.equal(await f.extract(), 'a person in a room');
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.url, '/api/backends/chat-completions/generate');
    assert.equal(call.headers['X-CSRF-Token'], 'csrf-test');
    assert.equal(call.headers.Authorization, undefined);
    const b = call.body;
    assert.equal(b.chat_completion_source, 'vertexai');
    assert.equal(b.vertexai_auth_mode, 'express');
    assert.equal(b.vertexai_region, 'global');
    assert.equal(b.vertexai_express_project_id, 'my-proj-123');
    assert.equal(b.model, 'gemini-2.5-flash');
    assert.equal(b.stream, false);
    assert.equal(b.use_sysprompt, true);
    assert.equal(b.reasoning_effort, 'auto');
    assert.equal(b.max_tokens, undefined, '不限制输出上限');
    assert.equal(b.reverse_proxy, undefined);
    assert.equal(b.custom_url, undefined);
    assert.deepEqual(b.messages.map(m => m.role), ['system', 'user']);
    assert.ok(b.messages[1].content.includes('角色走进房间'));
    assert.ok(!JSON.stringify(call).includes('PRIVATE_EXTRACT_KEY'), '插件里那把 Key 不出现在 Vertex 请求里');
});

test('改认证模式 / 区域 / 项目 ID / 模型：改完即存进站点，下一次请求就用新值', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    f.fire('#sdg-ext-vx-region', ' europe-west4 ');
    f.fire('#sdg-ext-vx-project', 'other-proj');
    f.fire('#sdg-ext-model-sel', 'gemini-2.5-pro');
    await f.extract();
    let b = f.calls.at(-1).body;
    assert.equal(b.vertexai_region, 'europe-west4');
    assert.equal(b.vertexai_express_project_id, 'other-proj');
    assert.equal(b.model, 'gemini-2.5-pro');
    assert.equal(f.profile().vxRegion, 'europe-west4');

    f.fire('#sdg-ext-vx-auth', 'full');
    assert.equal(f.$('#sdg-ext-vx-project-box').style.display, 'none', 'Full 模式项目 ID 来自服务账号，不显示');
    await f.extract();
    assert.equal(f.calls.at(-1).body.vertexai_auth_mode, 'full');

    f.fire('#sdg-ext-vx-region', '');
    assert.equal(f.$('#sdg-ext-vx-region').value, 'us-central1', '清空区域后框里回显实际生效值');
    assert.equal(f.settings.extVxRegion, 'us-central1');

    f.fire('#sdg-ext-model', 'gemini-9-custom');
    await f.extract();
    assert.equal(f.calls.at(-1).body.model, 'gemini-9-custom', '手填模型可用');
});

test('接口来回切：两边的模型和列表互不覆盖；酒馆配置只抄一次', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    f.fire('#sdg-ext-vx-region', 'asia-northeast1');
    f.fire('#sdg-ext-model-sel', 'gemini-2.5-pro');
    f.fire('#sdg-ext-api', 'openai');
    assert.equal(f.$('#sdg-ext-model').value, 'relay-model');
    assert.equal(f.$('#sdg-ext-endpoint').value, 'https://extract.test/v1');
    await f.extract();
    assert.equal(f.calls.at(-1).url, 'https://extract.test/v1/chat/completions');
    assert.equal(f.calls.at(-1).body.model, 'relay-model');
    f.fire('#sdg-ext-api', 'vertex');
    assert.equal(f.$('#sdg-ext-vx-region').value, 'asia-northeast1', '第二次切回来不再被酒馆的值盖掉');
    assert.equal(f.$('#sdg-ext-model-sel').value, 'gemini-2.5-pro');
});

test('接口跟站点走：切站点时各用各的接口，重载后保留', async t => {
    const f = fixture(t, {}, { promptAnswer: 'Vertex站' });
    const firstId = f.profile().id;
    f.$('#sdg-ext-site-add').click();
    assert.equal(f.$('#sdg-ext-api').value, 'openai', '新建站点默认 OpenAI 兼容');
    f.fire('#sdg-ext-api', 'vertex');
    const vertexId = f.profile().id;
    assert.notEqual(vertexId, firstId);
    f.fire('#sdg-ext-site', firstId);
    assert.equal(f.settings.extApi, 'openai');
    assert.equal(f.$('#sdg-ext-box-vertex').style.display, 'none');
    await f.extract();
    assert.equal(f.calls.at(-1).url, 'https://extract.test/v1/chat/completions');
    f.fire('#sdg-ext-site', vertexId);
    assert.equal(f.settings.extApi, 'vertex');
    await f.extract();
    assert.equal(f.calls.at(-1).url, '/api/backends/chat-completions/generate');

    const reloaded = fixture(t, clone(f.settings));
    assert.equal(reloaded.$('#sdg-ext-api').value, 'vertex');
    assert.equal(reloaded.$('#sdg-ext-vx-region').value, 'global');
    assert.equal(reloaded.$('#sdg-ext-model-sel').value, 'gemini-2.5-flash');
    await reloaded.extract();
    assert.equal(reloaded.calls.at(-1).body.chat_completion_source, 'vertexai');
});

test('谷歌报错：状态码在最前，带谷歌原话；只发一次不重试', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    /* 酒馆后端把谷歌的错误体原样包成 500 返回，真状态码在 error.code */
    f.setReply(() => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { code: 429, message: 'Resource exhausted. Please try again later.', status: 'RESOURCE_EXHAUSTED' } }) }));
    await assert.rejects(f.extract(), e => {
        assert.ok(e.message.startsWith('Vertex 报错 429：'), e.message);
        assert.ok(e.message.includes('Resource exhausted'));
        assert.ok(e.message.includes('RESOURCE_EXHAUSTED'));
        return true;
    });
    assert.equal(f.calls.length, 1);
});

test('酒馆里没存 Vertex 密钥：报错说明去哪存', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    f.setReply(() => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: true, message: 'API key is required for Vertex AI Express mode' }) }));
    await assert.rejects(f.extract(), e => {
        assert.ok(e.message.startsWith('Vertex 报错 400：API key is required'), e.message);
        assert.ok(e.message.includes('酒馆 API 连接页里还没存 Vertex 密钥'));
        return true;
    });
});

test('谷歌没给正文（被拦）：酒馆回 200 + error.message，报错原样带出拦截原因', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    f.setReply(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: 'Google Vertex AI API returned no candidate\nPrompt was blocked due to : PROHIBITED_CONTENT' } }) }));
    await assert.rejects(f.extract(), /Vertex：Google Vertex AI API returned no candidate[\s\S]*PROHIBITED_CONTENT/);
});

test('没选模型 / 酒馆拿不到请求头：不发请求，直接说清原因', async t => {
    const empty = fixture(t, {}, { tavern: {}, noTavernVertexUi: true });
    empty.fire('#sdg-ext-api', 'vertex');
    assert.equal(empty.$('#sdg-ext-vx-region').value, 'us-central1', '酒馆没配过时区域回显默认值');
    await assert.rejects(empty.extract(), /请先选择 Vertex 模型/);
    assert.equal(empty.calls.length, 0);

    const old = fixture(t, {}, { noRequestHeaders: true });
    old.fire('#sdg-ext-api', 'vertex');
    await assert.rejects(old.extract(), /用不了 Vertex 直连/);
    assert.equal(old.calls.length, 0);
});

test('酒馆设置对象读不到时，退回读连接页上的控件', async t => {
    const f = fixture(t, {}, { tavern: null });
    f.w.document.querySelector('#vertexai_region').value = 'us-east4';
    f.w.document.querySelector('#model_vertexai_select').value = 'gemini-2.5-pro';
    f.fire('#sdg-ext-api', 'vertex');
    assert.equal(f.$('#sdg-ext-vx-region').value, 'us-east4');
    assert.equal(f.$('#sdg-ext-model-sel').value, 'gemini-2.5-pro');
});

test('拉取模型：Vertex 读酒馆连接页的模型列表，不发网络请求；读不到时提示手填', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    const sel = f.w.document.querySelector('#model_vertexai_select');
    const opt = f.w.document.createElement('option');
    opt.value = 'gemini-new-model'; opt.textContent = 'gemini-new-model';
    sel.appendChild(opt);
    await f.debug.fetchModels('ext');
    assert.equal(f.calls.length, 0);
    assert.ok(f.profile().vxModels.includes('gemini-new-model'));
    assert.equal(f.$('#sdg-ext-model-sel').value, 'gemini-2.5-flash', '已选的模型不被换掉');
    assert.ok(/已加载 4 个模型/.test(f.status()), f.status());
    assert.deepEqual(clone(f.profile().models || []), [], 'OpenAI 兼容那份模型列表不动');

    const none = fixture(t, {}, { noTavernVertexUi: true });
    none.fire('#sdg-ext-api', 'vertex');
    await none.debug.fetchModels('ext');
    assert.ok(/手填/.test(none.status()), none.status());
    assert.equal(none.calls.length, 0);
});

test('测试连接：Vertex 走酒馆 Vertex 通道发一条 Hi，成功 / 失败都带出结果', async t => {
    const f = fixture(t);
    f.fire('#sdg-ext-api', 'vertex');
    await f.debug.testExtConnection();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, '/api/backends/chat-completions/generate');
    assert.equal(f.calls[0].body.chat_completion_source, 'vertexai');
    assert.deepEqual(f.calls[0].body.messages, [{ role: 'user', content: 'Hi' }]);
    assert.equal(f.calls[0].body.max_tokens, undefined);
    assert.ok(/连接成功/.test(f.status()), f.status());

    f.setReply(() => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { code: 404, message: 'Publisher Model was not found', status: 'NOT_FOUND' } }) }));
    await f.debug.testExtConnection();
    assert.ok(/连接失败：Vertex 报错 404：Publisher Model was not found/.test(f.status()), f.status());
});

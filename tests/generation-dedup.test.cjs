const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(process.env.SDG_TEST_SOURCE || path.join(__dirname, '..', 'index.js'), 'utf8')
    .replace('window.__sdgDebug = {', 'window.__sdgDebug = { testBusy: () => processing || Object.keys(genBusy).length > 0,');
const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const message = (text = 'A woman enters the office.') => ({
    is_user: false, mes: text, extra: {}, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }],
});

function fixture(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map(), handlers = new Map(), calls = [];
    let nextId = 0;
    w.setTimeout = (fn, ms = 0) => { timers.set(++nextId, { fn, ms }); return nextId; };
    w.clearTimeout = id => timers.delete(id);
    w.requestAnimationFrame = fn => { queueMicrotask(() => fn(0)); return 0; };
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, enabled: true, imageKeepCount: 0,
        extEndpoint: 'https://extract.test/v1', extModel: 'extractor', extProxy: false,
        genEndpoint: 'https://images.test/v1', genModel: 'generator', genProxy: false,
        genRetryOnce: false, genTimeout: 300, genFixedPrompt: '', genPostfixPrompt: '',
        autoExtract: true, autoInject: true, autoGenerate: true, autoDelay: 100, retryOnce: true,
    }, overrides);
    const ctx = {
        chat: [message()], extensionSettings: { 'st-drawgen': settings }, saveSettingsDebounced() {}, saveChat() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        event_types: { MESSAGE_RECEIVED: 'received', CHAT_CHANGED: 'changed' },
        eventSource: { on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); } },
    };
    w.SillyTavern = { getContext: () => ctx };
    const response = (data, status = 200) => ({
        ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' },
        text: async () => typeof data === 'string' ? data : JSON.stringify(data), json: async () => data,
    });
    const chatResponse = content => response({ choices: [{ message: { content } }] });
    let answer = call => call.kind === 'extract' ? chatResponse('A woman in an office.') : chatResponse('![](' + DATA + ')');
    w.fetch = async (url, options = {}) => {
        const address = String(url);
        if (address === '/api/images/upload') {
            calls.push({ kind: 'upload', url: address });
            return response({ path: 'user/images/test/sdg_123_generated.png' });
        }
        const kind = address.startsWith('https://extract.test/') ? 'extract' : address.startsWith('https://images.test/') ? 'generation' : '';
        assert.ok(kind, 'unexpected fetch: ' + address);
        const call = { kind, url: address, body: JSON.parse(options.body) };
        calls.push(call);
        return answer(call);
    };
    w.eval(source);
    const [initId, init] = timers.entries().next().value;
    timers.delete(initId); init.fn();
    const pump = async (limit = 100) => {
        for (let n = 0; n < 12; n++) await Promise.resolve();
        for (const [id, timer] of Array.from(timers)) if (timer.ms <= limit && timers.delete(id)) timer.fn();
        await new Promise(resolve => setImmediate(resolve));
        for (let n = 0; n < 12; n++) await Promise.resolve();
    };
    const settle = async () => {
        for (let n = 0; n < 100; n++) {
            await pump();
            if (!w.__sdgDebug.testBusy() && !Array.from(timers.values()).some(task => task.ms <= 100)) return;
        }
        assert.fail('automatic generation did not settle');
    };
    const emit = (name = 'received', idx = 0) => { for (const handler of handlers.get(name) || []) handler(idx); };
    return {
        w, ctx, settings, calls, response, chatResponse, debug: w.__sdgDebug, pump, settle, emit,
        respond(fn) { answer = fn; },
        generation: () => calls.filter(call => call.kind === 'generation'),
        extraction: () => calls.filter(call => call.kind === 'extract'),
        runDelay(ms) { for (const [id, timer] of Array.from(timers)) if (timer.ms === ms && timers.delete(id)) timer.fn(); },
    };
}

test('自动生图完成后同一楼重复通知不会剥掉自有标记再付费生图', async t => {
    const f = fixture(t);
    f.emit(); await f.settle();
    const savedBody = f.ctx.chat[0].mes;
    assert.equal(f.generation().length, 1);
    assert.match(savedBody, /image###/);
    f.emit(); await f.settle();
    assert.equal(f.generation().length, 1, '重复通知不是用户要求重画，不能再发生成 POST');
    assert.equal(f.extraction().length, 1, '同一份正文也不应重复提取');
    assert.equal(f.ctx.chat[0].mes, savedBody, '不要把自己刚注入的标记当成主模型新标记剥掉');
});

test('生图仍在等待响应时的重复通知不会排队在解锁后再生成', async t => {
    const f = fixture(t);
    let release;
    f.respond(call => call.kind === 'extract' ? f.chatResponse('A woman in an office.') : new Promise(resolve => { release = resolve; }));
    f.emit();
    for (let n = 0; n < 100 && !release; n++) await f.pump();
    assert.equal(typeof release, 'function');
    f.emit();
    release(f.chatResponse('![](' + DATA + ')'));
    f.respond(call => f.chatResponse(call.kind === 'extract' ? 'A woman in an office.' : '![](' + DATA + ')'));
    await f.settle();
    assert.equal(f.generation().length, 1);
    assert.equal(f.extraction().length, 1);
});

test('提取仍在等待响应时的重复通知只提取一次并只生成一次', async t => {
    const f = fixture(t);
    let release;
    f.respond(call => call.kind === 'extract' ? new Promise(resolve => { release = resolve; }) : f.chatResponse('![](' + DATA + ')'));
    f.emit();
    for (let n = 0; n < 100 && !release; n++) await f.pump();
    assert.equal(typeof release, 'function');
    f.emit();
    release(f.chatResponse('A woman in an office.'));
    f.respond(call => f.chatResponse(call.kind === 'extract' ? 'A woman in an office.' : '![](' + DATA + ')'));
    await f.settle();
    assert.equal(f.extraction().length, 1);
    assert.equal(f.generation().length, 1);
});

test('关闭生图重试：失败后重复消息通知也不能隐式再生成', async t => {
    const f = fixture(t);
    f.respond(call => call.kind === 'extract' ? f.chatResponse('A woman in an office.') : f.response('not found', 404));
    f.emit(); await f.settle();
    f.emit(); await f.settle();
    assert.equal(f.generation().length, 1);
    assert.equal(f.extraction().length, 1);
});

test('真正改正文、新 swipe、新消息及新聊天仍分别生成', async t => {
    const f = fixture(t);
    f.emit(); await f.settle();
    const msg = f.ctx.chat[0];
    msg.mes = msg.swipes[0] = 'The woman leaves the office.';
    f.emit(); await f.settle();
    msg.swipe_id = 1; msg.mes = 'The woman leaves the office.'; msg.swipes.push(msg.mes); msg.swipe_info.push({ extra: {} }); msg.extra = {};
    f.emit(); await f.settle();
    f.ctx.chat.push(message()); f.emit('received', 1); await f.settle();
    // Reuse the same message deliberately: the chat identity must still separate the work.
    f.ctx.chat = [msg]; f.emit('changed'); f.emit(); await f.settle();
    assert.equal(f.generation().length, 5);
});

test('去重不影响用户手动重画', async t => {
    const f = fixture(t);
    f.emit(); await f.settle();
    const manual = f.debug.generateForFloor(0, '', 0);
    await f.settle(); await manual;
    assert.equal(f.generation().length, 2);
});

test('自动提取显式失败重试仍可完成一次生图', async t => {
    const f = fixture(t);
    f.respond(call => {
        if (call.kind === 'extract' && f.extraction().length === 1) return f.response('temporary extraction failure', 503);
        return f.chatResponse(call.kind === 'extract' ? 'A woman in an office.' : '![](' + DATA + ')');
    });
    f.emit(); await f.settle();
    assert.equal(f.generation().length, 0);
    f.emit(); f.runDelay(10000); await f.settle();
    assert.equal(f.extraction().length, 2, '显式提取重试照常执行');
    assert.equal(f.generation().length, 1);
});

test('关闭自动提取时，一楼不同标记仍各生成一张，重复通知不重试失败槽', async t => {
    const f = fixture(t, { autoExtract: false });
    f.ctx.chat[0].mes = 'image###first scene###\nimage###second scene###';
    f.respond(() => f.response('not found', 404));
    f.emit(); await f.settle();
    assert.equal(f.generation().length, 2, '两条独立标记对应两次独立生成');
    f.emit(); await f.settle();
    assert.equal(f.generation().length, 2, '重复通知不能把失败槽再自动生成一轮');
    f.ctx.chat[0].mes = 'image###a changed scene###';
    f.emit(); await f.settle();
    assert.equal(f.generation().length, 3, '改标记属于新生图输入，不能被去标记正文误拦');
});

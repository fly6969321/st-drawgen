const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');

// An optional saved source lets the same behavioral tests demonstrate the old bug.
const source = fs.readFileSync(process.env.SDG_TEST_SOURCE || path.join(__dirname, '..', 'index.js'), 'utf8')
    .replace('window.__sdgDebug = {', 'window.__sdgDebug = { generateForFloor, onRegenFloor,');
const IMAGE = 'https://cdn.test/generated.png?signature=swipe-test';
const clone = value => JSON.parse(JSON.stringify(value));
const tag = desc => 'image###' + desc + '###';
const gallery = images => ({ list: images, cur: images.length - 1 });

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function response(content) {
    const data = { choices: [{ message: { content } }] };
    return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(data), json: async () => data,
    };
}
function swipedMessage({ marked = true, records = true } = {}) {
    const words = ['first-scene', 'second-scene', 'third-scene'];
    const swipes = words.map(word => 'Story of ' + word + (marked ? '\n\n' + tag(word) : ''));
    const swipe_info = words.map(word => ({ extra: records ? {
        sdg_desc: word, sdg_tag: tag(word), sdg_layers: { env: 'setting-for-' + word },
    } : {} }));
    return { is_user: false, mes: swipes[2], swipes, swipe_id: 2, swipe_info, extra: clone(swipe_info[2].extra) };
}

function fixture(t, msg = swipedMessage(), overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map();
    let timerId = 0, saves = 0;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    w.requestAnimationFrame = fn => { queueMicrotask(() => fn(0)); return 0; };
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, enabled: true, imageKeepCount: 0,
        extEndpoint: 'https://extract.test/v1', extModel: 'test-extractor', extKey: 'test-only', extProxy: false,
        genEndpoint: 'https://images.test/v1', genModel: 'test-image-model', genKey: 'test-only', genProxy: false,
        genFixedPrompt: 'Setting: {Env}', genPostfixPrompt: '', convertToJpeg: false,
        autoExtract: true, autoInject: true, autoGenerate: true, layered: false,
        template: 'image###{Description}###',
    }, overrides);
    const context = {
        chat: [msg], extensionSettings: { 'st-drawgen': settings }, saveSettingsDebounced() {},
        saveChat() { saves++; },
    };
    w.SillyTavern = { getContext: () => context };
    const text = w.document.querySelector('.mes_text');
    text.textContent = msg.mes;
    const calls = [];
    let reply = call => response(call.kind === 'extract' ? 'extracted-current-scene' : '![](' + IMAGE + ')');
    // Every fetch is intercepted; no real endpoint or paid generation is reachable.
    w.fetch = async (url, options) => {
        const kind = String(url).startsWith('https://extract.test/') ? 'extract' : 'image';
        assert.ok(String(url).startsWith('https://extract.test/') || String(url).startsWith('https://images.test/'), 'unexpected request: ' + url);
        const call = { url: String(url), kind, body: JSON.parse(options.body) };
        calls.push(call);
        return reply(call);
    };
    w.eval(source);
    const [initId, init] = timers.entries().next().value;
    timers.delete(initId); init.fn();

    const pump = async () => {
        for (let n = 0; n < 8; n++) await Promise.resolve();
        for (const [id, timer] of Array.from(timers.entries())) {
            if (timer.ms <= 60 && timers.delete(id)) timer.fn();
        }
        for (let n = 0; n < 8; n++) await Promise.resolve();
    };
    const until = async predicate => {
        for (let n = 0; n < 100; n++) { if (predicate()) return; await pump(); }
        assert.ok(predicate(), 'asynchronous operation did not reach expected state');
    };
    const finish = async promise => {
        let done = false, value, error;
        promise.then(result => { value = result; done = true; }, reason => { error = reason; done = true; });
        await until(() => done);
        if (error) throw error;
        return value;
    };
    return {
        w, msg, ctx: context, debug: w.__sdgDebug, calls, settings, until, finish,
        saves: () => saves,
        respond(fn) { reply = fn; },
        images: () => calls.filter(call => call.kind === 'image'),
        prompt: call => call.body.messages[0].content.find(part => part.type === 'text').text,
        select(id) {
            msg.swipe_id = id; msg.mes = msg.swipes[id]; msg.extra = clone(msg.swipe_info[id].extra);
            text.textContent = msg.mes;
        },
    };
}

test('third reply redraw keeps both reply records and all original image history after switching to second', async t => {
    const msg = swipedMessage();
    msg.swipe_info[2].extra.sdg_gal = { '2': { '0': gallery(['old-third-A', 'old-third-B']) }, '0': { '0': gallery(['old-first']) } };
    msg.swipe_info[1].extra.sdg_gal = { '1': { '0': gallery(['old-second']) } };
    msg.extra = clone(msg.swipe_info[2].extra);
    const secondBefore = clone(msg.swipe_info[1].extra);
    const f = fixture(t, msg), pending = deferred();
    f.respond(() => pending.promise);
    const draw = f.debug.generateForFloor(0, '', 0);
    assert.equal(f.images().length, 1);
    f.select(1);
    pending.resolve(response('![](' + IMAGE + ')'));
    await f.finish(draw);

    assert.equal(msg.swipe_info[2].extra.sdg_desc, 'third-scene', 'the third reply must retain its own description');
    assert.equal(msg.swipe_info[2].extra.sdg_layers.env, 'setting-for-third-scene');
    assert.equal(msg.extra.sdg_desc, 'second-scene', 'completion must not alter the currently displayed reply record');
    assert.deepEqual(clone(msg.swipe_info[1].extra), secondBefore, 'the second reply snapshot is unchanged');
    assert.deepEqual(clone(msg.swipe_info[2].extra.sdg_gal['2']['0'].list), ['old-third-A', 'old-third-B', IMAGE]);
    assert.equal(msg.swipe_info[2].extra.sdg_gal['0'], undefined, 'other replies are no longer duplicated in every snapshot');
    assert.deepEqual(clone(msg.swipe_info[0].extra.sdg_gal['0']['0'].list), ['old-first']);
    assert.deepEqual(clone(msg.extra.sdg_gal['1']['0'].list), ['old-second']);

    f.select(2);
    f.respond(() => response('![](' + IMAGE + ')'));
    await f.finish(f.debug.generateForFloor(0, '', 0));
    assert.match(f.prompt(f.images()[1]), /setting-for-third-scene/);
    assert.doesNotMatch(f.prompt(f.images()[1]), /second-scene/);
});

test('an old mismatching cached record cannot add the previous reply layers to the current marker', async t => {
    const msg = swipedMessage();
    msg.extra = clone(msg.swipe_info[1].extra); // Existing data polluted by an older version.
    const f = fixture(t, msg);
    await f.finish(f.debug.generateForFloor(0, '', 0));
    assert.equal(f.prompt(f.images()[0]), 'third-scene');
});

test('multiple markers only reuse the layers of the matching slot', async t => {
    const msg = swipedMessage();
    msg.mes = msg.swipes[2] = tag('first-slot') + '\n\n' + tag('third-scene');
    const f = fixture(t, msg);
    await f.finish(f.debug.generateForFloor(0, '', 0));
    await f.finish(f.debug.generateForFloor(0, '', 1));
    assert.equal(f.prompt(f.images()[0]), 'first-slot');
    assert.equal(f.prompt(f.images()[1]), 'Setting: setting-for-third-scene, third-scene');
});

test('custom XML templates retain matching layers when old records only saved the envelope name', async t => {
    const f = fixture(t, swipedMessage({ marked: false, records: false }), {
        template: '<draw>Location: {Env} | Action: {Pose}</draw>',
    });
    f.debug.injectDescToMessage('current-room current-action', 0, { env: 'current-room', pose: 'current-action' });
    assert.equal(f.msg.extra.sdg_env, 'draw');
    assert.equal(f.msg.extra.sdg_tag, undefined, 'legacy XML records contain no complete saved marker');
    await f.finish(f.debug.generateForFloor(0, '', 0));
    assert.equal(f.prompt(f.images()[0]), 'Setting: current-room, current-room | Action: current-action');
});

test('custom XML template reconstruction cannot reintroduce another reply layers', async t => {
    const f = fixture(t, swipedMessage({ marked: false, records: false }), {
        template: '<draw>Location: {Env} | Action: {Pose}</draw>',
    });
    f.debug.injectDescToMessage('current-room current-action', 0, { env: 'current-room', pose: 'current-action' });
    f.msg.extra.sdg_desc = 'previous-room previous-action';
    f.msg.extra.sdg_layers = { env: 'previous-room', pose: 'previous-action' };
    await f.finish(f.debug.generateForFloor(0, '', 0));
    assert.equal(f.prompt(f.images()[0]), 'current-room | Action: current-action');
    assert.doesNotMatch(f.prompt(f.images()[0]), /previous-/);
});

test('completion without a prior injection record writes only to the original reply', async t => {
    const f = fixture(t, swipedMessage({ records: false })), pending = deferred();
    f.respond(() => pending.promise);
    const draw = f.debug.generateForFloor(0, '', 0);
    f.select(1);
    pending.resolve(response('![](' + IMAGE + ')'));
    await f.finish(draw);
    assert.equal(f.msg.extra.sdg_desc, undefined, 'current second reply must not inherit the third description');
    assert.equal(f.msg.swipe_info[1].extra.sdg_desc, undefined);
    assert.equal(f.msg.swipe_info[2].extra.sdg_desc, 'third-scene');
    assert.deepEqual(clone(f.msg.swipe_info[2].extra.sdg_gal['2']['0'].list), [IMAGE]);
});

for (const change of ['swipe', 'edit', 'chat']) {
    test('extraction result is discarded when its original target changes: ' + change, async t => {
        const f = fixture(t, swipedMessage({ marked: false, records: false })), pending = deferred();
        f.respond(call => call.kind === 'extract' ? pending.promise : response('![](' + IMAGE + ')'));
        const extraction = f.debug.runExtract(f.msg.mes, '', { auto: true, targetIdx: 0 });
        assert.equal(f.calls.length, 1);
        if (change === 'swipe') f.select(1);
        if (change === 'edit') f.msg.mes = f.msg.swipes[2] = 'Edited while extracting';
        if (change === 'chat') f.ctx.chat = [swipedMessage({ marked: false, records: false })];
        const current = f.ctx.chat[0], before = current.mes;
        pending.resolve(response('stale-extracted-scene'));
        await f.finish(extraction);
        assert.equal(current.mes, before, 'stale results must not inject into a different target');
        assert.equal(current.extra.sdg_desc, undefined);
        assert.equal(f.images().length, 0);
        assert.equal(f.w.document.querySelector('#sdg-btn-extract').disabled, false, 'extraction lock must be released');
    });
}

test('switching replies while injection is being saved prevents automatic image generation', async t => {
    const f = fixture(t, swipedMessage({ marked: false, records: false })), saving = deferred();
    let saveStarted = false;
    f.ctx.saveChat = () => { saveStarted = true; return saving.promise; };
    const extraction = f.debug.runExtract(f.msg.mes, '', { auto: true, targetIdx: 0 });
    await f.until(() => saveStarted);
    assert.match(f.msg.swipes[2], /extracted-current-scene/);
    f.select(1);
    const secondBefore = f.msg.mes;
    saving.resolve();
    await f.finish(extraction);
    assert.equal(f.images().length, 0);
    assert.equal(f.msg.mes, secondBefore);
    assert.equal(f.msg.swipe_info[2].extra.sdg_desc, 'extracted-current-scene');
    assert.equal(f.msg.extra.sdg_desc, undefined);
});

test('batch redraw stops before the next marker after switching replies', async t => {
    const msg = swipedMessage();
    msg.mes = msg.swipes[2] = tag('third-slot-one') + '\n\n' + tag('third-slot-two');
    const f = fixture(t, msg), pending = deferred();
    f.respond(() => f.images().length === 1 ? pending.promise : response('![](' + IMAGE + ')'));
    const batch = f.debug.onRegenFloor(0);
    assert.equal(f.images().length, 1);
    f.select(1);
    pending.resolve(response('![](' + IMAGE + ')'));
    await f.finish(batch);
    assert.equal(f.images().length, 1, 'remaining old markers must not be generated for the newly selected reply');
    assert.equal(f.msg.swipe_info[1].extra.sdg_gal, undefined);
});

test('normal extraction saves its marker before generating and preserves the same reply layers', async t => {
    const f = fixture(t, swipedMessage({ marked: false, records: false }), { layered: true });
    f.respond(call => {
        if (call.kind === 'extract') return response('<env>current-room</env><pose>current-action</pose>');
        assert.ok(f.saves() >= 1, 'the injection must be saved before contacting the image endpoint');
        assert.match(f.msg.mes, /image###current-room current-action###/);
        assert.equal(f.msg.swipe_info[2].extra.sdg_layers.env, 'current-room');
        return response('![](' + IMAGE + ')');
    });
    await f.finish(f.debug.runExtract(f.msg.mes, '', { auto: true, targetIdx: 0 }));
    assert.equal(f.calls.length, 2);
    assert.equal(f.images().length, 1);
    assert.equal(f.prompt(f.images()[0]), 'Setting: current-room, current-room current-action');
    assert.equal(f.msg.extra.sdg_desc, 'current-room current-action');
    assert.deepEqual(clone(f.msg.swipe_info[2].extra.sdg_gal['2']['0'].list), [IMAGE]);
});

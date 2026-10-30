const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture(t) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map();
    let timerId = 0, currentId = 'chat-A', context;
    w.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    const calls = [], pending = [];
    let active = 0, maxActive = 0, implementation = () => {
        const task = deferred(); pending.push(task);
        active++; maxActive = Math.max(maxActive, active);
        return task.promise.finally(() => { active--; });
    };
    function saveChat() {
        calls.push({ chat: context.chat, id: currentId, body: JSON.stringify(context.chat) });
        return implementation();
    }
    context = {
        chat: [{ mes: 'first state', extra: {} }], characterId: 'character-A', groupId: null,
        getCurrentChatId: () => currentId, saveChat,
        extensionSettings: { 'st-drawgen': { sdgBuiltinSeeded17: true } }, saveSettingsDebounced() {},
    };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    const [initId, init] = timers.entries().next().value;
    timers.delete(initId); init.fn();
    const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
    return {
        w, debug: w.__sdgDebug, calls, pending, tick,
        context: () => context,
        maxActive: () => maxActive,
        timers: () => Array.from(timers.values()).filter(timer => timer.ms === 40),
        flush() {
            for (const [id, timer] of Array.from(timers.entries())) {
                if (timer.ms === 40 && timers.delete(id)) timer.fn();
            }
        },
        saveWith(fn) { implementation = fn; },
        select({ sameArray = false } = {}) {
            currentId = 'chat-B';
            const nextChat = sameArray ? context.chat : [];
            nextChat.splice(0, nextChat.length, { mes: 'other chat', extra: {} });
            context = { ...context, chat: nextChat };
        },
    };
}

test('a burst of save requests waits 40ms and shares one actual save', async t => {
    const f = fixture(t);
    const first = f.debug.persistChat('first');
    const second = f.debug.persistChat('second');
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers().length, 1);
    assert.equal(f.timers()[0].ms, 40);
    f.flush();
    await f.tick();
    assert.equal(f.calls.length, 1);
    f.pending[0].resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('a pending save prevents overlap and coalesces all later changes into the next save', async t => {
    const f = fixture(t);
    const first = f.debug.persistChat('initial image');
    f.flush();
    await f.tick();
    f.context().chat[0].mes = 'second state';
    const second = f.debug.persistChat('second image');
    const third = f.debug.persistChat('third image');
    f.flush();
    assert.equal(f.calls.length, 1, 'the first network save is still pending');
    assert.equal(f.maxActive(), 1);
    f.context().chat[0].mes = 'latest state';
    f.pending[0].resolve();
    await f.tick();
    assert.equal(await first, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.includes('first state'), true);
    assert.equal(f.calls[1].body.includes('latest state'), true, 'new changes must be captured by a later save');
    let secondFinished = false;
    second.then(() => { secondFinished = true; });
    await f.tick();
    assert.equal(secondFinished, false, 'later callers cannot resolve with the earlier save');
    f.pending[1].resolve();
    assert.deepEqual(await Promise.all([second, third]), [true, true]);
    assert.equal(f.maxActive(), 1);
});

test('finishing an active save does not bypass the next batch debounce', async t => {
    const f = fixture(t);
    const first = f.debug.persistChat('first');
    f.flush();
    await f.tick();
    const second = f.debug.persistChat('second');
    f.pending[0].resolve();
    await first;
    await f.tick();
    assert.equal(f.calls.length, 1, 'the second 40ms timer has not fired');
    f.flush();
    await f.tick();
    assert.equal(f.calls.length, 2);
    f.pending[1].resolve();
    assert.equal(await second, true);
});

test('an asynchronous save failure resolves its callers false and allows the queued save to continue', async t => {
    const f = fixture(t);
    const first = f.debug.persistChat('first');
    const sameBatch = f.debug.persistChat('same batch');
    f.flush();
    await f.tick();
    const later = f.debug.persistChat('later');
    f.flush();
    f.pending[0].reject(new Error('server unavailable'));
    assert.deepEqual(await Promise.all([first, sameBatch]), [false, false]);
    await f.tick();
    assert.equal(f.calls.length, 2);
    f.pending[1].resolve();
    assert.equal(await later, true);
    assert.equal(f.maxActive(), 1);
});

test('a synchronous save exception releases the queue for a future attempt', async t => {
    const f = fixture(t);
    f.saveWith(() => { throw new Error('cannot save now'); });
    const failed = f.debug.persistChat('fails immediately');
    f.flush();
    assert.equal(await failed, false);
    f.saveWith(() => undefined);
    const retry = f.debug.persistChat('retry');
    f.flush();
    assert.equal(await retry, true);
    assert.equal(f.calls.length, 2);
});

test('stillValid is checked after the previous save finishes and invalid callers do not block valid callers', async t => {
    const f = fixture(t);
    const first = f.debug.persistChat('active');
    f.flush();
    await f.tick();
    let valid = true;
    const stale = f.debug.persistChat('stale backup', () => valid);
    const current = f.debug.persistChat('current image', () => true);
    f.flush();
    valid = false;
    f.pending[0].resolve();
    await first; await f.tick();
    assert.equal(await stale, false);
    assert.equal(f.calls.length, 2);
    f.pending[1].resolve();
    assert.equal(await current, true);
});

for (const sameArray of [false, true]) {
    test('queued old-chat saves are discarded after a chat switch' + (sameArray ? ' that reuses the chat array' : ''), async t => {
        const f = fixture(t);
        const active = f.debug.persistChat('active old chat');
        f.flush();
        await f.tick();
        const stale = f.debug.persistChat('queued old chat');
        f.flush();
        f.select({ sameArray });
        const current = f.debug.persistChat('new chat');
        f.flush();
        assert.equal(f.calls.length, 1);
        f.pending[0].resolve();
        await active; await f.tick();
        assert.equal(await stale, false, 'a delayed request must not save a different chat');
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[1].id, 'chat-B');
        assert.ok(f.calls[1].body.includes('other chat'));
        f.pending[1].resolve();
        assert.equal(await current, true);
        assert.equal(f.maxActive(), 1);
    });
}

test('a stale or throwing validity guard resolves false without starting a save or wedging later requests', async t => {
    const f = fixture(t);
    const stale = f.debug.persistChat('stale', () => false);
    const throws = f.debug.persistChat('throws', () => { throw new Error('view gone'); });
    f.flush();
    assert.deepEqual(await Promise.all([stale, throws]), [false, false]);
    assert.equal(f.calls.length, 0);
    const later = f.debug.persistChat('valid');
    f.flush();
    await f.tick();
    f.pending[0].resolve();
    assert.equal(await later, true);
});

test('a queued chat change without any replacement save does not call saveChat for the wrong chat', async t => {
    const f = fixture(t);
    const stale = f.debug.persistChat('old chat');
    f.select();
    f.flush();
    assert.equal(await stale, false);
    assert.equal(f.calls.length, 0);
});

test('oversized legacy inline images stop before chat serialization and leave the source untouched', async t => {
    const f = fixture(t);
    const inline = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024);
    f.context().chat[0].extra.sdg_image = inline;
    const save = f.debug.persistChat('legacy chat');
    f.flush();
    assert.equal(await save, false);
    assert.equal(f.calls.length, 0, 'saveChat must not serialize or upload the huge chat');
    assert.equal(f.context().chat[0].extra.sdg_image, inline, 'the existing image is not deleted');
    f.context().chat[0].extra.sdg_image = 'images/test/already-backed-up.png';
    const later = f.debug.persistChat('after successful backup');
    f.flush(); await f.tick();
    assert.equal(f.calls.length, 1, 'the budget failure must release the save queue');
    f.pending[0].resolve();
    assert.equal(await later, true);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const A = 'https://temporary.test/a.png?expires=short';
const B = 'https://temporary.test/b.png?expires=short';
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const DATA = 'data:image/png;base64,' + BASE64;
const clone = value => JSON.parse(JSON.stringify(value));
const imageRecord = (list, cur = 0) => ({ list, cur });
const message = extra => ({ is_user: false, mes: 'A story', extra, swipe_id: 0, swipes: ['A story', 'Another reply'], swipe_info: [{ extra: {} }, { extra: {} }] });

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(t, chat, { headers = true } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map(), calls = [];
    let timerId = 0, saveCount = 0, uploads = 0, chatSavesPaused = false;
    let save = () => undefined;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    const settings = { sdgBuiltinSeeded17: true, imageKeepDays: 0, autoExtract: false, autoGenerate: false, genTimeout: 300 };
    const ctx = {
        chat, extensionSettings: { 'st-drawgen': settings }, saveSettingsDebounced() {},
        saveChat() { saveCount++; return save(); },
    };
    if (headers) ctx.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' });
    w.SillyTavern = { getContext: () => ctx };
    const imageResponse = () => ({
        ok: true, status: 200,
        headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'image/png' : null },
        blob: async () => new w.Blob([Uint8Array.from(Buffer.from(BASE64, 'base64'))], { type: 'image/png' }),
    });
    const failureResponse = () => ({ ok: false, status: 403, text: async () => 'Image link expired', headers: { get: () => 'text/plain' } });
    const defaultResponse = call => {
        if (call.url === '/api/images/upload') {
            const result = { path: '/images/user/backup-' + (++uploads) + '.png' };
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => result, text: async () => JSON.stringify(result) };
        }
        return imageResponse();
    };
    let respond = defaultResponse;
    // Intercept every request, including proxy downloads; paid generation is forbidden here.
    w.fetch = async (url, options = {}) => {
        const call = { url: String(url), options, body: typeof options.body === 'string' ? JSON.parse(options.body) : null };
        assert.doesNotMatch(call.url, /\/chat\/completions|\/images\/generations|\/images\/edits|\/backends\/chat-completions\/generate/,
            'backing up an existing image must never contact a generation endpoint');
        calls.push(call);
        return respond(call);
    };
    w.eval(source);
    const [initId, init] = timers.entries().next().value;
    timers.delete(initId); init.fn();
    const pump = async () => {
        // FileReader uses browser task scheduling as well as promise microtasks.
        await new Promise(resolve => setImmediate(resolve));
        for (const [id, timer] of Array.from(timers.entries())) {
            if (timer.ms <= 60 && !(chatSavesPaused && timer.ms === 40) && timers.delete(id)) timer.fn();
        }
        for (let n = 0; n < 8; n++) await Promise.resolve();
    };
    const until = async predicate => {
        for (let n = 0; n < 150; n++) { if (predicate()) return; await pump(); }
        assert.ok(predicate(), 'backup did not reach the expected asynchronous state');
    };
    const finish = async promise => {
        let done = false, result, error;
        promise.then(value => { result = value; done = true; }, reason => { error = reason; done = true; });
        await until(() => done);
        if (error) throw error;
        return result;
    };
    return {
        w, ctx, calls, debug: w.__sdgDebug, finish, until, imageResponse, failureResponse, defaultResponse,
        saveCount: () => saveCount,
        uploadCalls: () => calls.filter(call => call.url === '/api/images/upload'),
        downloadCalls: () => calls.filter(call => call.url !== '/api/images/upload'),
        respond(fn) { respond = fn; },
        saveWith(fn) { save = fn; },
        pauseChatSaves(value) { chatSavesPaused = value; },
    };
}

test('backup deduplicates URLs across every swipe, message and legacy record without changing history order', async t => {
    const first = message({ sdg_desc: 'first description', sdg_layers: { env: 'first room' }, sdg_gal: {
        '0': { '0': imageRecord([A, 'images/user/local.png', A], 2) },
        '1': { '2': imageRecord([B, A], 1) },
    }, sdg_image: A, sdg_images: { '0': B, '2': A } });
    first.swipe_info[0].extra = clone(first.extra);
    first.swipe_info[1].extra = { sdg_desc: 'second description', sdg_layers: { env: 'second room' }, sdg_gal: { '1': { '0': imageRecord([A, B], 1) } }, sdg_image: B };
    const second = message({ sdg_image: A, sdg_images: { '4': B } });
    const chat = [first, second], before = clone(chat), f = fixture(t, chat);
    const result = await f.finish(f.debug.backupChatImages());
    assert.equal(result.saved, 2, 'each distinct temporary URL is backed up once');
    assert.equal(result.failed, 0);
    assert.equal(result.stopped, false);
    assert.equal(f.downloadCalls().length, 2);
    assert.equal(f.uploadCalls().length, 2);
    assert.ok(f.saveCount() > 0, 'rewritten references are saved to the chat');
    const savedA = first.extra.sdg_gal['0']['0'].list[0];
    const savedB = first.extra.sdg_gal['1']['2'].list[0];
    assert.match(savedA, /^images\/user\//);
    assert.match(savedB, /^images\/user\//);
    assert.notEqual(savedA, savedB);
    const replace = value => typeof value === 'string' ? (value === A ? savedA : value === B ? savedB : value)
        : Array.isArray(value) ? value.map(replace)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)])) : value;
    assert.deepEqual(clone(chat), replace(before), 'only matching URLs change; cur, slot ordering and reply metadata stay intact');
    const callsBefore = f.calls.length;
    const again = await f.finish(f.debug.backupChatImages());
    assert.equal(again.saved, 0);
    assert.equal(again.failed, 0);
    assert.equal(f.calls.length, callsBefore, 'already local files are not re-downloaded');
});

test('onlyUrl backs up all copies of the selected URL and leaves other images alone', async t => {
    const msg = message({ sdg_gal: { '0': { '0': imageRecord([A, B, A], 1) } }, sdg_image: A });
    msg.swipe_info[1].extra.sdg_images = { '0': A, '1': B };
    const f = fixture(t, [msg]);
    const result = await f.finish(f.debug.backupChatImages(A));
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 0);
    assert.equal(f.downloadCalls().length, 1);
    assert.equal(f.uploadCalls().length, 1);
    const saved = msg.extra.sdg_image;
    assert.match(saved, /^images\//);
    assert.deepEqual(clone(msg.extra.sdg_gal['0']['0']), { list: [saved, B, saved], cur: 1 });
    assert.deepEqual(clone(msg.swipe_info[1].extra.sdg_images), { '0': saved, '1': B });
});

test('relative files, same-origin image URLs and unsupported schemes are never migrated', async t => {
    const urls = ['images/user/local.png', '/images/user/absolute.png', '../assets/local.png', 'https://tavern.test/images/user/same-origin.png', 'blob:https://tavern.test/local', '', 'file:///local.png'];
    const msg = message({ sdg_gal: { '0': { '0': imageRecord(urls, 2) } } }), before = clone(msg), f = fixture(t, [msg]);
    const result = await f.finish(f.debug.backupChatImages());
    assert.equal(result.saved, 0);
    assert.equal(result.failed, 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(clone(msg), before);
});

test('embedded image data is uploaded once and replaced everywhere without downloading', async t => {
    const msg = message({ sdg_image: DATA, sdg_gal: { '0': { '0': imageRecord([DATA, DATA], 1) } } });
    msg.swipe_info[1].extra.sdg_images = { '0': DATA };
    const f = fixture(t, [msg]), result = await f.finish(f.debug.backupChatImages());
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 0);
    assert.equal(f.downloadCalls().length, 0);
    assert.equal(f.uploadCalls().length, 1);
    const saved = msg.extra.sdg_image;
    assert.match(saved, /^images\//);
    assert.deepEqual(clone(msg.extra.sdg_gal['0']['0']), { list: [saved, saved], cur: 1 });
    assert.equal(msg.swipe_info[1].extra.sdg_images['0'], saved);
});

test('embedded data remains intact when the server upload capability is unavailable', async t => {
    const msg = message({ sdg_image: DATA }), before = clone(msg), f = fixture(t, [msg], { headers: false });
    const result = await f.finish(f.debug.backupChatImages());
    assert.equal(result.saved, 0);
    assert.equal(result.failed, 0, 'unsupported inline migration is skipped');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(clone(msg), before);
});

test('expired external images retain all original references while other backups can succeed', async t => {
    const msg = message({ sdg_gal: { '0': { '0': imageRecord([A, B, A], 2) } }, sdg_image: A });
    const f = fixture(t, [msg]);
    f.respond(call => {
        if (call.url.includes('a.png') || decodeURIComponent(call.url).includes('a.png') || (call.body && JSON.stringify(call.body).includes('a.png'))) return f.failureResponse();
        return f.defaultResponse(call);
    });
    const result = await f.finish(f.debug.backupChatImages());
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 1, 'duplicate failures count once per URL');
    assert.equal(msg.extra.sdg_image, A);
    assert.equal(msg.extra.sdg_gal['0']['0'].list[0], A);
    assert.equal(msg.extra.sdg_gal['0']['0'].list[2], A);
    assert.match(msg.extra.sdg_gal['0']['0'].list[1], /^images\//);
    assert.equal(msg.extra.sdg_gal['0']['0'].cur, 2);
});

test('failed chat persistence rolls back rewritten references and does not claim a saved backup', async t => {
    const msg = message({ sdg_image: A, sdg_gal: { '0': { '0': imageRecord([A, A], 1) } } });
    msg.swipe_info[0].extra = clone(msg.extra);
    const before = clone(msg), f = fixture(t, [msg]);
    f.saveWith(() => Promise.reject(new Error('storage unavailable')));
    const result = await f.finish(f.debug.backupChatImages());
    assert.equal(result.saved, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(clone(msg), before, 'all references must revert if the chat cannot be saved');
});

test('switching chats during download stops the job and leaves the new chat untouched', async t => {
    const oldMsg = message({ sdg_image: A }), newMsg = message({ sdg_image: A }), oldBefore = clone(oldMsg), newBefore = clone(newMsg);
    const f = fixture(t, [oldMsg]), download = deferred();
    f.respond(call => call.url === A ? download.promise : f.defaultResponse(call));
    const backup = f.debug.backupChatImages();
    await f.until(() => f.downloadCalls().length === 1);
    f.ctx.chat = [newMsg];
    download.resolve(f.imageResponse());
    const result = await f.finish(backup);
    assert.equal(result.stopped, true);
    assert.equal(result.saved, 0);
    assert.deepEqual(clone(newMsg), newBefore);
    assert.deepEqual(clone(oldMsg), oldBefore, 'an uncommitted old-chat backup must not rewrite an orphan reference');
    assert.equal(f.saveCount(), 0, 'do not save the new chat for an old chat result');
});

test('switching chats while the chat save is queued rolls back the old references and skips the new chat save', async t => {
    const oldMsg = message({ sdg_image: DATA }), newMsg = message({ sdg_image: A });
    const oldBefore = clone(oldMsg), newBefore = clone(newMsg), f = fixture(t, [oldMsg]);
    f.pauseChatSaves(true);
    const backup = f.debug.backupChatImages();
    await f.until(() => oldMsg.extra.sdg_image !== DATA);
    assert.equal(f.saveCount(), 0, 'save has not reached the server yet');
    f.ctx.chat = [newMsg];
    f.pauseChatSaves(false);
    const result = await f.finish(backup);
    assert.equal(result.stopped, true);
    assert.equal(result.saved, 0, 'an unsaved old-chat rewrite is not a completed backup');
    assert.equal(f.saveCount(), 0, 'the queued old-chat job must not save the newly selected chat');
    assert.deepEqual(clone(oldMsg), oldBefore);
    assert.deepEqual(clone(newMsg), newBefore);
});

test('switching replies in the same chat updates current and stored image references without mixing metadata', async t => {
    const msg = message({ sdg_desc: 'first description', sdg_layers: { env: 'first room' }, sdg_gal: { '0': { '0': imageRecord([A], 0) } } });
    msg.swipe_info[0].extra = clone(msg.extra);
    msg.swipe_info[1].extra = { sdg_desc: 'second description', sdg_layers: { env: 'second room' }, sdg_gal: { '1': { '0': imageRecord([A, B], 1) } } };
    const f = fixture(t, [msg]), download = deferred();
    f.respond(call => call.url === A ? download.promise : f.defaultResponse(call));
    const backup = f.debug.backupChatImages(A);
    await f.until(() => f.downloadCalls().length === 1);
    msg.swipe_id = 1; msg.mes = msg.swipes[1]; msg.extra = clone(msg.swipe_info[1].extra);
    download.resolve(f.imageResponse());
    const result = await f.finish(backup);
    assert.equal(result.saved, 1);
    assert.equal(result.stopped, false, 'changing only the reply does not cancel a chat-wide backup');
    const saved = msg.swipe_info[0].extra.sdg_gal['0']['0'].list[0];
    assert.match(saved, /^images\//);
    assert.deepEqual(clone(msg.extra.sdg_gal['1']['0']), { list: [saved, B], cur: 1 });
    assert.deepEqual(clone(msg.swipe_info[1].extra.sdg_gal['1']['0']), { list: [saved, B], cur: 1 });
    assert.equal(msg.extra.sdg_desc, 'second description');
    assert.equal(msg.extra.sdg_layers.env, 'second room');
    assert.equal(msg.swipe_info[0].extra.sdg_desc, 'first description');
    assert.equal(msg.swipe_info[0].extra.sdg_layers.env, 'first room');
});

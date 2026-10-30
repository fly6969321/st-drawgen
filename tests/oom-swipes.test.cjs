const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(process.env.SDG_TEST_SOURCE || path.join(__dirname, '..', 'index.js'), 'utf8')
    .replace('window.__sdgDebug = {', 'window.__sdgDebug = { syncSwipeExtraFor,');
const clone = value => JSON.parse(JSON.stringify(value));
const record = (list, cur = 0) => ({ list, cur });
const group = (list, cur = 0) => ({ '0': record(list, cur) });

function message(count = 3) {
    return {
        mes: 'Story', is_user: false, swipe_id: 0, swipes: Array(count).fill('Story'),
        extra: {}, swipe_info: Array.from({ length: count }, (_, i) => ({ extra: { sdg_desc: 'reply-' + i } })),
    };
}
function fixture(t, msg) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, tasks = [];
    w.setTimeout = fn => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    w.fetch = () => { throw new Error('gallery compaction must not perform network requests'); };
    const ctx = { chat: [msg], extensionSettings: { 'st-drawgen': { sdgBuiltinSeeded17: true, imageKeepDays: 0 } }, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => ctx };
    w.eval(source); tasks.shift()();
    return { w, debug: w.__sdgDebug, ctx };
}

test('legacy inline gallery serialization falls from S+1 copies to two without deleting image bytes', t => {
    const count = 5, perSwipe = 3, msg = message(count), gal = {};
    for (let s = 0; s < count; s++) {
        gal[s] = group(Array.from({ length: perSwipe }, (_, i) => 'data:image/png;base64,' + 'A'.repeat(1024) + s + '-' + i), 1);
    }
    msg.extra = { sdg_desc: 'reply-0', sdg_gal: gal };
    msg.swipe_info.forEach(slot => { slot.extra.sdg_gal = gal; });
    const before = JSON.stringify(msg);
    assert.equal((before.match(/data:image\/png;base64,/g) || []).length, count * perSwipe * (count + 1));
    const { debug } = fixture(t, msg);
    debug.syncSwipeExtra(msg);
    const after = JSON.stringify(msg);
    assert.equal((after.match(/data:image\/png;base64,/g) || []).length, count * perSwipe * 2);
    assert.ok(after.length < before.length * 0.4, 'the serialized payload is reduced without decoding or dropping legacy bytes');
    for (let s = 0; s < count; s++) {
        assert.deepEqual(Object.keys(msg.swipe_info[s].extra.sdg_gal), [String(s)]);
        assert.deepEqual(clone(msg.swipe_info[s].extra.sdg_gal[s]), clone(gal[s]));
        assert.equal(msg.swipe_info[s].extra.sdg_desc, 'reply-' + s);
    }
    debug.syncSwipeExtra(msg);
    assert.equal(JSON.stringify(msg), after, 'repeated synchronization does not grow the gallery again');
});

test('old all-swipe snapshots return unique history and slots to their owner before removing duplicates', t => {
    const msg = message();
    msg.extra = { sdg_desc: 'reply-0', sdg_gal: { '0': group(['current-zero']) } };
    msg.swipe_info[0].extra.sdg_gal = { '0': group(['old-zero']), '2': { '0': record(['older-two', 'shared-two']), '3': record(['other-slot']) } };
    msg.swipe_info[1].extra.sdg_gal = { '1': group(['current-one']), '2': group(['shared-two', 'latest-two'], 1) };
    msg.swipe_info[2].extra.sdg_gal = { '2': group(['shared-two', 'latest-two'], 1) };
    const { debug } = fixture(t, msg);
    debug.syncSwipeExtra(msg);
    assert.deepEqual(clone(msg.swipe_info[2].extra.sdg_gal['2']['0']), { list: ['older-two', 'shared-two', 'latest-two'], cur: 2 });
    assert.deepEqual(clone(msg.swipe_info[2].extra.sdg_gal['2']['3'].list), ['other-slot']);
    assert.deepEqual(clone(msg.swipe_info[0].extra.sdg_gal), { '0': group(['current-zero']) });
    assert.deepEqual(clone(msg.swipe_info[1].extra.sdg_gal), { '1': group(['current-one']) });
    assert.deepEqual(Object.keys(msg.extra.sdg_gal), ['0'], 'displaying one reply need not load other galleries into current extra');
});

test('unowned or malformed legacy groups are retained instead of being silently dropped', t => {
    const msg = message(2);
    msg.extra.sdg_gal = { '0': group(['zero']), '99': group(['future-owner']) };
    msg.swipe_info[0].extra.sdg_gal = { '0': group(['zero']), unknown: group(['unowned']), '1': group(['one']), '01': group(['noncanonical']) };
    msg.swipe_info[1].extra.sdg_gal = { '0': group(['zero']), '1': group(['one']), '88': group(['unavailable-owner']) };
    const { debug } = fixture(t, msg);
    debug.syncSwipeExtra(msg);
    assert.deepEqual(clone(msg.extra.sdg_gal['99']), group(['future-owner']));
    assert.deepEqual(clone(msg.swipe_info[0].extra.sdg_gal.unknown), group(['unowned']));
    assert.deepEqual(clone(msg.swipe_info[0].extra.sdg_gal['01']), group(['noncanonical']));
    assert.deepEqual(clone(msg.swipe_info[1].extra.sdg_gal['88']), group(['unavailable-owner']));
    assert.equal(msg.swipe_info[0].extra.sdg_gal['1'], undefined);
    assert.equal(msg.swipe_info[1].extra.sdg_gal['0'], undefined);
});

test('restore migrates a gallery found only in another reply snapshot and loads only the selected reply', t => {
    const msg = message();
    msg.swipe_id = 2;
    msg.swipe_info[0].extra.sdg_gal = { '0': group(['zero']), '2': group(['two-A', 'two-B'], 1) };
    const { debug } = fixture(t, msg);
    assert.equal(debug.restoreSwipeExtra(msg), true);
    assert.deepEqual(Object.keys(msg.extra.sdg_gal), ['2']);
    assert.deepEqual(clone(msg.extra.sdg_gal['2']), group(['two-A', 'two-B'], 1));
    assert.equal(msg.extra.sdg_desc, 'reply-2');
    assert.deepEqual(Object.keys(msg.swipe_info[0].extra.sdg_gal), ['0']);
    assert.deepEqual(Object.keys(msg.swipe_info[2].extra.sdg_gal), ['2']);
    assert.equal(debug.restoreSwipeExtra(msg), false, 'already compact and restored state is stable');
});

test('synchronizing fresh extra without a gallery does not erase the only saved current-reply images', t => {
    const msg = message();
    msg.extra = { sdg_desc: 'fresh description' };
    msg.swipe_info[1].extra.sdg_gal = { '0': group(['saved-only-in-old-snapshot']) };
    const { debug } = fixture(t, msg);
    debug.syncSwipeExtra(msg);
    assert.deepEqual(clone(msg.swipe_info[0].extra.sdg_gal), { '0': group(['saved-only-in-old-snapshot']) });
    assert.equal(msg.swipe_info[0].extra.sdg_desc, 'fresh description');
    assert.equal(msg.swipe_info[1].extra.sdg_gal['0'], undefined);
});

test('explicitly deleting the current gallery also removes stale cross-swipe copies without restoring them', t => {
    const msg = message();
    msg.extra.sdg_gal = { '0': group(['delete-me']), '1': group(['keep-one']) };
    msg.swipe_info[0].extra.sdg_gal = clone(msg.extra.sdg_gal);
    msg.swipe_info[1].extra.sdg_gal = clone(msg.extra.sdg_gal);
    const { debug } = fixture(t, msg);
    assert.equal(debug.dropFloorImages(msg, 'test cleanup'), true);
    assert.equal(msg.extra.sdg_gal['0'], undefined);
    assert.equal(msg.swipe_info[0].extra.sdg_gal['0'], undefined);
    assert.equal(msg.swipe_info[1].extra.sdg_gal['0'], undefined);
    assert.deepEqual(clone(msg.swipe_info[1].extra.sdg_gal['1']), group(['keep-one']));
    msg.extra = clone(msg.swipe_info[0].extra);
    debug.restoreSwipeExtra(msg);
    assert.equal(debug.getImage(msg, 0), '');
});

test('async redraw synchronization appends to its original gallery and keeps current reply metadata isolated', t => {
    const msg = message();
    msg.swipe_id = 2;
    msg.extra = { sdg_desc: 'reply-2', sdg_layers: { env: 'room-two' }, sdg_gal: { '2': group(['two']) } };
    msg.swipe_info[1].extra.sdg_gal = { '1': group(['one-A', 'one-B'], 1), '0': group(['zero']) };
    const { debug } = fixture(t, msg);
    debug.setImage(msg, 0, 'images/new-one.png', '1');
    debug.syncSwipeExtraFor(msg, '1');
    assert.deepEqual(clone(msg.swipe_info[1].extra.sdg_gal), { '1': group(['one-A', 'one-B', 'images/new-one.png'], 2) });
    assert.deepEqual(clone(msg.swipe_info[0].extra.sdg_gal), { '0': group(['zero']) });
    assert.equal(msg.swipe_info[1].extra.sdg_desc, 'reply-1');
    assert.equal(msg.extra.sdg_desc, 'reply-2');
    assert.equal(msg.extra.sdg_layers.env, 'room-two');
    assert.deepEqual(clone(msg.extra.sdg_gal['2']), group(['two']));
});

test('compaction safely detaches extra aliases without pruning the current full gallery', t => {
    const msg = message(2);
    msg.extra = { sdg_desc: 'shared metadata', sdg_gal: { '0': group(['zero']), '1': group(['one']) } };
    msg.swipe_info[0].extra = msg.extra;
    msg.swipe_info[1].extra = msg.extra;
    const { debug } = fixture(t, msg);
    debug.syncSwipeExtra(msg);
    assert.deepEqual(Object.keys(msg.extra.sdg_gal), ['0', '1']);
    assert.deepEqual(Object.keys(msg.swipe_info[0].extra.sdg_gal), ['0']);
    assert.deepEqual(Object.keys(msg.swipe_info[1].extra.sdg_gal), ['1']);
    assert.notEqual(msg.swipe_info[0].extra, msg.extra);
    assert.notEqual(msg.swipe_info[1].extra, msg.extra);
});

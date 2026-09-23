const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const A = 'data:image/png;base64,AAAA';
const B = 'https://example.test/generated.png?token=a&size=1024';

function fixture(t, { orphan = false, native = false, observer = true } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole().on("jsdomError", error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = fn => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    if (!observer) w.MutationObserver = undefined;
    let nativeCalls = 0;
    if (native) w.HTMLDialogElement.prototype.showModal = function () {
        nativeCalls++;
        this.setAttribute('open', '');
    };
    else w.HTMLDialogElement.prototype.showModal = undefined;
    const msg = { mes: orphan ? 'No marker' : 'Before image###a cat### after', is_user: false, extra: {} };
    const context = { chat: [msg], extensionSettings: { 'st-drawgen': {} }, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => context };
    const text = w.document.querySelector('.mes_text');
    text.textContent = msg.mes;
    w.eval(source);
    tasks.shift()(); // Initialize the real plugin without running delayed generation or observer timers.
    const debug = w.__sdgDebug;
    debug.setImage(msg, 0, A);
    debug.renderFloorImage(0);
    return {
        w, msg, debug, text,
        image: () => text.querySelector('img.sdg-img'),
        preview: () => w.document.querySelector('#sdg-image-preview'),
        click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
        key: (el, key) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
        nativeCalls: () => nativeCalls,
    };
}

test('marker image opens in native dialog and returns focus after closing', t => {
    const f = fixture(t, { native: true });
    f.click(f.image());
    assert.equal(f.nativeCalls(), 1);
    assert.equal(f.preview().querySelector('img').getAttribute('src'), A);
    assert.equal(f.preview().hasAttribute('open'), true);
    f.click(f.preview().querySelector('button'));
    assert.equal(f.preview(), null);
    assert.equal(f.w.document.activeElement, f.image());
});

test('old WebView fallback opens and Escape closes without focusing chat input', t => {
    const f = fixture(t);
    f.w.document.querySelector('textarea').focus();
    f.click(f.image());
    assert.equal(f.preview().hasAttribute('open'), true);
    f.key(f.preview().querySelector('button'), 'Escape');
    assert.equal(f.preview(), null);
    assert.equal(f.w.document.activeElement, f.image());
});

test('orphan images preview the current src, including after source updates', t => {
    const f = fixture(t, { orphan: true });
    assert.ok(f.image().classList.contains('sdg-orphan'));
    f.click(f.image());
    assert.equal(f.preview().querySelector('img').getAttribute('src'), A);
    f.click(f.preview().querySelector('button'));
    f.debug.setImage(f.msg, 0, B);
    f.debug.renderFloorImage(0);
    f.click(f.image());
    assert.equal(f.preview().querySelector('img').getAttribute('src'), B);
});

test('history paging and collapse still work; re-rendered images remain clickable', t => {
    const f = fixture(t);
    f.debug.setImage(f.msg, 0, B);
    f.debug.renderFloorImage(0);
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    assert.equal(f.preview(), null);
    f.click(f.image());
    assert.equal(f.preview().querySelector('img').getAttribute('src'), A);
    f.click(f.preview());
    f.click(f.text.querySelector('.sdg-bar'));
    assert.equal(f.text.querySelector('.sdg-imgbox').style.display, 'none');
    f.click(f.text.querySelector('.sdg-bar'));
    assert.equal(f.text.querySelector('.sdg-imgbox').style.display, '');
    f.click(f.image());
    assert.ok(f.preview());
});

test('clicking the preview image does not close it; background does', t => {
    const f = fixture(t);
    f.click(f.image());
    f.click(f.preview().querySelector('img'));
    assert.ok(f.preview());
    f.click(f.preview());
    assert.equal(f.preview(), null);
});

test('Enter/Space open preview and Tab keeps focus inside', t => {
    const f = fixture(t);
    for (const key of ['Enter', ' ']) {
        assert.equal(f.image().getAttribute('role'), 'button');
        f.key(f.image(), key);
        const button = f.preview().querySelector('button');
        f.key(button, 'Tab');
        assert.equal(f.w.document.activeElement, button);
        f.key(button, 'Escape');
    }
    f.key(f.image(), 'ArrowRight');
    assert.equal(f.preview(), null);
});

test('unrelated images, controls and touch scrolling are not intercepted', t => {
    const f = fixture(t);
    const other = f.w.document.createElement('img');
    other.src = B;
    f.text.appendChild(other);
    assert.equal(f.click(other), true);
    assert.equal(f.preview(), null);
    f.image().dispatchEvent(new f.w.Event('touchend', { bubbles: true }));
    assert.equal(f.preview(), null);
});

test('preview does not depend on MutationObserver or bubbling through the theme', t => {
    const f = fixture(t, { observer: false });
    f.w.document.addEventListener('click', e => e.stopImmediatePropagation(), true);
    f.click(f.image());
    assert.ok(f.preview());
});

test('cloned chat DOM remains clickable without another render', t => {
    const f = fixture(t);
    const clone = f.image().cloneNode(true);
    f.image().replaceWith(clone);
    f.click(clone);
    assert.equal(f.preview().querySelector('img').getAttribute('src'), A);
});

test('multiple slots preview their own image', t => {
    const f = fixture(t);
    f.msg.mes = 'image###first### image###second###';
    f.text.textContent = f.msg.mes;
    f.debug.setImage(f.msg, 1, B);
    f.debug.renderFloorImage(0);
    const images = f.text.querySelectorAll('img.sdg-img');
    assert.equal(images.length, 2);
    f.click(images[1]);
    assert.equal(f.preview().querySelector('img').getAttribute('src'), B);
});

test('failed loads show a message and repeated opens do not leak dialogs or key handlers', t => {
    const f = fixture(t);
    for (let i = 0; i < 3; i++) {
        f.click(f.image());
        const preview = f.preview();
        preview.querySelector('img').dispatchEvent(new f.w.Event('error'));
        assert.equal(preview.querySelector('.sdg-preview-error').hidden, false);
        assert.equal(preview.querySelector('img').hidden, true);
        f.key(preview.querySelector('button'), 'Escape');
        assert.equal(f.w.document.querySelectorAll('#sdg-image-preview').length, 0);
    }
    const escape = new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    assert.equal(f.w.document.dispatchEvent(escape), true);
});

test('native dialog cancel closes and cleans up', t => {
    const f = fixture(t, { native: true });
    f.click(f.image());
    f.preview().dispatchEvent(new f.w.Event('cancel', { cancelable: true }));
    assert.equal(f.preview(), null);
});



test('an orphan source update does not preview stale currentSrc while loading', t => {
    const f = fixture(t, { orphan: true });
    Object.defineProperty(f.image(), 'currentSrc', { value: A, configurable: true });
    f.debug.setImage(f.msg, 0, B);
    f.debug.renderFloorImage(0);
    f.click(f.image());
    assert.equal(f.preview().querySelector('img').getAttribute('src'), B);
});

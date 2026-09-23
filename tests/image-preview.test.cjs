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
    f.click(f.preview().querySelector('.sdg-preview-close'));
    assert.equal(f.preview(), null);
    assert.equal(f.w.document.activeElement, f.image());
});

test('old WebView fallback opens and Escape closes without focusing chat input', t => {
    const f = fixture(t);
    f.w.document.querySelector('textarea').focus();
    f.click(f.image());
    assert.equal(f.preview().hasAttribute('open'), true);
    f.key(f.preview().querySelector('.sdg-preview-close'), 'Escape');
    assert.equal(f.preview(), null);
    assert.equal(f.w.document.activeElement, f.image());
});

test('orphan images preview the current src, including after source updates', t => {
    const f = fixture(t, { orphan: true });
    assert.ok(f.image().classList.contains('sdg-orphan'));
    f.click(f.image());
    assert.equal(f.preview().querySelector('img').getAttribute('src'), A);
    f.click(f.preview().querySelector('.sdg-preview-close'));
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
        const button = f.preview().querySelector('.sdg-preview-close');
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
        f.key(preview.querySelector('.sdg-preview-close'), 'Escape');
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

function loadedPreview(f, { width = 1024, height = 1536, vw = 390, vh = 800 } = {}) {
    f.click(f.image());
    const box = f.preview();
    const image = box.querySelector('img');
    const viewport = box.querySelector('.sdg-preview-viewport');
    const size = { width: vw, height: vh };
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    Object.defineProperties(viewport, {
        clientWidth: { get: () => size.width }, clientHeight: { get: () => size.height },
        scrollWidth: { get: () => Math.max(size.width, parseFloat(image.style.width) || 0) },
        scrollHeight: { get: () => Math.max(size.height, parseFloat(image.style.height) || 0) },
    });
    image.dispatchEvent(new f.w.Event('load'));
    const pointer = (type, data = {}) => {
        const ev = new f.w.Event(type, { bubbles: true, cancelable: true });
        Object.assign(ev, { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 100, clientY: 100 }, data);
        viewport.dispatchEvent(ev);
        return ev;
    };
    return { box, image, viewport, size, pointer, mode: box.querySelector('.sdg-preview-mode'), close: box.querySelector('.sdg-preview-close') };
}

test('opens at intrinsic 100% size, centered and scrollable beyond the screen', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    assert.equal(p.box.dataset.mode, 'original');
    assert.equal(p.image.style.width, '1024px');
    assert.equal(p.image.style.height, '1536px');
    assert.equal(p.image.style.getPropertyPriority('width'), 'important');
    assert.equal(p.viewport.scrollLeft, 317);
    assert.equal(p.viewport.scrollTop, 368);
    assert.equal(p.mode.disabled, false);
    assert.equal(p.box.querySelector('.sdg-preview-size').textContent, '100% · 1024 × 1536');
});

test('fit/original toggle changes actual image dimensions without changing the source', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    f.click(p.mode);
    assert.equal(p.box.dataset.mode, 'fit');
    assert.equal(p.image.style.width, '390px');
    assert.equal(p.image.style.height, '585px');
    assert.equal(p.viewport.scrollLeft, 0);
    assert.equal(p.viewport.scrollTop, 0);
    assert.equal(p.mode.textContent, '原图 100%');
    f.click(p.mode);
    assert.equal(p.box.dataset.mode, 'original');
    assert.equal(p.image.style.width, '1024px');
    assert.equal(p.image.getAttribute('src'), A);
});

test('fit mode preserves aspect ratio in landscape and never enlarges a small source', t => {
    const f = fixture(t);
    let p = loadedPreview(f, { width: 1600, height: 800, vw: 390, vh: 800 });
    f.click(p.mode);
    assert.equal(p.image.style.width, '390px');
    assert.equal(p.image.style.height, '195px');
    f.click(p.close);
    p = loadedPreview(f, { width: 120, height: 80 });
    f.click(p.mode);
    assert.equal(p.image.style.width, '120px');
    assert.equal(p.image.style.height, '80px');
});

test('resize recalculates fit mode, preserves 100%, and unregisters on close', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.size.width = 300;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(p.image.style.width, '1024px');
    f.click(p.mode);
    assert.equal(p.image.style.width, '300px');
    p.size.width = 600;
    p.size.height = 300;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(p.image.style.width, '200px');
    assert.equal(p.image.style.height, '300px');
    f.click(p.close);
    p.size.width = 50;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(p.image.style.width, '200px');
});

test('mouse drag pans the image and its trailing click does not close the viewer', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.pointer('pointerdown');
    assert.equal(p.pointer('pointermove', { clientX: 40, clientY: 70 }).defaultPrevented, true);
    assert.equal(p.viewport.scrollLeft, 377);
    assert.equal(p.viewport.scrollTop, 398);
    p.pointer('pointerup', { clientX: 40, clientY: 70 });
    f.click(p.viewport);
    assert.ok(f.preview());
    p.pointer('pointerdown');
    p.pointer('pointerup');
    f.click(p.viewport);
    assert.equal(f.preview(), null);
});

test('a simple click does not capture the pointer; native touch scrolling is not prevented', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    let captured = 0;
    p.viewport.setPointerCapture = () => captured++;
    p.pointer('pointerdown');
    p.pointer('pointerup');
    f.click(p.image);
    assert.equal(captured, 0);
    assert.ok(f.preview());
    p.pointer('pointerdown', { pointerType: 'touch' });
    assert.equal(p.pointer('pointermove', { pointerType: 'touch', clientX: 10 }).defaultPrevented, false);
    assert.equal(p.viewport.scrollLeft, 317);
});

test('both toolbar buttons are reachable with Tab/Shift+Tab after loading', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    f.key(p.close, 'Tab');
    assert.equal(f.w.document.activeElement, p.mode);
    const shiftTab = new f.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    p.mode.dispatchEvent(shiftTab);
    assert.equal(f.w.document.activeElement, p.close);
});

test('original dimensions are available in the old WebView fallback too', t => {
    const f = fixture(t, { native: false });
    const p = loadedPreview(f);
    assert.equal(p.box.hasAttribute('open'), true);
    assert.equal(p.image.style.width, '1024px');
    f.click(p.mode);
    assert.equal(p.image.style.width, '390px');
});

test('preview locks background scrolling and removes only its own lock when closed', t => {
    const f = fixture(t);
    f.w.document.documentElement.style.overflow = 'auto';
    const p = loadedPreview(f);
    assert.equal(f.w.document.documentElement.classList.contains('sdg-preview-open'), true);
    f.click(p.close);
    assert.equal(f.w.document.documentElement.classList.contains('sdg-preview-open'), false);
    assert.equal(f.w.document.documentElement.style.overflow, 'auto');
});

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
    const pointer = (type, data = {}, target = viewport) => {
        const ev = new f.w.Event(type, { bubbles: true, cancelable: true });
        Object.assign(ev, { pointerType: 'touch', pointerId: 1, button: 0, buttons: 1, clientX: 100, clientY: 100 }, data);
        target.dispatchEvent(ev);
        return ev;
    };
    const wheel = (deltaY, data = {}) => {
        const ev = new f.w.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: size.width / 2, clientY: size.height / 2, ...data });
        viewport.dispatchEvent(ev);
        return ev;
    };
    const zoom = (factor, x = size.width / 2, y = size.height / 2) => {
        pointer('pointerdown', { pointerId: 101, clientX: x - 50, clientY: y });
        pointer('pointerdown', { pointerId: 102, clientX: x + 50, clientY: y });
        pointer('pointermove', { pointerId: 101, clientX: x - 50 * factor, clientY: y });
        const moved = pointer('pointermove', { pointerId: 102, clientX: x + 50 * factor, clientY: y });
        pointer('pointerup', { pointerId: 101 });
        pointer('pointerup', { pointerId: 102 });
        return moved;
    };
    return { box, image, viewport, size, pointer, wheel, zoom, close: box.querySelector('.sdg-preview-close') };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);
const dimensions = p => ({ width: parseFloat(p.image.style.width), height: parseFloat(p.image.style.height) });

test('opens with the full source fitted, no toolbar, and no original-size flash', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    assert.equal(p.box.dataset.mode, 'fit');
    assert.equal(p.image.style.width, '390px');
    assert.equal(p.image.style.height, '585px');
    assert.equal(p.image.style.visibility, 'visible');
    assert.equal(p.image.style.getPropertyPriority('width'), 'important');
    assert.equal(p.viewport.scrollLeft, 0);
    assert.equal(p.viewport.scrollTop, 0);
    assert.equal(p.box.querySelectorAll('button').length, 1);
    assert.equal(p.box.querySelector('.sdg-preview-toolbar'), null);
    assert.equal(p.image.getAttribute('src'), A);
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
    assert.match(css, /\.sdg-preview-image\s*\{\s*visibility:\s*hidden/);
});

test('pinch zooms in and back out proportionally, without replacing the source or closing', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    assert.equal(p.zoom(2).defaultPrevented, true);
    near(dimensions(p).width, 780);
    near(dimensions(p).height, 1170);
    assert.equal(p.box.dataset.mode, 'custom');
    near(p.viewport.scrollLeft, 195);
    near(p.viewport.scrollTop, 185);
    p.zoom(0.5);
    near(dimensions(p).width, 390);
    near(dimensions(p).height, 585);
    assert.equal(p.image.getAttribute('src'), A);
    assert.ok(f.preview());
});

test('portrait, landscape and small sources retain their original aspect ratio when shrinking', t => {
    const f = fixture(t);
    for (const [width, height] of [[1024, 1536], [1600, 800], [120, 80]]) {
        const p = loadedPreview(f, { width, height });
        assert.ok(dimensions(p).width <= 390 && dimensions(p).height <= 800);
        if (width === 120) near(dimensions(p).width, 120); // Never enlarge a small source on open.
        const before = dimensions(p);
        p.zoom(0.5);
        near(dimensions(p).width, before.width * 0.5);
        near(dimensions(p).height, before.height * 0.5);
        near(dimensions(p).width / dimensions(p).height, width / height);
        assert.equal(p.image.naturalWidth, width);
        assert.equal(p.image.naturalHeight, height);
        assert.equal(p.image.getAttribute('src'), A);
        f.click(p.close);
    }
});

test('pinch anchors zoom to the finger midpoint, not always the image center', t => {
    const f = fixture(t);
    const p = loadedPreview(f, { width: 1000, height: 1000, vw: 500, vh: 500 });
    p.zoom(2, 100, 150);
    near(dimensions(p).width, 1000);
    near(p.viewport.scrollLeft, 100);
    near(p.viewport.scrollTop, 150);
});

test('pinch zoom limits stay finite and preserve the image aspect ratio', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.zoom(10000);
    near(dimensions(p).width, 4096);
    near(dimensions(p).height, 6144);
    p.zoom(0.00001);
    near(dimensions(p).width, 102.4);
    near(dimensions(p).height, 153.6);
});

test('desktop wheel and mouse movement do not change image size or trigger custom drag', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    assert.equal(p.wheel(-100).defaultPrevented, false);
    p.pointer('pointerdown', { pointerType: 'mouse' });
    assert.equal(p.pointer('pointermove', { pointerType: 'mouse', clientX: 40 }).defaultPrevented, false);
    near(dimensions(p).width, 390);
    assert.equal(p.viewport.scrollLeft, 0);
    assert.equal(p.box.dataset.mode, 'fit');
});

test('huge images can initially fit below the usual minimum zoom', t => {
    const f = fixture(t);
    const p = loadedPreview(f, { width: 10000, height: 10000 });
    near(dimensions(p).width, 390);
    p.zoom(0.5);
    near(dimensions(p).width, 390);
    p.zoom(2);
    near(dimensions(p).width, 780);
});

test('resize refits untouched previews but preserves manually chosen scale and cleans up', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.size.width = 300;
    f.w.dispatchEvent(new f.w.Event('resize'));
    near(dimensions(p).width, 300);
    p.size.width = 600;
    p.size.height = 300;
    f.w.dispatchEvent(new f.w.Event('resize'));
    near(dimensions(p).width, 200);
    p.zoom(2);
    p.size.width = 500;
    p.size.height = 800;
    f.w.dispatchEvent(new f.w.Event('resize'));
    near(dimensions(p).width, 400);
    f.click(p.close);
    p.size.width = 50;
    f.w.dispatchEvent(new f.w.Event('resize'));
    near(dimensions(p).width, 400);
    assert.equal(p.wheel(-100).defaultPrevented, false);
});

test('single-finger drag pans zoomed images and its trailing click does not close the viewer', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.zoom(2);
    p.pointer('pointerdown');
    assert.equal(p.pointer('pointermove', { clientX: 40, clientY: 70 }).defaultPrevented, true);
    near(p.viewport.scrollLeft, 255);
    near(p.viewport.scrollTop, 215);
    p.pointer('pointerup', { clientX: 40, clientY: 70 });
    f.click(p.viewport);
    assert.ok(f.preview());
    p.pointer('pointerdown');
    p.pointer('pointerup');
    f.click(p.viewport);
    assert.equal(f.preview(), null);
});

test('a simple image click does not capture the pointer or dismiss the viewer', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    let captured = 0;
    p.viewport.setPointerCapture = () => captured++;
    p.pointer('pointerdown');
    p.pointer('pointerup');
    f.click(p.image);
    assert.equal(captured, 0);
    assert.ok(f.preview());
});

test('two fingers zoom the image in and out about their midpoint without changing its source', t => {
    const f = fixture(t);
    const p = loadedPreview(f, { width: 1000, height: 1000, vw: 500, vh: 500 });
    const touch = (type, pointerId, clientX) => p.pointer(type, { pointerType: 'touch', pointerId, clientX, clientY: 250 });
    touch('pointerdown', 1, 200);
    touch('pointerdown', 2, 300);
    touch('pointermove', 1, 150);
    assert.equal(touch('pointermove', 2, 350).defaultPrevented, true);
    near(dimensions(p).width, 1000);
    near(dimensions(p).height, 1000);
    near(p.viewport.scrollLeft, 250);
    near(p.viewport.scrollTop, 250);
    touch('pointermove', 1, 225);
    touch('pointermove', 2, 275);
    near(dimensions(p).width, 250);
    near(dimensions(p).height, 250);
    assert.equal(p.image.getAttribute('src'), A);
    touch('pointerup', 1, 225);
    touch('pointerup', 2, 275);
    f.click(p.viewport);
    assert.ok(f.preview());
});

test('lifting one finger after pinch seamlessly continues as a single-finger pan', t => {
    const f = fixture(t);
    const p = loadedPreview(f, { width: 1000, height: 1000, vw: 500, vh: 500 });
    p.pointer('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 250 });
    p.pointer('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 250 });
    p.pointer('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 400, clientY: 250 });
    const left = p.viewport.scrollLeft;
    p.pointer('pointerup', { pointerType: 'touch', pointerId: 2, clientX: 400, clientY: 250 });
    p.pointer('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 180, clientY: 250 });
    near(p.viewport.scrollLeft, left + 20);
    near(dimensions(p).width, 1000);
});

test('pointer cancellation/lost capture releases gestures; child capture transfer does not', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.zoom(2);
    p.pointer('pointerdown', { pointerType: 'touch' });
    p.pointer('lostpointercapture', {}, p.image);
    p.pointer('pointermove', { pointerType: 'touch', clientX: 80 });
    near(p.viewport.scrollLeft, 215);
    p.pointer('pointercancel', { pointerType: 'touch' });
    p.pointer('pointermove', { pointerType: 'touch', clientX: 30 });
    near(p.viewport.scrollLeft, 215);
    assert.equal(p.viewport.classList.contains('sdg-preview-dragging'), false);
    p.pointer('pointerdown');
    p.pointer('lostpointercapture');
    p.pointer('pointermove', { clientX: 20 });
    near(p.viewport.scrollLeft, 215);
});

test('single-finger drag is confined to preview and does not zoom the whole page', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.zoom(2);
    p.pointer('pointerdown', { pointerType: 'touch' });
    assert.equal(p.pointer('pointermove', { pointerType: 'touch', clientX: 80 }).defaultPrevented, true);
    near(p.viewport.scrollLeft, 215);
    assert.equal(f.w.document.body.style.transform, '');
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
    assert.match(css, /#sdg-image-preview \.sdg-preview-viewport\s*\{[^}]*touch-action:\s*none/);
});

test('keyboard focus stays on the only close control, also after zooming', t => {
    const f = fixture(t);
    const p = loadedPreview(f);
    p.zoom(2);
    f.key(p.close, 'Tab');
    assert.equal(f.w.document.activeElement, p.close);
    p.close.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.w.document.activeElement, p.close);
});

test('old WebView dialog fallback also fits initially and supports touch zoom', t => {
    const f = fixture(t, { native: false });
    const p = loadedPreview(f);
    assert.equal(p.box.hasAttribute('open'), true);
    near(dimensions(p).width, 390);
    p.zoom(2);
    near(dimensions(p).width, 780);
});

test('reopening forgets zoom and restores full-image fit; background lock is removed on close', t => {
    const f = fixture(t);
    f.w.document.documentElement.style.overflow = 'auto';
    let p = loadedPreview(f);
    p.zoom(2);
    assert.equal(f.w.document.documentElement.classList.contains('sdg-preview-open'), true);
    f.click(p.close);
    assert.equal(f.w.document.documentElement.classList.contains('sdg-preview-open'), false);
    assert.equal(f.w.document.documentElement.style.overflow, 'auto');
    p = loadedPreview(f);
    near(dimensions(p).width, 390);
    near(dimensions(p).height, 585);
    assert.equal(p.box.dataset.mode, 'fit');
});

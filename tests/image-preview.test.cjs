const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const A = 'data:image/png;base64,AAAA';
const B = 'https://example.test/generated.png?token=a&size=1024';

function fixture(t, { orphan = false, native = false, observer = true, settings = {}, viewport } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_buttons"></div></div></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole().on("jsdomError", error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    if (viewport) {
        w.innerWidth = viewport.width;
        w.innerHeight = viewport.height;
    }
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
    const context = { chat: [msg], extensionSettings: { 'st-drawgen': settings }, saveSettingsDebounced() {} };
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

test('floor renderer leaves a message alone while SillyTavern is editing it', t => {
    const f = fixture(t);
    const before = f.text.innerHTML;
    const editor = f.w.document.createElement('textarea');
    editor.className = 'edit_textarea';
    f.text.appendChild(editor);
    const editingDom = f.text.innerHTML;

    assert.equal(f.debug.renderFloorImage(0), false, '编辑期间跳过图片槽重绘');
    assert.equal(f.text.innerHTML, editingDom, '编辑器里的楼层 DOM 保持不变');
    assert.notEqual(editingDom, before, '模拟楼层已经进入编辑状态');

    editor.remove();
    assert.equal(f.debug.renderFloorImage(0), true, '编辑结束后恢复正常重绘');
});

test('re-rendering a slot keeps the same img element instead of rebuilding it', t => {
    const f = fixture(t);
    const img1 = f.image();
    f.debug.setImage(f.msg, 0, B);
    f.debug.renderFloorImage(0);
    const img2 = f.image();
    assert.equal(img2, img1, 'img element must be reused so its height never collapses');
    assert.equal(img2.getAttribute('src'), B);
    assert.equal(f.text.querySelector('.sdg-pgn').textContent, '2/2');
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    assert.equal(f.image(), img1);
    assert.equal(f.image().getAttribute('src'), A);
});

test('slot rendering uses its container width on mobile and desktop without a portrait height cap', t => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
        const f = fixture(t, { viewport });
        const img = f.image();
        for (const [width, height] of [[900, 1600], [1600, 900], [200, 200]]) {
            Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
            Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
            img.dispatchEvent(new f.w.Event('load'));
            f.debug.renderFloorImage(0);
            assert.equal(img.style.width, '100%', viewport.width + 'px viewport: 图片占满工具栏所在的槽宽');
            assert.equal(img.style.maxWidth, '100%');
            assert.equal(img.style.height, 'auto', width + '×' + height + ' 图片保留原比例');
            assert.equal(img.style.maxHeight, 'none', '竖图不再被固定视口限高缩窄');
        }
    }
});

test('image width setting controls the whole slot while the image fills that slot', t => {
    const f = fixture(t, { settings: { imageMaxWidth: 75 } });
    const widthRule = () => f.w.document.querySelector('#sdg-imgw-style').sheet.cssRules[0];
    assert.equal(widthRule().style.maxWidth, '75%', '已有用户宽度设置继续控制整个图片槽');
    const input = f.w.document.querySelector('#sdg-imgw');
    input.value = '50';
    input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(widthRule().style.maxWidth, '50%', '修改宽度设置会同步更新槽宽');
    assert.equal(widthRule().style.getPropertyPriority('max-width'), 'important');
    assert.equal(f.image().style.width, '100%', '图片宽度相对槽计算，不再单独缩窄');
    assert.equal(f.image().style.maxHeight, 'none');
});

test('resize updates orphan height caps without capping slot images or shrinking on keyboard open', t => {
    const f = fixture(t, { orphan: true, viewport: { width: 390, height: 844 } });
    const orphan = f.image();
    const initialCap = orphan.style.maxHeight;
    f.msg.mes = 'image###portrait###';
    f.text.textContent = f.msg.mes;
    f.debug.renderFloorImage(0);
    const slotImage = f.image();
    f.text.appendChild(orphan); // Keep both display types in the chat for the same resize event.
    f.w.innerHeight = 1200;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(orphan.style.maxHeight, '840px', '无工具栏图片保留随视口增大的限高');
    assert.notEqual(orphan.style.maxHeight, initialCap);
    assert.equal(slotImage.style.maxHeight, 'none', '转屏不能给槽内图加回限高');
    f.w.innerHeight = 400;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(orphan.style.maxHeight, '840px', '键盘缩小视口不会把旧图一起缩小');
    assert.equal(slotImage.style.width, '100%');
    assert.equal(slotImage.style.maxHeight, 'none');
});

test('paging between portrait and landscape keeps the image node and clears the loading height reserve', t => {
    const f = fixture(t);
    const img = f.image();
    Object.defineProperty(img, 'offsetHeight', { configurable: true, value: 640 });
    f.debug.setImage(f.msg, 0, B);
    f.debug.renderFloorImage(0);
    assert.equal(f.image(), img, '换图期间复用 img，避免高度先塌陷');
    assert.equal(img.style.minHeight, '640px', '新图加载前暂留原显示高度');
    img.dispatchEvent(new f.w.Event('load'));
    assert.equal(img.style.minHeight, '', '新图加载后移除临时高度，允许不同宽高比');
    f.click(f.text.querySelector('.sdg-pg[data-d="-1"]'));
    assert.equal(f.image(), img);
    assert.equal(img.getAttribute('src'), A);
    img.dispatchEvent(new f.w.Event('error'));
    assert.equal(img.style.minHeight, '', '失败时也不能留下上一张图的固定高度');
    assert.equal(img.style.width, '100%');
    assert.equal(img.style.maxHeight, 'none');
});

test('renderFloorImage retries shortly when the floor DOM does not exist yet', t => {
    const f = fixture(t);
    const scheduled = [];
    f.w.setTimeout = fn => (scheduled.push(fn), scheduled.length);
    f.w.document.querySelector('#chat .mes').remove();
    assert.equal(f.debug.renderFloorImage(0, { domRetry: 2 }), false);
    assert.equal(scheduled.length, 1, 'a retry must be scheduled');
    f.w.document.getElementById('chat').insertAdjacentHTML('beforeend',
        '<div class="mes" mesid="0"><div class="mes_text"></div></div>');
    f.w.document.querySelector('#chat .mes_text').textContent = f.msg.mes;
    scheduled.shift()();
    const img = f.w.document.querySelector('#chat .mes_text img.sdg-img');
    assert.ok(img, 'retry renders the slot once the floor exists');
    assert.equal(img.getAttribute('src'), A);
});

test('slots come back after their marker text nodes were lost from the DOM', t => {
    const f = fixture(t);
    f.w.document.querySelector('.sdg-slot').remove();
    f.debug.renderFloorImage(0);
    assert.ok(f.text.querySelector('.sdg-slot'), 'slot is re-created from msg.mes');
    assert.ok(f.image());
    assert.equal(f.image().getAttribute('src'), A);
});

test('mid-reroll floors do not get stale markers appended back', t => {
    const f = fixture(t);
    /* re-roll 进行中：swipe_id 已前移到空洞、msg.mes 还是带标记的旧回复、DOM 已是新回复文本 */
    f.msg.mes = 'old reply image###stale### end';
    f.msg.swipes = ['old reply image###stale### end'];
    f.msg.swipe_id = 1;
    f.text.textContent = 'new partial reply';
    f.w.document.querySelector('.mes').setAttribute('data-sdg-swipe', '0');
    f.debug.renderFloorImage(0);
    assert.equal(f.text.querySelector('.sdg-slot'), null, '不得把旧标记补回正在重roll的楼层');
    assert.ok(f.text.textContent.includes('new partial reply'), '新回复文本原样保留');
});

test('model-imitated markers are stripped for the normal pipeline when auto-extract is on', t => {
    const f = fixture(t);
    assert.equal(f.debug.stripImageTag('…\n\nimage###…###').trim(), '…',
        'image### 样式的模仿标记要能剥干净');
    assert.equal(f.debug.stripImageTag('text <draw>foo</draw> tail').includes('<draw>'), false,
        '<draw> 样式的模仿标记要能剥干净');
    const onMsg = source.slice(source.indexOf('function onMsgReceived'),
                               source.indexOf('function runPendingAutoExtract'));
    assert.ok(onMsg.includes('cfg().autoExtract ? stripImageTag(msg.mes)'),
        '自动提取开着时先剥模型自带的标记');
    assert.ok(onMsg.indexOf('剥掉模型自己写的生图标记') < onMsg.indexOf('pendingAutoIdx = i'),
        '剥完落回正常自动提取流程');
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

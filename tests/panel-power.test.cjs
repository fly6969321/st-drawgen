/*
 * 顶栏开关回归（v1.8.21）
 *  · 顶栏右侧：🌙 日夜图标 · 🎨 悬浮球图标按钮（点一下开/关，关了变暗）· 插件圆形滑块 · ✕ 关闭
 *  · 点击切换、立即落盘；与面板里的勾选框（#sdg-enabled / #sdg-show-ball）互相同步
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function fixture(t, settings) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = fn => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    const context = { chat: [], extensionSettings: { 'st-drawgen': settings || {} }, saveSettingsDebounced() {}, saveChat() {} };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    tasks.shift()();   /* waitAndInit 排的任务 = init，面板在这里创建 */
    return { w, settings: context.extensionSettings['st-drawgen'] };
}

test('顶栏插件开关（圆形滑块）：默认在开位，点一下变关并落盘，再点回来', t => {
    const f = fixture(t, { enabled: true });
    const btn = f.w.document.querySelector('#sdg-power');
    assert.ok(btn, '顶栏有插件开关（圆形滑块）');
    assert.equal(btn.classList.contains('sdg-topswitch'), true, '是圆形滑块样式');
    assert.equal(btn.checked, true, '开着时滑块在开位');
    btn.click();
    assert.equal(f.settings.enabled, false, '点击后落盘为关');
    assert.equal(btn.checked, false);
    btn.click();
    assert.equal(f.settings.enabled, true, '再点一下开回来');
    assert.equal(btn.checked, true);
});

test('顶栏悬浮球按钮（🎨）：点一下隐藏并变暗，再点恢复', t => {
    const f = fixture(t, { showBall: true });
    const d = f.w.document;
    const ball = d.querySelector('#sdg-ball');
    const btn = d.querySelector('#sdg-ball-toggle');
    assert.ok(ball, '悬浮球已创建');
    assert.ok(btn, '顶栏有悬浮球按钮');
    assert.equal(btn.textContent, '🎨');
    assert.ok(!btn.classList.contains('sdg-ball-off'), '开着时图标正常');
    assert.notEqual(ball.style.display, 'none');

    btn.click();
    assert.equal(f.settings.showBall, false, '落盘');
    assert.equal(ball.style.display, 'none', '悬浮球隐藏');
    assert.ok(btn.classList.contains('sdg-ball-off'), '图标变暗');
    assert.match(btn.title, /已隐藏/);

    btn.click();
    assert.equal(f.settings.showBall, true);
    assert.notEqual(ball.style.display, 'none', '悬浮球恢复显示');
    assert.ok(!btn.classList.contains('sdg-ball-off'), '图标恢复');
});

test('顶栏开关与面板勾选框双向同步（两处都保留）', t => {
    const f = fixture(t, { enabled: true, showBall: true });
    const d = f.w.document;
    const tp = d.querySelector('#sdg-power');
    const te = d.querySelector('#sdg-enabled');
    const tb = d.querySelector('#sdg-ball-toggle');
    const ts = d.querySelector('#sdg-show-ball');
    assert.ok(te && ts, '面板里的勾选框保留');

    tp.click();
    assert.equal(te.checked, false, '顶栏关掉插件，面板勾选框跟着取消');
    te.click();
    assert.equal(tp.checked, true, '面板勾上插件，顶栏滑块跟着点亮');

    tb.click();
    assert.equal(ts.checked, false, '顶栏隐藏悬浮球，面板勾选框跟着取消');
    assert.ok(tb.classList.contains('sdg-ball-off'));
    ts.click();
    assert.ok(!tb.classList.contains('sdg-ball-off'), '面板勾回来，顶栏按钮跟着恢复');
});

test('重新加载后顶栏反映已保存的状态', t => {
    const f = fixture(t, { enabled: false, showBall: false });
    const d = f.w.document;
    assert.equal(d.querySelector('#sdg-power').checked, false, '插件关闭时滑块在关位');
    assert.ok(d.querySelector('#sdg-ball-toggle').classList.contains('sdg-ball-off'), '悬浮球隐藏时图标变暗');
});

test('点悬浮球：抬手时面板还不动，等这次点按的 click 到了才开 / 关', t => {
    const f = fixture(t, { showBall: true });
    const w = f.w, d = w.document, ball = d.querySelector('#sdg-ball'), panel = d.querySelector('#sdg-panel');
    const fire = type => ball.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
    const shown = () => panel.classList.contains('show');
    fire('pointerdown'); fire('pointerup');
    assert.equal(shown(), false, '抬手这一刻不开面板：之后补发的 mousedown / mouseup / click 落不到面板里');
    fire('click');
    assert.equal(shown(), true, 'click 到了才开');
    fire('pointerdown'); fire('pointerup');
    assert.equal(shown(), true, '关也一样等 click');
    fire('click');
    assert.equal(shown(), false);
    fire('click');
    assert.equal(shown(), false, '没有对应的按下 / 抬起，单独一个 click 不算数');
});

test('点悬浮球：拖动不开面板；收不到 click 的环境里等一小会儿自己开，且只开一次', t => {
    const f = fixture(t, { showBall: true });
    const w = f.w, d = w.document, ball = d.querySelector('#sdg-ball'), panel = d.querySelector('#sdg-panel');
    const timers = [];
    w.setTimeout = fn => (timers.push(fn), timers.length);
    const at = (type, x, y) => { const ev = new w.Event(type, { bubbles: true, cancelable: true }); ev.clientX = x; ev.clientY = y; ball.dispatchEvent(ev); };
    const shown = () => panel.classList.contains('show');
    at('pointerdown', 10, 10); at('pointermove', 60, 80); at('pointerup', 60, 80); at('click', 60, 80);
    assert.equal(shown(), false, '拖动球只挪位置');
    assert.equal(timers.length, 0);
    assert.ok(f.settings.ballLeft && f.settings.ballTop, '拖到的位置存下来');
    at('pointerdown', 60, 80); at('pointerup', 60, 80);
    assert.equal(shown(), false);
    assert.equal(timers.length, 1, '排了一个兜底');
    timers[0]();
    assert.equal(shown(), true, '一直没等到 click 就自己开');
    at('click', 60, 80);
    assert.equal(shown(), true, '迟到的 click 不会再把面板关掉');
    at('pointerdown', 60, 80); at('pointerup', 60, 80); at('click', 60, 80);
    assert.equal(shown(), false);
    timers[1]();
    assert.equal(shown(), false, 'click 已经处理过，兜底不再重复开关');
});

test('「失败后自动重试一次」「走酒馆后端代理」在生图页最底部', t => {
    const f = fixture(t, {});
    const labels = Array.from(f.w.document.querySelectorAll('#sdg-pane-gen > label.sdg-chk')).map(l => l.querySelector('input').id);
    assert.deepEqual(labels.slice(-2), ['sdg-gen-retry', 'sdg-gen-proxy']);
    assert.equal(f.w.document.querySelector('#sdg-pane-gen').lastElementChild.querySelector('input').id, 'sdg-gen-proxy');
});

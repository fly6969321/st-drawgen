/*
 * 顶栏插件开关回归（v1.8.20）
 *  · 「启用生图工坊」从面板里挪到顶栏右侧（🌙 和 ✕ 之间），按钮上显示当前状态（开 / 关）
 *  · 点击切换并立即落盘；重新加载面板时按钮反映已存状态
 *  · 面板里旧的多选框 #sdg-enabled 不再存在
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

test('顶栏插件开关：默认显示「开」，点一下变「关」并落盘，再点回来', t => {
    const f = fixture(t, { enabled: true });
    const btn = f.w.document.querySelector('#sdg-power');
    assert.ok(btn, '顶栏有插件开关按钮');
    assert.equal(btn.textContent, '开');
    assert.ok(!btn.classList.contains('sdg-off'));

    btn.click();
    assert.equal(f.settings.enabled, false, '点击后落盘为关');
    assert.equal(btn.textContent, '关');
    assert.ok(btn.classList.contains('sdg-off'), '关闭状态有灰显样式');

    btn.click();
    assert.equal(f.settings.enabled, true, '再点一下开回来');
    assert.equal(btn.textContent, '开');
    assert.ok(!btn.classList.contains('sdg-off'));
});

test('重新加载后按钮反映已保存的关闭状态', t => {
    const f = fixture(t, { enabled: false });
    const btn = f.w.document.querySelector('#sdg-power');
    assert.equal(btn.textContent, '关');
    assert.ok(btn.classList.contains('sdg-off'));
});

test('面板里旧的多选框已移除（开关只留在顶栏）', t => {
    const f = fixture(t, {});
    assert.equal(f.w.document.querySelector('#sdg-enabled'), null);
});

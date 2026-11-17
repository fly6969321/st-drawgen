const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function fixture(t) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = [];
    w.setTimeout = fn => (timers.push(fn), timers.length);
    w.clearTimeout = () => {};
    const settings = { sdgBuiltinSeeded17: true, autoExtract: false, autoGenerate: false };
    const context = { chat: [], extensionSettings: { 'st-drawgen': settings }, saveSettings() {}, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    timers.shift()();
    return { w, settings, debug: w.__sdgDebug };
}

const sections = {
    'sdg-fold-work': ['提取结果', ['#sdg-preview', '#sdg-btn-extract', '#sdg-layers']],
    'sdg-fold-style': ['画风与公共块', ['#sdg-style', '#sdg-gen-fixed', '#sdg-style-common', '#sdg-common-text']],
    'sdg-fold-api': ['副 AI 接口', ['#sdg-ext-api', '#sdg-ext-endpoint']],
    'sdg-fold-system': ['系统提示', ['#sdg-sys-select', '#sdg-sys-value', '#sdg-sys-save']],
    'sdg-fold-rules': ['提取规则', ['#sdg-rules-p', '#sdg-rules']],
    'sdg-fold-anchors': ['角色锚点与公共规则', ['#sdg-anch-p', '#sdg-anchors', '#sdg-anchor-guide']],
    'sdg-fold-request': ['注入模板与请求设置', ['#sdg-template', '#sdg-ext-proxy', '#sdg-retry', '#sdg-timeout']],
};

test('提取页七个功能分区完整且默认只展开提取结果', t => {
    const f = fixture(t), d = f.w.document;
    const folds = Array.from(d.querySelectorAll('#sdg-pane-ext > details.sdg-fold'));
    assert.equal(folds.length, 7);
    assert.deepEqual(folds.map(x => x.id), Object.keys(sections));
    for (const [id, [title, selectors]] of Object.entries(sections)) {
        const fold = d.getElementById(id);
        assert.ok(fold, id + ' 存在');
        assert.equal(fold.querySelector(':scope > summary').textContent, title);
        assert.ok(fold.querySelector(':scope > .sdg-fold-body'), id + ' 有独立内容区');
        assert.equal(fold.open, id === 'sdg-fold-work', id + ' 默认展开状态');
        for (const selector of selectors) {
            const control = d.querySelector(selector);
            assert.ok(control, selector + ' 保留');
            assert.ok(fold.contains(control), selector + ' 位于 ' + id);
        }
    }
    assert.equal(d.querySelectorAll('#sdg-pane-gen > details.sdg-fold').length, 0, '生图页未被改动');
});

test('各分区可独立展开收起，折叠后原有编辑与按钮事件仍生效', t => {
    const f = fixture(t), d = f.w.document;
    const style = d.getElementById('sdg-fold-style');
    const summary = style.querySelector(':scope > summary');
    summary.click();
    assert.equal(style.open, true);
    assert.equal(d.getElementById('sdg-fold-rules').open, false, '不影响其它分区');
    assert.equal(d.getElementById('sdg-fold-work').open, true, '工作区保持原状态');
    summary.click();
    assert.equal(style.open, false);

    const rules = d.querySelector('#sdg-rules');
    rules.value = '只写可见画面';
    rules.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(f.settings.extRules, '只写可见画面', '收起的规则框仍已绑定保存事件');

    d.querySelector('#sdg-common-add').click();
    assert.equal(f.debug.getCommonBlocks().length, 1, '收起的公共块按钮仍可用');

    const anchors = d.getElementById('sdg-fold-anchors');
    anchors.open = true;
    const guide = d.querySelector('#sdg-anchors ~ .sdg-anchor-guide') || d.querySelector('#sdg-fold-anchors .sdg-anchor-guide');
    guide.querySelector('summary').click();
    assert.equal(guide.open, true, '公共规则仍可单独展开');
    assert.equal(anchors.open, true, '嵌套展开不关闭父分区');
});

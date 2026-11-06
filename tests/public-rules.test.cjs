const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = [], requests = [], confirmations = [], downloads = [];
    let saves = 0;
    w.setTimeout = fn => (timers.push(fn), timers.length);
    w.clearTimeout = () => {};
    w.confirm = message => (confirmations.push(message), true);
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, extEndpoint: 'https://extract.test/v1', extModel: 'test-extract',
        extKey: 'PRIVATE_EXTRACT_KEY', genKey: 'PRIVATE_IMAGE_KEY', extAnchors: 'PRIVATE_CHARACTER_ANCHOR',
        autoExtract: false, autoGenerate: false, requestTimeout: 0,
    }, overrides);
    const context = {
        chat: [], extensionSettings: { 'st-drawgen': settings },
        saveSettings() { saves++; }, saveSettingsDebounced() { saves++; },
    };
    w.SillyTavern = { getContext: () => context };
    w.fetch = async (url, options) => {
        assert.equal(String(url), 'https://extract.test/v1/chat/completions', '仅调用模拟的提取接口');
        requests.push(JSON.parse(options.body));
        return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'a person in a room' } }] }) };
    };
    w.URL.createObjectURL = blob => (downloads.push(blob), 'blob:public-rules-test');
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () {};
    w.eval(source);
    timers.shift()();
    return {
        w, settings, debug: w.__sdgDebug, requests, confirmations, downloads,
        saveCount: () => saves,
        input(text) {
            const editor = w.document.querySelector('#sdg-anchor-guide');
            assert.ok(editor, '公共规则编辑框存在');
            editor.value = text;
            editor.dispatchEvent(new w.Event('input', { bubbles: true }));
        },
        async requestText() {
            await w.__sdgDebug.callSubAI('角色走进房间', '', null);
            return requests.at(-1).messages.find(message => message.role === 'user').content;
        },
    };
}

test('公共规则普通编辑立即保存，重载保留，恢复默认后实际提取使用默认规则', async t => {
    const f = fixture(t);
    const defaultGuide = f.debug.getAnchorUsageGuide();
    assert.ok(defaultGuide.trim());
    assert.equal(f.w.document.querySelector('#sdg-anchor-guide').value, defaultGuide);
    for (const id of ['sdg-anchor-guide-reset', 'sdg-anchor-guide-import', 'sdg-anchor-guide-export']) {
        assert.ok(f.w.document.getElementById(id), id + ' 可用');
    }

    const custom = '只画当前场景的人物。\n不同房间的人不能强行同框。';
    const beforeSaves = f.saveCount();
    f.input(custom);
    assert.equal(f.settings.anchorUsageGuide, custom);
    assert.ok(f.saveCount() > beforeSaves, '编辑触发设置保存');
    const prompt = await f.requestText();
    assert.equal(prompt.split(custom).length - 1, 1, '自定义规则只发送一次');
    assert.ok(!prompt.includes(defaultGuide), '不重复附带内置默认规则');

    const reloaded = fixture(t, clone(f.settings));
    assert.equal(reloaded.w.document.querySelector('#sdg-anchor-guide').value, custom);
    reloaded.w.document.querySelector('#sdg-anchor-guide-reset').click();
    assert.equal(reloaded.debug.getAnchorUsageGuide(), defaultGuide);
    assert.equal(reloaded.w.document.querySelector('#sdg-anchor-guide').value, defaultGuide);
    assert.ok((await reloaded.requestText()).includes(defaultGuide));
});

test('放大编辑保存同步公共规则，取消不覆盖已保存内容', async t => {
    const f = fixture(t, { anchorUsageGuide: '原公共规则' });
    const grip = f.w.document.querySelector('.sdg-grip[data-target="sdg-anchor-guide"]');
    assert.ok(grip, '公共规则支持放大编辑');
    grip.click();
    const editor = f.w.document.querySelector('#sdg-editor .sdg-editor-ta');
    assert.equal(editor.value, '原公共规则');
    editor.value = '放大后修改的公共规则';
    f.w.document.querySelector('#sdg-editor .sdg-editor-save').click();
    assert.equal(f.settings.anchorUsageGuide, editor.value);
    assert.equal(f.w.document.querySelector('#sdg-anchor-guide').value, editor.value);
    assert.ok((await f.requestText()).includes(editor.value));
    grip.click();
    editor.value = '这段取消';
    f.w.document.querySelector('#sdg-editor .sdg-editor-cancel').click();
    assert.equal(f.debug.getAnchorUsageGuide(), '放大后修改的公共规则');
});

test('公共规则开关和无角色锚点时的请求门控保留，空白规则回退默认', async t => {
    const f = fixture(t, { anchorUsageGuide: '自定义规则门控', anchorGuideOn: false });
    const toggle = f.w.document.querySelector('#sdg-anchor-guide-on');
    assert.equal(toggle.checked, false);
    let prompt = await f.requestText();
    assert.ok(!prompt.includes('自定义规则门控'));
    assert.ok(prompt.includes('PRIVATE_CHARACTER_ANCHOR'), '停用公共规则不删除角色资料');
    toggle.click();
    assert.equal(f.settings.anchorGuideOn, true);
    assert.ok((await f.requestText()).includes('自定义规则门控'));
    f.settings.extAnchors = '';
    assert.ok(!(await f.requestText()).includes('自定义规则门控'), '没有角色锚点时不发送公共规则');
    f.input(' \n\t ');
    const clean = fixture(t);
    assert.equal(f.debug.getAnchorUsageGuide(), clean.debug.getAnchorUsageGuide());
});

test('公共规则跨角色锚点预设共用，文本中的标签重载后保持原样', t => {
    const custom = '规则 <人物> & </textarea><span id="unexpected-rule-node">不要创建节点</span>';
    const f = fixture(t, {
        anchorUsageGuide: custom,
        anchorsJson: JSON.stringify([{ id: 'a1', name: '角色一', text: '银发' }, { id: 'a2', name: '角色二', text: '黑发' }]),
        anchorsId: 'a1',
    });
    assert.equal(f.w.document.querySelector('#sdg-anchor-guide').value, custom);
    assert.equal(f.w.document.querySelector('#unexpected-rule-node'), null, '规则内容按纯文本显示');
    const select = f.w.document.querySelector('#sdg-anch-p');
    select.value = 'a2';
    select.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(f.settings.extAnchors, '黑发');
    assert.equal(f.debug.getAnchorUsageGuide(), custom);
    assert.equal(f.w.document.querySelector('#sdg-anchor-guide').value, custom);
});

test('独立公共规则导出按钮生成可再次导入的文件，并更新实际请求', async t => {
    const from = fixture(t, { anchorUsageGuide: '独立文件中的公共规则' });
    from.w.document.querySelector('#sdg-anchor-guide-export').click();
    assert.equal(from.downloads.length, 1);
    const raw = await new Promise((resolve, reject) => {
        const reader = new from.w.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(from.downloads[0]);
    });
    const pack = JSON.parse(raw);
    assert.equal(pack._fmt, 'drawgen-anchor-guide');
    assert.equal(pack.anchorGuide, from.debug.getAnchorUsageGuide());
    assert.ok(pack.version);
    const to = fixture(t, { anchorUsageGuide: '导入前的规则' });
    to.debug.packImportText(raw);
    assert.equal(to.confirmations.length, 1, '仅规则变化也需确认');
    assert.match(to.confirmations[0], /公共规则/);
    assert.equal(to.debug.getAnchorUsageGuide(), pack.anchorGuide);
    assert.equal(to.w.document.querySelector('#sdg-anchor-guide').value, pack.anchorGuide);
    assert.ok((await to.requestText()).includes(pack.anchorGuide));
});

test('画风包包含公共规则，画风完全相同时仍能导入不同规则，且不导出私有资料', t => {
    const styles = [{ id: 's1', name: '日常', fixed: 'soft light', postfix: '' }];
    const common = { stylesJson: JSON.stringify(styles), styleId: 's1' };
    const from = fixture(t, { ...common, anchorUsageGuide: '跟随画风文件的公共规则' });
    const pack = from.debug.stylePackBuild();
    assert.equal(pack._fmt, 'drawgen-style-pack');
    assert.equal(pack.anchorGuide, from.debug.getAnchorUsageGuide());
    for (const exported of [pack, from.debug.anchorGuidePackBuild()]) {
        const raw = JSON.stringify(exported);
        assert.doesNotMatch(raw, /PRIVATE_EXTRACT_KEY|PRIVATE_IMAGE_KEY|PRIVATE_CHARACTER_ANCHOR|https:\/\/extract\.test/);
    }
    const to = fixture(t, { ...common, anchorUsageGuide: '原公共规则' });
    to.debug.packImportText(JSON.stringify(pack));
    assert.equal(to.confirmations.length, 1);
    assert.equal(to.debug.getAnchorUsageGuide(), pack.anchorGuide);
    assert.deepEqual(clone(to.debug.getPresets('style')), styles, '相同画风不重复创建');
});

test('默认公共规则也能导出并恢复到另一份自定义设置', t => {
    const from = fixture(t);
    const defaultGuide = from.debug.getAnchorUsageGuide();
    for (const pack of [from.debug.anchorGuidePackBuild(), from.debug.stylePackBuild()]) {
        assert.equal(pack.anchorGuide, defaultGuide, '导出实际生效规则');
        const to = fixture(t, { anchorUsageGuide: '待替换自定义规则' });
        to.debug.packImportText(JSON.stringify(pack));
        assert.equal(to.debug.getAnchorUsageGuide(), defaultGuide);
    }
});

test('旧预设包非空公共规则可以导入，缺失、null、空白规则不覆盖本地', t => {
    const f = fixture(t, { anchorUsageGuide: '本地规则' });
    f.debug.packImportText(JSON.stringify({ _fmt: 'ipe-image-pack', templates: [], anchorGuide: '旧格式公共规则' }));
    assert.equal(f.debug.getAnchorUsageGuide(), '旧格式公共规则');
    for (const format of ['ipe-image-pack', 'drawgen-style-pack']) {
        for (const guide of [undefined, null, '', ' \n ']) {
            const pack = format === 'ipe-image-pack' ? { _fmt: format, templates: [] } : { _fmt: format, styles: [] };
            if (guide !== undefined) pack.anchorGuide = guide;
            f.debug.packImportText(JSON.stringify(pack));
            assert.equal(f.debug.getAnchorUsageGuide(), '旧格式公共规则');
        }
    }
});

test('取消组合导入时公共规则和所有预设均不更改', t => {
    const f = fixture(t, { anchorUsageGuide: '取消前规则' });
    const before = JSON.stringify(f.settings);
    let confirmation = '';
    f.w.confirm = message => { confirmation = message; return false; };
    f.debug.packImportText(JSON.stringify({
        _fmt: 'ipe-image-pack', anchorGuide: '取消的规则',
        templates: [{ name: '取消的画风', value: 'cinematic' }],
        rules: [{ name: '取消的提取规则', text: 'visible only' }],
        systemPrompts: [{ name: '取消的系统', value: 'Describe the scene' }],
    }));
    assert.match(confirmation, /公共规则/);
    assert.equal(JSON.stringify(f.settings), before);
    assert.equal(f.w.document.querySelector('#sdg-anchor-guide').value, '取消前规则');
});

test('错误类型的公共规则在导入前报错，避免写入对象或部分导入画风', t => {
    const f = fixture(t, { anchorUsageGuide: '有效规则' });
    const before = JSON.stringify(f.settings);
    for (const anchorGuide of [{ text: '对象' }, ['数组'], 12, false]) {
        assert.throws(() => f.debug.packImportText(JSON.stringify({
            _fmt: 'drawgen-style-pack', anchorGuide,
            styles: [{ name: '不能部分导入', fixed: 'prefix', postfix: 'suffix' }],
        })), /公共规则|anchorGuide/);
        assert.equal(JSON.stringify(f.settings), before);
    }
});

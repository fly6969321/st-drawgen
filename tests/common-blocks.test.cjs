const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function fixture(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = [], confirmations = [];
    w.setTimeout = fn => (timers.push(fn), timers.length);
    w.clearTimeout = () => {};
    w.confirm = message => (confirmations.push(message), true);
    const settings = Object.assign({ sdgBuiltinSeeded17: true, autoExtract: false, autoGenerate: false }, overrides);
    const context = { chat: [], extensionSettings: { 'st-drawgen': settings }, saveSettings() {}, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => context };
    w.fetch = async () => { throw new Error('公共块测试不应发起网络请求'); };
    w.eval(source);
    timers.shift()();
    return { w, settings, debug: w.__sdgDebug, confirmations };
}

function styleSettings({ fixed = 'soft light', postfix = 'masterpiece', common = '', blocks = null } = {}) {
    const style = { id: 's1', name: '画风一', fixed, postfix };
    if (common) style.common = common;
    return {
        stylesJson: JSON.stringify([style]), styleId: 's1', genFixedPrompt: fixed, genPostfixPrompt: postfix,
        commonBlocksJson: JSON.stringify(blocks || []), activeCommonBlock: blocks && blocks[0] ? blocks[0].id : '',
    };
}

function select(w, id, value) {
    const el = w.document.getElementById(id);
    assert.ok(el, id + ' 存在');
    el.value = value;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
}

test('未挂公共块时保留原画风前后缀与六层组装结果', t => {
    const cfg = styleSettings({ fixed: 'Composition: {Camera} | Setting: {Env}', postfix: 'masterpiece, best quality' });
    const f = fixture(t, cfg);
    const layers = { camera: 'close-up', env: 'rainy alley', mood: '', chars: '', outfit: '', pose: '' };
    const legacy = [f.debug.styleSegment(cfg.genFixedPrompt, layers), 'joined scene', f.debug.styleSegment(cfg.genPostfixPrompt, layers)].filter(Boolean).join(', ');
    assert.equal(f.debug.buildFinalPrompt('joined scene', layers), legacy);
    assert.equal(legacy, 'Composition: close-up | Setting: rainy alley, joined scene, masterpiece, best quality');
});

test('未写占位符时公共块固定接在描述和画风后缀之后', t => {
    const f = fixture(t, styleSettings({ common: 'c1', blocks: [{ id: 'c1', name: '通用', value: 'COMMON RULES.\nClosing line.' }] }));
    assert.equal(f.debug.buildFinalPrompt('scene', null), 'soft light, scene, masterpiece, COMMON RULES.\nClosing line.');
});

test('前后缀都可用 {Common} 显式定位且不会再次自动追加', t => {
    const postfix = fixture(t, styleSettings({ postfix: 'masterpiece\n{Common}\nClosing after', common: 'c1', blocks: [{ id: 'c1', name: '通用', value: 'COMMON\nLINE' }] }));
    assert.equal(postfix.debug.buildFinalPrompt('scene', null), 'soft light, scene, masterpiece\nCOMMON\nLINE\nClosing after');
    const fixed = fixture(t, styleSettings({ fixed: '{Common}\nsoft light', common: 'c1', blocks: [{ id: 'c1', name: '通用', value: 'COMMON' }] }));
    assert.equal(fixed.debug.buildFinalPrompt('scene', null), 'COMMON\nsoft light, scene, masterpiece');
});

test('不挂公共块或块为空时清掉 {Common}，不泄漏字面占位符', t => {
    for (const blocks of [[], [{ id: 'c1', name: '空块', value: '  ' }]]) {
        const f = fixture(t, styleSettings({ fixed: 'soft light\n{Common}', postfix: '{Common}\nmasterpiece', common: blocks.length ? 'c1' : '', blocks }));
        assert.equal(f.debug.buildFinalPrompt('scene', null), 'soft light, scene, masterpiece');
    }
});

test('模板已含相同公共文本时按空白归一化防重复', t => {
    const f = fixture(t, styleSettings({
        postfix: 'masterpiece\nCOMMON   RULES.  Closing line.\n{Common}', common: 'c1',
        blocks: [{ id: 'c1', name: '通用', value: 'COMMON RULES.\nClosing line.' }],
    }));
    const prompt = f.debug.buildFinalPrompt('scene', null);
    assert.equal(prompt.split('COMMON').length - 1, 1);
    assert.ok(!prompt.includes('{Common}'));
});

test('画风切换使用各自公共块，删除后所有画风自动脱钩', t => {
    const styles = [
        { id: 's1', name: '画风一', fixed: 'one', postfix: '', common: 'c1' },
        { id: 's2', name: '画风二', fixed: 'two', postfix: '', common: 'c2' },
    ];
    const f = fixture(t, {
        stylesJson: JSON.stringify(styles), styleId: 's1', genFixedPrompt: 'one', genPostfixPrompt: '',
        commonBlocksJson: JSON.stringify([{ id: 'c1', name: '通用', value: 'COMMON ONE' }, { id: 'c2', name: '古风', value: 'COMMON TWO' }]),
        activeCommonBlock: 'c1',
    });
    assert.equal(f.w.document.querySelector('#sdg-style-common').value, 'c1');
    assert.equal(f.debug.buildFinalPrompt('scene', null), 'one, scene, COMMON ONE');
    select(f.w, 'sdg-style', 's2');
    assert.equal(f.debug.buildFinalPrompt('scene', null), 'two, scene, COMMON TWO');
    select(f.w, 'sdg-style-common', 'c1');
    assert.equal(f.debug.getPresets('style').find(x => x.id === 's2').common, 'c1');
    f.debug.deleteCommonBlock('c1');
    assert.equal(f.debug.getPresets('style').map(x => x.common).join('|'), '|');
    assert.equal(f.debug.buildFinalPrompt('scene', null), 'two, scene');
});

test('公共块编辑实时写入设置，新块可立即挂到当前画风', t => {
    const f = fixture(t, styleSettings());
    f.w.document.querySelector('#sdg-common-add').click();
    const block = f.debug.getCommonBlocks()[0];
    assert.ok(block);
    const editor = f.w.document.querySelector('#sdg-common-text');
    editor.value = 'FIXED COMMON';
    editor.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    select(f.w, 'sdg-style-common', block.id);
    assert.equal(f.debug.buildFinalPrompt('scene', null), 'soft light, scene, masterpiece, FIXED COMMON');
});

test('画风包携带公共块并在导入后重映射本地 ID', t => {
    const from = fixture(t, styleSettings({ common: 'c1', blocks: [{ id: 'c1', name: '通用', value: 'PACK COMMON' }] }));
    const pack = from.debug.stylePackBuild();
    assert.equal(pack.commons.length, 1);
    assert.equal(pack.styles[0].commonName, '通用');
    const to = fixture(t);
    to.debug.packImportText(JSON.stringify(pack));
    assert.equal(to.confirmations.length, 1);
    const imported = to.debug.getPresets('style').find(x => x.name === '画风一');
    const common = to.debug.getCommonBlocks().find(x => x.name === '通用');
    assert.ok(imported && common);
    assert.equal(imported.common, common.id);
    select(to.w, 'sdg-style', imported.id);
    assert.equal(to.debug.buildFinalPrompt('scene', null), 'soft light, scene, masterpiece, PACK COMMON');
});

test('IPE 预设包的 commons/commonName 可导入，旧包不改动既有挂接', t => {
    const current = styleSettings({ common: 'local', blocks: [{ id: 'local', name: '本地', value: 'KEEP LOCAL' }] });
    const f = fixture(t, current);
    f.debug.packImportText(JSON.stringify({
        _fmt: 'ipe-image-pack',
        templates: [{ name: 'IPE 画风', value: 'watercolor', common: 'ipe-c', commonName: 'IPE 公共' }],
        commons: [{ id: 'ipe-c', name: 'IPE 公共', value: 'IPE COMMON' }],
    }));
    const imported = f.debug.getPresets('style').find(x => x.name === 'IPE 画风');
    assert.equal(imported.common, f.debug.getCommonBlocks().find(x => x.name === 'IPE 公共').id);
    assert.equal(f.debug.getPresets('style').find(x => x.id === 's1').common, 'local');
    f.debug.packImportText(JSON.stringify({ _fmt: 'drawgen-style-pack', styles: [{ name: '画风一', fixed: 'soft light', postfix: 'masterpiece' }] }));
    assert.equal(f.debug.getPresets('style').find(x => x.id === 's1').common, 'local');
});

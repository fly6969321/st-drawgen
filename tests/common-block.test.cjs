const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clone = v => JSON.parse(JSON.stringify(v));

const COMMON = 'East Asian adults, distinct faces.\nCorrect anatomy, five fingers.\nNo text, no watermark.\nmasterpiece, best quality';
const HANFU = 'ancient China, hanfu accurate';

function fixture(t, settings, opts = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, tasks = [], confirms = [], prompts = (opts.prompts || []).slice();
    w.setTimeout = fn => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    w.confirm = msg => (confirms.push(String(msg)), true);
    w.prompt = (_m, def) => (prompts.length ? prompts.shift() : def);
    const st = Object.assign({ sdgBuiltinSeeded17: true }, settings || {});
    const context = { chat: [], extensionSettings: { 'st-drawgen': st }, saveSettings() {}, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    tasks.shift()();
    const $ = sel => w.document.querySelector(sel);
    const fire = (sel, value, type = 'change') => { const el = $(sel); assert.ok(el, sel + ' 存在'); el.value = value; el.dispatchEvent(new w.Event(type, { bubbles: true })); };
    const debug = w.__sdgDebug;
    return {
        w, debug, settings: st, confirms, $, fire,
        style: name => debug.getPresets('style').find(p => p.name === name),
        common: name => debug.getCommons().find(b => b.name === name),
        useStyle(name) { fire('#sdg-style', this.style(name).id); },
        status: () => $('#sdg-status').textContent,
        options: sel => Array.from($(sel).options).map(o => o.textContent),
    };
}
/* 包的形状照小海螺 ipeImgPackBuild（_fmt ipe-image-pack，_v 2） */
function ipePack(templates, commons) {
    const p = { _fmt: 'ipe-image-pack', _v: 2, scope: 'all', pluginVersion: '2.38.0', templates, rules: [], systemPrompts: [], anchors: [], anchorGuide: '' };
    if (commons !== null) p.commons = commons || [{ id: 'common_a', name: '夹心糖', value: COMMON }, { id: 'common_b', name: '棒棒糖', value: HANFU }];
    return JSON.stringify(p);
}
const TPL = 'Composition: {Camera}\nSetting: {Env}\nsoft pastel, airy light';

test('导入小海螺画风包：公共块单独存，画风正文不动，各画风挂各的那份', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([
        { id: 't1', name: '透甜氧气', value: TPL, common: 'common_a', commonName: '夹心糖', group: '质感' },
        { id: 't2', name: '古风', value: 'ink wash', common: 'common_b', commonName: '棒棒糖' },
        { id: 't3', name: '不挂的', value: 'plain', common: '', commonName: '' },
        { id: 't4', name: '按名字认', value: 'x', common: 'stale', commonName: '棒棒糖' },
        { id: 't5', name: '认不出', value: 'y', common: 'stale', commonName: '不存在' },
    ]));
    assert.deepEqual(clone(f.debug.getCommons().map(b => [b.name, b.value])), [['夹心糖', COMMON], ['棒棒糖', HANFU]]);
    assert.equal(f.style('透甜氧气').value, TPL, '整张模板原样进来，公共块没有并进画风正文');
    assert.equal(f.style('透甜氧气').group, '质感', '分组一起带进来');
    assert.equal(f.style('透甜氧气').common, f.common('夹心糖').id);
    assert.equal(f.style('古风').common, f.common('棒棒糖').id);
    assert.equal(f.style('不挂的').common || '', '');
    assert.equal(f.style('按名字认').common, f.common('棒棒糖').id);
    assert.equal(f.style('认不出').common || '', '');
    assert.ok(f.confirms.some(m => /公共块：新增 2/.test(m)), f.confirms.join('|'));
    assert.ok(/公共块 新增2/.test(f.status()), f.status());
});

test('面板：画风下面有「挂公共块」下拉，切画风跟着变；公共块能新建、改内容、改名', t => {
    const f = fixture(t, {}, { prompts: ['通用', '通用2'] });
    assert.deepEqual(f.options('#sdg-style-common'), ['（不挂）']);
    assert.equal(f.$('#sdg-common-text').disabled, true, '一份都没有时内容框不可填');
    f.$('#sdg-common-add').click();
    assert.equal(f.$('#sdg-common-text').disabled, false);
    f.fire('#sdg-common-text', COMMON, 'input');
    assert.equal(f.common('通用').value, COMMON, '改完即存');
    assert.deepEqual(f.options('#sdg-style-common'), ['（不挂）', '通用']);
    f.fire('#sdg-style-common', f.common('通用').id);
    assert.equal(f.debug.activePreset('style').common, f.common('通用').id);
    f.$('#sdg-common-ren').click();
    assert.ok(f.common('通用2'), '改名生效');
    assert.deepEqual(f.options('#sdg-style-common'), ['（不挂）', '通用2']);
    assert.equal(f.$('#sdg-style-common').value, f.common('通用2').id, '改名后挂接还在');

    f.debug.packImportText(JSON.stringify({ _fmt: 'drawgen-style-pack', styles: [{ name: '另一个', fixed: '', postfix: 'b' }] }));
    f.useStyle('另一个');
    assert.equal(f.$('#sdg-style-common').value, '', '另一个画风没挂');
    f.useStyle('默认');
    assert.equal(f.$('#sdg-style-common').value, f.common('通用2').id);

    const reloaded = fixture(t, clone(f.settings));
    assert.equal(reloaded.$('#sdg-style-common').value, f.common('通用2').id, '重载后挂接保留');
    assert.equal(reloaded.$('#sdg-common-text').value, COMMON);
});

test('删公共块：挂着它的画风改为不挂，别的画风不受影响', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([
        { id: 't1', name: '甲', value: 'a', common: 'common_a' }, { id: 't2', name: '乙', value: 'b', common: 'common_a' }, { id: 't3', name: '丙', value: 'c', common: 'common_b' },
    ]));
    f.fire('#sdg-common', f.common('夹心糖').id);
    f.confirms.length = 0;
    f.$('#sdg-common-del').click();
    assert.ok(/挂着它的 2 个画风会改为不挂/.test(f.confirms[0]), f.confirms[0]);
    assert.equal(f.common('夹心糖'), undefined);
    assert.equal(f.style('甲').common, '');
    assert.equal(f.style('乙').common, '');
    assert.equal(f.style('丙').common, f.common('棒棒糖').id);
});

test('拼提示词：场景分层 → 画风正文 → 公共块（空一行）；不挂就不拼', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([{ id: 't1', name: '挂', value: TPL, common: 'common_a' }, { id: 't2', name: '不挂', value: TPL, common: '' }]));
    f.useStyle('挂');
    const layers = { camera: 'medium shot', env: 'cafe', mood: '', chars: '', outfit: '', pose: '' };
    assert.equal(f.debug.buildFinalPrompt('a girl', layers), 'Composition: medium shot\nSetting: cafe\nsoft pastel, airy light\n\n' + COMMON);
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'Composition: a girl\nsoft pastel, airy light\n\n' + COMMON, '没分层时整段填进占位符那一片，公共块照拼');
    f.useStyle('不挂');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'Composition: a girl\nsoft pastel, airy light');
});

test('画风里写了 {Common}：放在那个位置；没挂时占位符去掉，不发字面量', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([
        { id: 't1', name: '有', value: 'soft pastel\n{Common}\nfinal touch', common: 'common_b' },
        { id: 't2', name: '无', value: 'soft pastel\n{Common}\nfinal touch', common: '' },
    ]));
    assert.ok(f.style('有').value.includes('{Common}'), '占位符原样留在画风里');
    f.useStyle('有');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'soft pastel\n' + HANFU + '\nfinal touch, a girl');
    f.useStyle('无');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'soft pastel\nfinal touch, a girl');
});

test('画风正文里已经带着同一段公共文本（空白不同也算）：不再叠一份', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([{ id: 't1', name: '已带', value: 'soft pastel\nEast Asian adults,  distinct faces. Correct anatomy, five fingers.\nNo text, no watermark. masterpiece, best quality', common: 'common_a' }]));
    f.useStyle('已带');
    assert.equal(f.debug.buildFinalPrompt('a girl', null).split('No text, no watermark').length - 1, 1);
});

test('改公共块内容：所有挂着它的画风下一次出图就用新内容', async t => {
    const f = fixture(t, { genEndpoint: 'https://img.test/v1/images/generations', genModel: 'm', genKey: 'k', genTimeout: 300 });
    f.debug.packImportText(ipePack([{ id: 't1', name: '甲', value: 'style A', common: 'common_a' }, { id: 't2', name: '乙', value: 'style B', common: 'common_a' }]));
    f.fire('#sdg-common', f.common('夹心糖').id);
    f.fire('#sdg-common-text', 'NEW COMMON LINE', 'input');
    const sent = [];
    f.w.fetch = async (url, o) => {
        if (o && typeof o.body === 'string') sent.push(JSON.parse(o.body));
        const body = JSON.stringify({ data: [{ b64_json: 'AAAA' }] });
        return { ok: true, status: 200, headers: { get: k => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => body, json: async () => JSON.parse(body) };
    };
    globalThis.fetch = f.w.fetch;
    for (const name of ['甲', '乙']) { f.useStyle(name); try { await f.debug.generateImage('a girl', null); } catch (e) {} }
    const prompts = sent.map(b => b.prompt).filter(Boolean);
    assert.equal(prompts[0], 'style A, a girl\n\nNEW COMMON LINE');
    assert.equal(prompts[1], 'style B, a girl\n\nNEW COMMON LINE');
});

test('老版本导过、没挂公共块的画风：重新导同一个包按同名覆盖挂上；再导一次什么都不变', t => {
    const f = fixture(t);
    const tpl = [{ id: 't1', name: '透甜氧气', value: TPL, common: 'common_a', commonName: '夹心糖' }];
    f.debug.packImportText(ipePack(tpl, null));
    assert.equal(f.style('透甜氧气').common, undefined);
    f.confirms.length = 0;
    f.debug.packImportText(ipePack(tpl));
    assert.ok(f.confirms.some(m => /画风：新增 0 \/ 覆盖 1/.test(m)), f.confirms.join('|'));
    assert.equal(f.style('透甜氧气').common, f.common('夹心糖').id);
    assert.equal(f.debug.getPresets('style').filter(p => p.name === '透甜氧气').length, 1);
    f.debug.packImportText(ipePack(tpl));
    assert.ok(/什么都没变/.test(f.status()), f.status());
});

test('旧包（没有 commons 字段）：不动现有公共块和挂接', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([{ id: 't1', name: '透甜氧气', value: TPL, common: 'common_a' }]));
    const mounted = f.style('透甜氧气').common;
    f.debug.packImportText(ipePack([{ id: 't1', name: '透甜氧气', value: TPL + ', v2' }], null));
    assert.equal(f.style('透甜氧气').value, TPL + ', v2');
    assert.equal(f.style('透甜氧气').common, mounted, '挂接保留');
    assert.equal(f.debug.getCommons().length, 2);
});

test('同名公共块内容不同：按名字覆盖并提示；导出再导入，公共块和挂接原样回来', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([{ id: 't1', name: '甲', value: 'style A', common: 'common_a' }]));
    f.confirms.length = 0;
    f.debug.packImportText(ipePack([{ id: 't1', name: '甲', value: 'style A', common: 'common_a' }], [{ id: 'common_a', name: '夹心糖', value: 'CHANGED' }]));
    assert.ok(f.confirms.some(m => /公共块：新增 0 \/ 覆盖 1/.test(m)), f.confirms.join('|'));
    assert.equal(f.common('夹心糖').value, 'CHANGED');
    assert.equal(f.debug.getCommons().length, 2, '包里没有的那份不删');

    const packed = f.debug.stylePackBuild();
    assert.equal(packed.commons.length, 2);
    assert.equal(packed.styles.find(s => s.name === '甲').commonName, '夹心糖');
    const to = fixture(t);
    to.debug.packImportText(JSON.stringify(packed));
    assert.equal(to.common('夹心糖').value, 'CHANGED');
    assert.equal(to.style('甲').common, to.common('夹心糖').id);
    assert.equal(to.style('默认').common || '', '');
});

test('提取页分区：默认全收起，点开后记住；工作区不在折叠里', t => {
    const f = fixture(t);
    const folds = Array.from(f.w.document.querySelectorAll('#sdg-pane-ext details.sdg-fold'));
    assert.deepEqual(folds.map(d => d.getAttribute('data-fold')), ['layers', 'style', 'common', 'site', 'sys', 'rules', 'anchors', 'template', 'misc']);
    assert.ok(folds.every(d => !d.open), '默认全收起');
    assert.equal(f.$('#sdg-preview').closest('details'), null);
    assert.equal(f.$('#sdg-btn-extract').closest('details'), null);
    assert.equal(f.w.document.querySelectorAll('#sdg-pane-gen details.sdg-fold').length, 0, '生图页不动');
    const where = { '#sdg-style': 'style', '#sdg-style-common': 'style', '#sdg-gen-style': 'style', '#sdg-style-group': 'style', '#sdg-style-group-filter': 'style', '#sdg-layer-env': 'layers', '#sdg-common-text': 'common', '#sdg-ext-api': 'site', '#sdg-ext-model-sel': 'site', '#sdg-sys-value': 'sys', '#sdg-rules': 'rules', '#sdg-anchors': 'anchors', '#sdg-anchor-guide': 'anchors', '#sdg-template': 'template', '#sdg-timeout': 'misc' };
    for (const sel in where) assert.equal(f.$(sel).closest('details.sdg-fold').getAttribute('data-fold'), where[sel], sel);

    const site = f.$('details[data-fold="site"]');
    site.open = true; site.dispatchEvent(new f.w.Event('toggle'));
    assert.deepEqual(clone(f.settings.foldsOpen), { site: true });
    const reloaded = fixture(t, clone(f.settings));
    assert.equal(reloaded.$('details[data-fold="site"]').open, true);
    assert.equal(reloaded.$('details[data-fold="style"]').open, false);
    const again = reloaded.$('details[data-fold="site"]');
    again.open = false; again.dispatchEvent(new reloaded.w.Event('toggle'));
    assert.deepEqual(clone(reloaded.settings.foldsOpen), {});
});

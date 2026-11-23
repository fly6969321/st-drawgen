const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const clone = v => JSON.parse(JSON.stringify(v));

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
        useStyle(name) { fire('#sdg-style', this.style(name).id); },
        status: () => $('#sdg-status').textContent,
        options: sel => Array.from($(sel).options).map(o => o.textContent),
        optgroups: sel => Array.from($(sel).querySelectorAll('optgroup')).map(g => [g.label, Array.from(g.querySelectorAll('option')).map(o => o.textContent)]),
    };
}
function ipePack(templates, commons) {
    return JSON.stringify({ _fmt: 'ipe-image-pack', _v: 2, scope: 'all', pluginVersion: '2.38.0', templates, commons: commons || [], rules: [], systemPrompts: [], anchors: [], anchorGuide: '' });
}
/* 1.8.24 及以前的拼法：风格词（分层填好）→ 描述 → 后缀词 */
const oldPrompt = (fixed, desc, postfix) => [fixed, desc, postfix].filter(Boolean).join(', ');

test('老设置升级：风格词 / 后缀词并成一张模板，出图一字不差，旧数据留备份，只转一次', t => {
    const styles = [
        { id: 's1', name: '只有后缀', fixed: '', postfix: 'soft pastel, airy light' },
        { id: 's2', name: '两格都有', fixed: 'masterpiece', postfix: 'film grain', common: 'c1' },
        { id: 's3', name: '两格都空', fixed: '', postfix: '' },
        { id: 's4', name: '以前导的小海螺', fixed: 'Composition: {Camera}\nSetting: {Env}', postfix: 'Korean semi-realistic' },
    ];
    const f = fixture(t, { stylesJson: JSON.stringify(styles), styleId: 's1', genFixedPrompt: '', genPostfixPrompt: 'soft pastel, airy light', commonsJson: JSON.stringify([{ id: 'c1', name: '通用', value: 'no watermark' }]) });
    assert.deepEqual(clone(f.debug.getPresets('style')), [
        { id: 's1', name: '只有后缀', value: '{Description}, soft pastel, airy light' },
        { id: 's2', name: '两格都有', common: 'c1', value: 'masterpiece, {Description}, film grain' },
        { id: 's3', name: '两格都空', value: '{Description}' },
        { id: 's4', name: '以前导的小海螺', value: 'Composition: {Camera}\nSetting: {Env}\nKorean semi-realistic' },
    ]);
    assert.deepEqual(JSON.parse(f.settings.stylesJsonV1), styles, '转换前的画风列表留了备份');
    assert.equal(f.settings.genStyle, '{Description}, soft pastel, airy light');
    assert.equal(f.$('#sdg-gen-style').value, '{Description}, soft pastel, airy light');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), oldPrompt('', 'a girl', 'soft pastel, airy light'));
    f.useStyle('两格都有');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), oldPrompt('masterpiece', 'a girl', 'film grain') + '\n\nno watermark');
    f.useStyle('两格都空');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'a girl');

    f.fire('#sdg-gen-style', 'my new style, {Description}');
    const again = fixture(t, clone(f.settings));
    assert.equal(again.style('两格都空').value, 'my new style, {Description}', '重载不再转第二次，改过的内容还在');
    assert.deepEqual(JSON.parse(again.settings.stylesJsonV1), styles);
});

test('没有画风列表、只有两格内容的更老设置：一样并成一张', t => {
    const f = fixture(t, { genFixedPrompt: 'masterpiece', genPostfixPrompt: 'soft pastel' });
    assert.equal(f.settings.genStyle, 'masterpiece, {Description}, soft pastel');
    assert.equal(f.debug.activePreset('style').value, 'masterpiece, {Description}, soft pastel');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'masterpiece, a girl, soft pastel');
});

test('面板：画风只有一格，改完即存；清空回到 {Description}；全新安装默认就是 {Description}', t => {
    const f = fixture(t);
    assert.equal(f.$('#sdg-gen-fixed'), null);
    assert.equal(f.$('#sdg-gen-postfix'), null);
    assert.equal(f.$('#sdg-gen-style').value, '{Description}');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'a girl');
    f.fire('#sdg-gen-style', '{Description}\nwatercolor');
    assert.equal(f.debug.activePreset('style').value, '{Description}\nwatercolor');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'a girl\nwatercolor');
    f.fire('#sdg-gen-style', '   ');
    assert.equal(f.$('#sdg-gen-style').value, '{Description}', '框里显示正在生效的值');
    assert.equal(f.debug.activePreset('style').value, '{Description}');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'a girl', '空着不会把描述弄丢');
});

test('小海螺模板整张照它的拼法出图：<draw> 壳去掉，层原地填，空行连标签收掉，公共块在最后', t => {
    const f = fixture(t);
    const TPL = '<draw>\nComposition: {Camera}\nSetting: {Env}\nMood: {Mood}\nCharacters: {Chars}\nAction: {Pose}\n{Description}\n\nKorean semi-realistic, ultra detailed\n</draw>';
    f.debug.packImportText(ipePack([{ id: 't1', name: '韩漫', value: TPL, common: 'c1', commonName: '通用' }], [{ id: 'c1', name: '通用', value: 'East Asian adults.\nNo text, no watermark.' }]));
    assert.equal(f.style('韩漫').value, TPL);
    f.useStyle('韩漫');
    const layers = { camera: 'medium shot', env: 'cafe', mood: '', chars: 'a girl', outfit: 'white dress', pose: 'reading' };
    const out = f.debug.buildFinalPrompt('whatever', layers);
    assert.equal(out, 'Composition: medium shot\nSetting: cafe\nCharacters: a girl white dress\nAction: reading\n\nKorean semi-realistic, ultra detailed\n\nEast Asian adults.\nNo text, no watermark.');
    assert.doesNotMatch(out, /<\/?draw>|\{[A-Z][a-z]+\}|Mood:/);
    assert.equal((out.match(/a girl/g) || []).length, 1, '同一层只写一遍');
    /* 没分层结果：层那几行整行收掉，整段进 {Description} */
    assert.equal(f.debug.buildFinalPrompt('a girl reading in a cafe', null), 'a girl reading in a cafe\n\nKorean semi-realistic, ultra detailed\n\nEast Asian adults.\nNo text, no watermark.');
});

test('导入覆盖了正在用的那套画风：生效内容立刻换成新的，不用切一下', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([{ id: 't1', name: '甲', value: '{Description}, v1' }]));
    f.useStyle('甲');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'a girl, v1');
    f.debug.packImportText(ipePack([{ id: 't1', name: '甲', value: '{Description}, v2' }]));
    assert.equal(f.$('#sdg-gen-style').value, '{Description}, v2');
    assert.equal(f.debug.buildFinalPrompt('a girl', null), 'a girl, v2');
});

test('分组：导入带进来；筛选下拉列出各组和数量；选了组，画风下拉只剩这组', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([
        { id: 't1', name: '韩漫', value: 'a', group: '二次元' }, { id: 't2', name: '厚涂', value: 'b', group: '二次元' },
        { id: 't3', name: '胶片', value: 'c', group: '写实' }, { id: 't4', name: '古.水墨', value: 'd' }, { id: 't5', name: '2.5D 厚涂', value: 'e' },
    ]));
    assert.equal(f.style('韩漫').group, '二次元');
    assert.equal(f.debug.styleGroupOf(f.style('古.水墨')), '古', '短前缀自动归组');
    assert.equal(f.debug.styleGroupOf(f.style('2.5D 厚涂')), '', '版本号不算组');
    assert.deepEqual(f.options('#sdg-style-group-filter'), ['全部（6）', '二次元（2）', '古（1）', '写实（1）', '未分组（2）']);
    assert.deepEqual(f.optgroups('#sdg-style'), [['二次元', ['韩漫', '厚涂']], ['古', ['古.水墨']], ['写实', ['胶片']], ['未分组', ['默认', '2.5D 厚涂']]]);

    f.fire('#sdg-style-group-filter', '二次元');
    assert.deepEqual(f.options('#sdg-style'), ['（当前）默认', '韩漫', '厚涂'], '当前这套不在组里也留着，不会偷偷换画风');
    assert.equal(f.debug.activePreset('style').name, '默认');
    f.useStyle('厚涂');
    assert.deepEqual(f.options('#sdg-style'), ['韩漫', '厚涂']);
    assert.equal(f.$('#sdg-style-group').value, '二次元');

    const reloaded = fixture(t, clone(f.settings));
    assert.equal(reloaded.$('#sdg-style-group-filter').value, '二次元', '筛选记住');
    assert.deepEqual(reloaded.options('#sdg-style'), ['韩漫', '厚涂']);
    f.fire('#sdg-style-group-filter', '');
    assert.equal(f.optgroups('#sdg-style').length, 4);
});

test('所属分组：改组、新建分组、设为未分组、给整组改名', t => {
    const f = fixture(t, {}, { prompts: ['国风', '古风'] });
    f.debug.packImportText(ipePack([{ id: 't1', name: '韩漫', value: 'a', group: '二次元' }, { id: 't2', name: '厚涂', value: 'b', group: '二次元' }, { id: 't3', name: '古.水墨', value: 'd' }]));
    f.useStyle('厚涂');
    assert.deepEqual(f.options('#sdg-style-group'), ['（未分组）', '二次元', '古', '＋ 新建分组…', '✎ 给「二次元」这组改名…']);
    f.fire('#sdg-style-group', '古');
    assert.equal(f.style('厚涂').group, '古');
    f.fire('#sdg-style-group', '__new__');
    assert.equal(f.style('厚涂').group, '国风');
    assert.ok(f.options('#sdg-style-group-filter').includes('国风（1）'));
    f.useStyle('古.水墨');
    f.fire('#sdg-style-group', '');
    assert.equal(f.debug.styleGroupOf(f.style('古.水墨')), '', '手动设成未分组后，名字前缀不再自动归组');
    f.useStyle('韩漫');
    f.fire('#sdg-style-group-filter', '二次元');
    f.fire('#sdg-style-group', '__rename__');
    assert.equal(f.style('韩漫').group, '古风');
    assert.equal(f.$('#sdg-style-group-filter').value, '古风', '正筛着的组改名后筛选跟着走');
    assert.deepEqual(f.options('#sdg-style'), ['韩漫']);

    /* 筛着某组时新建画风：直接进这组 */
    f.w.prompt = () => '新的';
    f.$('.sdg-p-add[data-k="style"]').click();
    assert.equal(f.style('新的').group, '古风');
    assert.equal(f.style('新的').value, '{Description}');
});

test('导出再导入：整张模板、分组、挂的公共块原样回来；重导同一份什么都不变', t => {
    const f = fixture(t);
    f.debug.packImportText(ipePack([{ id: 't1', name: '韩漫', value: '<draw>{Description}\nstyle</draw>', group: '二次元', common: 'c1', commonName: '通用' }], [{ id: 'c1', name: '通用', value: 'no watermark' }]));
    const pack = f.debug.stylePackBuild();
    assert.equal(pack._v, 2);
    const s = pack.styles.find(x => x.name === '韩漫');
    assert.deepEqual([s.value, s.group, s.commonName], ['<draw>{Description}\nstyle</draw>', '二次元', '通用']);
    assert.equal('fixed' in s || 'postfix' in s, false);
    const to = fixture(t);
    to.debug.packImportText(JSON.stringify(pack));
    assert.equal(to.style('韩漫').value, '<draw>{Description}\nstyle</draw>');
    assert.equal(to.style('韩漫').group, '二次元');
    assert.equal(to.style('韩漫').common, to.debug.getCommons().find(b => b.name === '通用').id);
    to.debug.packImportText(JSON.stringify(pack));
    assert.ok(/什么都没变/.test(to.status()), to.status());
});

test('1.8.24 及以前导出的画风包（前缀 / 后缀两格）照样能导', t => {
    const f = fixture(t);
    f.debug.packImportText(JSON.stringify({ _fmt: 'drawgen-style-pack', styles: [{ name: '旧包', fixed: '', postfix: 'soft pastel' }, { name: '旧包2', fixed: 'Setting: {Env}', postfix: 'x' }] }));
    assert.equal(f.style('旧包').value, '{Description}, soft pastel');
    assert.equal(f.style('旧包2').value, 'Setting: {Env}\nx');
});

test('分层提取开关和分层内容在同一个折叠栏里；关掉开关只藏内容', t => {
    const f = fixture(t, { layered: true });
    const fold = f.$('#sdg-layers').closest('details.sdg-fold');
    assert.equal(fold.getAttribute('data-fold'), 'layers');
    assert.equal(fold.open, false);
    assert.equal(f.$('#sdg-layers-wrap').style.display, '');
    assert.equal(f.$('#sdg-layered').closest('details'), fold, '分层开关在「分层提取」折叠栏里');
    assert.equal(fold.querySelector('summary').textContent, '分层提取');
    assert.equal(f.$('#sdg-layers-wrap').contains(f.$('#sdg-layered')), false, '关掉后开关自己还看得见');
    fold.open = true; fold.dispatchEvent(new f.w.Event('toggle'));
    assert.equal(f.settings.foldsOpen.layers, true);
    const el = f.$('#sdg-layered'); el.checked = false; el.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(f.$('#sdg-layers-wrap').style.display, 'none');
    el.checked = true; el.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(f.$('#sdg-layers-wrap').style.display, '');
    assert.equal(fixture(t, clone(f.settings)).$('details[data-fold="layers"]').open, true);
    assert.equal(fixture(t, { layered: false }).$('#sdg-layers-wrap').style.display, 'none');
});

test('面板里只有「锚点规则」，没有「公共规则」', t => {
    const f = fixture(t);
    const panel = f.w.document.body;
    const all = panel.textContent + Array.from(panel.querySelectorAll('[title],[placeholder]')).map(e => (e.getAttribute('title') || '') + (e.getAttribute('placeholder') || '')).join('');
    assert.doesNotMatch(all, /公共规则/);
    assert.match(all, /锚点规则/);
    assert.match(all, /公共块/);
});

test('一次导入几百个画风：编号一个不撞；旧数据里撞号的开机换新号', t => {
    const f = fixture(t);
    const styles = Array.from({ length: 400 }, (_, i) => ({ name: '批量' + i, value: 'v' + i + ' {Description}' }));
    f.debug.packImportText(JSON.stringify({ _fmt: 'drawgen-style-pack', _v: 2, styles }));
    const list = JSON.parse(f.settings.stylesJson);
    assert.ok(list.length >= 400);
    assert.equal(new Set(list.map(p => p.id)).size, list.length);
    const dup = clone(f.settings);
    const l2 = JSON.parse(dup.stylesJson); l2[5].id = l2[4].id; l2[9].id = l2[4].id; dup.stylesJson = JSON.stringify(l2);
    const g = fixture(t, dup);
    const healed = JSON.parse(g.settings.stylesJson);
    assert.equal(new Set(healed.map(p => p.id)).size, healed.length);
    assert.equal(healed[4].id, l2[4].id, '先出现的那个编号不变');
    assert.deepEqual(healed.map(p => p.value), l2.map(p => p.value), '内容一个字不动');
});

test('文件选择导入：完整读取 JSON，清空旧值后可重复选择同一个文件', async t => {
    const f = fixture(t);
    const input = f.$('#sdg-style-file');
    const file = new f.w.File([JSON.stringify({
        _fmt: 'drawgen-style-pack', _v: 2,
        styles: [{ name: '文件画风', value: '{Description}, watercolor' }],
    })], 'same-style.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    const choose = () => input.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    const settle = async () => {
        for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    };
    choose();
    await settle();
    assert.equal(f.style('文件画风').value, '{Description}, watercolor');
    assert.match(f.status(), /导入完成/);
    assert.equal(input.value, '', '选择后清空，下一次选同一文件仍会触发 change');
    choose();
    await settle();
    assert.match(f.status(), /什么都没变/, '同一文件第二次也正常完成导入流程');
});

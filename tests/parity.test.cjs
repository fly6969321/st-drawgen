const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

/* 最小化夹具：空设置启动插件（触发内置站点播种），不挂楼层 UI */
function fixture(t, settings) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = fn => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    w.confirm = () => true;
    const context = { chat: [], extensionSettings: { 'st-drawgen': settings || {} }, saveSettingsDebounced() {} };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    tasks.shift()();
    return { w, debug: w.__sdgDebug, ctx: context };
}

test('fresh install seeds builtin gen/ext sites and syncs flat fields', t => {
    const { debug, ctx } = fixture(t);
    const gens = debug.getProfiles('gen');
    assert.equal(gens.length, 13, '13 builtin gen sites');
    const exts = debug.getProfiles('ext');
    assert.equal(exts.length, 1, '1 builtin ext site');
    assert.equal(exts[0].id, 'smu0ujfttce', 'ext site is the builtin one, not a lazy snapshot');
    assert.equal(exts[0].endpoint, 'https://gcli.ggchan.dev/v1');
    assert.equal(ctx.extensionSettings['st-drawgen'].sdgBuiltinSeeded17, true, 'seeding completed without throwing');
    const active = debug.activeProfile('gen');
    assert.equal(active.name, 'wong');
    assert.equal(ctx.extensionSettings['st-drawgen'].genProfileId, active.id);
    assert.equal(ctx.extensionSettings['st-drawgen'].genEndpoint, active.endpoint);
    assert.equal(ctx.extensionSettings['st-drawgen'].genKey, active.key);
    assert.equal(ctx.extensionSettings['st-drawgen'].genModel, active.model);
    assert.equal(ctx.extensionSettings['st-drawgen'].grokSize, active.size);
    assert.equal(ctx.extensionSettings['st-drawgen'].genQuality, active.quality);
    const extActive = debug.activeProfile('ext');
    assert.equal(ctx.extensionSettings['st-drawgen'].extEndpoint, extActive.endpoint);
});

test('existing user sites are not overwritten by builtin seeding', t => {
    const { debug } = fixture(t, {
        sdgBuiltinSeeded17: false,
        genProfilesJson: JSON.stringify([{ id: 'u1', name: '我的站', endpoint: 'https://mine.test/v1', key: 'k', model: 'm', models: [], size: '512x512' }]),
        genProfileId: 'u1'
    });
    const gens = debug.getProfiles('gen');
    assert.equal(gens.length, 1);
    assert.equal(gens[0].name, '我的站');
});

test('extraction input strips plugin injection blocks and inline base64 images', t => {
    const { debug } = fixture(t);
    const out1 = debug.trimSourceText('少女走进森林 image###a girl walking into the forest### 风吹过树叶');
    assert.doesNotMatch(out1, /image###|a girl walking/);
    assert.match(out1, /少女走进森林/);
    assert.match(out1, /风吹过树叶/);
    const out2 = debug.trimSourceText('正文开头\n<draw>masterpiece, 1girl, forest</draw>\n正文结尾');
    assert.doesNotMatch(out2, /<draw>|masterpiece/);
    assert.match(out2, /正文开头/);
    assert.match(out2, /正文结尾/);
    const out3 = debug.trimSourceText('前文 ![](data:image/png;base64,iVBORw0KGgoAAAANS=) 后文');
    assert.doesNotMatch(out3, /data:image|base64/);
    assert.match(out3, /前文/);
    assert.match(out3, /后文/);
    const out4 = debug.trimSourceText('xxx data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ yyy');
    assert.doesNotMatch(out4, /data:image|4AAQSkZJRg/);
    /* 普通外链图片和正常正文不动 */
    const keep = debug.trimSourceText('看图 ![](https://x.test/a.png) 结束');
    assert.match(keep, /https:\/\/x\.test\/a\.png/);
});

test('auto delay migrates untouched 1800ms default to 800ms, keeps custom values', t => {
    const f1 = fixture(t, { autoDelay: 1800 });
    assert.equal(f1.ctx.extensionSettings['st-drawgen'].autoDelay, 800);
    const f2 = fixture(t, { autoDelay: 3000 });
    assert.equal(f2.ctx.extensionSettings['st-drawgen'].autoDelay, 3000);
    const f3 = fixture(t, {});
    assert.equal(f3.ctx.extensionSettings['st-drawgen'].autoDelay, 800);
});

test('normalizeGenSize converts full-width multiply sign and defaults', t => {
    const { debug } = fixture(t);
    assert.equal(debug.normalizeGenSize('1024×1536'), '1024x1536');
    assert.equal(debug.normalizeGenSize(' 768×1024 '), '768x1024');
    assert.equal(debug.normalizeGenSize(''), '1024x1024');
    assert.equal(debug.normalizeGenSize(undefined), '1024x1024');
    assert.equal(debug.normalizeGenSize('1024x1024'), '1024x1024');
});

test('siteErrorBrief extracts status code and provider message', t => {
    const { debug } = fixture(t);
    assert.equal(
        debug.siteErrorBrief(429, '{"error":{"message":"no available image quota","code":"insufficient_quota"}}'),
        'HTTP 429：no available image quota (insufficient_quota)'
    );
    /* JSON 被包在一堆杂讯中间也能抠出来 */
    assert.equal(
        debug.siteErrorBrief(400, 'upstream said: {"error":{"message":"only response_format=url supported"}} end'),
        'HTTP 400：only response_format=url supported'
    );
    /* 非 JSON 错误体取原文 */
    assert.equal(debug.siteErrorBrief(502, 'Bad Gateway'), 'HTTP 502：Bad Gateway');
    assert.equal(debug.siteErrorBrief(500, ''), 'HTTP 500：站点未返回原因');
});

test('formatGenError leads with status code and keeps timeout/cancel wording', t => {
    const { debug, w } = fixture(t);
    const e1 = new Error('images 接口 HTTP 400：{"error":{"message":"bad size"}} / chat 接口 HTTP 500：{"error":{"message":"down"}}');
    assert.equal(debug.formatGenError(e1), '生图失败 400：bad size');
    assert.equal(debug.formatGenError(new Error('生图请求超时（300 秒），已停止（不自动重试，以免重复扣费）')), '生图请求超时（300 秒），已停止（不自动重试，以免重复扣费）');
    assert.equal(debug.formatGenError(new w.DOMException('aborted', 'AbortError')), '已取消生图');
    assert.equal(debug.formatGenError(new Error('请先填写生图模型')), '请先填写生图模型');
});

test('imgUrlFromChat accepts reasoning_details images without explicit type', t => {
    const { debug } = fixture(t);
    assert.equal(
        debug.imgUrlFromChat({ choices: [{ message: { reasoning_details: { images: [{ image_url: { url: 'https://x.test/a.png' } }] } } }] }),
        'https://x.test/a.png'
    );
    assert.equal(
        debug.imgUrlFromChat({ choices: [{ message: { content: [{ type: 'text', text: 'ok' }, { type: 'image_url', image_url: 'https://x.test/b.png' }] } }] }),
        'https://x.test/b.png'
    );
    assert.equal(
        debug.imgUrlFromChat({ choices: [{ message: { content: 'here ![](https://x.test/c.png) done' } }] }),
        'https://x.test/c.png'
    );
    assert.equal(debug.imgUrlFromChat({ choices: [{ message: { content: 'no image here' } }] }), '');
    assert.equal(debug.imgUrlFromChat({}), '');
});

test('imgUrlFromGen handles b64_json and url items', t => {
    const { debug } = fixture(t);
    assert.equal(debug.imgUrlFromGen({ data: [{ b64_json: 'AAAA' }] }), 'data:image/png;base64,AAAA');
    assert.equal(debug.imgUrlFromGen({ data: [{ url: 'https://x.test/d.png' }] }), 'https://x.test/d.png');
    assert.equal(debug.imgUrlFromGen({ data: [] }), '');
});

test('styleSegment fills scaffold placeholders from layers and skips unresolved ones', t => {
    const { debug } = fixture(t);
    const layers = { camera: 'close-up', env: 'forest', mood: 'warm', chars: 'a girl', outfit: 'white dress', pose: 'standing' };
    assert.equal(
        debug.styleSegment('Composition: {Camera} | Setting: {Env} | Mood: {Mood}', layers),
        'Composition: close-up | Setting: forest | Mood: warm'
    );
    /* 空层值产生的空壳段落被清掉 */
    assert.equal(
        debug.styleSegment('Composition: {Camera} | Setting: {Env} | Mood: {Mood}', { camera: 'close-up' }),
        'Composition: close-up'
    );
    /* 非分层时带占位符的前缀整段跳过，绝不把 {Camera} 发出去 */
    assert.equal(debug.styleSegment('Composition: {Camera}', null), '');
    /* 普通画风词原样返回 */
    assert.equal(debug.styleSegment('masterpiece, best quality', null), 'masterpiece, best quality');
});

test('packSixTagText upgrades five-tag contracts mechanically', t => {
    const { debug } = fixture(t);
    assert.match(debug.packSixTagText('Camera / Setting / Mood / Characters / Pose'), /Outfit/);
    assert.match(debug.packSixTagText('镜头 / 环境 / 氛围 / 人物 / 动作'), /服装/);
    assert.match(debug.packSixTagText('{Camera}/{Env}/{Mood}/{Chars}/{Pose}'), /\{Outfit\}/);
});

test('packTemplateSplit splits scaffold prefix from style body', t => {
    const { debug } = fixture(t);
    const sp = debug.packTemplateSplit('Composition: {Camera}/{Setting}/{Mood}/{Characters}/{Pose}\nKorean semi-realistic anime, ultra detailed');
    assert.match(sp.fixed, /\{Outfit\}/);
    assert.match(sp.fixed, /Composition:/);
    assert.equal(sp.postfix, 'Korean semi-realistic anime, ultra detailed');
    const plain = debug.packTemplateSplit('just style words, masterpiece');
    assert.equal(plain.fixed, '');
    assert.equal(plain.postfix, 'just style words, masterpiece');
});

test('packPlan recognizes style packs, preset packs and loose arrays', t => {
    const { debug } = fixture(t);
    assert.equal(debug.packPlan(JSON.stringify({ _fmt: 'drawgen-style-pack', styles: [] })).kind, 'style');
    assert.equal(debug.packPlan(JSON.stringify({ _fmt: 'ipe-image-pack', templates: [] })).kind, 'pack');
    assert.equal(debug.packPlan(JSON.stringify({ templates: [], rules: [] })).kind, 'pack');
    assert.equal(debug.packPlan(JSON.stringify([{ name: 's', fixed: 'a', postfix: 'b' }])).kind, 'style');
    assert.equal(debug.packPlan(JSON.stringify({ name: 's', value: 'v' })).kind, 'style');
    assert.throws(() => debug.packPlan('{'), /合法 JSON/);
    assert.throws(() => debug.packPlan(JSON.stringify({ foo: 1 })), /可识别的预设包/);
});

test('packImportText merges styles by name with overwrite/add counts', t => {
    const { debug, w } = fixture(t);
    /* 全新安装后画风列表里有一个自动建的「默认」空画风 */
    const before = debug.getPresets('style');
    assert.equal(before.length, 1);
    let captured = '';
    w.confirm = msg => { captured = msg; return true; };
    const pack = {
        _fmt: 'drawgen-style-pack',
        styles: [
            { name: '默认', fixed: 'prefix-default', postfix: 'postfix-default' },
            { name: '赛璐璐', fixed: 'cel style', postfix: 'clean lines' }
        ]
    };
    debug.packImportText(JSON.stringify(pack));
    assert.match(captured, /覆盖 1/);
    assert.match(captured, /新增 1/);
    const after = debug.getPresets('style');
    assert.equal(after.length, 2);
    const byName = Object.fromEntries(after.map(p => [p.name, p]));
    assert.equal(byName['默认'].fixed, 'prefix-default');
    assert.equal(byName['赛璐璐'].postfix, 'clean lines');
});

test('preset pack import merges templates, rules, system prompts and anchors', t => {
    const { debug, w } = fixture(t);
    w.confirm = () => true;
    const pack = {
        _fmt: 'ipe-image-pack',
        templates: [{ name: '电影感', value: 'Composition: {Camera}/{Setting}/{Mood}/{Characters}/{Pose}\ncinematic lighting, film grain' }],
        rules: [{ name: '只写画面', text: '只输出可见画面，镜头 / 环境 / 氛围 / 人物 / 动作 五层' }],
        systemPrompts: [{ name: '自定义系统', value: 'You are an image describer. Camera / Setting / Mood / Characters / Pose' }],
        anchors: [{ name: '女主', text: '女主：银发少女' }]
    };
    debug.packImportText(JSON.stringify(pack));
    const styles = debug.getPresets('style');
    const film = styles.find(p => p.name === '电影感');
    assert.ok(film, 'template imported as style');
    assert.match(film.fixed, /\{Outfit\}/, 'five-tag scaffold upgraded in prefix');
    assert.equal(film.postfix, 'cinematic lighting, film grain');
    const rules = debug.getPresets('rules');
    assert.ok(rules.some(p => p.name === '只写画面'));
    assert.match(rules.find(p => p.name === '只写画面').text, /服装/);
    const anchors = debug.getPresets('anchors');
    assert.ok(anchors.some(p => p.name === '女主'));
    assert.ok(debug.getSystemPrompts().some(p => p.name === '自定义系统'));
});

test('cancelling import changes nothing', t => {
    const { debug, w } = fixture(t);
    w.confirm = () => false;
    const before = JSON.stringify(debug.getPresets('style'));
    debug.packImportText(JSON.stringify({ _fmt: 'drawgen-style-pack', styles: [{ name: '新画风', fixed: 'x', postfix: 'y' }] }));
    assert.equal(JSON.stringify(debug.getPresets('style')), before);
});

test('stylePackBuild exports only styles without keys', t => {
    const { debug } = fixture(t);
    const pack = debug.stylePackBuild();
    assert.equal(pack._fmt, 'drawgen-style-pack');
    assert.ok(Array.isArray(pack.styles));
    const json = JSON.stringify(pack);
    assert.doesNotMatch(json, /api[_-]?key|Bearer|endpoint/i);
});

test('panel builds with quality selector and style import/export controls, quality persists to site', t => {
    const { w, debug, ctx } = fixture(t);
    const doc = w.document;
    /* init() 已在夹具里跑过，面板应已挂载 */
    const quality = doc.querySelector('#sdg-gen-quality');
    assert.ok(quality, 'quality select rendered');
    const vals = Array.from(quality.options).map(o => o.value);
    assert.deepEqual(vals, ['', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
    assert.ok(doc.querySelector('#sdg-style-import'), 'style import button rendered');
    assert.ok(doc.querySelector('#sdg-style-export'), 'style export button rendered');
    assert.ok(doc.querySelector('#sdg-style-file'), 'style file input rendered');
    /* 生图超时输入框渲染并生效 */
    const timeout = doc.querySelector('#sdg-gen-timeout');
    assert.ok(timeout, 'gen timeout input rendered');
    assert.equal(timeout.value, '300');
    timeout.value = '120';
    timeout.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(ctx.extensionSettings['st-drawgen'].genTimeout, 120);
    /* 非法值回退默认 */
    timeout.value = 'abc';
    timeout.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(ctx.extensionSettings['st-drawgen'].genTimeout, 300);
    /* 切换画质随站点档案保存 */
    quality.value = 'high';
    quality.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(debug.activeProfile('gen').quality, 'high');
    /* 切站点后画质回填 */
    const gens = debug.getProfiles('gen');
    const other = gens.find(p => p.id !== debug.activeProfile('gen').id);
    if (other) {
        const siteSel = doc.querySelector('#sdg-gen-site');
        siteSel.value = other.id;
        siteSel.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(doc.querySelector('#sdg-gen-quality').value, other.quality || '');
    }
});

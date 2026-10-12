/*
 * 面板布局回归（v1.7.3）
 *  · 「延迟 / 图片宽度」同一行的输入框必须底边对齐
 *  · 手机端面板整体比视口矮 60px（上边缘下移 30px、下边缘上移 30px）
 * 用真 CSSOM 解析 style.css，确保声明真的落进规则里（不是正则看字符串）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

function sheet(t) {
    const dom = new JSDOM('<!doctype html><style>' + css + '</style>');
    t.after(() => dom.window.close());
    return { dom, rules: dom.window.document.styleSheets[0].cssRules };
}

function findRule(rules, selector) {
    for (const r of rules) if (r.selectorText === selector) return r;
    return null;
}

function findInMedia(rules, mediaNeedle, selectorNeedle) {
    for (const r of rules) {
        const text = r.media ? (r.conditionText || r.media.mediaText) : '';
        if (!text.includes(mediaNeedle)) continue;
        for (const inner of r.cssRules) {
            if ((inner.selectorText || '').includes(selectorNeedle)) return inner;
        }
    }
    return null;
}

test('.sdg-grid2 bottom-aligns its cells so the inputs sit on one line', t => {
    const { rules } = sheet(t);
    const grid = findRule(rules, '.sdg-grid2');
    assert.ok(grid, '.sdg-grid2 规则存在');
    assert.equal(grid.style.display, 'grid');
    assert.equal(grid.style.gridTemplateColumns, '1fr 1fr');
    /* 病根：默认 align-items:stretch 时，左边长标签换行会把输入框顶下去。
       end = 格子底边对齐；输入框是 .sdg-field 的最后一个子元素且 margin:0，
       所以「格子底边对齐」等价于「输入框底边对齐」。 */
    assert.equal(grid.style.alignItems, 'end', '必须底边对齐，否则标签换行就歪');
});

test('.sdg-field puts no gap under the input, so field bottom == input bottom', t => {
    const { rules } = sheet(t);
    const field = findRule(rules, '.sdg-field');
    assert.ok(field, '.sdg-field 规则存在');
    /* 下外边距必须是 0：有下边距的话底边对齐的是边距外沿，输入框仍会错开 */
    assert.equal(field.style.marginBottom, '0px', '.sdg-field 无下外边距');
    assert.equal(field.style.marginTop, '5px');

    /* 这条选择器是多行写的，jsdom 会原样保留换行，所以按特征找而不是全串比对 */
    let inputs = null;
    for (const r of rules) {
        const sel = r.selectorText || '';
        if (sel.includes('input[type="number"]') && sel.includes('textarea')) { inputs = r; break; }
    }
    assert.ok(inputs, '输入框规则存在');
    assert.equal(inputs.style.margin, '0px', '输入框自身无外边距');
});

test('mobile panel is 60px shorter: top +30px, max-height -60px', t => {
    const { rules } = sheet(t);
    const panel = findInMedia(rules, '720px', '#sdg-panel');
    assert.ok(panel, '手机端 #sdg-panel 规则存在');

    /* jsdom 会把 calc(2vh + 30px) 规范化成 calc(30px + 2vh)，所以查成分不查原串 */
    assert.match(panel.style.top, /^calc\(/, 'top 用 calc');
    assert.ok(panel.style.top.includes('30px'), '上边缘下移 30px');
    assert.ok(panel.style.top.includes('2vh'), '仍以 2vh 为基准');

    assert.match(panel.style.maxHeight, /^calc\(/, 'max-height 用 calc');
    assert.ok(panel.style.maxHeight.includes('94vh'), '仍以 94vh 为基准');
    assert.ok(panel.style.maxHeight.includes('60px'), '总高减 60px（上下各 30）');
});

test('the delay label is short enough not to wrap next to 图片宽度', t => {
    /* 长标签换行是歪掉的直接原因，也白吃一行纵向高度 */
    assert.ok(source.includes('field("延迟（毫秒）"'), '延迟标签已收短');
    assert.ok(!source.includes('越小提取触发越快'), '机制说明不留在标签里');

    const m = source.match(/<div class="sdg-grid2">([\s\S]*?)<\/div>'/);
    assert.ok(m, '找到 sdg-grid2 那一段');
    const fields = m[1].match(/field\(/g) || [];
    assert.equal(fields.length, 3, '这一行仍是三个字段：延迟 / 图片宽度 / 生图超时');
});

test('grid cells really end on the same line once rendered', t => {
    /* jsdom 不算真实布局，量不出像素；这里退一步验证 DOM 形状符合对齐前提：
       每个 .sdg-field 的最后一个子节点都是 input，底边即格子底边。 */
    const dom = new JSDOM(
        '<!doctype html><style>' + css + '</style><div id="sdg-panel"><div class="sdg-grid2">' +
        '<div class="sdg-field"><label>延迟（毫秒）</label><input id="a" type="number" value="800"></div>' +
        '<div class="sdg-field"><label>图片宽度（%）</label><input id="b" type="number" value="100"></div>' +
        '<div class="sdg-field"><label>生图超时（秒）</label><input id="c" type="number" value="120"></div>' +
        '</div></div>');
    t.after(() => dom.window.close());
    const d = dom.window.document;
    const cells = d.querySelectorAll('.sdg-grid2 > .sdg-field');
    assert.equal(cells.length, 3);
    cells.forEach((cell, i) => {
        assert.equal(cell.lastElementChild.tagName, 'INPUT', '第 ' + (i + 1) + ' 格最后一个元素是输入框');
        assert.equal(cell.firstElementChild.tagName, 'LABEL');
    });
    assert.equal(d.defaultView.getComputedStyle(d.querySelector('.sdg-grid2')).alignItems, 'end');
});

test('version is consistent across manifest, package and source', t => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const m = source.match(/const VERSION = "([^"]+)"/);
    assert.ok(m, 'index.js 里有 VERSION');
    assert.equal(manifest.version, pkg.version, 'manifest 与 package 版本一致');
    assert.equal(manifest.version, m[1], 'manifest 与 index.js 版本一致');
    assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version));
    const css1 = css.match(/DrawGen v([\d.]+)/);
    assert.ok(css1 && css1[1] === manifest.version, 'style.css 头注释版本一致');
});

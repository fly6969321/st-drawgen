/*
 * 稳定性回归（v1.7.3）
 * 盯住三件她实际遇到的事：
 *   ① 标记 image###…### 识别不稳定 —— 模型井号写多写少、全角、漏闭合
 *   ② 注入「落盘」不稳定 —— 酒馆会用 swipe_info[swipe_id].extra 覆盖 msg.extra
 *   ③ 输入框清空后偷偷退回老默认值
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function fixture(t, settings, chat) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only', virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const tasks = [];
    w.setTimeout = fn => (tasks.push(fn), tasks.length);
    w.clearTimeout = () => {};
    w.confirm = () => true;
    let saves = 0;
    const context = { chat: chat || [], extensionSettings: { 'st-drawgen': settings || {} }, saveSettingsDebounced() {}, saveChat() { saves++; } };
    w.SillyTavern = { getContext: () => context };
    w.eval(source);
    tasks.shift()();
    return { w, debug: w.__sdgDebug, ctx: context, settings: context.extensionSettings['st-drawgen'], saveCount: () => saves, flush: () => { while (tasks.length) tasks.shift()(); } };
}

/* ── ① 标记识别 ───────────────────────────────────────────── */

test('findAllTags tolerates hash-count and full-width variants', t => {
    const { debug } = fixture(t);
    /* findAllTags 返回的是 jsdom realm 的数组，deepStrictEqual 会因为 prototype 不同而失败，
       先搬回 Node realm 再比 */
    const inners = txt => Array.from(debug.findAllTags(txt)).map(x => x.inner);

    assert.deepEqual(inners('前文 image###a girl### 中间 image###a cat### 尾'), ['a girl', 'a cat'], '标准写法两个都认');
    assert.deepEqual(inners('image##a girl##'), ['a girl'], '少写一个井号也要认');
    assert.deepEqual(inners('image####a girl####'), ['a girl'], '多写井号不该把 # 带进提示词');
    assert.deepEqual(inners('image＃＃＃a girl＃＃＃'), ['a girl'], '全角井号也要认');
    assert.deepEqual(inners('IMAGE###a girl###'), ['a girl'], '大写也要认');
    assert.deepEqual(inners('<draw>a girl</draw>'), ['a girl'], 'draw 标签照旧');
});

test('a tag missing its closing hashes does not swallow the next tag', t => {
    const { debug } = fixture(t);
    /* 老实现会匹配成一个错标记（inner 里混进 "image"）并把后面那个真标记整个吞掉 */
    const got = Array.from(debug.findAllTags('image###a girl 中间文字 image###a cat###'));
    assert.deepEqual(got.map(x => x.inner), ['a cat'], '残缺的那个丢掉，后面完好的必须留下');
    got.forEach(g => assert.ok(!/image[#＃]/i.test(g.inner), 'inner 里不该混进另一个标记头'));
});

test('tagInner strips hash variants cleanly', t => {
    const { debug } = fixture(t);
    assert.equal(debug.tagInner('image###a girl###'), 'a girl');
    assert.equal(debug.tagInner('image##a girl##'), 'a girl');
    assert.equal(debug.tagInner('image####a dog####'), 'a dog', '多井号不能剩下 #');
    assert.equal(debug.tagInner('image＃＃＃a cat＃＃＃'), 'a cat');
});

test('stripImageTag removes hash variants so the sub-AI never sees last round output', t => {
    const { debug } = fixture(t);
    /* 剥不干净的话，上一轮的提示词会随正文发给副AI，它会照抄 */
    ['剧情 image###a girl###', '剧情 image##a girl##', '剧情 image####a girl####', '剧情 image＃＃＃a girl＃＃＃']
        .forEach(txt => {
            const out = debug.stripImageTag(txt);
            assert.ok(!/image[#＃]/i.test(out), '剥干净: ' + JSON.stringify(txt) + ' → ' + JSON.stringify(out));
            assert.ok(out.includes('剧情'), '正文要留着');
        });
});

/* ── ② 落盘：swipe_info 同步 ──────────────────────────────── */

function msgWithSwipes(mes) {
    return {
        name: 'AI', is_user: false, mes: mes,
        swipe_id: 0, swipes: [mes, '另一个回复'],
        swipe_info: [{ extra: {} }, { extra: {} }],
        extra: {}
    };
}

test('injecting mirrors our records into swipe_info so swiping away cannot wipe them', t => {
    const msg = msgWithSwipes('剧情文字');
    const { debug, ctx } = fixture(t, {}, [msg]);

    const r = debug.injectDescToMessage('a girl in the forest', 0, null);
    assert.ok(r.injected, '注入成功');
    assert.ok(msg.mes.includes('image###'), '正文里有标记');
    assert.equal(msg.swipes[0], msg.mes, 'swipes[swipe_id] 同步了正文');

    /* 关键：酒馆切 swipe 时会拿 swipe_info[swipe_id].extra 覆盖 msg.extra，
       所以我们的记录必须也写在那儿 */
    const si = msg.swipe_info[0].extra;
    assert.equal(si.sdg_desc, 'a girl in the forest', 'sdg_desc 落进 swipe_info');
    assert.ok(si.sdg_tag || si.sdg_env, '标记本身也落进 swipe_info');
    assert.equal(ctx.chat[0], msg);
});

test('restoreSwipeExtra brings records back after SillyTavern overwrites extra', t => {
    const msg = msgWithSwipes('剧情文字');
    const { debug } = fixture(t, {}, [msg]);
    debug.injectDescToMessage('a girl', 0, null);

    /* 模拟酒馆切 swipe：extra 被 swipe_info 那份整个替换掉 */
    const mirrored = JSON.parse(JSON.stringify(msg.swipe_info[0].extra));
    msg.extra = {};
    assert.equal(debug.injectRecord(msg), null, '覆盖后记录确实没了（这就是她看到的"落盘不稳定"）');

    msg.swipe_info[0].extra = mirrored;
    assert.equal(debug.restoreSwipeExtra(msg), true, '补回来了');
    const rec = debug.injectRecord(msg);
    assert.ok(rec, '记录恢复');
    assert.equal(rec.desc, 'a girl');
});

test('restoring merges the gallery instead of clobbering images from other swipes', t => {
    const msg = msgWithSwipes('剧情');
    const { debug } = fixture(t, {}, [msg]);

    msg.extra.sdg_gal = { '1': { '0': { list: ['新图-swipe1'], cur: 0 } } };
    msg.swipe_info[0].extra = { sdg_gal: { '0': { '0': { list: ['旧图-swipe0'], cur: 0 } } } };

    debug.restoreSwipeExtra(msg);
    const g = msg.extra.sdg_gal;
    assert.ok(g['0'] && g['0']['0'], 'swipe_info 里的旧图补进来了');
    assert.ok(g['1'] && g['1']['0'], '内存里别的 swipe 的图没被挤掉');
    assert.equal(g['1']['0'].list[0], '新图-swipe1');
});

test('syncSwipeExtra is a no-op on messages without swipe_info', t => {
    const { debug } = fixture(t);
    const bare = { mes: 'x', extra: { sdg_desc: 'd' } };
    debug.syncSwipeExtra(bare);            /* 不该抛 */
    assert.equal(bare.extra.sdg_desc, 'd');
});

/* ── ③ 输入框清空不许偷偷退回老默认 ───────────────────────── */

test('clearing the delay box falls back to 800, not the old 1800', t => {
    const { w, settings } = fixture(t);
    const el = w.document.querySelector('#sdg-delay');
    assert.ok(el, '延迟框渲染了');

    el.value = '';
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(settings.autoDelay, 800, '清空 → 800（老代码会存成 1800，直接废掉上一轮提速）');
    assert.equal(el.value, '800', '生效值要回显到框里，别让她以为是空的');

    el.value = '0';
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(settings.autoDelay, 800, '填 0 同样退回 800');

    el.value = '50';
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(settings.autoDelay, 100, '低于下限抬到 100');
    assert.equal(el.value, '100', '抬过的值也要回显');

    el.value = '600';
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(settings.autoDelay, 600, '正常值原样存');
});

test('clearing the image-width box falls back to 100, not the old 60', t => {
    const { w, settings } = fixture(t);
    const el = w.document.querySelector('#sdg-imgw');
    el.value = '';
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(settings.imageMaxWidth, 100, '清空 → 100（老代码存 60，图会永久变窄）');
    assert.equal(el.value, '100');

    el.value = '150';
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(settings.imageMaxWidth, 100, '上限封到 100');
});

test('extraction timeout defaults to a finite value and old zeros get migrated', t => {
    const fresh = fixture(t, {});
    assert.equal(fresh.settings.requestTimeout, 180, '新安装默认 180 秒');

    /* 0 = 不限 会在中转站吞连接时把提取锁死（按钮永久灰），属于病根不是偏好 */
    const old = fixture(t, { requestTimeout: 0 });
    assert.equal(old.settings.requestTimeout, 180, '老配置里的 0 抬成 180');

    const custom = fixture(t, { requestTimeout: 90, migrated173: true });
    assert.equal(custom.settings.requestTimeout, 90, '她自己设过的值不动');
});

/* ── 分层 NO_CHANGE 不该静默抹空 ──────────────────────────── */

test('NO_CHANGE with no previous value leaves the layer empty (and is detectable)', t => {
    const { debug } = fixture(t);
    const parsed = { camera: 'NO_CHANGE', env: 'a forest', mood: '', chars: '', outfit: '', pose: '' };
    const merged = debug.mergeLayers(parsed, null, {});
    assert.equal(merged.camera, '', '没有旧值可沿用时该层是空的');
    assert.equal(merged.env, 'a forest');
    /* runExtract 靠 isNoChange + 空值这个组合来提示她，别静默丢层 */
    assert.equal(debug.isNoChange(parsed.camera), true);
    assert.equal(debug.isNoChange(parsed.env), false);
});

test('NO_CHANGE carries the previous value forward when there is one', t => {
    const { debug } = fixture(t);
    const merged = debug.mergeLayers({ camera: 'NO_CHANGE' }, { camera: 'close-up shot' }, {});
    assert.equal(merged.camera, 'close-up shot', '有旧值就沿用');
});

/* ── 提取锁不许圈住生图（最大提速项，必须防回归）───────────── */

test('image generation happens outside the extraction lock', t => {
    const fn = source.slice(source.indexOf('async function runExtract'),
                            source.indexOf('async function generateForFloor'));
    assert.ok(fn.length > 200, '截到了 runExtract');

    const unlock = fn.indexOf('processing = false;');
    const gen = fn.indexOf('await generateForFloor(');
    assert.ok(unlock > 0, '找到解锁');
    assert.ok(gen > 0, '找到生图调用');
    /* 生图原来被圈在锁内到 finally 才解锁，下一楼的提取得干等整张图生完（几十秒），
       runPendingAutoExtract 还每 300ms 空转一次 */
    assert.ok(gen > unlock, '生图必须在解锁之后才调用');
    assert.ok(/pendingGen = \{/.test(fn), '锁内只登记参数，不直接生图');

    /* 生图失败不该再落进提取的 catch 去触发「提取重试」白烧一次提取 */
    const retry = fn.indexOf('scheduleRetry(');
    assert.ok(retry > 0 && retry < gen, 'scheduleRetry 留在提取自己的 catch 里');
});

test('extraction has a watchdog so the lock cannot stay stuck', t => {
    const fn = source.slice(source.indexOf('async function runExtract'),
                            source.indexOf('async function generateForFloor'));
    assert.ok(/guard = setTimeout\(/.test(fn), '有看门狗');
    assert.ok(/if \(guard\) \{ clearTimeout\(guard\)/.test(fn), '正常结束要撤掉看门狗');
});

test('fetchWithTimeout keeps guarding while the body is read', t => {
    const fn = source.slice(source.indexOf('function fetchWithTimeout'),
                            source.indexOf('function normalizeApiBase'));
    /* 之前是 fetch(...).finally(clearTimeout)：headers 一到就撤了闸门，
       站点半途不发 body 就永久挂着 */
    assert.ok(!/\.finally\(function \(\) \{ clearTimeout\(timer\); \}\)/.test(fn),
        '不许在 fetch resolve 时就撤掉超时');
    assert.ok(!/timeoutMs < 30000/.test(fn), '不许把她填的小超时静默抬到 30 秒');
});

test('extraction request caps its output length', t => {
    const fn = source.slice(source.indexOf('async function callSubAI'),
                            source.indexOf('function directHeaders'));
    assert.ok(/max_tokens: \d+/.test(fn), '请求体要封顶输出，不封顶时每多 100 个 token 就多等几秒');
    /* 代理通道也得带上，不然开了代理就等于没封顶 */
    const proxy = fn.slice(fn.indexOf('chat_completion_source'));
    assert.ok(/max_tokens/.test(proxy), '代理通道也要封顶');
});

test('her source text is not truncated below the long-standing 9000 limit', t => {
    const { debug } = fixture(t);
    /* 她的正文确实会很长（一条标记就几千字符）。上限是她的既有行为，
       不许再擅自往下砍 —— 之前砍到 4000 被她当场驳回。 */
    const long = '剧'.repeat(12000);
    const out = debug.trimSourceText(long);
    assert.ok(out.length > 8500, '8500 字以内的正文必须原样送出去，别替她做减法');
    assert.ok(out.includes('正文末尾片段'), '真超长时截断要说明');

    /* 没超上限的正文一个字都不许动 */
    const normal = '剧'.repeat(7000);
    assert.equal(debug.trimSourceText(normal), normal, '7000 字原样不动');

    /* 真截断时留下的必须是最新的尾部，不是开头 */
    const tail = '最后这句必须留着';
    const out2 = debug.trimSourceText('开头'.repeat(6000) + tail);
    assert.ok(out2.includes(tail), '保留的是末尾最新剧情');
});

/* ── 跨段落的长标记必须能变成槽（她 2026-10-12 报的：
      "头尾都有、已经生成过图了，文字形式停在楼层里半天没转成图片"）── */

/* 她截图里那条标记的真实形态：内容跨四段，中间有空行 */
const LONG_INNER = [
    'Main shot: Medium shot from a slightly low angle, composed in depth with Fang Yikai seated in the foreground.',
    'Bubble 1 (largest, POV focus): Extreme close-up of Xin Ruohe\'s piercing eyes looking downward.',
    'Bubble 2 (medium, psychological focus): Extreme close-up of the freshly slapped paper contract.',
    'Bubble 3 (small, POV focus): Extreme close-up of the console\'s LED volume meter in sharp red peaks.'
].join('\n\n');

function floorDom(w, mes) {
    /* 酒馆 messageFormatting 会把空行拆成多个段落 —— 标记就这样被切进了不同文本节点 */
    const doc = w.document;
    const mesEl = doc.createElement('div');
    mesEl.className = 'mes';
    mesEl.setAttribute('mesid', '0');
    const txt = doc.createElement('div');
    txt.className = 'mes_text';
    txt.innerHTML = mes.split('\n\n').map(s => '<p>' + s + '</p>').join('');
    mesEl.appendChild(txt);
    doc.querySelector('#chat').appendChild(mesEl);
    return txt;
}

test('per-node replacement cannot handle a marker split across paragraphs', t => {
    const { w, debug } = fixture(t);
    const el = floorDom(w, 'image###' + LONG_INNER + '###');
    /* 逐个文本节点跑正则，每个节点里只有标记的一截 → 一个槽都建不出来。
       这就是她看到的病状：标记文字赖在楼里，图没地方显示。 */
    assert.equal(debug.replaceMarkersInDom(el), 0, '复现：逐节点替换建不出槽');
    assert.equal(el.querySelectorAll('.sdg-slot').length, 0);
});

test('cross-node replacement turns the split marker into one slot', t => {
    const { w, debug } = fixture(t);
    const el = floorDom(w, 'image###' + LONG_INNER + '###');

    assert.equal(debug.replaceMarkersAcrossNodes(el), 1, '跨节点建出 1 个槽');
    assert.equal(el.querySelectorAll('.sdg-slot').length, 1);

    const tag = el.querySelector('.sdg-slot .sdg-tag').textContent;
    assert.ok(tag.includes('Main shot'), '第一段在');
    assert.ok(tag.includes('Bubble 3'), '最后一段也在（不是只截到第一段）');

    /* 标记头尾都不该再留在正文里 */
    assert.ok(!/image[#＃]{2,}/i.test(el.textContent), '正文里不该再有标记头');
});

test('cross-node replacement handles two split markers in one floor', t => {
    const { w, debug } = fixture(t);
    const el = floorDom(w, 'image###甲\n\n第二段甲###\n\n中间旁白\n\nimage###乙\n\n第二段乙###');
    assert.equal(debug.replaceMarkersAcrossNodes(el), 2, '两条都建出来');
    const tags = Array.from(el.querySelectorAll('.sdg-slot .sdg-tag')).map(x => x.textContent);
    assert.ok(tags[0].includes('甲') && tags[0].includes('第二段甲'));
    assert.ok(tags[1].includes('乙') && tags[1].includes('第二段乙'));
    assert.ok(el.textContent.includes('中间旁白'), '标记之间的正文要留着');
});

test('cross-node replacement leaves surrounding prose alone', t => {
    const { w, debug } = fixture(t);
    const el = floorDom(w, '前面的剧情\n\nimage###甲\n\n乙###\n\n后面的剧情');
    debug.replaceMarkersAcrossNodes(el);
    assert.ok(el.textContent.includes('前面的剧情'), '标记前的正文保留');
    assert.ok(el.textContent.includes('后面的剧情'), '标记后的正文保留');
});

test('cross-node replacement is a no-op when there is no marker', t => {
    const { w, debug } = fixture(t);
    const el = floorDom(w, '就是普通剧情\n\n没有任何标记');
    assert.equal(debug.replaceMarkersAcrossNodes(el), 0, '没标记就别动 DOM');
    assert.equal(el.querySelectorAll('.sdg-slot').length, 0);
    assert.ok(el.textContent.includes('普通剧情'));
});

test('markdown hashes inside the marker body do not cut it short', t => {
    const { debug } = fixture(t);
    /* 上一轮把结束符放宽成「两个以上井号」，正文里的 ## 会把标记提前截断。
       现在首尾井号必须是同一串。 */
    const got = Array.from(debug.findAllTags('image###a girl ## 还有 ### 更多 内容###'));
    assert.equal(got.length, 1);
    assert.ok(got[0].inner.includes('还有'), '内容里的 ## 不该截断标记');
});

test('renderFloorImage shows the image for a marker split across paragraphs', t => {
    const mes = 'image###' + LONG_INNER + '###';
    const msg = {
        name: 'AI', is_user: false, mes: mes,
        swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }],
        extra: { sdg_gal: { '0': { '0': { list: ['data:image/png;base64,AAAA'], cur: 0 } } } }
    };
    const { w, debug } = fixture(t, {}, [msg]);
    const el = floorDom(w, mes);

    /* 端到端：她的实际情形 —— 标记跨段 + 图已经生成好了 */
    assert.equal(debug.renderFloorImage(0), true, '渲染成功');
    const img = el.querySelector('.sdg-slot img.sdg-img') || el.querySelector('img.sdg-img');
    assert.ok(img, '图显示出来了（之前这里什么都不做，文字就赖在楼里）');
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAAA');
});

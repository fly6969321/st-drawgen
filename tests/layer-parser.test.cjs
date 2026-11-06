const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function fixture(t) {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.setTimeout = () => 0;
    w.SillyTavern = { getContext: () => ({ chat: [], extensionSettings: {} }) };
    w.eval(source);
    return w.__sdgDebug;
}

const plain = value => JSON.parse(JSON.stringify(value));

test('标准六层保持独立，服装层及英文描述原样保留', t => {
    const debug = fixture(t);
    const expected = {
        camera: 'A close-up, eye level.', env: 'An office, late afternoon.',
        mood: 'Warm light from the left.', chars: 'A woman with a quiet smile.',
        outfit: 'A blue coat and a loose braid.', pose: 'Her left hand rests on the desk.',
    };
    const text = Object.entries(expected).map(([name, value]) => `<${name}>\n${value}\n</${name}>`).join('\n');
    assert.deepEqual(plain(debug.parseLayers(text)), expected);
});

test('标签大小写及开闭标签内部多余空格不会丢掉对应层', t => {
    const debug = fixture(t);
    assert.deepEqual(plain(debug.parseLayers('< CAMERA >close-up< / camera >\n< OuTfIt\t>blue coat< / OUTFIT\t>')), {
        camera: 'close-up', outfit: 'blue coat',
    });
});

test('缺闭标签止于下一层，最后一层可止于回复末尾', t => {
    const debug = fixture(t);
    const parsed = debug.parseLayers('<camera>close-up\n<env>office</env>\n<chars>a woman\n<outfit>blue coat\n<pose>standing by the desk');
    assert.deepEqual(plain(parsed), {
        camera: 'close-up', env: 'office', chars: 'a woman', outfit: 'blue coat', pose: 'standing by the desk',
    });
    assert.doesNotMatch(debug.joinLayers(parsed), /<\/?(?:camera|env|chars|outfit|pose)>/i);
});

test('外层 Markdown 围栏不会混入缺闭标签的最后一层', t => {
    const debug = fixture(t);
    for (const fence of ['```', '````', '~~~']) {
        const text = `${fence}xml\r\n<camera>close-up</camera>\r\n<pose>standing by the desk\r\n${fence}`;
        assert.deepEqual(plain(debug.parseLayers(text)), { camera: 'close-up', pose: 'standing by the desk' });
    }
});

test('未知标签与相似前缀不被误认成分层，层内普通文字不被改写', t => {
    const debug = fixture(t);
    assert.equal(debug.parseLayers('An office with warm light.'), null);
    assert.equal(debug.parseLayers('<camera_angle>close-up</camera_angle><outfits>blue coat</outfits>'), null);
    assert.equal(debug.parseLayers('```xml\n<scene>office</scene>\n```'), null);
    assert.deepEqual(plain(debug.parseLayers('<chars>a <detail>quiet</detail> woman</chars>')), {
        chars: 'a <detail>quiet</detail> woman',
    });
});

test('容错解析不改变空层、缺层、锁定与 NO_CHANGE 的合并含义', t => {
    const debug = fixture(t);
    const parsed = debug.parseLayers('<camera>\n<env>NO_CHANGE\n<chars></chars>\n<outfit>new outfit</outfit>');
    const previous = { camera: 'old camera', env: 'old room', mood: 'old mood', chars: 'old character', outfit: 'old outfit', pose: 'old pose' };
    assert.deepEqual(plain(debug.mergeLayers(parsed, previous, { outfit: true })), {
        camera: '', env: 'old room', mood: '', chars: '', outfit: 'old outfit', pose: '',
    });
});

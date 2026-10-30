const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const repair = require('../scripts/repair-inline-images.cjs');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'repair-inline-images.cjs');
const PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const DATA = 'data:image/png;base64,' + PNG64;
const STAMP = 1793318400000;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drawgen-repair-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'data', 'default-user', 'chats', 'Character', 'active.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const images = path.join(root, 'data', 'default-user', 'user', 'images', 'DrawGenRecovered');
    return { root, file, images, location: () => repair.discoverFiles(root, file)[0] };
}
function listFiles(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
        ? listFiles(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}

test('stream repair changes only plugin image tokens, preserving exact text, escapes, whitespace and swipe bytes', t => {
    const f = fixture(t);
    const escaped = JSON.stringify(DATA).replace('data:', '\\u0064ata:').replace('image/', 'image\\/').replace('iVB', '\\u0069VB');
    const template = '{ "meta": "中文 \\u4e2d", "extra_note": ' + JSON.stringify(DATA) + ' }\r\n' +
        '{"mes":"unaltered story \\"quote\\" \\n end","swipes":["one","二"],"extra":{' +
        '"sdg_gal":{"0":{"0":{"list":[$A,$B,"https://keep.test/a.png"],"cur":1}},"2":{"3":{"list":[$C],"cur":0}}},' +
        '"sdg_images":{"0":$D},"\\u0073dg_image":$E},"swipe_info":[{"extra":{"sdg_image":$F}}],' +
        '"unrelated":{"image":' + JSON.stringify(DATA) + '},"nums":[0,-0,1.25e+2,true,false,null]}\r\n';
    const tokens = [JSON.stringify(DATA), escaped, JSON.stringify(DATA), JSON.stringify(DATA), JSON.stringify(DATA), JSON.stringify(DATA)];
    const original = template.replace(/\$([A-F])/g, (_, letter) => tokens[letter.charCodeAt(0) - 65]);
    fs.writeFileSync(f.file, original);
    const inspected = repair.transformFile(f.file);
    assert.equal(inspected.inline, 6);
    assert.equal(inspected.unique, 1);
    const result = repair.repairFile(repair.createRun(f.root, STAMP), f.location(), inspected);
    const files = listFiles(f.images);
    assert.equal(files.length, 1, 'identical decoded images share one recovered file');
    assert.deepEqual(fs.readFileSync(files[0]), Buffer.from(PNG64, 'base64'));
    const relative = 'user/images/DrawGenRecovered/' + path.basename(files[0]);
    const expected = template.replace(/\$[A-F]/g, JSON.stringify(relative));
    assert.equal(fs.readFileSync(f.file, 'utf8'), expected, 'all non-target bytes remain unchanged');
    assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
    assert.equal(repair.transformFile(f.file).inline, 0);
    assert.equal(repair.transformFile(f.file).records, 2);
});

test('default CLI inspection writes nothing and scanning includes group chats but skips every backup directory', t => {
    const f = fixture(t);
    const original = JSON.stringify({ extra: { sdg_image: DATA } }) + '\n';
    fs.writeFileSync(f.file, original);
    const group = path.join(f.root, 'data', 'default-user', 'group chats', 'group.jsonl');
    fs.mkdirSync(path.dirname(group), { recursive: true }); fs.writeFileSync(group, original);
    for (const backup of [path.join(f.root, 'data', 'default-user', 'backups', 'old.jsonl'),
        path.join(f.root, 'drawgen-repair-backup-old', 'data', 'default-user', 'chats', 'old.jsonl'),
        path.join(path.dirname(f.file), 'backups', 'nested.jsonl')]) {
        fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, '{BROKEN BACKUP');
    }
    const before = listFiles(f.root).sort();
    assert.deepEqual(repair.discoverFiles(f.root).map(item => item.absolute).sort(), [f.file, group].sort());
    const child = spawnSync(process.execPath, [SCRIPT, '--root', f.root], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /CHECK ONLY/);
    assert.match(child.stdout, /pluginInline=1/);
    assert.match(child.stdout, /SUMMARY files=2/);
    assert.deepEqual(listFiles(f.root).sort(), before);
    assert.equal(fs.existsSync(f.images), false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.doesNotMatch(child.stdout + child.stderr, /iVBOR|BROKEN BACKUP/);
});

test('apply is idempotent and restoring the exact backup preserves image deduplication on another run', t => {
    const f = fixture(t), original = JSON.stringify({ extra: { sdg_image: DATA }, mes: 'restore this exact text' });
    fs.writeFileSync(f.file, original);
    const result = repair.repairFile(repair.createRun(f.root, STAMP), f.location());
    const firstOutput = fs.readFileSync(f.file, 'utf8'), firstImages = listFiles(f.images);
    const second = repair.repairFile(repair.createRun(f.root, STAMP + 1), f.location());
    assert.equal(second.repaired, false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), firstOutput);
    fs.copyFileSync(result.backup, f.file);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    repair.repairFile(repair.createRun(f.root, STAMP + 2), f.location());
    assert.equal(fs.readFileSync(f.file, 'utf8'), firstOutput, 'existing recovered hash is reused even on another recovery date');
    assert.deepEqual(listFiles(f.images), firstImages);
});

test('malformed JSON, incomplete base64 and invalid image signatures never replace the original file', t => {
    const f = fixture(t);
    const cases = [
        JSON.stringify({ extra: { sdg_image: DATA } }) + '\n{"unterminated":',
        JSON.stringify({ extra: { sdg_image: 'data:image/png;base64,' + PNG64.slice(0, -1) } }),
        JSON.stringify({ extra: { sdg_image: 'data:image/png;base64,QUJDRA==' } }),
        '{"extra":{"sdg_image":' + JSON.stringify(DATA) + '},"bad":[1,]}',
        '{"extra":{"sdg_image":' + JSON.stringify(DATA) + '},"bad":"\\q"}',
    ];
    for (const original of cases) {
        fs.writeFileSync(f.file, original);
        const child = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--apply'], { encoding: 'utf8' });
        assert.equal(child.status, 1, child.stdout + child.stderr);
        assert.equal(fs.readFileSync(f.file, 'utf8'), original);
        assert.equal(fs.existsSync(f.images), false);
        assert.doesNotMatch(child.stderr, /iVBOR|QUJDRA/);
    }
});

test('write/commit faults leave the original intact and its verified backup available for restoration', t => {
    const f = fixture(t), original = JSON.stringify({ extra: { sdg_image: DATA }, mes: 'never lose this record' }) + '\n';
    for (const phase of ['afterBackup', 'beforeReplace']) {
        fs.writeFileSync(f.file, original);
        const run = repair.createRun(f.root, STAMP + (phase === 'afterBackup' ? 10 : 11));
        assert.throws(() => repair.repairFile(run, f.location(), undefined, { [phase]() { throw new Error('simulated disk/rename failure'); } }), /simulated/);
        assert.equal(fs.readFileSync(f.file, 'utf8'), original);
        const backup = path.join(run.backupRoot, path.relative(f.root, f.file));
        assert.equal(fs.readFileSync(backup, 'utf8'), original);
        assert.equal(listFiles(path.dirname(f.file)).filter(file => /\.drawgen-.*\.tmp$/.test(file)).length, 0);
        assert.equal(fs.readdirSync(run.backupRoot).some(name => name.startsWith('.staging-')), false);
    }
});

test('a file modified after inspection is not replaced with a stale version', t => {
    const f = fixture(t), original = JSON.stringify({ extra: { sdg_image: DATA } });
    fs.writeFileSync(f.file, original);
    const inspected = repair.transformFile(f.file);
    const newer = original + '\n{"mes":"new message"}\n';
    fs.writeFileSync(f.file, newer);
    assert.throws(() => repair.repairFile(repair.createRun(f.root, STAMP), f.location(), inspected), /changed/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), newer);
});

test('escaped keys, base64 whitespace and token boundaries crossing read chunks remain valid', t => {
    const f = fixture(t);
    const spaced = PNG64.slice(0, 40) + '\n\t ' + PNG64.slice(40);
    const original = '{"padding":' + JSON.stringify('x'.repeat(65500)) + ',"extra":{"\\u0073dg_images":{"0":' +
        JSON.stringify('data:image/png;base64,' + spaced).replace('base64,', 'base64\\u002c') + '}}}\n';
    fs.writeFileSync(f.file, original);
    const info = repair.transformFile(f.file);
    assert.equal(info.inline, 1);
    repair.repairFile(repair.createRun(f.root, STAMP), f.location(), info);
    const output = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(output.padding, 'x'.repeat(65500));
    assert.match(output.extra.sdg_images[0], /^user\/images\/DrawGenRecovered\//);
    assert.deepEqual(fs.readFileSync(listFiles(f.images)[0]), Buffer.from(PNG64, 'base64'));
});

test('exact-file selection cannot reach backups, unrelated files, another root or symlink targets', t => {
    const f = fixture(t); fs.writeFileSync(f.file, '{}\n');
    const backup = path.join(f.root, 'data', 'default-user', 'backups', 'x.jsonl');
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, '{}\n');
    assert.throws(() => repair.discoverFiles(f.root, backup), /active|backup/);
    assert.throws(() => repair.discoverFiles(f.root, path.join(f.root, '..', 'outside.jsonl')), /active/);
    const link = path.join(path.dirname(f.file), 'linked.jsonl');
    try { fs.symlinkSync(backup, link, 'file'); }
    catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return; throw error; }
    assert.throws(() => repair.discoverFiles(f.root, link), /symlink/);
    assert.deepEqual(repair.discoverFiles(f.root).map(item => item.absolute), [f.file]);
});

test('a JSONL record larger than a 64 MiB V8 heap is repaired in a constrained child process', { timeout: 180000 }, t => {
    const f = fixture(t), fd = fs.openSync(f.file, 'w');
    const prefix = '{"mes":"unchanged large-record text","swipes":["一","two"],"other":' + JSON.stringify(DATA) + ',"extra":{"sdg_image":"data:image/png;base64,iVBORw0KGgoA';
    const block = Buffer.from('A'.repeat(64 * 1024));
    try {
        fs.writeSync(fd, prefix);
        for (let i = 0; i < 1440; i++) fs.writeSync(fd, block); // 90 MiB encoded token; never allocated as one string.
        fs.writeSync(fd, '"}}\n');
    } finally { fs.closeSync(fd); }
    const originalSize = fs.statSync(f.file).size, originalHash = repair.hashFile(f.file);
    assert.ok(originalSize > 90 * 1024 * 1024);
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', SCRIPT, '--root', f.root, '--apply'], {
        encoding: 'utf8', timeout: 170000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.error ? String(child.error) : child.stdout + child.stderr);
    assert.match(child.stdout, /repaired=1 failed=0/);
    assert.ok(fs.statSync(f.file).size < 1000);
    const output = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(output.mes, 'unchanged large-record text');
    assert.deepEqual(output.swipes, ['一', 'two']);
    assert.equal(output.other, DATA, 'non-plugin inline image is byte-for-byte unchanged');
    const backups = listFiles(f.root).filter(file => file.includes('drawgen-repair-backup-') && file.endsWith('active.jsonl'));
    assert.equal(backups.length, 1);
    assert.equal(repair.hashFile(backups[0]), originalHash);
    const recovered = path.join(f.root, 'data', 'default-user', output.extra.sdg_image);
    assert.equal(fs.statSync(recovered).size, 9 + 90 * 1024 * 1024 * 3 / 4);
    assert.ok(fs.statSync(recovered).size > 64 * 1024 * 1024, 'the decoded file also exceeds the child heap limit');
});

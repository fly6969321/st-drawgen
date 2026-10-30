#!/usr/bin/env node
'use strict';

// Offline, bounded-memory repair. No dependencies, server, network, or chat-content logging.
// Stop SillyTavern before --apply. Only plugin image string tokens are rewritten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const CHUNK = 64 * 1024;
const IMAGE_FIELDS = new Set(['sdg_gal', 'sdg_images', 'sdg_image']);

function writeAll(fd, data) {
    if (fd == null || !data.length) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}
function hashFile(file) {
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK);
    const fd = fs.openSync(file, 'r');
    try {
        for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, n));
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}
function imageExtension(head) {
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255) return 'jpg';
    if (/^GIF8[79]a$/.test(head.subarray(0, 6).toString('ascii'))) return 'gif';
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    if (head.length >= 2 && head[0] === 66 && head[1] === 77) return 'bmp';
    throw new Error('unsupported or invalid image signature');
}

class Base64Image {
    constructor(context) {
        this.context = context;
        this.carry = '';
        this.ended = false;
        this.bytes = 0;
        this.head = Buffer.alloc(0);
        this.hash = crypto.createHash('sha256');
        this.file = context.stageDir ? path.join(context.stageDir, 'image-' + (++context.sequence) + '.tmp') : null;
        this.fd = this.file ? fs.openSync(this.file, 'wx', 0o600) : null;
    }
    feed(data) {
        // latin1, rather than ascii, makes non-ASCII bytes fail validation instead of masking bit 7.
        let text = typeof data === 'string' ? data : data.toString('latin1');
        if (/[^A-Za-z0-9+/=\t\r\n ]/.test(text)) throw new Error('invalid base64 image character');
        text = text.replace(/[\t\r\n ]/g, '');
        if (!text) return;
        if (this.ended) throw new Error('base64 content after padding');
        text = this.carry + text;
        const length = text.length - text.length % 4;
        this.carry = text.slice(length);
        if (!length) return;
        const whole = text.slice(0, length), padding = whole.indexOf('=');
        if (padding >= 0) {
            const last = whole.slice(-4);
            if (padding < whole.length - 2 || this.carry || !/^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(last)) {
                throw new Error('invalid base64 image padding');
            }
            this.ended = true;
        }
        const decoded = Buffer.from(whole, 'base64');
        if (decoded.toString('base64') !== whole) throw new Error('incomplete or noncanonical base64 image');
        if (this.head.length < 16) this.head = Buffer.concat([this.head, decoded.subarray(0, 16 - this.head.length)]);
        this.hash.update(decoded);
        this.bytes += decoded.length;
        writeAll(this.fd, decoded);
    }
    finish() {
        if (this.carry || !this.bytes) throw new Error('incomplete or empty base64 image');
        const extension = imageExtension(this.head), digest = this.hash.digest('hex');
        if (this.fd != null) { fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null; }
        const ctx = this.context;
        ctx.inline++;
        ctx.imageBytes += this.bytes;
        ctx.unique.add(digest);
        let item = ctx.images.get(digest);
        if (!item) {
            const existing = ctx.existing.get(digest);
            if (existing && hashFile(existing.absolute) === digest) item = existing;
            else {
                const filename = 'sdg_' + ctx.timestamp + '_' + digest + '.' + extension;
                item = { relative: 'images/DrawGenRecovered/' + filename, filename, digest, staged: this.file };
            }
            ctx.images.set(digest, item);
        }
        if (this.file && item.staged !== this.file) fs.unlinkSync(this.file);
        return item.relative;
    }
    close() {
        if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; }
    }
}

// A JSON grammar/tokenizer operating on bytes. Large strings and number tokens are never collected.
// Keys need only a tiny prefix to recognize the three exact plugin field names.
class JsonlTransformer {
    constructor(context, outputFd) {
        this.ctx = context;
        this.output = outputFd;
        this.stack = [];
        this.root = 'value';
        this.mode = null;
        this.line = 1;
        this.offset = 0;
        this.records = 0;
        this.copying = true;
        this.string = null;
    }
    error(message) { throw new Error(message + ' (JSONL line ' + this.line + ', byte ' + this.offset + ')'); }
    parent() { return this.stack[this.stack.length - 1]; }
    scope() {
        const frame = this.parent();
        return !!frame && (frame.scope || (frame.type === 'object' && IMAGE_FIELDS.has(frame.key)));
    }
    completeValue() {
        const frame = this.parent();
        if (frame) frame.state = 'commaOrEnd';
        else { this.root = 'done'; this.records++; }
    }
    startString(key, candidate) {
        this.mode = 'string';
        this.string = { key, keyText: '', state: 'normal', unicode: '', candidate: candidate ? 'prefix' : 'plain', prefix: '', raw: candidate ? [34] : null, image: null };
        if (candidate) this.copying = false;
    }
    decoded(code, index) {
        const s = this.string;
        if (s.key) {
            if (s.keyText.length <= 64) s.keyText += code < 128 ? String.fromCharCode(code) : '?';
            return;
        }
        if (s.candidate === 'image') {
            if (code > 127) this.error('non-ASCII base64 image');
            s.image.feed(String.fromCharCode(code));
            return;
        }
        if (s.candidate !== 'prefix') return;
        s.prefix += String.fromCharCode(code);
        const lower = s.prefix.toLowerCase();
        const possible = lower.length <= 11 ? 'data:image/'.startsWith(lower) : lower.startsWith('data:image/');
        if (possible && lower.endsWith(',') && /^data:image\/[a-z0-9.+-]+;base64,$/.test(lower)) {
            s.candidate = 'image'; s.raw = null; s.image = new Base64Image(this.ctx); return;
        }
        if (!possible || lower.endsWith(',') || s.prefix.length > 96) {
            writeAll(this.output, Buffer.from(s.raw));
            s.raw = null; s.candidate = 'plain'; this.copying = true; this.copyStart = index + 1;
        }
    }
    stringByte(byte, index) {
        const s = this.string;
        if (s.candidate === 'prefix') s.raw.push(byte);
        if (s.state === 'unicode') {
            if (!/[0-9a-f]/i.test(String.fromCharCode(byte))) this.error('invalid Unicode escape');
            s.unicode += String.fromCharCode(byte);
            if (s.unicode.length === 4) { s.state = 'normal'; this.decoded(parseInt(s.unicode, 16), index); }
            return;
        }
        if (s.state === 'escape') {
            if (byte === 117) { s.state = 'unicode'; s.unicode = ''; return; }
            const escapes = { 34: 34, 92: 92, 47: 47, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };
            if (!(byte in escapes)) this.error('invalid JSON string escape');
            s.state = 'normal'; this.decoded(escapes[byte], index); return;
        }
        if (byte === 34) {
            if (s.candidate === 'image') {
                let relative;
                try { relative = s.image.finish(); } catch (error) { this.error(error.message); }
                writeAll(this.output, JSON.stringify(relative));
                this.copying = true; this.copyStart = index + 1;
            } else if (s.candidate === 'prefix') {
                writeAll(this.output, Buffer.from(s.raw));
                this.copying = true; this.copyStart = index + 1;
            }
            this.mode = null;
            if (s.key) { const frame = this.parent(); frame.key = s.keyText; frame.state = 'colon'; }
            else this.completeValue();
            this.string = null;
            return;
        }
        if (byte === 92) { s.state = 'escape'; return; }
        if (byte < 32) this.error('unescaped control character in JSON string');
        this.decoded(byte, index);
    }
    finishNumber() {
        if (!['zero', 'integer', 'fraction', 'exponent'].includes(this.number)) this.error('incomplete JSON number');
        this.mode = null; this.completeValue();
    }
    numberByte(byte) {
        const digit = byte >= 48 && byte <= 57;
        if (this.number === 'minus') {
            if (!digit) this.error('invalid JSON number');
            this.number = byte === 48 ? 'zero' : 'integer'; return true;
        }
        if (this.number === 'integer' && digit) return true;
        if ((this.number === 'integer' || this.number === 'zero') && byte === 46) { this.number = 'dot'; return true; }
        if (this.number === 'dot') {
            if (!digit) this.error('invalid JSON fraction');
            this.number = 'fraction'; return true;
        }
        if (this.number === 'fraction' && digit) return true;
        if (['integer', 'zero', 'fraction'].includes(this.number) && (byte === 101 || byte === 69)) { this.number = 'exp'; return true; }
        if (this.number === 'exp' && (byte === 43 || byte === 45)) { this.number = 'expSign'; return true; }
        if (this.number === 'exp' || this.number === 'expSign') {
            if (!digit) this.error('invalid JSON exponent');
            this.number = 'exponent'; return true;
        }
        if (this.number === 'exponent' && digit) return true;
        this.finishNumber(); return false;
    }
    process(buffer, position) {
        this.copyStart = 0;
        for (let i = 0; i < buffer.length;) {
            const byte = buffer[i]; this.offset = position + i;
            if (this.mode === 'string') {
                const s = this.string;
                if (s.candidate === 'image' && s.state === 'normal' && byte !== 34 && byte !== 92 && byte >= 32) {
                    let end = i + 1;
                    while (end < buffer.length && buffer[end] !== 34 && buffer[end] !== 92 && buffer[end] >= 32) end++;
                    try { s.image.feed(buffer.subarray(i, end)); } catch (error) { this.error(error.message); }
                    i = end; continue;
                }
                this.stringByte(byte, i); i++; continue;
            }
            if (this.mode === 'number') { if (this.numberByte(byte)) i++; continue; }
            if (this.mode === 'literal') {
                if (this.literalIndex < this.literal.length) {
                    if (byte !== this.literal.charCodeAt(this.literalIndex++)) this.error('invalid JSON literal');
                    i++; continue;
                }
                this.mode = null; this.completeValue(); continue;
            }
            if (position + i === 0 && buffer.length >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191) { i += 3; continue; }
            if (byte === 32 || byte === 9 || byte === 13) { i++; continue; }
            if (byte === 10) {
                if (this.stack.length) this.error('record spans multiple physical lines');
                this.root = 'value'; this.line++; i++; continue;
            }
            const frame = this.parent(), state = frame ? frame.state : this.root;
            if (state === 'done') this.error('multiple JSON values on one line');
            if (state === 'colon') {
                if (byte !== 58) this.error('missing JSON colon');
                frame.state = 'value'; i++; continue;
            }
            if (state === 'commaOrEnd') {
                if (byte === 44) { frame.state = frame.type === 'object' ? 'key' : 'value'; i++; continue; }
                if ((frame.type === 'object' && byte === 125) || (frame.type === 'array' && byte === 93)) {
                    this.stack.pop(); this.completeValue(); i++; continue;
                }
                this.error('missing JSON comma or closing delimiter');
            }
            if (state === 'keyOrEnd' || state === 'key') {
                if (state === 'keyOrEnd' && byte === 125) { this.stack.pop(); this.completeValue(); i++; continue; }
                if (byte !== 34) this.error('object key is not a JSON string');
                this.startString(true, false); i++; continue;
            }
            if (state === 'valueOrEnd' && byte === 93) { this.stack.pop(); this.completeValue(); i++; continue; }
            if (byte === 123 || byte === 91) {
                if (this.stack.length >= 512) this.error('JSON nesting exceeds 512 levels');
                this.stack.push({ type: byte === 123 ? 'object' : 'array', state: byte === 123 ? 'keyOrEnd' : 'valueOrEnd', scope: this.scope(), key: null });
                i++; continue;
            }
            if (byte === 34) {
                const candidate = this.scope();
                if (candidate && this.copying) writeAll(this.output, buffer.subarray(this.copyStart, i));
                this.startString(false, candidate); i++; continue;
            }
            if (byte === 45 || (byte >= 48 && byte <= 57)) {
                this.mode = 'number'; this.number = byte === 45 ? 'minus' : byte === 48 ? 'zero' : 'integer'; i++; continue;
            }
            if (byte === 116 || byte === 102 || byte === 110) {
                this.mode = 'literal'; this.literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'; this.literalIndex = 1; i++; continue;
            }
            this.error('unexpected JSON token');
        }
        if (this.copying) writeAll(this.output, buffer.subarray(this.copyStart));
    }
    finish() {
        if (this.mode === 'number') this.finishNumber();
        if (this.mode === 'literal') {
            if (this.literalIndex !== this.literal.length) this.error('incomplete JSON literal');
            this.mode = null; this.completeValue();
        }
        if (this.mode || this.stack.length) this.error('incomplete JSON record');
    }
    close() { if (this.string && this.string.image) this.string.image.close(); }
}

function transformFile(file, options = {}) {
    const context = {
        timestamp: options.timestamp || Date.now(), stageDir: options.stageDir || null, sequence: 0,
        images: new Map(), existing: options.existing || new Map(), unique: new Set(), inline: 0, imageBytes: 0,
    };
    const parser = new JsonlTransformer(context, options.outputFd);
    const hash = crypto.createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.allocUnsafe(CHUNK), fd = fs.openSync(file, 'r');
    let size = 0;
    try {
        for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null));) {
            const chunk = buffer.subarray(0, n);
            decoder.decode(chunk, { stream: true });
            hash.update(chunk); parser.process(chunk, size); size += n;
        }
        decoder.decode(); parser.finish();
        return { size, sha256: hash.digest('hex'), records: parser.records, inline: context.inline, unique: context.unique.size, imageBytes: context.imageBytes, images: context.images };
    } finally { parser.close(); fs.closeSync(fd); }
}

function within(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function noSymlinks(root, target) {
    if (!within(root, target)) throw new Error('path is outside the SillyTavern root');
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink paths are not repaired');
    }
}
function fileLocation(root, file) {
    const absolute = path.resolve(file), relative = path.relative(root, absolute), parts = relative.split(path.sep);
    if (!within(root, absolute) || parts.length < 4 || parts[0] !== 'data' || !['chats', 'group chats'].includes(parts[2]) || !/\.jsonl$/i.test(absolute)) {
        throw new Error('--file must identify an active data/<user>/chats or group chats JSONL file');
    }
    if (parts.some(part => /^backups?$/i.test(part) || /^drawgen-repair-backup-/i.test(part))) throw new Error('backup files are never repaired');
    noSymlinks(root, absolute);
    if (!fs.statSync(absolute).isFile()) throw new Error('selected path is not a regular file');
    return { absolute, relative, userRoot: path.join(root, 'data', parts[1]) };
}
function discoverFiles(root, selected) {
    if (selected) return [fileLocation(root, path.isAbsolute(selected) ? selected : path.resolve(root, selected))];
    const files = [], data = path.join(root, 'data');
    if (!fs.existsSync(data)) throw new Error('root/data does not exist');
    noSymlinks(root, data);
    const visit = folder => {
        noSymlinks(root, folder);
        if (!fs.existsSync(folder)) return;
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || /^backups?$/i.test(entry.name) || /^drawgen-repair-backup-/i.test(entry.name)) continue;
            const next = path.join(folder, entry.name);
            if (entry.isDirectory()) visit(next);
            else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) files.push(fileLocation(root, next));
        }
    };
    for (const user of fs.readdirSync(data, { withFileTypes: true })) {
        if (!user.isDirectory() || user.isSymbolicLink()) continue;
        visit(path.join(data, user.name, 'chats'));
        visit(path.join(data, user.name, 'group chats'));
    }
    return files.sort((a, b) => a.relative.localeCompare(b.relative));
}
function recoveredImages(root, userRoot) {
    const directory = path.join(userRoot, 'user', 'images', 'DrawGenRecovered'), existing = new Map();
    noSymlinks(root, directory);
    if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const match = /^sdg_\d+_([a-f0-9]{64})\.(png|jpg|gif|webp|bmp)$/.exec(entry.name);
        if (entry.isFile() && !entry.isSymbolicLink() && match) existing.set(match[1], {
            absolute: path.join(directory, entry.name), relative: 'images/DrawGenRecovered/' + entry.name, digest: match[1],
        });
    }
    return { directory, existing };
}
function createRun(root, timestamp = Date.now()) {
    const suffix = new Date(timestamp).toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    return { root: fs.realpathSync(root), timestamp, backupRoot: path.join(fs.realpathSync(root), 'drawgen-repair-backup-' + suffix) };
}
function repairFile(run, location, inspected, hooks = {}) {
    const original = location.absolute, info = inspected || transformFile(original), stat = fs.statSync(original);
    if (!info.inline) return { repaired: false, info };
    const backup = path.join(run.backupRoot, location.relative);
    noSymlinks(run.root, original); noSymlinks(run.root, backup);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(original, backup, fs.constants.COPYFILE_EXCL);
    const backupFd = fs.openSync(backup, 'r+');
    try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
    if (hashFile(backup) !== info.sha256 || hashFile(original) !== info.sha256) throw new Error('file changed while backing up; original was not replaced');
    const token = crypto.randomBytes(8).toString('hex');
    const temp = path.join(path.dirname(original), '.' + path.basename(original) + '.drawgen-' + token + '.tmp');
    const stageDir = path.join(run.backupRoot, '.staging-' + token);
    fs.mkdirSync(stageDir);
    let outputFd = null;
    try {
        if (hooks.afterBackup) hooks.afterBackup({ original, backup });
        const recovered = recoveredImages(run.root, location.userRoot);
        outputFd = fs.openSync(temp, 'wx', stat.mode & 0o777);
        const result = transformFile(original, { outputFd, stageDir, timestamp: run.timestamp, existing: recovered.existing });
        fs.fsyncSync(outputFd); fs.closeSync(outputFd); outputFd = null;
        if (result.sha256 !== info.sha256) throw new Error('file changed during repair; original was not replaced');
        const verified = transformFile(temp);
        if (verified.inline || verified.records !== info.records) throw new Error('rewritten JSONL verification failed');
        if (hashFile(original) !== info.sha256) throw new Error('file changed before commit; original was not replaced');
        noSymlinks(run.root, recovered.directory);
        fs.mkdirSync(recovered.directory, { recursive: true });
        for (const image of result.images.values()) {
            if (!image.staged) continue;
            const destination = path.join(recovered.directory, image.filename);
            // Exclusive copy never overwrites an existing image, even on Windows.
            try { fs.copyFileSync(image.staged, destination, fs.constants.COPYFILE_EXCL); }
            catch (error) { if (error.code !== 'EEXIST' || hashFile(destination) !== image.digest) throw error; }
            if (hashFile(destination) !== image.digest) throw new Error('recovered image verification failed');
            const imageFd = fs.openSync(destination, 'r+');
            try { fs.fsyncSync(imageFd); } finally { fs.closeSync(imageFd); }
        }
        if (hooks.beforeReplace) hooks.beforeReplace({ original, backup, temp });
        if (hashFile(original) !== info.sha256) throw new Error('file changed before replacement; original was not replaced');
        // Same-directory rename atomically replaces the file. If the OS refuses replacement,
        // leave the original intact; never unlink it as a Windows fallback.
        fs.renameSync(temp, original);
        return { repaired: true, info: result, backup, newSize: verified.size };
    } finally {
        if (outputFd != null) fs.closeSync(outputFd);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
        // Only this run's generated staging directory is removed, never original images/backups.
        if (within(run.backupRoot, stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
    }
}

function main(argv) {
    let root = process.cwd(), selected, apply = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root' && argv[i + 1]) root = argv[++i];
        else if (argv[i] === '--file' && argv[i + 1]) selected = argv[++i];
        else if (argv[i] === '--apply') apply = true;
        else if (argv[i] === '--help' || argv[i] === '-h') {
            console.log('Usage: node scripts/repair-inline-images.cjs --root /path/SillyTavern [--file data/<user>/chats/...jsonl] [--apply]\nDefault: read-only inspection. Stop SillyTavern before --apply.\nOnly active chats and group chats are scanned; backups are skipped.\nApply creates drawgen-repair-backup-<timestamp> under the root before replacing any file.\nTo restore, stop SillyTavern and copy the backup file to its original relative location.\nRecovered image timestamps use the recovery date; DrawGen retention starts from that date.');
            return 0;
        } else throw new Error('unknown or incomplete option: ' + argv[i]);
    }
    const run = createRun(path.resolve(root)), files = discoverFiles(run.root, selected);
    console.log(apply ? 'APPLY: SillyTavern must be stopped. Originals are backed up before replacement.' : 'CHECK ONLY: no files will be changed.');
    let repaired = 0, failures = 0, inline = 0;
    for (const location of files) {
        try {
            const info = transformFile(location.absolute);
            inline += info.inline;
            console.log('CHECK ' + JSON.stringify(location.relative) + ' bytes=' + info.size + ' pluginInline=' + info.inline + ' uniqueImages=' + info.unique);
            if (apply && info.inline) {
                const result = repairFile(run, location, info);
                if (result.repaired) { repaired++; console.log('REPAIRED ' + JSON.stringify(location.relative) + ' bytes=' + result.newSize); }
            }
        } catch (error) {
            failures++;
            console.error('ERROR ' + JSON.stringify(location.relative) + ': ' + error.message);
        }
    }
    if (repaired) console.log('BACKUP ' + JSON.stringify(run.backupRoot) + '\nRecovered filenames use today\'s recovery timestamp; image-retention age restarts today.');
    console.log('SUMMARY files=' + files.length + ' pluginInline=' + inline + ' repaired=' + repaired + ' failed=' + failures);
    return failures ? 1 : 0;
}

module.exports = { transformFile, hashFile, discoverFiles, createRun, repairFile, main };
if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) { console.error('ERROR: ' + error.message); process.exitCode = 1; }
}

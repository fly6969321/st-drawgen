const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=';
const PNG = Buffer.from(PNG_BASE64, 'base64');
const DATA = 'data:image/png;base64,' + PNG_BASE64;
const REMOTE = 'https://cdn.test/render/one.png?token=a%2Bb&expires=123&sig=x%2Fy%3D';
const LOCAL = 'images/Test/sdg_1793145600000_saved.png';

function fixture(t, overrides = {}, { server = true } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body>', {
        url: 'https://tavern.test/', runScripts: 'outside-only',
        virtualConsole: new VirtualConsole().on('jsdomError', error => { throw error; }),
    });
    t.after(() => dom.window.close());
    const w = dom.window, timers = new Map();
    let timerId = 0;
    w.setTimeout = (fn, ms = 0) => { timers.set(++timerId, { fn, ms }); return timerId; };
    w.clearTimeout = id => timers.delete(id);
    // jsdom Blob deliberately omits this modern method; use its real FileReader.
    if (!w.Blob.prototype.arrayBuffer) w.Blob.prototype.arrayBuffer = function () {
        const blob = this;
        return new Promise((resolve, reject) => {
            const reader = new w.FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    };
    const settings = Object.assign({
        sdgBuiltinSeeded17: true, genEndpoint: 'https://images.test/v1', genModel: 'test-image-model',
        genKey: 'test-api-key', genProxy: false, genTimeout: 300,
        genFixedPrompt: '', genPostfixPrompt: '', convertToJpeg: false,
    }, overrides);
    const context = { chat: [], extensionSettings: { 'st-drawgen': settings }, saveSettingsDebounced() {} };
    if (server) context.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' });
    w.SillyTavern = { getContext: () => context };
    const calls = [];
    let respond = () => { throw new Error('Unexpected network request'); };
    w.fetch = async (url, options = {}) => {
        const call = { url: String(url), options };
        calls.push(call);
        return respond(call);
    };
    w.eval(source);
    const [initId, init] = timers.entries().next().value;
    timers.delete(initId); init.fn();
    function response(body, { status = 200, type = 'application/json' } = {}) {
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        return {
            ok: status >= 200 && status < 300, status,
            headers: { get: key => key.toLowerCase() === 'content-type' ? type : null },
            blob: async () => new w.Blob([bytes], { type }),
            arrayBuffer: async () => Uint8Array.from(bytes).buffer,
            text: async () => bytes.toString('utf8'),
            json: async () => JSON.parse(bytes.toString('utf8')),
        };
    }
    return {
        w, ctx: context, settings, calls, response, debug: w.__sdgDebug,
        respond(fn) { respond = fn; },
        image: (bytes = PNG, type = 'image/png') => response(bytes, { type }),
        generated: (url = REMOTE) => response({ choices: [{ message: { content: '![](' + url + ')' } }] }),
    };
}

function header(options, name) {
    const headers = options.headers || {};
    if (typeof headers.get === 'function') return headers.get(name);
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
}
function assertNoProviderSecrets(options) {
    assert.ok(!header(options, 'Authorization'), 'CDN downloads must not receive the generation API key');
    assert.ok(!header(options, 'Cookie'), 'downloads must not explicitly forward the Tavern session cookie');
    assert.ok(!JSON.stringify(options.headers || {}).includes('test-api-key'));
}

test('a signed CDN URL is downloaded unchanged and uploaded as independent image bytes', async t => {
    const f = fixture(t);
    f.respond(call => {
        if (call.url === REMOTE) {
            assertNoProviderSecrets(call.options);
            return f.image();
        }
        assert.equal(call.url, '/api/images/upload');
        const body = JSON.parse(call.options.body);
        assert.equal(body.image, PNG_BASE64, 'upload must contain image bytes, never the API URL');
        assert.equal(body.format, 'png');
        assert.match(body.filename, /^sdg_\d+_/);
        assert.equal(header(call.options, 'X-CSRF-Token'), 'test-csrf');
        return f.response({ path: '/' + LOCAL });
    });
    assert.equal(await f.debug.persistGenImage(REMOTE), LOCAL);
    assert.deepEqual(f.calls.map(call => call.url), [REMOTE, '/api/images/upload']);
});

test('CORS download failure falls back to the Tavern proxy without modifying the signed URL or sending provider credentials', async t => {
    const f = fixture(t);
    f.ctx.getRequestHeaders = () => ({ 'X-CSRF-Token': 'test-csrf', Authorization: 'Basic server-only', Cookie: 'session=server-only' });
    f.respond(call => {
        if (call.url === REMOTE) throw new TypeError('Failed to fetch');
        assert.equal(call.url, '/proxy/' + encodeURIComponent(REMOTE));
        assert.equal(decodeURIComponent(call.url.slice('/proxy/'.length)), REMOTE);
        assertNoProviderSecrets(call.options);
        assert.equal(header(call.options, 'X-CSRF-Token'), 'test-csrf', 'only the proxy-local CSRF header is retained');
        return f.image();
    });
    assert.equal(await f.debug.normalizeImageToDataUrl(REMOTE), DATA);
    assert.equal(f.calls.length, 2);
});

test('valid PNG bytes with an octet-stream response are saved using their actual image format', async t => {
    const f = fixture(t);
    f.respond(() => f.image(PNG, 'application/octet-stream'));
    assert.equal(await f.debug.normalizeImageToDataUrl(REMOTE), DATA);
});

test('HTML returned with an image content type is rejected rather than saved as a broken image', async t => {
    const f = fixture(t);
    f.respond(() => f.image(Buffer.from('<html><body>Link expired</body></html>'), 'image/png'));
    await assert.rejects(f.debug.normalizeImageToDataUrl(REMOTE), error => {
        assert.equal(error.sdgImageDownload, true);
        assert.equal(error.sdgImageUrl, REMOTE);
        return true;
    });
    assert.ok(!f.calls.some(call => call.url === '/api/images/upload'));
});

test('failed direct and proxy downloads retain source metadata instead of claiming a saved URL', async t => {
    const f = fixture(t);
    f.respond(call => call.url === REMOTE
        ? f.response('gone', { status: 410, type: 'text/plain' })
        : f.response('proxy disabled', { status: 404, type: 'text/plain' }));
    await assert.rejects(f.debug.normalizeImageToDataUrl(REMOTE), error => {
        assert.equal(error.sdgImageDownload, true);
        assert.equal(error.sdgImageUrl, REMOTE);
        return true;
    });
    assert.equal(f.calls.length, 2);
});

for (const mode of ['chat', 'images', 'server-proxy']) {
    test('download failure after a charged ' + mode + ' response never makes another image generation request', async t => {
        const f = fixture(t, mode === 'images'
            ? { genEndpoint: 'https://images.test/v1/images/generations' }
            : mode === 'server-proxy' ? { genProxy: true } : {});
        f.respond(call => {
            if (call.url.endsWith('/images/generations')) return f.response({ data: [{ url: REMOTE }] });
            if (call.url.endsWith('/chat/completions') || call.url === '/api/backends/chat-completions/generate') return f.generated();
            return f.response('expired', { status: 410, type: 'text/plain' });
        });
        await assert.rejects(f.debug.genImageUnified('test scene'), error => {
            assert.equal(error.sdgImageDownload, true, 'the original download failure must reach the caller');
            assert.equal(error.sdgImageUrl, REMOTE);
            return true;
        });
        const generations = f.calls.filter(call => call.options.method === 'POST');
        assert.equal(generations.length, 1, 'image download failure must not spend another generation request');
    });
}

test('the generation result explicitly marks an unavailable local copy as temporary', async t => {
    const f = fixture(t);
    f.respond(call => call.url.endsWith('/chat/completions')
        ? f.generated()
        : f.response('expired', { status: 410, type: 'text/plain' }));
    const result = await f.debug.generateImage('test scene', null);
    assert.equal(result.image, REMOTE, 'keep the already-generated image available for retrying its save');
    assert.equal(result.saved, false, 'the caller must not show a successful local-cache status');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a charged image-edit response with an expired URL does not retry other edit request shapes', async t => {
    const f = fixture(t, { faceRefOn: true, faceRefMode: 'edits', faceRef: DATA });
    // Skip optional canvas conversion through the existing image-load failure fallback.
    f.w.Image = class { set src(value) { queueMicrotask(() => this.onerror()); } };
    f.respond(call => call.url.endsWith('/images/edits')
        ? f.response({ data: [{ url: REMOTE }] })
        : f.response('expired', { status: 410, type: 'text/plain' }));
    const result = await f.debug.generateImage('test edit scene', null);
    assert.equal(result.saved, false);
    assert.equal(result.image, REMOTE);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1, 'the first edit was already charged');
});

test('base64 generation uploads directly without fetching any provider image URL', async t => {
    const f = fixture(t);
    f.respond(call => {
        if (call.url.endsWith('/chat/completions')) return f.generated(DATA);
        assert.equal(call.url, '/api/images/upload');
        assert.equal(JSON.parse(call.options.body).image, PNG_BASE64);
        return f.response({ path: LOCAL });
    });
    const result = await f.debug.generateImage('test scene', null);
    assert.equal(result.image, LOCAL);
    assert.notEqual(result.saved, false);
    assert.deepEqual(f.calls.map(call => call.url), ['https://images.test/v1/chat/completions', '/api/images/upload']);
});

test('upload failure keeps a self-contained image copy instead of falling back to the temporary URL', async t => {
    const f = fixture(t);
    f.respond(call => call.url === REMOTE ? f.image() : f.response('disk unavailable', { status: 500 }));
    assert.equal(await f.debug.persistGenImage(REMOTE), DATA);
    assert.deepEqual(f.calls.map(call => call.url), [REMOTE, '/api/images/upload']);
});

test('an upload response containing another temporary URL cannot replace the downloaded image bytes', async t => {
    const f = fixture(t);
    f.respond(() => f.response({ path: 'https://cdn.test/temporary-upload.png' }));
    assert.equal(await f.debug.persistGenImage(DATA), DATA);
    assert.deepEqual(f.calls.map(call => call.url), ['/api/images/upload']);
});

test('without a server upload API, a base64 image remains self-contained in the gallery', async t => {
    const f = fixture(t, {}, { server: false });
    assert.equal(await f.debug.persistGenImage(DATA), DATA);
    assert.equal(f.calls.length, 0);
});

test('cancelling a download prevents the proxy retry and never returns a temporary success', async t => {
    const f = fixture(t), controller = new f.w.AbortController();
    f.respond(() => {
        controller.abort();
        throw new f.w.DOMException('aborted', 'AbortError');
    });
    await assert.rejects(f.debug.normalizeImageToDataUrl(REMOTE, controller.signal), error => error.name === 'AbortError');
    assert.equal(f.calls.length, 1);
});

test('an internal direct-download timeout can still use the proxy when the generation signal remains active', async t => {
    const f = fixture(t), controller = new f.w.AbortController();
    f.respond(call => {
        if (call.url === REMOTE) throw new f.w.DOMException('download timer expired', 'AbortError');
        assert.equal(call.url, '/proxy/' + encodeURIComponent(REMOTE));
        return f.image();
    });
    assert.equal(await f.debug.normalizeImageToDataUrl(REMOTE, controller.signal), DATA);
    assert.equal(controller.signal.aborted, false);
    assert.equal(f.calls.length, 2, 'the download timer does not cancel the whole generation');
});

test('timeouts from both download routes preserve the original URL for saving later', async t => {
    const f = fixture(t), controller = new f.w.AbortController();
    f.respond(() => { throw new f.w.DOMException('download timer expired', 'AbortError'); });
    await assert.rejects(f.debug.normalizeImageToDataUrl(REMOTE, controller.signal), error => {
        assert.equal(error.sdgImageDownload, true);
        assert.equal(error.sdgImageUrl, REMOTE);
        assert.match(error.message, /超时/);
        return true;
    });
    assert.equal(controller.signal.aborted, false);
    assert.equal(f.calls.length, 2);
});

test('new installs preserve images indefinitely while existing retention choices are respected', t => {
    const fresh = fixture(t);
    assert.equal(fresh.settings.imageKeepDays, 0, 'a fresh install must not silently delete saved images after seven days');
    for (const days of [0, 7, 30, 365]) {
        const existing = fixture(t, { imageKeepDays: days });
        assert.equal(existing.settings.imageKeepDays, days, 'keep the existing ' + days + '-day user setting');
    }
});

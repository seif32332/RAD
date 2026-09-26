// End-to-end tests through HTTP with the real, pinned Typst binary.
// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadFontBundle } from '../src/fonts.mjs';
import { Limiter } from '../src/render.mjs';
import { createServer } from '../src/server.mjs';
import { b64, FONTS_DIR, FONTS_LOCK, fixtureBody, GOLDEN, TOKEN, TYPST_BIN } from './helpers.mjs';

const fonts = await loadFontBundle(FONTS_DIR, FONTS_LOCK);

/** Starts a server on a random port; returns its base URL, tmp dir, logs and a closer. */
async function start({ typstBin = TYPST_BIN, concurrency = 4, queue = 16, timeoutMs = 15_000, maxBodyBytes = 8 * 1024 * 1024 } = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'render-test-'));
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const server = createServer({
    token: TOKEN,
    maxBodyBytes,
    limiter: new Limiter(concurrency, queue),
    fonts,
    typst: { version: '0.15.1', sha256: 'test' },
    renderOptions: { typstBin, fontsDir: FONTS_DIR, tmpDir, timeoutMs, jobs: 2 },
    log: (e) => logs.push(e),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    tmpDir,
    logs,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

/** POST /render with JSON; returns status, headers and body (Buffer). */
async function render(url, body, { token = TOKEN, contentType = 'application/json' } = {}) {
  const res = await fetch(`${url}/render`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const json = (buf) => JSON.parse(buf.toString('utf8'));

describe('radeef-render over HTTP', () => {
  /** @type {Awaited<ReturnType<typeof start>>} */
  let srv;
  before(async () => (srv = await start()));
  after(async () => srv.close());

  test('GET /health reports versions without secrets', async () => {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
    const h = await res.json();
    assert.equal(h.status, 'ok');
    assert.equal(h.typst.version, '0.15.1');
    assert.equal(h.fontsSha256, fonts.bundleSha256);
    assert.ok(!JSON.stringify(h).includes(TOKEN));
  });

  test('golden: the service renders the POC fixture byte-for-byte (determinism, AC-15)', async () => {
    const hashes = new Set();
    for (let i = 0; i < 3; i++) {
      const r = await render(srv.url, fixtureBody('F2-ar-en'));
      assert.equal(r.status, 200, r.body.toString());
      assert.equal(r.headers.get('content-type'), 'application/pdf');
      assert.equal(r.headers.get('x-pdf-sha256'), sha(r.body));
      assert.equal(r.headers.get('x-fonts-sha256'), fonts.bundleSha256);
      hashes.add(sha(r.body));
    }
    assert.deepEqual([...hashes], [GOLDEN['F2-ar-en'].none]);
  });

  test('PDF/A-2b renders and is deterministic', async () => {
    const a = await render(srv.url, fixtureBody('F2-ar-en', { pdfStandard: 'a-2b' }));
    const b = await render(srv.url, fixtureBody('F2-ar-en', { pdfStandard: 'a-2b' }));
    assert.equal(a.status, 200, a.body.toString());
    assert.equal(sha(a.body), sha(b.body));
    assert.equal(sha(a.body), GOLDEN['F2-ar-en']['a-2b']);
    assert.match(a.body.subarray(0, 4000).toString('latin1') + a.body.toString('latin1'), /pdfaid:part/);
  });

  test('Eastern Arabic numerals and injection-looking data render (F5, F7)', async () => {
    for (const f of ['F5-arabnum', 'F7-inject']) {
      const r = await render(srv.url, fixtureBody(f));
      assert.equal(r.status, 200, `${f}: ${r.body.toString()}`);
    }
  });

  test('authentication: missing and wrong tokens are 401', async () => {
    assert.equal((await render(srv.url, fixtureBody('F2-ar-en'), { token: '' })).status, 401);
    assert.equal((await render(srv.url, fixtureBody('F2-ar-en'), { token: TOKEN + 'x' })).status, 401);
    assert.equal((await render(srv.url, fixtureBody('F2-ar-en'), { token: 'short' })).status, 401);
  });

  test('protocol errors: media type, JSON, method, route', async () => {
    assert.equal((await render(srv.url, fixtureBody('F2-ar-en'), { contentType: 'text/plain' })).status, 415);
    const bad = await render(srv.url, '{not json');
    assert.equal(bad.status, 400);
    assert.equal(json(bad.body).error, 'INVALID_JSON');
    assert.equal((await fetch(`${srv.url}/render`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
    assert.equal((await fetch(`${srv.url}/nope`)).status, 404);
  });

  test('template errors and warnings fail the render (warnings are errors)', async () => {
    const err = await render(srv.url, fixtureBody('F2-ar-en', { template: { 'main.typ': b64('#let x = (\n') } }));
    assert.equal(err.status, 422);
    assert.equal(json(err.body).error, 'TEMPLATE_ERROR');

    const warn = await render(srv.url, fixtureBody('F2-ar-en', { template: { 'main.typ': b64('#set text(font: "No Such Font")\nنص') } }));
    assert.equal(warn.status, 422);
    assert.equal(json(warn.body).error, 'RENDER_WARNING');
    assert.match(json(warn.body).detail, /unknown font family/);
  });

  test('templates cannot read outside their own directory', async () => {
    for (const src of ['#read("/etc/passwd")', '#read("../../etc/hostname")']) {
      const r = await render(srv.url, fixtureBody('F2-ar-en', { template: { 'main.typ': b64(src) } }));
      assert.equal(r.status, 422, src);
      assert.equal(json(r.body).error, 'TEMPLATE_ERROR');
    }
  });

  test('every job directory is removed, after success and after failure', () => {
    assert.deepEqual(readdirSync(srv.tmpDir), []);
  });

  test('logs carry codes and sizes, never content', () => {
    const text = JSON.stringify(srv.logs);
    assert.ok(srv.logs.some((l) => l.status === 200 && typeof l.renderMs === 'number'));
    for (const secret of [TOKEN, 'محمد', 'Mohammed', '2456789012', 'unknown font family']) assert.ok(!text.includes(secret), secret);
  });
});

describe('limits', () => {
  test('bodies over the limit are 413 before being parsed', async () => {
    const srv = await start({ maxBodyBytes: 4 * 1024 });
    try {
      const r = await render(srv.url, fixtureBody('F2-ar-en'));
      assert.equal(r.status, 413);
    } finally {
      await srv.close();
    }
  });

  test('beyond concurrency + queue the service answers 503 BUSY with Retry-After', async () => {
    const srv = await start({ concurrency: 1, queue: 0 });
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => render(srv.url, fixtureBody('F2-ar-en'))));
      const codes = results.map((r) => r.status);
      assert.ok(codes.includes(200), String(codes));
      const busy = results.find((r) => r.status === 503);
      assert.ok(busy, String(codes));
      assert.equal(busy.headers.get('retry-after'), '2');
      assert.deepEqual(readdirSync(srv.tmpDir), []);
    } finally {
      await srv.close();
    }
  });

  test('a render that exceeds the timeout is killed (504) and cleaned up', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-typst-'));
    const fake = path.join(dir, 'typst');
    writeFileSync(fake, '#!/bin/sh\nsleep 30\n');
    chmodSync(fake, 0o755);
    const srv = await start({ typstBin: fake, timeoutMs: 1000 });
    try {
      const t0 = Date.now();
      const r = await render(srv.url, fixtureBody('F2-ar-en'));
      assert.equal(r.status, 504);
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual(readdirSync(srv.tmpDir), []);
    } finally {
      await srv.close();
    }
  });

  test('the service environment (token) never reaches Typst', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-typst-'));
    const fake = path.join(dir, 'typst');
    writeFileSync(fake, '#!/bin/sh\nenv 1>&2\nexit 1\n');
    chmodSync(fake, 0o755);
    process.env.RENDER_SERVICE_TOKEN = TOKEN;
    const srv = await start({ typstBin: fake });
    try {
      const r = await render(srv.url, fixtureBody('F2-ar-en'));
      assert.equal(r.status, 422);
      const detail = String(json(r.body).detail);
      assert.ok(!detail.includes(TOKEN) && !detail.includes('RENDER_SERVICE_TOKEN'), detail);
      assert.deepEqual(detail.split('\n').map((l) => l.split('=')[0]).filter(Boolean).sort().filter((k) => !['PWD', 'SHLVL', '_'].includes(k)), ['HOME', 'LANG', 'TZ']);
    } finally {
      delete process.env.RENDER_SERVICE_TOKEN;
      await srv.close();
    }
  });
});

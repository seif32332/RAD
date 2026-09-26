// radeef-render entry point. Refuses to start unless the pinned Typst binary and font bundle are
// exactly the ones the golden tests were produced with.
//
// Environment:
//   RENDER_SERVICE_TOKEN   required, >= 32 characters (shared with the tenants)
//   RENDER_HOST            default 127.0.0.1 (0.0.0.0 only inside a container)
//   RENDER_PORT            default 8091
//   TYPST_BIN              default <service>/bin/typst
//   TYPST_SHA256           expected SHA-256 of TYPST_BIN; default: <TYPST_BIN>.sha256 written by
//                          scripts/fetch-assets.sh (RENDER_ALLOW_UNPINNED=1 only for development)
//   TYPST_VERSION          expected version, default 0.15.1
//   FONTS_DIR / FONTS_LOCK default <service>/fonts, <service>/fonts.lock
//   RENDER_TMP_DIR         default os.tmpdir() (systemd PrivateTmp / container tmpfs)
//   RENDER_CONCURRENCY=4  RENDER_QUEUE=16  RENDER_TIMEOUT_MS=15000  RENDER_MAX_BODY_BYTES=8388608  TYPST_JOBS=2
// @ts-check
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFontBundle } from './fonts.mjs';
import { fileSha256, Limiter, typstVersion } from './render.mjs';
import { createServer } from './server.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

/** @param {string} name @param {number} def @param {number} min @param {number} max */
function intEnv(name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', message }) + '\n');
  process.exit(1);
}

async function main() {
  const token = env.RENDER_SERVICE_TOKEN ?? '';
  if (token.length < 32) fail('RENDER_SERVICE_TOKEN must be set (>= 32 characters)');

  const typstBin = env.TYPST_BIN || path.join(HERE, 'bin', 'typst');
  const expectedVersion = env.TYPST_VERSION || '0.15.1';
  const version = await typstVersion(typstBin).catch((e) => fail(`cannot run ${typstBin}: ${e.message}`));
  if (!new RegExp(`^typst ${expectedVersion.replace(/\./g, '\\.')}\\b`).test(String(version))) {
    fail(`${typstBin} reports "${version}", expected typst ${expectedVersion}`);
  }
  // Expected hash: TYPST_SHA256, else the pin file written by scripts/fetch-assets.sh after it
  // verified the download against typst.lock.
  const sha256 = await fileSha256(typstBin);
  const pinned = (env.TYPST_SHA256 || (await readFile(`${typstBin}.sha256`, 'utf8').catch(() => ''))).trim().toLowerCase();
  if (pinned) {
    if (sha256 !== pinned) fail(`${typstBin} sha256 ${sha256} does not match the pinned ${pinned}`);
  } else if (env.RENDER_ALLOW_UNPINNED !== '1') {
    fail(`no pinned hash for ${typstBin}: set TYPST_SHA256 or install with scripts/fetch-assets.sh`);
  }

  const fontsDir = env.FONTS_DIR || path.join(HERE, 'fonts');
  const fonts = await loadFontBundle(fontsDir, env.FONTS_LOCK || path.join(HERE, 'fonts.lock')).catch((e) => fail(e.message));

  const limiter = new Limiter(intEnv('RENDER_CONCURRENCY', 4, 1, 64), intEnv('RENDER_QUEUE', 16, 0, 1024));
  const server = createServer({
    token,
    maxBodyBytes: intEnv('RENDER_MAX_BODY_BYTES', 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    limiter,
    fonts,
    typst: { version: expectedVersion, sha256 },
    renderOptions: {
      typstBin,
      fontsDir,
      tmpDir: env.RENDER_TMP_DIR || os.tmpdir(),
      timeoutMs: intEnv('RENDER_TIMEOUT_MS', 15_000, 1_000, 120_000),
      jobs: intEnv('TYPST_JOBS', 2, 1, 16),
    },
  });

  const host = env.RENDER_HOST || '127.0.0.1';
  const port = intEnv('RENDER_PORT', 8091, 1, 65535);
  server.listen(port, host, () => {
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(), level: 'info', message: 'radeef-render listening',
      host, port, typst: expectedVersion, typstSha256: sha256, fontsSha256: fonts.bundleSha256,
      concurrency: limiter.concurrency, node: process.version,
    }) + '\n');
  });

  // Graceful stop: no new connections; in-flight renders finish (bounded by the render timeout).
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', message: 'stopping', signal }) + '\n');
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

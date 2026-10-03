#!/usr/bin/env node
/**
 * Radeef HRMS — Radeef's vendor CLI on a tenant host (BL-PAY-017 / BL-PAY-022). Launcher only (ARCH-008): the
 * operations are iam's TypeScript code (src/modules/iam/transitions/vendor.ts, entry src/modules/iam/vendor-cli.ts), compiled by
 * `npm run build:jobs` (part of `npm run build`) into dist/vendor/vendor.cjs. This file loads that bundle, reads
 * ONE JSON request from stdin and prints ONE JSON line. Run by radeef-manage over SSH, inside the tenant's app
 * directory with the tenant's environment:
 *
 *   cd <app> && set -a && . ./.env && set +a && node scripts/vendor.mjs < request.json
 *
 * Exit codes: 0 ok, 1 refused or failed, 2 usage error or missing build.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const bundle = fileURLToPath(new URL('../dist/vendor/vendor.cjs', import.meta.url));

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (!existsSync(bundle)) {
  process.stdout.write(`${JSON.stringify({ ok: false, status: 500, error: 'dist/vendor/vendor.cjs not found: run npm run build:jobs' })}\n`);
  process.exitCode = 2;
} else {
  const { main } = createRequire(import.meta.url)(bundle);
  readStdin()
    .then((input) => main(input))
    .then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        process.stdout.write(`${JSON.stringify({ ok: false, status: 500, error: 'internal error' })}\n`);
        process.exitCode = 1;
      },
    );
}

// Shared test helpers. Integration tests need the pinned Typst binary and fonts
// (scripts/fetch-assets.sh <dir>): TYPST_BIN / FONTS_DIR, defaults ./bin/typst and ./fonts.
// @ts-check
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TYPST_BIN = process.env.TYPST_BIN || path.join(ROOT, 'bin', 'typst');
export const FONTS_DIR = process.env.FONTS_DIR || path.join(ROOT, 'fonts');
export const FONTS_LOCK = path.join(ROOT, 'fonts.lock');
export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
export const ISSUED_AT = 1790413200; // 2026-09-26T09:00:00Z, the POC fixtures' issuance instant

/**
 * Golden SHA-256 of fixture renders. The `none` values are byte-identical to the POC
 * (docs/document-engine/POC.md §A, AC-15): the service renders exactly what was accepted.
 */
export const GOLDEN = {
  'F2-ar-en': {
    none: '5b33c7274cd169b26a0ff54f2e9f6eeaece4446084810dc2b05ce06dbee2b551',
    // Same bytes on Alpine/Node 24 (Docker) and Debian 13/Node 20 (systemd), 2026-09-26.
    'a-2b': '3e05aa9536b237aac483b45469710e884f4fa8ab13b9739e9854fb1433990512',
  },
};

/** A /render body built from a fixture directory (main.typ + data.json + assets). */
export function fixtureBody(name, overrides = {}) {
  const dir = path.join(ROOT, 'test', 'fixtures', name);
  const files = readdirSync(dir);
  /** @type {Record<string, string>} */
  const assets = {};
  for (const f of files) if (/\.(png|svg)$/.test(f)) assets[f] = readFileSync(path.join(dir, f)).toString('base64');
  return {
    templateRef: 'typst:salary-certificate/ar-en@1',
    template: { 'main.typ': readFileSync(path.join(dir, 'main.typ')).toString('base64') },
    data: JSON.parse(readFileSync(path.join(dir, 'data.json'), 'utf8')),
    assets,
    creationTimestamp: ISSUED_AT,
    pdfStandard: 'none',
    ...overrides,
  };
}

/** Base64 of a UTF-8 string. */
export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

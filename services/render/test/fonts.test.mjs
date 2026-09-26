// @ts-check
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleHash, cmapCodepoints, loadFontBundle, parseLock, uncovered } from '../src/fonts.mjs';
import { FONTS_DIR, FONTS_LOCK } from './helpers.mjs';

test('parseLock reads sha / name pairs and rejects malformed lines', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(parseLock(`# c\n${sha}  A.ttf  https://x\n\n`), [{ sha256: sha, name: 'A.ttf' }]);
  assert.throws(() => parseLock('xyz  A.ttf'), /malformed/);
  assert.throws(() => parseLock(`${sha}  ../A.ttf`), /malformed/);
  assert.throws(() => parseLock('# only comments'), /no fonts/);
});

test('bundleHash ignores order, urls and comments', () => {
  const a = { sha256: '1'.repeat(64), name: 'A.ttf' };
  const b = { sha256: '2'.repeat(64), name: 'B.ttf' };
  assert.equal(bundleHash([a, b]), bundleHash([b, a]));
  assert.notEqual(bundleHash([a, b]), bundleHash([a, { ...b, sha256: '3'.repeat(64) }]));
});

test('cmap of IBM Plex Sans Arabic: Arabic, Latin, Eastern digits and separators; no CJK', () => {
  const cps = cmapCodepoints(readFileSync(path.join(FONTS_DIR, 'IBMPlexSansArabic-Regular.ttf')));
  for (const ch of 'شركة أكمي للمقاولات ABCxyz 0123 ٠١٢٣٤٥٦٧٨٩ ٫٬ «» — ،؛؟') {
    if (ch !== ' ') assert.ok(cps.has(/** @type {number} */ (ch.codePointAt(0))), `missing ${ch}`);
  }
  assert.ok(!cps.has(0x4e2d), 'CJK must not be covered');
  assert.ok(!cps.has(0x1f600), 'emoji must not be covered');
});

test('the whole bundle loads and its coverage is the intersection of all weights', async () => {
  const bundle = await loadFontBundle(FONTS_DIR, FONTS_LOCK);
  assert.equal(bundle.files.length, 3);
  assert.match(bundle.bundleSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(uncovered('محمد عبدالله Mohammed ١٣٬٥٠٠٫٥٠\n', bundle.coverage), []);
  assert.deepEqual(uncovered('✓ 中文 😀', bundle.coverage), [0x4e2d, 0x6587, 0x1f600]); // Plex has ✓
});

test('loadFontBundle refuses a tampered font and an extra font file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fonts-'));
  for (const f of parseLock(readFileSync(FONTS_LOCK, 'utf8'))) copyFileSync(path.join(FONTS_DIR, f.name), path.join(dir, f.name));
  await loadFontBundle(dir, FONTS_LOCK); // clean copy loads

  writeFileSync(path.join(dir, 'Extra.ttf'), 'x');
  await assert.rejects(loadFontBundle(dir, FONTS_LOCK), /not in fonts.lock: Extra.ttf/);

  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'fonts-'));
  for (const f of parseLock(readFileSync(FONTS_LOCK, 'utf8'))) copyFileSync(path.join(FONTS_DIR, f.name), path.join(dir2, f.name));
  const victim = path.join(dir2, 'IBMPlexSansArabic-Bold.ttf');
  const buf = readFileSync(victim);
  buf[buf.length - 1] ^= 0xff;
  writeFileSync(victim, buf);
  await assert.rejects(loadFontBundle(dir2, FONTS_LOCK), /does not match fonts.lock/);
});

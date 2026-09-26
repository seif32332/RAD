// Font bundle: verification against fonts.lock and glyph coverage.
//
// Typst silently draws a blank box (exit code 0, no warning) for a character that the fonts do
// not contain, even with `fallback: false` and --ignore-embedded-fonts (docs/document-engine/POC.md
// §C1). So every character that will be rendered is checked here, against the cmap of EVERY
// font in the bundle (a Bold run must be covered as well as a Regular one), before Typst runs.
// @ts-check
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {{ sha256: string, name: string }} LockEntry
 * @typedef {{ files: LockEntry[], bundleSha256: string, coverage: Set<number> }} FontBundle
 */

/** Parses fonts.lock: "<sha256>  <file name>  <source url>" per line, '#' comments. */
export function parseLock(text) {
  /** @type {LockEntry[]} */
  const files = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [sha256, name] = line.split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? '') || !/^[A-Za-z0-9._-]+\.(ttf|otf)$/.test(name ?? '')) {
      throw new Error(`fonts.lock: malformed line: ${raw}`);
    }
    files.push({ sha256, name });
  }
  if (!files.length) throw new Error('fonts.lock lists no fonts');
  return files;
}

/**
 * Identity of the bundle recorded on every issued document (fontsSha256): SHA-256 of the lock
 * entries "<sha256>  <name>\n" sorted by name. Independent of download URLs and comments.
 * @param {LockEntry[]} files
 */
export function bundleHash(files) {
  const canonical = [...files].sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => `${f.sha256}  ${f.name}\n`).join('');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Code points mapped by a TrueType/OpenType font (cmap subtables format 4 and 12; the
 * Unicode ones). Throws on anything it cannot read instead of guessing.
 * @param {Buffer} buf
 * @returns {Set<number>}
 */
export function cmapCodepoints(buf) {
  const u16 = (o) => buf.readUInt16BE(o);
  const u32 = (o) => buf.readUInt32BE(o);
  const numTables = u16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = u32(rec + 8);
  }
  if (cmap < 0) throw new Error('font has no cmap table');

  const out = new Set();
  let used = 0;
  const n = u16(cmap + 2);
  for (let i = 0; i < n; i++) {
    const platform = u16(cmap + 4 + i * 8);
    const encoding = u16(cmap + 6 + i * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const st = cmap + u32(cmap + 8 + i * 8);
    const format = u16(st);
    if (format === 4) {
      const segX2 = u16(st + 6);
      const ends = st + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const offsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(ends + s * 2);
        const start = u16(starts + s * 2);
        const delta = u16(deltas + s * 2);
        const roff = u16(offsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph;
          if (roff === 0) glyph = (c + delta) & 0xffff;
          else {
            const g = u16(offsets + s * 2 + roff + (c - start) * 2);
            glyph = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (glyph !== 0) out.add(c);
        }
      }
      used++;
    } else if (format === 12) {
      const groups = u32(st + 12);
      for (let g = 0; g < groups; g++) {
        const o = st + 16 + g * 12;
        const start = u32(o);
        const end = u32(o + 4);
        const glyph = u32(o + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
      }
      used++;
    }
  }
  if (!used) throw new Error('font has no Unicode cmap subtable of format 4 or 12');
  return out;
}

/**
 * Loads the bundle: every file listed in the lock must exist with the pinned hash (fails the
 * service start otherwise), and no other font file may sit in the directory, because Typst would
 * pick it up as a fallback.
 * @param {string} fontsDir
 * @param {string} lockPath
 * @returns {Promise<FontBundle>}
 */
export async function loadFontBundle(fontsDir, lockPath) {
  const files = parseLock(await readFile(lockPath, 'utf8'));
  const { readdir } = await import('node:fs/promises');
  const present = (await readdir(fontsDir)).filter((f) => /\.(ttf|otf|ttc|otc|woff2?)$/i.test(f));
  const extra = present.filter((f) => !files.some((l) => l.name === f));
  if (extra.length) throw new Error(`fonts dir contains fonts not in fonts.lock: ${extra.join(', ')}`);

  /** @type {Set<number> | null} */
  let coverage = null;
  for (const f of files) {
    const buf = await readFile(path.join(fontsDir, f.name));
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== f.sha256) throw new Error(`font ${f.name}: sha256 ${actual} does not match fonts.lock ${f.sha256}`);
    const cps = cmapCodepoints(buf);
    coverage = coverage ? new Set([...coverage].filter((c) => cps.has(c))) : cps;
  }
  return { files, bundleSha256: bundleHash(files), coverage: /** @type {Set<number>} */ (coverage) };
}

/** Code points that never need a glyph (layout controls). */
const NO_GLYPH = new Set([0x09, 0x0a, 0x0d, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]);

/**
 * Distinct code points of `text` that the bundle cannot draw.
 * @param {string} text
 * @param {Set<number>} coverage
 * @returns {number[]}
 */
export function uncovered(text, coverage) {
  const missing = new Set();
  for (const ch of text) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (!NO_GLYPH.has(cp) && !coverage.has(cp)) missing.add(cp);
  }
  return [...missing].sort((a, b) => a - b);
}

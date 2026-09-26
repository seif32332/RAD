// Request validation for POST /render. Pure functions (no I/O), unit tested.
//
// The caller (a Radeef tenant) is authenticated, but its input still carries user-controlled
// content: employee data, and logo / signature / stamp images uploaded by customers. Everything
// is checked here before anything touches the disk or Typst.
// @ts-check
import { uncovered } from './fonts.mjs';

export const LIMITS = Object.freeze({
  templateFiles: 16,
  templateFileBytes: 256 * 1024,
  assets: 12,
  pngBytes: 2 * 1024 * 1024,
  pngMaxSide: 4096,
  svgBytes: 128 * 1024,
  dataBytes: 1024 * 1024,
  dataDepth: 16,
  stringChars: 20_000,
  // 2000-01-01 .. 2100-01-01: a timestamp outside this range is a caller bug.
  minTimestamp: 946_684_800,
  maxTimestamp: 4_102_444_800,
});

export const PDF_STANDARDS = /** @type {const} */ (['a-2b', 'none']);

/** Error returned to the caller as `{ error: code, detail }` with an HTTP status. */
export class RequestError extends Error {
  /** @param {number} status @param {string} code @param {unknown} [detail] */
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
const bad = (code, detail) => new RequestError(400, code, detail);

/**
 * @typedef {{
 *   templateRef: string,
 *   template: Map<string, Buffer>,
 *   data: unknown,
 *   dataJson: string,
 *   assets: Map<string, Buffer>,
 *   creationTimestamp: number,
 *   pdfStandard: 'a-2b' | 'none',
 * }} RenderJob
 */

// Lower-case, no path separators, no leading dot: nothing can climb out of the work directory.
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}\.typ$/;
const ASSET_NAME = /^[a-z0-9][a-z0-9_-]{0,31}\.(png|svg)$/;
const TEMPLATE_REF = /^typst:[a-z0-9-]{1,64}\/[a-z]{2}(-[a-z]{2})?@[0-9]{1,4}$/;
const RESERVED = new Set(['data.json', 'out.pdf']);

/**
 * Package imports make Typst download from the network (POC.md §F). Templates are reviewed code,
 * so this is defence in depth, as is the network-less sandbox.
 */
const FORBIDDEN_TEMPLATE = [
  { re: /["']@[a-z0-9-]+\//i, why: 'package import (@namespace/...)' },
  { re: /\bsys\s*\.\s*inputs\b/, why: 'sys.inputs (data comes only from data.json)' },
];

/** Strict base64 (no whitespace, correct padding) decoded to a Buffer. */
function decodeBase64(value, field) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw bad('INVALID_BASE64', field);
  }
  return Buffer.from(value, 'base64');
}

/** Valid UTF-8 without NUL; returns the text. */
function utf8(buf, field) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    throw bad('INVALID_TEXT', field);
  }
  if (text.includes('\u0000')) throw bad('INVALID_TEXT', field);
  return text;
}

/**
 * PNG: signature, IHDR first, sane dimensions, IEND present. Typst decodes it; a malformed or
 * oversized ("decompression bomb") image is refused here.
 * @param {Buffer} buf @param {string} name
 */
export function checkPng(buf, name) {
  if (buf.length > LIMITS.pngBytes) throw bad('ASSET_TOO_LARGE', name);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 57 || !buf.subarray(0, 8).equals(sig) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw bad('INVALID_PNG', name);
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w < 1 || h < 1 || w > LIMITS.pngMaxSide || h > LIMITS.pngMaxSide) throw bad('PNG_DIMENSIONS', { name, w, h });
  if (buf.toString('latin1', buf.length - 8, buf.length - 4) !== 'IEND') throw bad('INVALID_PNG', name);
}

/**
 * SVG: only the vector subset a QR code needs. No DOCTYPE / entities (XXE, billion laughs),
 * no processing instructions other than the XML declaration, no references (href), no scripts,
 * styles, images or foreign objects: a strict allow-list of elements and attributes.
 * @param {Buffer} buf @param {string} name
 */
export function checkSvg(buf, name) {
  if (buf.length > LIMITS.svgBytes) throw bad('ASSET_TOO_LARGE', name);
  // Only a real XML declaration ("<?xml version=…?>") is stripped; "<?xml-stylesheet …?>" is not one.
  const text = utf8(buf, name).replace(/^<\?xml\s[^?]*\?>\s*/, '');
  if (/<!|<\?|&/.test(text)) throw bad('SVG_NOT_ALLOWED', { name, reason: 'doctype, entity or processing instruction' });
  const ELEMENTS = new Set(['svg', 'g', 'path', 'rect']);
  const ATTRS = new Set(['xmlns', 'version', 'width', 'height', 'viewBox', 'shape-rendering', 'fill', 'stroke', 'stroke-width', 'd', 'x', 'y', 'transform']);
  const tags = [...text.matchAll(/<\/?\s*([A-Za-z][\w:.-]*)([^>]*)>/g)];
  if (!tags.length || tags[0][1] !== 'svg') throw bad('SVG_NOT_ALLOWED', { name, reason: 'root element must be <svg>' });
  if (text.replace(/<[^>]*>/g, '').trim()) throw bad('SVG_NOT_ALLOWED', { name, reason: 'text content' });
  for (const [, el, attrs] of tags) {
    if (!ELEMENTS.has(el)) throw bad('SVG_NOT_ALLOWED', { name, reason: `element <${el}>` });
    for (const [, attr, value] of attrs.matchAll(/([A-Za-z][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
      if (!ATTRS.has(attr)) throw bad('SVG_NOT_ALLOWED', { name, reason: `attribute ${attr}` });
      if (/url\s*\(|javascript:|data:/i.test(value)) throw bad('SVG_NOT_ALLOWED', { name, reason: `value of ${attr}` });
    }
    // Every attribute must be a plain double-quoted pair (no single quotes, no bare names).
    const leftover = attrs.replace(/([A-Za-z][\w:.-]*)\s*=\s*"[^"]*"/g, '').replace(/\/\s*$/, '').trim();
    if (leftover) throw bad('SVG_NOT_ALLOWED', { name, reason: 'malformed attributes' });
  }
}

/**
 * Walks the data: bounded depth, JSON-safe values only, every string bounded. Returns all
 * string values concatenated for the coverage check.
 */
function walkData(value, depth, strings) {
  if (depth > LIMITS.dataDepth) throw bad('DATA_TOO_DEEP');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw bad('INVALID_DATA', 'non-finite number');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > LIMITS.stringChars) throw bad('DATA_STRING_TOO_LONG');
    // C0/C1 controls other than tab / newline have no place in a document.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) throw bad('INVALID_DATA', 'control character');
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkData(v, depth + 1, strings);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw bad('INVALID_DATA', `key ${JSON.stringify(k).slice(0, 40)}`);
      walkData(v, depth + 1, strings);
    }
    return;
  }
  throw bad('INVALID_DATA');
}

/**
 * Validates a parsed JSON body and returns the job. Coverage failures are 422 (the request is
 * well formed; the content cannot be printed faithfully).
 * @param {unknown} body
 * @param {Set<number>} coverage
 * @returns {RenderJob}
 */
export function validateRenderRequest(body, coverage) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('INVALID_BODY');
  const b = /** @type {Record<string, unknown>} */ (body);
  const known = new Set(['templateRef', 'template', 'data', 'assets', 'creationTimestamp', 'pdfStandard']);
  const unknownKeys = Object.keys(b).filter((k) => !known.has(k));
  if (unknownKeys.length) throw bad('UNKNOWN_FIELDS', unknownKeys);

  if (typeof b.templateRef !== 'string' || !TEMPLATE_REF.test(b.templateRef)) throw bad('INVALID_TEMPLATE_REF');

  if (!Number.isSafeInteger(b.creationTimestamp)) throw bad('INVALID_TIMESTAMP');
  const ts = /** @type {number} */ (b.creationTimestamp);
  if (ts < LIMITS.minTimestamp || ts > LIMITS.maxTimestamp) throw bad('INVALID_TIMESTAMP');

  if (!PDF_STANDARDS.includes(/** @type {any} */ (b.pdfStandard))) throw bad('INVALID_PDF_STANDARD', PDF_STANDARDS);

  // Template files
  if (!b.template || typeof b.template !== 'object' || Array.isArray(b.template)) throw bad('INVALID_TEMPLATE');
  const templateEntries = Object.entries(b.template);
  if (templateEntries.length > LIMITS.templateFiles) throw bad('TOO_MANY_FILES', 'template');
  /** @type {Map<string, Buffer>} */
  const template = new Map();
  /** @type {string[]} */
  const toCover = [];
  for (const [name, content] of templateEntries) {
    if (!TEMPLATE_NAME.test(name)) throw bad('INVALID_FILE_NAME', name);
    const buf = decodeBase64(content, `template/${name}`);
    if (buf.length > LIMITS.templateFileBytes) throw bad('FILE_TOO_LARGE', name);
    const text = utf8(buf, name);
    for (const f of FORBIDDEN_TEMPLATE) if (f.re.test(text)) throw new RequestError(422, 'TEMPLATE_FORBIDDEN', { name, reason: f.why });
    toCover.push(text);
    template.set(name, buf);
  }
  if (!template.has('main.typ')) throw bad('MISSING_MAIN_TYP');

  // Assets
  const rawAssets = b.assets ?? {};
  if (typeof rawAssets !== 'object' || Array.isArray(rawAssets)) throw bad('INVALID_ASSETS');
  const assetEntries = Object.entries(rawAssets);
  if (assetEntries.length > LIMITS.assets) throw bad('TOO_MANY_FILES', 'assets');
  /** @type {Map<string, Buffer>} */
  const assets = new Map();
  for (const [name, content] of assetEntries) {
    if (!ASSET_NAME.test(name) || RESERVED.has(name) || template.has(name)) throw bad('INVALID_FILE_NAME', name);
    const buf = decodeBase64(content, `assets/${name}`);
    if (name.endsWith('.png')) checkPng(buf, name);
    else checkSvg(buf, name);
    assets.set(name, buf);
  }

  // Data
  if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw bad('INVALID_DATA', 'data must be an object');
  /** @type {string[]} */
  const strings = [];
  walkData(b.data, 0, strings);
  const dataJson = JSON.stringify(b.data);
  if (Buffer.byteLength(dataJson) > LIMITS.dataBytes) throw bad('DATA_TOO_LARGE');

  const missing = uncovered(strings.join('\n') + '\n' + toCover.join('\n'), coverage);
  if (missing.length) {
    throw new RequestError(422, 'UNSUPPORTED_CHARACTERS', missing.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`));
  }

  return {
    templateRef: b.templateRef,
    template,
    data: b.data,
    dataJson,
    assets,
    creationTimestamp: ts,
    pdfStandard: /** @type {'a-2b' | 'none'} */ (b.pdfStandard),
  };
}

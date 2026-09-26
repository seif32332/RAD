// Document engine: pure primitives (no I/O). docs/document-engine/ADR-001.
//
// - Canonical JSON (RFC 8785 subset): the snapshot text whose SHA-256 is recorded and compared.
// - Document numbers (DOC-02): <prefix>-<TYPE>-<YYYY>-<000000>, never derived from a timestamp.
// - Verification tokens (DOC-06): 128-bit random, base32; only their SHA-256 is stored.
// - Arabic diacritics removal (render model, ADR DOC-01 / POC §B2).
import { createHash, randomBytes } from 'crypto';

export type Canonical = null | boolean | number | string | Canonical[] | { [k: string]: Canonical };

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, numbers restricted to
 * safe integers (amounts are decimal strings, dates ISO strings), `undefined` dropped from objects.
 * The same value always gives the same text, so its hash can be recomputed and compared.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`canonicalJson: only safe integers are allowed (got ${value}); use decimal strings`);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Numbering (DOC-02)
// ---------------------------------------------------------------------------

export const PREFIX_RE = /^[A-Z]{2,6}$/;
export const TYPE_CODE_RE = /^[A-Z]{3}$/;

export function formatDocumentNumber(prefix: string, typeCode: string, year: number, seq: number): string {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid number prefix: ${prefix}`);
  if (!TYPE_CODE_RE.test(typeCode)) throw new Error(`invalid type code: ${typeCode}`);
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new Error(`invalid year: ${year}`);
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999) throw new Error(`sequence out of range: ${seq}`);
  return `${prefix}-${typeCode}-${year}-${String(seq).padStart(6, '0')}`;
}

/** Calendar year of an instant in Asia/Riyadh (UTC+3, no DST): the numbering year. */
export function riyadhYear(d: Date): number {
  return new Date(d.getTime() + 3 * 3600 * 1000).getUTCFullYear();
}

/** YYYY-MM-DD of an instant in Asia/Riyadh. */
export function riyadhDate(d: Date): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Verification tokens (DOC-06)
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOKEN_RE = /^[A-Z2-7]{26}$/;

/** 26 base32 characters carrying 128 random bits (+2 zero bits). */
export function newVerifyToken(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

export function hashVerifyToken(token: string): string {
  return sha256Hex(`radeef-document-verify:${token}`);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Arabic harakat / tanween / superscript alef (U+064B–U+065F, U+0670). */
const ARABIC_MARKS = /[ً-ٰٟ]/g;

/** Removes Arabic diacritics from every string in a JSON-like value (letters are unchanged). */
export function stripArabicMarks<T>(value: T): T {
  if (typeof value === 'string') return value.replace(ARABIC_MARKS, '') as T;
  if (Array.isArray(value)) return value.map((v) => stripArabicMarks(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripArabicMarks(v)])) as T;
  }
  return value;
}

/** Decimal string with exactly two fraction digits from a stored amount (Float in the schema). */
export function toAmountString(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return (Math.round(v * 100) / 100).toFixed(2);
}

/** Sum of decimal strings, exact to the halala. */
export function sumAmounts(values: readonly string[]): string {
  const halalas = values.reduce((s, v) => s + Math.round(Number(v) * 100), 0);
  return (halalas / 100).toFixed(2);
}

// Field-level encryption for secrets stored in the database (e.g. GovPlatform.password).
// AES-256-GCM, 12-byte IV.
//
// Ciphertext formats:
//   new : "enc:v2:<kid>:<iv b64>:<tag b64>:<data b64>"  (kid = DATA_ENCRYPTION_KEY_ID, default 'k1')
//   old : "enc:v1:<iv b64>:<tag b64>:<data b64>"        (no key id; read with the current key)
// Values without an "enc:" prefix are legacy plaintext and returned as-is by decryptField.
//
// Keys (DEC-008):
//   - DATA_ENCRYPTION_KEY: 64 hex chars or base64 of 32 bytes (any other value is SHA-256 hashed).
//   - In production (NODE_ENV=production) a missing DATA_ENCRYPTION_KEY FAILS CLOSED: there is no
//     SESSION_SECRET fallback, so rotating the session secret can never make stored secrets unreadable.
//     A tenant that ran on the old SESSION_SECRET-derived key keeps its data readable by setting
//     DATA_ENCRYPTION_KEY to that same key once:  sha256("radeef-data-key:" + SESSION_SECRET) as hex
//     (see scripts/encrypt-gov-passwords.mjs).
//   - Outside production the old fallbacks remain (SESSION_SECRET-derived, then a fixed dev key).
//   - Rotation: a v2 value whose kid is not the current DATA_ENCRYPTION_KEY_ID is decrypted with
//     DATA_ENCRYPTION_KEY_<KID> (kid upper-cased, '-' -> '_'), e.g. DATA_ENCRYPTION_KEY_K0.
import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_KEY_ID = 'k1';

/** Normalizes a configured key value to 32 bytes (hex / base64 of 32 bytes, else SHA-256 of the text). */
export function keyFromSecret(raw: string): Buffer {
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(raw).digest();
}

/** Current key id for new ciphertexts (DATA_ENCRYPTION_KEY_ID, default 'k1'). */
export function currentKeyId(): string {
  const kid = process.env.DATA_ENCRYPTION_KEY_ID?.trim() || DEFAULT_KEY_ID;
  if (!KID_RE.test(kid)) throw new Error('DATA_ENCRYPTION_KEY_ID must match [A-Za-z0-9_-]{1,32}');
  return kid;
}

/** The current data key. Throws in production when DATA_ENCRYPTION_KEY is missing (fail closed). */
function getCurrentKey(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) return keyFromSecret(raw);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY must be set in production (no fallback to SESSION_SECRET)');
  }
  // Development / test only: keeps local data encrypted with the old derivation readable.
  const fallback = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (fallback) return createHash('sha256').update(`radeef-data-key:${fallback}`).digest();
  return createHash('sha256').update('dev-only-insecure-data-key').digest();
}

/** Key for a key id found in a v2 ciphertext. */
function getKeyById(kid: string): Buffer {
  if (kid === currentKeyId()) return getCurrentKey();
  const raw = process.env[`DATA_ENCRYPTION_KEY_${kid.toUpperCase().replace(/-/g, '_')}`];
  if (!raw) throw new Error(`Unknown data encryption key id "${kid}" (set DATA_ENCRYPTION_KEY_${kid.toUpperCase()})`);
  return keyFromSecret(raw);
}

export function isEncrypted(value: string | null | undefined): boolean {
  return !!value && (value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1));
}

/** Pure: AES-256-GCM encryption into the v2 format with an explicit key id and key. */
export function encryptWithKey(plain: string, kid: string, key: Buffer): string {
  if (!KID_RE.test(kid)) throw new Error('invalid key id');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX_V2}${kid}:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function gcmDecrypt(key: Buffer, ivB64: string, tagB64: string, dataB64: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Pure: decrypts a v1 or v2 value. `keyFor(kid)` returns the key for a v2 key id; v1 values
 * (no key id) are decrypted with `keyFor(null)`.
 */
export function decryptWithKeys(value: string, keyFor: (kid: string | null) => Buffer): string {
  if (value.startsWith(PREFIX_V2)) {
    const parts = value.slice(PREFIX_V2.length).split(':');
    if (parts.length !== 4 || !KID_RE.test(parts[0])) throw new Error('malformed enc:v2 value');
    const [kid, iv, tag, data] = parts;
    return gcmDecrypt(keyFor(kid), iv, tag, data);
  }
  if (value.startsWith(PREFIX_V1)) {
    const parts = value.slice(PREFIX_V1.length).split(':');
    if (parts.length !== 3) throw new Error('malformed enc:v1 value');
    const [iv, tag, data] = parts;
    return gcmDecrypt(keyFor(null), iv, tag, data);
  }
  throw new Error('not an encrypted value');
}

/** Encrypts with the current key (v2 format). Already-encrypted values are returned unchanged. */
export function encryptField(plain: string): string {
  if (isEncrypted(plain)) return plain;
  return encryptWithKey(plain, currentKeyId(), getCurrentKey());
}

export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value; // legacy plaintext
  return decryptWithKeys(value, (kid) => (kid === null ? getCurrentKey() : getKeyById(kid)));
}

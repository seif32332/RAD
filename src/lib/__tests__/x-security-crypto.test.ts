import { createCipheriv, createHash, randomBytes } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptField, decryptWithKeys, encryptField, encryptWithKey, isEncrypted, keyFromSecret } from '@/lib/crypto';

const HEX_KEY = 'a'.repeat(64);
const OTHER_HEX_KEY = 'b'.repeat(64);

/** Builds a value in the old v1 format exactly as the previous crypto.ts did. */
function encryptV1(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('crypto v2 format', () => {
  it('writes enc:v2:<kid>: with the default key id k1 and round-trips', () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', HEX_KEY);
    vi.stubEnv('DATA_ENCRYPTION_KEY_ID', '');
    const c = encryptField('سر 123');
    expect(c.startsWith('enc:v2:k1:')).toBe(true);
    expect(c.split(':')).toHaveLength(6);
    expect(isEncrypted(c)).toBe(true);
    expect(decryptField(c)).toBe('سر 123');
  });

  it('uses DATA_ENCRYPTION_KEY_ID as the key id', () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', HEX_KEY);
    vi.stubEnv('DATA_ENCRYPTION_KEY_ID', 'k2');
    expect(encryptField('x').startsWith('enc:v2:k2:')).toBe(true);
  });

  it('rejects an invalid key id', () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', HEX_KEY);
    vi.stubEnv('DATA_ENCRYPTION_KEY_ID', 'bad:id');
    expect(() => encryptField('x')).toThrow();
  });

  it('does not re-encrypt v1 or v2 values', () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', HEX_KEY);
    const v2 = encryptField('x');
    expect(encryptField(v2)).toBe(v2);
    const v1 = encryptV1('x', keyFromSecret(HEX_KEY));
    expect(encryptField(v1)).toBe(v1);
  });

  it('decrypts an old key id with DATA_ENCRYPTION_KEY_<KID> after rotation', () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', OTHER_HEX_KEY);
    vi.stubEnv('DATA_ENCRYPTION_KEY_ID', 'k1');
    const old = encryptField('rotated');
    vi.stubEnv('DATA_ENCRYPTION_KEY', HEX_KEY);
    vi.stubEnv('DATA_ENCRYPTION_KEY_ID', 'k2');
    expect(() => decryptField(old)).toThrow(/Unknown data encryption key id/);
    vi.stubEnv('DATA_ENCRYPTION_KEY_K1', OTHER_HEX_KEY);
    expect(decryptField(old)).toBe('rotated');
  });

  it('fails authentication with the wrong key', () => {
    const c = encryptWithKey('x', 'k1', keyFromSecret(HEX_KEY));
    expect(() => decryptWithKeys(c, () => keyFromSecret(OTHER_HEX_KEY))).toThrow();
  });

  it('rejects malformed values', () => {
    expect(() => decryptWithKeys('enc:v2:k1:only', () => keyFromSecret(HEX_KEY))).toThrow(/malformed/);
    expect(() => decryptWithKeys('enc:v1:a:b', () => keyFromSecret(HEX_KEY))).toThrow(/malformed/);
  });
});

describe('crypto v1 compatibility', () => {
  it('still reads enc:v1 values written with DATA_ENCRYPTION_KEY', () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', HEX_KEY);
    const v1 = encryptV1('legacy secret', keyFromSecret(HEX_KEY));
    expect(isEncrypted(v1)).toBe(true);
    expect(decryptField(v1)).toBe('legacy secret');
  });

  it('reads v1 values of a tenant that moved its SESSION_SECRET-derived key into DATA_ENCRYPTION_KEY', () => {
    const derived = createHash('sha256').update('radeef-data-key:old-session-secret').digest();
    const v1 = encryptV1('gov password', derived);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'old-session-secret');
    vi.stubEnv('DATA_ENCRYPTION_KEY', derived.toString('hex'));
    expect(decryptField(v1)).toBe('gov password');
  });

  it('returns legacy plaintext and null as-is', () => {
    expect(decryptField('plain')).toBe('plain');
    expect(decryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeNull();
  });
});

describe('production fails closed', () => {
  it('throws when DATA_ENCRYPTION_KEY is missing, even with SESSION_SECRET set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATA_ENCRYPTION_KEY', '');
    vi.stubEnv('SESSION_SECRET', 'some-session-secret');
    expect(() => encryptField('x')).toThrow(/DATA_ENCRYPTION_KEY must be set in production/);
    const derived = createHash('sha256').update('radeef-data-key:some-session-secret').digest();
    expect(() => decryptField(encryptV1('x', derived))).toThrow(/DATA_ENCRYPTION_KEY must be set in production/);
  });

  it('outside production keeps the SESSION_SECRET-derived development fallback', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATA_ENCRYPTION_KEY', '');
    vi.stubEnv('SESSION_SECRET', 'dev-secret');
    const derived = createHash('sha256').update('radeef-data-key:dev-secret').digest();
    expect(decryptField(encryptV1('dev', derived))).toBe('dev');
    expect(decryptField(encryptField('dev2'))).toBe('dev2');
  });
});

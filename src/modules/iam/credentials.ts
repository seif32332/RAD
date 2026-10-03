// One-time credential links and the in-person code (BL-PAY-005; DEC-PO-027 "a reset sends a one-time link
// to the account holder", RT-PAY-1102 / 1201 "the first attestation is a two-channel setup").
//
// Nothing secret is stored or logged:
//   - the link secret is DERIVED from the CredentialToken row id with a server key (HMAC-SHA256 of the
//     session secret), so neither the database, the outbox row, the operation log nor the audit holds it.
//     The row keeps only a keyed hash of the token (tokenHash) and of the code (codeHash);
//   - the outbox email carries a placeholder; the outbox-dispatch job renders the link right before
//     sending (renderCredentialLinkBody), so the stored message never contains it;
//   - comparisons are constant-time (crypto.timingSafeEqual) on fixed-length digests.
// A link is single use, expires (security setting credential_link_hours, default 24) and allows a few
// code attempts (CODE_MAX_ATTEMPTS) before it is revoked.
import { createHmac, timingSafeEqual } from 'crypto';

/** Wrong codes before the link is revoked (the holder then needs a new attestation / reset). */
export const CODE_MAX_ATTEMPTS = 5;

const DEV_FALLBACK = 'dev-only-insecure-credential-link-secret-0123456789';

/** The server key of the credential links, derived from SESSION_SECRET (fail closed in production). */
function linkKey(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set to derive credential links');
    return createHmac('sha256', DEV_FALLBACK).update('radeef-credential-link-key:v1').digest();
  }
  return createHmac('sha256', secret).update('radeef-credential-link-key:v1').digest();
}

const mac = (purpose: string, value: string) => createHmac('sha256', linkKey()).update(`${purpose}:${value}`).digest();
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

/** The link secret of a CredentialToken row: `<id>.<mac>` (only ever built in memory). */
export function credentialTokenFor(id: string): string {
  if (!UUID.test(id)) throw new Error('credential token: invalid id');
  return `${id}.${b64url(mac('link', id))}`;
}

/** The keyed hash stored in CredentialToken.tokenHash (64 hex). */
export function credentialTokenHash(token: string): string {
  return mac('token-hash', token).toString('hex');
}

/** The row id inside a presented token, or null when the token is malformed. */
export function credentialTokenId(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const m = TOKEN.exec(token.trim());
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time check of a presented token against the row (its id and its stored hash). */
export function credentialTokenMatches(row: { id: string; tokenHash: string }, presented: string): boolean {
  let expected: string;
  try {
    expected = credentialTokenFor(row.id);
  } catch {
    return false;
  }
  const p = Buffer.from(presented.trim());
  if (!safeEqual(p, Buffer.from(expected))) return false;
  return safeEqual(Buffer.from(credentialTokenHash(presented.trim()), 'hex'), Buffer.from(row.tokenHash, 'hex'));
}

/**
 * The second-channel code of a first attestation (8 digits, shown "1234-5678"): derived from the row id,
 * shown once to the attester who hands it over in person; it is never emailed (RT-PAY-1201).
 */
export function credentialCodeFor(id: string): string {
  const n = mac('code', id).readUIntBE(0, 6) % 100_000_000;
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalizeCode(code: string): string {
  return String(code).replace(/[\s-]/g, '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** The keyed hash stored in CredentialToken.codeHash (64 hex). */
export function credentialCodeHash(id: string, code: string): string {
  return mac('code-hash', `${id}:${normalizeCode(code)}`).toString('hex');
}

/** Constant-time check of a presented code. */
export function credentialCodeMatches(row: { id: string; codeHash: string | null }, presented: unknown): boolean {
  if (!row.codeHash || typeof presented !== 'string' || !/^\d{8}$/.test(normalizeCode(presented))) return false;
  return safeEqual(Buffer.from(credentialCodeHash(row.id, presented), 'hex'), Buffer.from(row.codeHash, 'hex'));
}

// ---------------------------------------------------------------------------------------------------
// The email (outbox): a placeholder in the stored body, rendered at send time.
// ---------------------------------------------------------------------------------------------------

const PLACEHOLDER = /\[\[radeef-credential-link:([0-9a-f-]{36})\]\]/g;

export function credentialLinkPlaceholder(tokenId: string): string {
  if (!UUID.test(tokenId)) throw new Error('credential link: invalid id');
  return `[[radeef-credential-link:${tokenId}]]`;
}

/** Token ids whose placeholder appears in an outbox body (to re-check them before sending). */
export function credentialLinkIds(body: string | null | undefined): string[] {
  return [...String(body ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** The application's public base URL (APP_URL), or null when it is not a usable http(s) origin. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const base = String(env.APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(base) ? base : null;
}

/**
 * The body to SEND: every placeholder replaced by the link. The secret travels in the URL fragment (#), which
 * browsers never send to a server, so it does not reach proxy or access logs. Null when APP_URL is missing.
 */
export function renderCredentialLinkBody(body: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = appBaseUrl(env);
  if (!base) return null;
  return body.replace(PLACEHOLDER, (_m, id: string) => `${base}/login/set-password#t=${credentialTokenFor(id)}`);
}

/**
 * Keyed hash of an account's password hash, stored on a link when it is issued: a link whose account changed
 * its credentials since (a vendor-script reset, a self change, another reset) no longer works.
 */
export function credentialFingerprintOf(passwordHash: string): string {
  return mac('credential-fingerprint', passwordHash).toString('hex');
}

/** Constant-time check that the account's credentials are the ones the link was issued for. */
export function credentialFingerprintMatches(stored: string, passwordHash: string): boolean {
  return safeEqual(Buffer.from(credentialFingerprintOf(passwordHash), 'hex'), Buffer.from(stored, 'hex'));
}

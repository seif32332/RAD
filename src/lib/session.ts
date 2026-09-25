// Edge-safe session helpers (used by middleware AND node route handlers).
// Only depends on `jose` and Web Crypto, so it can run in the Edge runtime.
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'radeef_session';
/** Default session lifetime (SystemSetting `session_timeout_minutes` overrides it at login). */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours
/** Bounds for a configured session lifetime: 15 minutes .. 7 days. */
export const SESSION_MIN_SECONDS = 15 * 60;
export const SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;

export interface SessionPayload {
  sub: string; // user id
  role: string; // Prisma Role enum value
  /**
   * Credential version: HMAC of the user's password hash at login time. A session whose `cv`
   * no longer matches the current password hash (password changed / reset) must be rejected
   * (see sessionMatchesCredentials). Absent on tokens issued before this claim existed.
   */
  cv?: string;
  /** User.sessionVersion at login; bumped on logout to revoke every older token of that user. */
  sv?: number;
  /** Issued-at (seconds since epoch). */
  iat?: number;
}

const DEV_FALLBACK_SECRET = 'dev-only-insecure-session-secret-change-me-0123456789';

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SESSION_SECRET (or NEXTAUTH_SECRET) must be set to a random string of at least 32 characters in production',
      );
    }
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }
  return new TextEncoder().encode(secret);
}

/** Clamps a session lifetime (seconds) to the allowed range; invalid input -> default. */
export function clampSessionSeconds(seconds: number | null | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return SESSION_MAX_AGE_SECONDS;
  return Math.min(SESSION_MAX_SECONDS, Math.max(SESSION_MIN_SECONDS, Math.floor(seconds)));
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Credential version for a password hash: a keyed HMAC (so the token reveals nothing about
 * the hash), truncated to 128 bits. Changes whenever the password changes (new bcrypt salt).
 */
export async function credentialVersion(passwordHash: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', getSecretKey() as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`cv1:${passwordHash}`));
  return toBase64Url(new Uint8Array(mac).slice(0, 16));
}

/**
 * True when the session was issued for the user's CURRENT password.
 * Call from getSessionUser with the user's passwordHash; false -> treat as logged out.
 * Tokens without a `cv` claim (issued before it existed) are accepted until they expire.
 */
export async function sessionMatchesCredentials(session: Pick<SessionPayload, 'cv'>, passwordHash: string): Promise<boolean> {
  if (!session.cv) return true;
  return session.cv === (await credentialVersion(passwordHash));
}

export interface SignSessionInput {
  sub: string;
  role: string;
  /** The user's current password hash; embeds a credential version in the token. */
  passwordHash?: string;
  /** The user's current User.sessionVersion. */
  sessionVersion?: number;
}

export async function signSession(payload: SignSessionInput, maxAgeSeconds = SESSION_MAX_AGE_SECONDS): Promise<string> {
  const claims: Record<string, string | number> = { role: payload.role };
  if (payload.passwordHash) claims.cv = await credentialVersion(payload.passwordHash);
  if (typeof payload.sessionVersion === 'number') claims.sv = payload.sessionVersion;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${clampSessionSeconds(maxAgeSeconds)}s`)
    .sign(getSecretKey());
}

export async function verifySession(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') return null;
    return {
      sub: payload.sub,
      role: payload.role,
      ...(typeof payload.cv === 'string' ? { cv: payload.cv } : {}),
      ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
      ...(typeof payload.sv === 'number' ? { sv: payload.sv } : {}),
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    // Set COOKIE_SECURE=false only when serving production over plain HTTP (not recommended).
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAge <= 0 ? 0 : clampSessionSeconds(maxAge),
  };
}

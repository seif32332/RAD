// P0-08 (AUDIT/13_MASTER_PLAN.md, EV-10017): src/proxy.ts, the Next 16 edge gate, with REAL tokens
// signed by src/lib/session.ts (jose, test secret). Nothing is mocked.
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxy, config } from '@/proxy';
import { SESSION_COOKIE, signSession } from '@/lib/session';

const TEST_SECRET = 'p0-08-proxy-test-secret-0123456789abcdef';
let prevSecret: string | undefined;
let validToken = '';

beforeAll(async () => {
  prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = TEST_SECRET;
  validToken = await signSession({ sub: 'u1', role: 'HR_MANAGER', passwordHash: 'h', sessionVersion: 0 });
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = prevSecret;
});

const ORIGIN = 'https://radeef.example.test';

function req(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`);
  return new NextRequest(new URL(path, ORIGIN), { headers });
}

const passes = (res: Response) => res.headers.get('x-middleware-next') === '1';

async function expectRedirectToLogin(res: Response, next: string | null) {
  expect(res.status).toBe(307);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.origin).toBe(ORIGIN);
  expect(loc.pathname).toBe('/login');
  expect(loc.searchParams.get('next')).toBe(next);
}

describe('proxy: public assets and pages', () => {
  it.each(['/logo.png', '/manifest.webmanifest', '/icons/icon-192.png', '/next.svg', '/icon.png', '/robots.txt', '/templates/employees.xlsx'])(
    'static asset %s passes without a session',
    async (p) => {
      expect(passes(await proxy(req(p)))).toBe(true);
    },
  );

  it.each(['/login', '/apply', '/apply/123', '/v/abc', '/offer/tok', '/offer/tok/pdf'])('public page %s passes without a session', async (p) => {
    expect(passes(await proxy(req(p)))).toBe(true);
  });

  it.each(['/loginx', '/verify', '/v2', '/offers', '/application'])('prefix boundary: %s is NOT public', async (p) => {
    const res = await proxy(req(p));
    expect(passes(res)).toBe(false);
    await expectRedirectToLogin(res, p);
  });

  it('asset pattern is anchored: images outside the listed locations need a session', async () => {
    expect(passes(await proxy(req('/uploads/2025/iqama.png')))).toBe(false);
    expect(passes(await proxy(req('/private/logo.png')))).toBe(false);
  });
});

describe('proxy: protected pages redirect to /login', () => {
  it('no cookie: 307 to /login?next=<path+query>', async () => {
    await expectRedirectToLogin(await proxy(req('/employees/123?tab=docs')), '/employees/123?tab=docs');
  });

  it('root: /login without a next parameter', async () => {
    await expectRedirectToLogin(await proxy(req('/')), null);
  });

  it('the redirect deletes the legacy insecure cookies', async () => {
    const res = await proxy(req('/payroll'));
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/isLoggedIn=;/);
    expect(setCookie).toMatch(/userId=;/);
  });

  it('legacy insecure cookies alone are not a session', async () => {
    const r = new NextRequest(new URL('/payroll', ORIGIN), { headers: { cookie: 'isLoggedIn=true; userId=admin' } });
    await expectRedirectToLogin(await proxy(r), '/payroll');
  });

  it('tampered, foreign-secret and expired tokens redirect like no token', async () => {
    const [h, p, s] = validToken.split('.');
    const tampered = [h, p, (s[0] === 'A' ? 'B' : 'A') + s.slice(1)].join('.');
    const foreign = await new SignJWT({ role: 'SUPER_ADMIN' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('another-secret-0123456789abcdefgh'));
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ role: 'HR_MANAGER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuedAt(now - 3600)
      .setExpirationTime(now - 1)
      .sign(new TextEncoder().encode(TEST_SECRET));
    for (const bad of [tampered, foreign, expired, 'garbage']) {
      await expectRedirectToLogin(await proxy(req('/payroll', bad)), '/payroll');
    }
  });

  it('/uploads/* (legacy file URLs) requires a session', async () => {
    await expectRedirectToLogin(await proxy(req('/uploads/a.pdf')), '/uploads/a.pdf');
    expect(passes(await proxy(req('/uploads/a.pdf', validToken)))).toBe(true);
  });

  it('valid token: protected page passes', async () => {
    expect(passes(await proxy(req('/employees', validToken)))).toBe(true);
  });

  it('valid token on /login is NOT redirected (a server-revoked token would otherwise loop)', async () => {
    expect(passes(await proxy(req('/login', validToken)))).toBe(true);
  });
});

describe('proxy: API routes answer 401 JSON, never a redirect', () => {
  it('protected API without a session: 401 JSON with UNAUTHORIZED', async () => {
    const res = await proxy(req('/api/employees'));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('protected API with a bad token: 401', async () => {
    expect((await proxy(req('/api/payroll-hub', 'garbage'))).status).toBe(401);
  });

  it.each(['/api/auth/login', '/api/auth/logout', '/api/health', '/api/apply', '/api/apply/submit', '/api/upload'])(
    'public API %s passes without a session',
    async (p) => {
      expect(passes(await proxy(req(p)))).toBe(true);
    },
  );

  it.each(['/api/auth/me', '/api/auth/loginx', '/api/healthz', '/api/uploads', '/api/applications', '/api/v/abc', '/api/offer/tok'])(
    'prefix boundary / not listed: %s needs a session (401)',
    async (p) => {
      expect((await proxy(req(p))).status).toBe(401);
    },
  );

  it('protected API with a valid token passes (route handlers then re-check with requireUser)', async () => {
    expect(passes(await proxy(req('/api/employees', validToken)))).toBe(true);
  });

  it('the proxy checks the signature only: a structurally valid token for a revoked / unknown user passes here (requireUser is the real gate)', async () => {
    const revoked = await signSession({ sub: 'deleted-user', role: 'SUPER_ADMIN', sessionVersion: 99 });
    expect(passes(await proxy(req('/api/employees', revoked)))).toBe(true);
  });

  it('/api without trailing slash is treated as a page (redirect), not an API', async () => {
    await expectRedirectToLogin(await proxy(req('/api')), '/api');
  });
});

describe('proxy: matcher', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  it('covers pages, APIs and /uploads, but not Next internals', () => {
    for (const p of ['/', '/employees', '/api/employees', '/uploads/x.pdf', '/login']) expect(matcher.test(p), p).toBe(true);
    for (const p of ['/_next/static/chunk.js', '/_next/image', '/favicon.ico']) expect(matcher.test(p), p).toBe(false);
  });
});

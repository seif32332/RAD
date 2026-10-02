// P0-08 (AUDIT/13_MASTER_PLAN.md): login rate limit.
//  - src/lib/rate-limit.ts directly (fixed window, per key), and
//  - POST /api/auth/login end to end: real bcrypt, real session signing, real limiter. Only the
//    database (users, SystemSetting, audit log) is in memory. Only Date is faked (bcrypt uses timers).
import bcrypt from 'bcryptjs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'p0-08-login-test-secret-0123456789abcdef';

const db = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  settings: [] as Array<{ key: string; value: string }>,
  findFirstCalls: 0,
  audit: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findFirst: async (a: { where: { email: { equals: string } } }) => {
        db.findFirstCalls += 1;
        const e = a.where.email.equals.toLowerCase();
        return db.users.find((u) => String(u.email).toLowerCase() === e) ?? null;
      },
      update: async () => ({}),
    },
    systemSetting: { findMany: async () => db.settings },
    auditLog: { create: async (a: { data: Record<string, unknown> }) => (db.audit.push(a.data), {}) },
  },
}));

const T0 = new Date('2026-09-28T08:00:00.000Z');
const WINDOW_MS = 15 * 60_000;
let goodHash = '';

beforeAll(async () => {
  goodHash = await bcrypt.hash('Correct-Horse-1', 4);
});

describe('rateLimit (fixed window)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.resetModules();
  });
  afterEach(() => vi.useRealTimers());

  it('allows `limit` hits, blocks the next one, reports remaining and retry-after', async () => {
    const { rateLimit } = await import('@/lib/rate-limit');
    for (let i = 1; i <= 5; i++) {
      const r = rateLimit('k', 5, WINDOW_MS);
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(5 - i);
    }
    const blocked = rateLimit('k', 5, WINDOW_MS);
    expect(blocked).toEqual({ ok: false, remaining: 0, retryAfterSeconds: 900 });
    vi.setSystemTime(T0.getTime() + 60_000);
    expect(rateLimit('k', 5, WINDOW_MS)).toMatchObject({ ok: false, retryAfterSeconds: 840 });
  });

  it('the window is fixed from the first hit and resets once it ends (not before)', async () => {
    const { rateLimit } = await import('@/lib/rate-limit');
    for (let i = 0; i < 6; i++) rateLimit('k', 5, WINDOW_MS);
    vi.setSystemTime(T0.getTime() + WINDOW_MS - 1);
    expect(rateLimit('k', 5, WINDOW_MS).ok).toBe(false);
    vi.setSystemTime(T0.getTime() + WINDOW_MS);
    expect(rateLimit('k', 5, WINDOW_MS)).toMatchObject({ ok: true, remaining: 4 });
  });

  it('keys are independent', async () => {
    const { rateLimit } = await import('@/lib/rate-limit');
    for (let i = 0; i < 6; i++) rateLimit('login:a@x.test', 5, WINDOW_MS);
    expect(rateLimit('login:a@x.test', 5, WINDOW_MS).ok).toBe(false);
    expect(rateLimit('login:b@x.test', 5, WINDOW_MS).ok).toBe(true);
  });

  it('refund gives one hit back (never below zero); reset clears the key', async () => {
    const { rateLimit, refundRateLimit, resetRateLimit } = await import('@/lib/rate-limit');
    for (let i = 0; i < 5; i++) rateLimit('k', 5, WINDOW_MS);
    refundRateLimit('k');
    expect(rateLimit('k', 5, WINDOW_MS).ok).toBe(true);
    expect(rateLimit('k', 5, WINDOW_MS).ok).toBe(false);
    resetRateLimit('k');
    expect(rateLimit('k', 5, WINDOW_MS)).toMatchObject({ ok: true, remaining: 4 });
    refundRateLimit('never-seen');
    for (let i = 0; i < 10; i++) refundRateLimit('k');
    expect(rateLimit('k', 5, WINDOW_MS).remaining).toBe(4);
  });
});

describe('POST /api/auth/login rate limit', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.resetModules(); // fresh in-memory limiter per test
    db.settings = [];
    db.findFirstCalls = 0;
    db.audit = [];
    db.users = [
      {
        id: 'u-victim', email: 'victim@example.test', passwordHash: goodHash, role: 'HR_MANAGER', name: 'V', avatarUrl: null,
        isActive: true, sessionVersion: 0, documentsOnlyUntil: null, employeeProfile: null,
      },
      {
        id: 'u-other', email: 'other@example.test', passwordHash: goodHash, role: 'EMPLOYEE', name: 'O', avatarUrl: null,
        isActive: true, sessionVersion: 0, documentsOnlyUntil: null, employeeProfile: null,
      },
    ];
  });
  afterEach(() => vi.useRealTimers());

  async function route() {
    return (await import('@/app/api/auth/login/route')).POST;
  }
  function login(POST: (r: Request) => Promise<Response>, email: string, password: string, ip = '10.0.0.1') {
    return POST(
      new Request('http://x.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  it('default policy: 5 failed attempts per account, the 6th is 429 with Retry-After', async () => {
    const POST = await route();
    for (let i = 0; i < 5; i++) expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(401);
    const res = await login(POST, 'victim@example.test', 'wrong');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(await res.json()).toMatchObject({ error: 'RATE_LIMITED' });
  });

  it('while blocked even the correct password is refused, without touching the user record', async () => {
    const POST = await route();
    for (let i = 0; i < 5; i++) await login(POST, 'victim@example.test', 'wrong');
    const callsBefore = db.findFirstCalls;
    const res = await login(POST, 'victim@example.test', 'Correct-Horse-1');
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(db.findFirstCalls).toBe(callsBefore);
  });

  it('the block lifts after the 15-minute window', async () => {
    const POST = await route();
    for (let i = 0; i < 6; i++) await login(POST, 'victim@example.test', 'wrong');
    vi.setSystemTime(T0.getTime() + WINDOW_MS - 1000);
    expect((await login(POST, 'victim@example.test', 'Correct-Horse-1')).status).toBe(429);
    vi.setSystemTime(T0.getTime() + WINDOW_MS);
    const ok = await login(POST, 'victim@example.test', 'Correct-Horse-1');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/radeef_session=/);
  });

  it('keyed per account: another account from the same IP is not blocked', async () => {
    const POST = await route();
    for (let i = 0; i < 6; i++) await login(POST, 'victim@example.test', 'wrong');
    expect((await login(POST, 'other@example.test', 'Correct-Horse-1')).status).toBe(200);
  });

  it('the account key ignores case and surrounding spaces (variants share one counter)', async () => {
    const POST = await route();
    for (const e of ['victim@example.test', 'VICTIM@example.test', ' Victim@Example.Test ', 'victim@EXAMPLE.test', 'vIcTiM@example.test']) {
      expect((await login(POST, e, 'wrong')).status).toBe(401);
    }
    expect((await login(POST, 'Victim@example.test', 'wrong')).status).toBe(429);
  });

  it('rotating the client IP does not bypass the per-account limit', async () => {
    const POST = await route();
    for (let i = 0; i < 5; i++) await login(POST, 'victim@example.test', 'wrong', `203.0.113.${i}`);
    expect((await login(POST, 'victim@example.test', 'wrong', '198.51.100.7')).status).toBe(429);
  });

  it('unknown e-mails are limited the same way (no enumeration through the limiter)', async () => {
    const POST = await route();
    for (let i = 0; i < 5; i++) expect((await login(POST, 'ghost@example.test', 'x')).status).toBe(401);
    expect((await login(POST, 'ghost@example.test', 'x')).status).toBe(429);
  });

  it('a successful login resets the account counter', async () => {
    const POST = await route();
    for (let i = 0; i < 4; i++) await login(POST, 'victim@example.test', 'wrong');
    expect((await login(POST, 'victim@example.test', 'Correct-Horse-1')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(401);
    expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(429);
  });

  it('SystemSetting max_login_attempts is honoured (3); out-of-range values fall back to 5', async () => {
    db.settings = [{ key: 'max_login_attempts', value: '3' }];
    let POST = await route();
    for (let i = 0; i < 3; i++) expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(401);
    expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(429);

    vi.resetModules();
    db.settings = [{ key: 'max_login_attempts', value: '0' }];
    POST = await route();
    for (let i = 0; i < 5; i++) expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(401);
    expect((await login(POST, 'victim@example.test', 'wrong')).status).toBe(429);
  });

  it('per-IP: 50 failures across many accounts block that IP, not another one', async () => {
    // Existing accounts (cost-4 hash) so the test does not pay the cost-12 dummy compare 50 times.
    for (let i = 0; i < 50; i++) db.users.push({ ...db.users[1], id: `u-spray${i}`, email: `spray${i}@example.test` });
    const POST = await route();
    for (let i = 0; i < 50; i++) expect((await login(POST, `spray${i}@example.test`, 'wrong', '192.0.2.66')).status).toBe(401);
    expect((await login(POST, 'other@example.test', 'Correct-Horse-1', '192.0.2.66')).status).toBe(429);
    expect((await login(POST, 'other@example.test', 'Correct-Horse-1', '192.0.2.67')).status).toBe(200);
  });

  it('per-IP counts failures only: many successful sign-ins behind one NAT never lock the office out', async () => {
    const POST = await route();
    for (let i = 0; i < 60; i++) {
      expect((await login(POST, i % 2 ? 'victim@example.test' : 'other@example.test', 'Correct-Horse-1', '192.0.2.10')).status).toBe(200);
    }
  });

  it('failed attempts are audited as LOGIN_FAILED with the client IP', async () => {
    const POST = await route();
    await login(POST, 'victim@example.test', 'wrong', '10.9.9.9');
    expect(db.audit.at(-1)).toMatchObject({ action: 'LOGIN_FAILED', ipAddress: '10.9.9.9' });
  });
});

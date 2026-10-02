// A leaver's documents-only access (owner decision 2026-09-26): after the end of service the login
// opens his official documents only, for terminated_documents_access_days (default 30), then the
// nightly job deactivates it. Everything else treats the session as logged out (fail closed).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocumentsDays as tsParse, terminatedLoginAction } from '@/lib/access';

const mocks = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'signed' }) }) }));
vi.mock('@/lib/session', () => ({
  SESSION_COOKIE: 'radeef_session',
  verifySession: async () => ({ sub: 'u1', sv: 3 }),
  sessionMatchesCredentials: async () => true,
}));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: async () => mocks.user } } }));

const baseUser = {
  id: 'u1', email: 'leaver@example.test', role: 'HR_MANAGER', name: 'x', avatarUrl: null, isActive: true, passwordHash: 'h', sessionVersion: 3,
  documentsOnlyUntil: null as Date | null, employeeProfile: { id: 'e1', firstNameArabic: 'م', lastNameArabic: 'ع' },
};

describe('sessions: documents-only is logged out everywhere except the documents endpoints', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('active employee: both getters return him, not documents-only', async () => {
    mocks.user = { ...baseUser };
    const auth = await import('@/lib/auth');
    expect((await auth.getSessionUser())?.id).toBe('u1');
    expect((await auth.getDocumentsSessionUser())?.documentsOnly).toBeUndefined();
  });

  it('within the window: getSessionUser = null (every other page / API); documents getter = him, flagged', async () => {
    mocks.user = { ...baseUser, documentsOnlyUntil: new Date(Date.now() + 86400e3) };
    const auth = await import('@/lib/auth');
    expect(await auth.getSessionUser()).toBeNull();
    await expect(auth.requireUser()).rejects.toThrow();
    const u = await auth.requireDocumentsUser();
    expect(u.documentsOnly).toBe(true);
  });

  it('window over: nobody', async () => {
    mocks.user = { ...baseUser, documentsOnlyUntil: new Date(Date.now() - 1000) };
    const auth = await import('@/lib/auth');
    expect(await auth.getSessionUser()).toBeNull();
    expect(await auth.getDocumentsSessionUser()).toBeNull();
  });

  it('a former HR employee keeps no staff role in document actions', async () => {
    const { actorFrom } = await import('@/app/api/documents/_shared');
    const req = new Request('http://x.test', { headers: { 'x-real-ip': '10.0.0.1' } });
    const base = { id: 'u1', email: '', role: 'HR_MANAGER' as const, name: '', avatarUrl: null, employeeId: 'e1', sessionVersion: 0 };
    expect(actorFrom({ ...base, documentsOnly: true }, req)).toMatchObject({ role: null, employeeId: 'e1', userId: 'u1' });
    expect(actorFrom(base, req).role).toBe('HR_MANAGER');
  });
});

describe('deactivate-terminated job with the documents window', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const on = (d: string) => new Date(`${d}T00:00:00.000Z`);

  it('window days: default 30, 0 = none, bounded (one parser for the app and the job)', () => {
    expect([tsParse(undefined), tsParse(null), tsParse(''), tsParse('abc'), tsParse('-1')]).toEqual([30, 30, 30, 30, 30]);
    expect([tsParse(undefined), tsParse('0'), tsParse('7.9'), tsParse('500')]).toEqual([30, 0, 7, 90]);
  });

  it('full access grace, then documents-only for N days from then, then deactivated', () => {
    // Still in the 3-day full-access grace.
    expect(terminatedLoginAction({ documentsOnlyUntil: null }, on('2026-09-25'), 3, 30, now)).toEqual({ action: 'KEEP' });
    // Grace over: documents-only for 30 days from now (a backdated termination never shortens it).
    expect(terminatedLoginAction({ documentsOnlyUntil: null }, on('2026-01-01'), 3, 30, now)).toEqual({ action: 'DOCUMENTS', until: new Date('2026-10-26T09:00:00Z') });
    // Inside / after the window.
    expect(terminatedLoginAction({ documentsOnlyUntil: new Date('2026-10-01T00:00:00Z') }, on('2026-09-01'), 0, 30, now)).toEqual({ action: 'KEEP' });
    expect(terminatedLoginAction({ documentsOnlyUntil: new Date('2026-09-20T00:00:00Z') }, on('2026-09-01'), 0, 30, now)).toEqual({ action: 'DEACTIVATE' });
    // No window configured: deactivated when the grace is over.
    expect(terminatedLoginAction({ documentsOnlyUntil: null }, on('2026-09-01'), 0, 0, now)).toEqual({ action: 'DEACTIVATE' });
  });
});

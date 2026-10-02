// P1-SCOPE (INV-SCOPE-01): /api/face-profiles/[employeeId]/photo on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('face profile photo route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/face-profiles/[employeeId]/photo/route');
  const b = await h.employee('B');
  // The stored file does not exist: past the scope check the route answers "image missing".
  await h.prisma.faceProfile.create({
    data: { employeeId: b.id, embedding: '[]', model: 'test', consentAt: new Date(), consentVersion: 'v1', photoStoredName: `missing-${h.tag}.jpg` },
  });
  const get = () => route.GET(h.req('GET', '/x'), h.params({ employeeId: b.id }));

  it('401 / 403; HR of another company gets "no profile" (404) and no audit row; HR of B reaches the image lookup', async () => {
    await h.as(null);
    expect((await get()).status).toBe(401);
    await h.as('empB');
    expect((await get()).status).toBe(403);
    await h.as('hrA');
    const denied = await get();
    expect(denied.status).toBe(404);
    expect((await denied.json()).error).toContain('لا توجد صورة');
    expect(await h.prisma.auditLog.count({ where: { userId: h.users.hrA.id, entityType: 'FaceProfile' } })).toBe(0);
    await h.as('hrB');
    const own = await get();
    expect(own.status).toBe(404);
    expect((await own.json()).error).toBe('الصورة غير موجودة');
  });
});

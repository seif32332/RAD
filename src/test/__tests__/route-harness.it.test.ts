// Smoke test of the shared route harness (src/test/route-harness.ts) on a real database, with one real
// route: GET /api/recruitment (already on the P1-FND-SCOPE layer). Opt-in: SCOPE_IT=1 with DATABASE_URL.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '../route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('route harness (real auth, two companies)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // vitest runs a skipped suite body while collecting
  const h = await createRouteHarness(state);
  const recruitment = await import('@/app/api/recruitment/route');

  it('builds scoped users and signs real sessions: no session 401, employee 403, HR of A allowed', async () => {
    expect(await h.prisma.userCompanyScope.count({ where: { userId: h.users.hrA.id, companyId: h.co.A } })).toBe(1);
    expect(await h.prisma.userCompanyScope.count({ where: { userId: h.users.owner.id } })).toBe(0);
    await h.as(null);
    expect((await recruitment.GET()).status).toBe(401);
    await h.as('empA');
    expect((await recruitment.GET()).status).toBe(403);
    await h.as('hrA');
    expect((await recruitment.GET()).status).toBe(200);
  });
});

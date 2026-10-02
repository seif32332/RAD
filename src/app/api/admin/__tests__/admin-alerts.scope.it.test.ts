// P1-SCOPE (INV-SCOPE-01): /api/admin/alerts on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { addDays, today } from '@/lib/dates';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('admin alerts route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/admin/alerts/route');
  const soon = addDays(today(), 5);
  for (const k of ['A', 'B'] as const) {
    await h.prisma.company.update({ where: { id: h.co[k] }, data: { commercialRegExp: soon } });
    await h.prisma.branch.update({ where: { id: h.branch[k] }, data: { munLicenseExp: soon } });
  }

  it('401 / 403; gov of B gets the company and branch alerts of B only; the owner both', async () => {
    const entities = async () => ((await (await route.GET()).json()).alerts as Array<{ entityId: string }>).map((x) => x.entityId);
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('finB');
    expect((await route.GET()).status).toBe(403);
    await h.as('govB');
    const got = await entities();
    expect(got).toEqual(expect.arrayContaining([h.co.B, h.branch.B]));
    expect(got).not.toContain(h.co.A);
    expect(got).not.toContain(h.branch.A);
    await h.as('owner');
    expect(await entities()).toEqual(expect.arrayContaining([h.co.A, h.co.B, h.branch.A, h.branch.B]));
  });
});

// P1-SCOPE (INV-SCOPE-01): /api/owner-reports on a real database with real sessions
// (src/test/route-harness.ts). The report is owner-only; owner roles have every company
// (actorCompanies), even a COMPANY_ADMIN with a UserCompanyScope row. Opt-in: SCOPE_IT=1.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('owner reports route: scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/owner-reports/route');

  it('401 / 403 for every non-owner role (HR, finance of either company); owners see both companies', async () => {
    const get = () => route.GET(h.req('GET', '/api/owner-reports'));
    await h.as(null);
    expect((await get()).status).toBe(401);
    for (const who of ['hrA', 'finB', 'empA'] as const) {
      await h.as(who);
      expect((await get()).status).toBe(403);
    }
    for (const who of ['owner', 'adminA'] as const) {
      await h.as(who);
      const res = await get();
      expect(res.status).toBe(200);
      expect(ids((await res.json()).companies)).toEqual(expect.arrayContaining([h.co.A, h.co.B]));
    }
  });
});

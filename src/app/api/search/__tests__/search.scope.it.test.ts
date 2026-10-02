// P1-SCOPE (INV-SCOPE-01): /api/search on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('search route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/search/route');
  const a = await h.employee('A');
  const b = await h.employee('B');
  const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A });
  const search = async () => (await (await route.GET(h.req('GET', `/api/search?q=${h.tag}`))).json()).results;

  it('401 / 403; staff of A finds employees, branches and companies of A only; the owner finds both', async () => {
    await h.as(null);
    expect((await route.GET(h.req('GET', `/api/search?q=${h.tag}`))).status).toBe(401);
    await h.as('empA');
    expect((await route.GET(h.req('GET', `/api/search?q=${h.tag}`))).status).toBe(403);
    for (const who of ['hrA', 'buyerA', 'branchMgrA'] as const) {
      await h.as(who);
      const r = await search();
      expect(ids(r.employees)).toContain(a.id);
      expect(ids(r.employees)).not.toContain(b.id);
      expect(ids(r.employees)).not.toContain(stray.id);
      expect(ids(r.companies)).toEqual([h.co.A]);
      expect(ids(r.branches)).toEqual([h.branch.A]);
    }
    await h.as('owner');
    const all = await search();
    expect(ids(all.employees)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids(all.companies)).toEqual(expect.arrayContaining([h.co.A, h.co.B]));
  });
});

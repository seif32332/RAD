// P1-SCOPE (INV-SCOPE-01): /api/hr/alerts on a real database with real sessions
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

describe.skipIf(process.env.SCOPE_IT !== '1')('hr alerts route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/hr/alerts/route');
  const soon = addDays(today(), 5);
  const a = await h.employee('A', { iqamaOrIdExp: soon });
  const b = await h.employee('B', { iqamaOrIdExp: soon });

  it('401 / 403; HR and gov of A get the alerts of A only; the owner both', async () => {
    const codes = async () => ((await (await route.GET()).json()).alerts as Array<{ employeeId: string }>).map((x) => x.employeeId);
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('finA');
    expect((await route.GET()).status).toBe(403);
    for (const who of ['hrA', 'govA'] as const) {
      await h.as(who);
      const got = await codes();
      expect(got).toContain(a.employeeId);
      expect(got).not.toContain(b.employeeId);
    }
    await h.as('owner');
    expect(await codes()).toEqual(expect.arrayContaining([a.employeeId, b.employeeId]));
  });

  it('pending counts cover the user companies only', async () => {
    await h.prisma.leave.create({ data: { employeeId: b.id, startDate: soon, endDate: soon, totalDays: 1, status: 'PENDING' } });
    await h.as('hrA');
    const alerts = (await (await route.GET()).json()).alerts as Array<{ id: string; message: string }>;
    const incoming = alerts.find((x) => x.id === 'incoming-requests-summary');
    const pendingA = await h.prisma.leave.count({ where: { status: 'PENDING', employee: { legalCompanyId: h.co.A } } });
    if (pendingA === 0) expect(incoming).toBeUndefined();
    else expect(incoming?.message).toContain(`(${pendingA})`);
  });
});

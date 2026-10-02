// P1-SCOPE (INV-SCOPE-01): /api/notifications on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('notifications route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/notifications/route');
  const b = await h.employee('B');
  // Dated in the future so it is the newest item whoever else writes to the database meanwhile.
  const future = new Date(Date.now() + 86_400_000);
  const leave = await h.prisma.leave.create({ data: { employeeId: b.id, startDate: future, endDate: future, totalDays: 1, status: 'PENDING', createdAt: future } });
  const loan = await moneyFixture((tx) => tx.loan.create({ data: { employeeId: b.id, amount: 1000, monthlyInstallment: 100, remainingAmount: 1000, status: 'PENDING', createdAt: future } }));
  const itemIds = async () => ((await (await route.GET()).json()) as Array<{ id: string }>).map((n) => n.id);

  it('401 without a session; HR and finance of A never see the pending requests of B; HR of B does', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    for (const who of ['hrA', 'finA'] as const) {
      await h.as(who);
      const got = await itemIds();
      expect(got).not.toContain(`leave-${leave.id}`);
      expect(got).not.toContain(`loan-${loan.id}`);
    }
    await h.as('hrB');
    expect(await itemIds()).toEqual(expect.arrayContaining([`leave-${leave.id}`, `loan-${loan.id}`]));
    // An employee of A (own scope) never sees another employee's requests.
    await h.as('empA');
    expect(await itemIds()).not.toContain(`leave-${leave.id}`);
  });
});

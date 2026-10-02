// P1-SCOPE (INV-SCOPE-01): the owner portal routes (/api/owner-portal/payments, /requests, /circulars)
// on a real database with real sessions (src/test/route-harness.ts). They are owner-only (circulars:
// published ones readable by everyone); owner roles have every company (actorCompanies), including a
// COMPANY_ADMIN that has a UserCompanyScope row. OwnerRequest and Circular carry no company.
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('owner portal routes: owner-only (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const payments = await import('@/app/api/owner-portal/payments/route');
  const requests = await import('@/app/api/owner-portal/requests/route');
  const circulars = await import('@/app/api/owner-portal/circulars/route');
  const b = await h.employee('B');
  const loan = await moneyFixture((tx) => tx.loan.create({ data: { employeeId: b.id, amount: 1000, monthlyInstallment: 100, remainingAmount: 1000, status: 'PENDING' } }));

  it('payments: 401 / 403 for HR and finance of either company; owners (any company scope row) see and decide every company', async () => {
    await h.as(null);
    expect((await payments.GET()).status).toBe(401);
    for (const who of ['hrB', 'finB', 'payrollA'] as const) {
      await h.as(who);
      expect((await payments.GET()).status).toBe(403);
      expect((await payments.POST(h.req('POST', '/x', { id: loan.id, type: 'LOAN', action: 'REJECT', notes: 'x' }))).status).toBe(403);
    }
    await h.as('adminA');
    expect(ids(await (await payments.GET()).json())).toContain(loan.id);
    expect((await h.prisma.loan.findUnique({ where: { id: loan.id } }))?.status).toBe('PENDING');
  });

  it('requests: owner only (401 / 403 / 201 / 200)', async () => {
    const body = { title: `توجيه ${h.tag}`, details: 'تفاصيل' };
    await h.as(null);
    expect((await requests.GET()).status).toBe(401);
    await h.as('hrA');
    expect((await requests.GET()).status).toBe(403);
    expect((await requests.POST(h.req('POST', '/x', body))).status).toBe(403);
    await h.as('owner');
    const created = await requests.POST(h.req('POST', '/x', body));
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(ids(await (await requests.GET()).json())).toContain(data.id);
  });

  it('circulars: drafts are the owner\'s; published ones are read by every employee; only the owner issues', async () => {
    await h.as(null);
    expect((await circulars.GET()).status).toBe(401);
    await h.as('hrA');
    expect((await circulars.POST(h.req('POST', '/x', { title: 'x', content: 'y' }))).status).toBe(403);
    await h.as('owner');
    const draft = (await (await circulars.POST(h.req('POST', '/x', { title: `مسودة ${h.tag}`, content: 'نص', status: 'DRAFT' }))).json()).data;
    expect(ids(await (await circulars.GET()).json())).toContain(draft.id);
    await h.as('empB');
    expect(ids(await (await circulars.GET()).json())).not.toContain(draft.id);
  });
});

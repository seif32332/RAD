// BL-LCY-012 (BR-LCY-011) on the routes, real database and real sessions (src/test/route-harness.ts):
//   - POST /api/settlements: an end-of-service settlement of an employee in NOTICE / TERMINATED is for
//     the recorded last working day (another day: 409, a D1 first); the "one end of service" guard
//     (pre-check and in-transaction re-check) skips void settlements and earlier employment periods, so a
//     rehired employee can be settled again;
//   - POST /api/payroll-hub CREATE_LOAN: no new loan while an end-of-service settlement of the current
//     period is live (hasOpenEos); a rejected one or one of an earlier period does not block.
// Each: allow, deny, other company. Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('settlements and loans read lifecycle (BL-LCY-012, real auth)', { timeout: 120_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/settlements/route');
  const hub = await import('@/app/api/payroll-hub/route');
  const lcy = await import('@/modules/lifecycle');

  const day = (offset: number) => {
    const d = new Date(Date.now() + 3 * 3600e3); // Riyadh calendar day
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const move = (employeeId: string, over: Partial<Parameters<typeof lcy.runEmploymentTransition>[1]>) =>
    lcy.runEmploymentTransition(h.prisma, {
      employeeId,
      command: 'EXIT',
      exitReason: 'RESIGNATION',
      source: { type: 'TEST', id: employeeId },
      actor: { type: 'USER', id: h.users.hrA.id },
      operationKey: `it:lcy12:${randomUUID()}`,
      companyIds: [h.co.A],
      ...over,
    });
  const eos = (employeeId: string, lastWorkingDate: string, extra: Record<string, unknown> = {}) => ({
    employeeId, type: 'END_OF_SERVICE', salaryBasis: 'total', terminationReason: 'RESIGNATION', lastWorkingDate, ...extra,
  });
  const post = (body: unknown) => route.POST(h.req('POST', '/api/settlements', body));
  const loan = (employeeId: string) => hub.POST(h.req('POST', '/api/payroll-hub', { actionType: 'CREATE_LOAN', payload: { employeeId, amount: 1000, monthlyInstallment: 100 } }));

  it('POST end of service for an employee in NOTICE: another last day 409, the recorded one 201; finance 403, HR of B 404', async () => {
    const e = await h.employee('A');
    const r = await move(e.id, { date: day(20) });
    expect(r.toState).toBe('NOTICE');
    await h.as('hrA');
    const wrong = await post(eos(e.id, day(25)));
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error ?? '').toContain(day(20));
    const preview = await (await post(eos(e.id, day(25), { preview: true }))).json();
    expect(preview.warnings.join(' ')).toContain(day(20));
    await h.as('finA');
    expect((await post(eos(e.id, day(20)))).status).toBe(403);
    await h.as('hrB');
    expect((await post(eos(e.id, day(20)))).status).toBe(404);
    expect(await h.prisma.settlement.count({ where: { employeeId: e.id } })).toBe(0);
    await h.as('hrA');
    expect((await post(eos(e.id, day(20)))).status).toBe(201);
    // One live end of service per period: a second one is refused.
    expect((await post(eos(e.id, day(20)))).status).toBe(409);
  });

  it('POST end of service after a rehire: the old period\'s PAID settlement no longer blocks (period scoping); a REJECTED one never did', async () => {
    const e = await h.employee('A');
    await move(e.id, { date: day(-40) }); // TERMINATED 40 days ago
    await moneyFixture((tx) =>
      tx.settlement.create({ data: { employeeId: e.id, type: 'END_OF_SERVICE', status: 'PAID', lastWorkingDate: new Date(`${day(-40)}T00:00:00Z`), salaryBasis: 'total' } }),
    );
    await h.as('hrA');
    expect((await post(eos(e.id, day(-40)))).status).toBe(409); // same period: one end of service
    await move(e.id, { command: 'REHIRE', date: day(-20), approvedById: h.users.legalA.id });
    await move(e.id, { date: day(-2) });
    await moneyFixture((tx) =>
      tx.settlement.create({ data: { employeeId: e.id, type: 'END_OF_SERVICE', status: 'REJECTED', lastWorkingDate: new Date(`${day(-2)}T00:00:00Z`), salaryBasis: 'total' } }),
    );
    expect((await post(eos(e.id, day(-2)))).status).toBe(201);
    expect(await h.prisma.settlement.count({ where: { employeeId: e.id, status: 'PENDING_APPROVAL' } })).toBe(1);
  });

  it('CREATE_LOAN: refused while an end of service of the current period is live; allowed after a rejection; payroll of B 404', async () => {
    const e = await h.employee('A');
    await h.as('payrollA');
    expect((await loan(e.id)).status).toBe(200);
    const s = await moneyFixture((tx) =>
      tx.settlement.create({ data: { employeeId: e.id, type: 'END_OF_SERVICE', status: 'PENDING_APPROVAL', lastWorkingDate: new Date(`${day(10)}T00:00:00Z`), salaryBasis: 'total' } }),
    );
    const refused = await loan(e.id);
    expect(refused.status).toBe(409);
    await h.as('payrollB');
    expect((await loan(e.id)).status).toBe(404);
    await moneyFixture((tx) => tx.settlement.update({ where: { id: s.id }, data: { status: 'REJECTED' } }));
    await h.as('payrollA');
    expect((await loan(e.id)).status).toBe(200);
    expect(await h.prisma.loan.count({ where: { employeeId: e.id } })).toBe(2);
    // A separated employee: refused as before (lifecycle isSeparated).
    const gone = await h.employee('A');
    await move(gone.id, { date: day(-1) });
    expect((await loan(gone.id)).status).toBe(409);
  });

  it('CREATE_LOAN after a rehire: the old period\'s end of service does not block', async () => {
    const e = await h.employee('A');
    await move(e.id, { date: day(-60) });
    await moneyFixture((tx) =>
      tx.settlement.create({ data: { employeeId: e.id, type: 'END_OF_SERVICE', status: 'PAID', lastWorkingDate: new Date(`${day(-60)}T00:00:00Z`), salaryBasis: 'total' } }),
    );
    await move(e.id, { command: 'REHIRE', date: day(-30), approvedById: h.users.legalA.id });
    await h.as('payrollA');
    expect((await loan(e.id)).status).toBe(200);
  });
});

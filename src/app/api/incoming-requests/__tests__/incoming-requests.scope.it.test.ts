// P1-SCOPE (INV-SCOPE-01): /api/incoming-requests (GET, POST) and /archive on a real database with real
// sessions (src/test/route-harness.ts). Every request follows its employee's company.
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture, payrollLineFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

type Hub = Record<string, Array<{ dbId?: string; id: string }> | unknown>;
const dbIds = (hub: Hub) =>
  ['employeeRequests', 'managerRequests', 'deptManagerRequests', 'ownerRequests'].flatMap((k) =>
    ((hub[k] as Array<{ dbId?: string }>) ?? []).map((r) => r.dbId),
  );

describe.skipIf(process.env.SCOPE_IT !== '1')('incoming-requests routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const hub = await import('@/app/api/incoming-requests/route');
  const archive = await import('@/app/api/incoming-requests/archive/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const leave = (employeeId: string, status: 'PENDING' | 'REJECTED' = 'PENDING') =>
    h.prisma.leave.create({
      data: { employeeId, leaveType: 'ANNUAL', startDate: new Date('2026-11-10'), endDate: new Date('2026-11-11'), totalDays: 2, status, isManagerApproved: true },
    });
  const lA = await leave(empA.id);
  const lB = await leave(empB.id);
  const doneB = await leave(empB.id, 'REJECTED');
  const loanA = await moneyFixture((tx) => tx.loan.create({ data: { employeeId: empA.id, amount: 1000, monthlyInstallment: 100, remainingAmount: 1000, status: 'PENDING' } }));
  const assetA = await h.prisma.assetRequest.create({ data: { requesterId: empA.id, requestedForId: empA.id, assetType: 'LAPTOP', status: 'PENDING_PURCHASING' } });

  it('GET: 401 / 403, HR of A sees the requests of A only, payroll of B no loan of A, the owner all', async () => {
    await h.as(null);
    expect((await hub.GET()).status).toBe(401);
    await h.as('empA');
    expect((await hub.GET()).status).toBe(403);
    await h.as('hrA');
    const a = dbIds(await (await hub.GET()).json());
    expect(a).toEqual(expect.arrayContaining([lA.id, loanA.id]));
    expect(a).not.toContain(lB.id);
    await h.as('payrollB');
    expect(dbIds(await (await hub.GET()).json())).not.toContain(loanA.id);
    await h.as('buyerB');
    expect(dbIds(await (await hub.GET()).json())).not.toContain(assetA.id);
    await h.as('buyerA');
    expect(dbIds(await (await hub.GET()).json())).toContain(assetA.id);
    await h.as('owner');
    expect(dbIds(await (await hub.GET()).json())).toEqual(expect.arrayContaining([lA.id, lB.id, loanA.id]));
  });

  it('archive: HR of A never sees a decided request of B; the owner does', async () => {
    await h.as('empA');
    expect((await archive.GET()).status).toBe(403);
    await h.as('hrA');
    const a = (await (await archive.GET()).json()).archive.map((r: { id: string }) => r.id);
    expect(a).not.toContain(`leave-${doneB.id}`);
    await h.as('owner');
    expect((await (await archive.GET()).json()).archive.map((r: { id: string }) => r.id)).toContain(`leave-${doneB.id}`);
  });

  it('POST: another company 404 and untouched (leave, loan, asset); own company once, the second call refused', async () => {
    const rejectLeave = { actionType: 'REJECT', type: 'LEAVE', dbId: lA.id, reason: 'ضغط عمل' };
    await h.as('hrB');
    expect((await hub.POST(h.req('POST', '/x', rejectLeave))).status).toBe(404);
    await h.as('payrollB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'REJECT', type: 'LOAN', dbId: loanA.id, reason: 'لا' }))).status).toBe(404);
    await h.as('buyerB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'APPROVE', type: 'ASSET_REQUEST', dbId: assetA.id }))).status).toBe(404);
    expect((await h.prisma.leave.findUnique({ where: { id: lA.id } }))?.status).toBe('PENDING');
    expect((await h.prisma.loan.findUnique({ where: { id: loanA.id } }))?.status).toBe('PENDING');
    expect((await h.prisma.assetRequest.findUnique({ where: { id: assetA.id } }))?.status).toBe('PENDING_PURCHASING');
    await h.as('hrA');
    expect((await hub.POST(h.req('POST', '/x', rejectLeave))).status).toBe(200);
    expect((await hub.POST(h.req('POST', '/x', rejectLeave))).status).toBe(409);
    expect((await h.prisma.leave.findUnique({ where: { id: lA.id } }))?.status).toBe('REJECTED');
  });

  it('OVERTIME through time.decideOvertime (BL-PAY-027, F9): own overtime 403, another company 404, the decider is recorded and cannot pay the month', async () => {
    const payroll = await import('@/modules/payroll');
    // payrollA is also an employee of A (his own overtime is a money act on himself, BR-PAY-001).
    const self = await h.employee('A', { userId: h.users.payrollA.id });
    const own = await h.prisma.overtimeRequest.create({ data: { employeeId: self.id, date: new Date('2045-03-02'), hours: 2 } });
    const other = await h.prisma.overtimeRequest.create({ data: { employeeId: empA.id, date: new Date('2045-03-03'), hours: 3 } });
    const decide = (id: string) => hub.POST(h.req('POST', '/x', { actionType: 'APPROVE', type: 'OVERTIME', dbId: id }));
    await h.as('payrollA');
    const refused = await decide(own.id);
    expect(refused.status).toBe(403);
    expect((await refused.json()).details).toMatchObject({ code: 'MONEY_GUARD_BLOCKED', reasons: ['SELF_BENEFICIARY'] });
    expect((await h.prisma.overtimeRequest.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('PENDING');
    await h.as('payrollB');
    expect((await decide(other.id)).status).toBe(404);
    expect((await h.prisma.overtimeRequest.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('PENDING');
    await h.as('payrollA');
    expect((await decide(other.id)).status).toBe(200);
    expect((await decide(other.id)).status).toBe(200); // same user, derived key: replays
    await h.as('hrA');
    expect((await decide(other.id)).status).toBe(409); // decided already
    const decided = await h.prisma.overtimeRequest.findUniqueOrThrow({ where: { id: other.id } });
    expect([decided.status, decided.decidedById, decided.decidedAt instanceof Date]).toEqual(['APPROVED', h.users.payrollA.id, true]);

    // The approved month that pays this overtime: its decider is one of the month's approvers (BR-PAY-002)
    // and may not record the payment.
    await moneyFixture(async (tx) => {
      const line = await payrollLineFixture(tx, { employeeId: empA.id, year: 2045, month: 3, basicSalary: 6000, netSalary: 6000, status: 'APPROVED' });
      await tx.payrollMonth.update({ where: { id: line.payrollMonthId! }, data: { status: 'APPROVED' } });
      await tx.overtimeRequest.update({ where: { id: other.id }, data: { paidInPayrollId: line.id } });
    });
    const month = { companyId: h.co.A, year: 2045, month: 3 };
    expect(await h.prisma.$transaction((t) => payroll.monthApprovers(t, month))).toContain(h.users.payrollA.id);
    const payer = { id: h.users.payrollA.id, role: 'PAYROLL_ADMIN', employeeId: self.id };
    await expect(
      payroll.runPayrollTransaction(h.prisma, (t) => payroll.markPayrollMonthPaid(t, { actor: payer, ...month, operationKey: `it:pay:${h.next()}:${h.tag}` })),
    ).rejects.toMatchObject({ status: 403, details: { reasons: ['PAYER_IS_APPROVER'] } });
  });
});

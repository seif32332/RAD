// compensation's money writers on a real PostgreSQL (P1-PAY-A, BL-PAY-003; P1-PAY-B): the bonus writers
// and the change-order pay, each called twice (sequentially and concurrently) with one key (ARCH-014):
// one set of rows, one audit, one event; never on one's own pay (BR-PAY-001). The financial change
// request and the period writers: financial-change.it.test.ts.
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('compensation money writers on PostgreSQL (P1-PAY-A)', { timeout: 180_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const comp = await import('@/modules/compensation');
  const { runPayrollTransaction } = await import('@/modules/payroll');
  const { moneyFixture, payrollLineFixture, employeeFixture } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  let companyId = '';
  const hr = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };
  const self = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };
  let n = 0;
  const employee = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return employeeFixture({
      employeeId: `CP-${tag}-${n}`, firstNameArabic: 'م', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `CP${tag}${n}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
      basicSalary: 5000, legalCompanyId: companyId, ...over,
    });
  };
  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { nameArabic: `أجور ${tag}`, commercialRegNum: `CP${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    hr.id = (await prisma.user.create({ data: { email: `cp-hr-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
    self.id = (await prisma.user.create({ data: { email: `cp-self-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
    self.employeeId = (await employee({ userId: self.id })).id;
  });
  const tx = <T,>(fn: (t: import('@/modules/platform').TxClient) => Promise<T>) => runPayrollTransaction(prisma, fn);
  const audits = (key: string) => prisma.auditRecord.count({ where: { operationKey: key } });

  it('createBonus double call (sequential and concurrent): one bonus, createdById / approvedById; never to oneself', async () => {
    const e = (await employee()).id;
    const key = `it:bonus:${randomUUID()}`;
    const input = { actor: hr, employeeId: e, name: 'مكافأة', amount: 300.333, payrollMonth: 5, payrollYear: 2031, operationKey: key };
    const a = await tx((t) => comp.createBonus(t, input));
    expect(await tx((t) => comp.createBonus(t, input))).toEqual(a);
    expect([a.amount, a.status, a.createdById, a.approvedById]).toEqual([300.33, 'APPROVED', hr.id, hr.id]);
    const k2 = `it:bonus:${randomUUID()}`;
    await Promise.all([0, 1].map(() => tx((t) => comp.createBonus(t, { ...input, operationKey: k2 }))));
    expect(await prisma.allowance.count({ where: { employeeId: e, isMonthly: false } })).toBe(2);
    expect(await audits(key)).toBe(1);
    await expect(tx((t) => comp.createBonus(t, { ...input, actor: self, employeeId: self.employeeId!, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  it('linkBonusesToPayroll / markBonusesPaid / unlinkBonusesFromPayrolls double calls act once', async () => {
    const e = (await employee()).id;
    const bonus = await moneyFixture((t) => t.allowance.create({ data: { employeeId: e, name: 'م', amount: 10, isMonthly: false } }));
    const line = await moneyFixture((t) => payrollLineFixture(t, { employeeId: e, year: 2031, month: 6, basicSalary: 1, netSalary: 1, status: 'DRAFT' }));
    const link = () => prisma.$transaction((t) => comp.linkBonusesToPayroll(t, { reservations: [{ payrollId: line.id, allowanceIds: [bonus.id] }], month: 6, year: 2031, operationKey: `it:${randomUUID()}` }));
    expect((await link()).linked).toBe(1);
    expect((await prisma.allowance.findUniqueOrThrow({ where: { id: bonus.id } })).paidInPayrollId).toBe(line.id);
    const unlink = () => prisma.$transaction((t) => comp.unlinkBonusesFromPayrolls(t, { payrollIds: [line.id], operationKey: `it:${randomUUID()}` }));
    expect([(await unlink()).released, (await unlink()).released]).toEqual([1, 0]);
    await link();
    const paid = await Promise.all([0, 1].map(() => prisma.$transaction((t) => comp.markBonusesPaid(t, { payrollIds: [line.id], operationKey: `it:${randomUUID()}` }))));
    expect(paid.map((p) => p.paid).reduce((s, v) => s + v, 0)).toBe(1);
    expect((await prisma.allowance.findUniqueOrThrow({ where: { id: bonus.id } })).isPaid).toBe(true);
  });

  it('linkBonusesToPayroll / markBonusesPaid take APPROVED bonuses only (BL-PAY-027): a PENDING bonus is not linked; a line holding a REJECTED one is a 409 and nothing is paid', async () => {
    const e = (await employee()).id;
    const pending = await moneyFixture((t) => t.allowance.create({ data: { employeeId: e, name: 'م', amount: 10, isMonthly: false, status: 'PENDING' } }));
    const line = await moneyFixture((t) => payrollLineFixture(t, { employeeId: e, year: 2031, month: 7, basicSalary: 1, netSalary: 1, status: 'DRAFT' }));
    const r = await prisma.$transaction((t) => comp.linkBonusesToPayroll(t, { reservations: [{ payrollId: line.id, allowanceIds: [pending.id] }], month: 7, year: 2031, operationKey: `it:${randomUUID()}` }));
    expect(r.linked).toBe(0);
    const ok = await moneyFixture((t) => t.allowance.create({ data: { employeeId: e, name: 'م', amount: 20, isMonthly: false } }));
    const late = await moneyFixture((t) => t.allowance.create({ data: { employeeId: e, name: 'م', amount: 30, isMonthly: false, status: 'REJECTED', paidInPayrollId: line.id } }));
    await prisma.$transaction((t) => comp.linkBonusesToPayroll(t, { reservations: [{ payrollId: line.id, allowanceIds: [ok.id] }], month: 7, year: 2031, operationKey: `it:${randomUUID()}` }));
    await expect(prisma.$transaction((t) => comp.markBonusesPaid(t, { payrollIds: [line.id], operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 409, details: { code: 'BONUS_NOT_APPROVED', count: 1 } });
    expect([(await prisma.allowance.findUniqueOrThrow({ where: { id: ok.id } })).isPaid, (await prisma.allowance.findUniqueOrThrow({ where: { id: late.id } })).isPaid]).toEqual([false, false]);
  });

  it('applyChangeOrderPay double call (guarded by the order in the real flow): a CompensationPeriod from the order date, the projection and the SalaryChange follow; a repeat replays (SYSTEM operation)', async () => {
    const e = (await employee()).id;
    const housing = await moneyFixture((t) => t.allowance.create({ data: { employeeId: e, name: 'بدل سكن', amount: 1000, isMonthly: true, allowanceType: 'HOUSING' } }));
    // The housing row joins the employee's compensation as a legacy item would (its id is the period item's allowanceId).
    const current = await prisma.compensationPeriod.findFirstOrThrow({ where: { employeeId: e, supersededAt: null } });
    await tx((t) => comp.applyDecision(t, { employeeId: e, effectiveDate: '2030-06-01', attrs: { basicSalary: Number(current.basicSalary), allowances: [{ allowanceId: housing.id, name: 'بدل سكن', line: 'HOUSING', allowanceType: 'HOUSING', amount: 1000, countsTowardGosi: true }] }, source: { type: 'TEST', id: tag }, triggeredById: hr.id, operationKey: `it:seed:${randomUUID()}` }));
    const orderId = randomUUID();
    const input = { employeeId: e, orderId, documentId: 'doc', effectiveDate: new Date('2030-12-31T21:00:00.000Z'), basicSalary: 8000, allowances: [{ kind: 'HOUSING' as const, rowId: housing.id, amount: 2000 }], triggeredById: hr.id };
    const r = await tx((t) => comp.applyChangeOrderPay(t, input));
    expect(r.allowances.HOUSING).toEqual({ from: 1000, to: 2000 });
    expect(r.replayed).toBe(false);
    const p = await prisma.compensationPeriod.findFirstOrThrow({ where: { employeeId: e, supersededAt: null, validFrom: new Date('2031-01-01') } });
    expect([Number(p.basicSalary), p.sourceType, p.sourceId]).toEqual([8000, 'CHANGE_ORDER', orderId]);
    // A second application of the same order (the caller's guard aside) replays: no second period, no second history row.
    const again = await tx((t) => comp.applyChangeOrderPay(t, input));
    expect(again.replayed).toBe(true);
    expect(await prisma.compensationPeriod.count({ where: { employeeId: e, sourceType: 'CHANGE_ORDER', validFrom: new Date('2031-01-01') } })).toBe(1);
    expect(await prisma.salaryChange.count({ where: { employeeId: e } })).toBe(1);
  });
});

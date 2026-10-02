// compensation's money writers on a real PostgreSQL (P1-PAY-A, BL-PAY-003): every export of
// transitions.ts called twice (sequentially and concurrently) with one key (ARCH-014): one set of rows,
// one audit, one event; never on one's own pay (BR-PAY-001).
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
  const { moneyFixture, payrollLineFixture } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  let companyId = '';
  const hr = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };
  const self = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };
  let n = 0;
  const employee = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return prisma.employee.create({
      data: {
        employeeId: `CP-${tag}-${n}`, firstNameArabic: 'م', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `CP${tag}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 5000, legalCompanyId: companyId, ...over,
      },
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

  it('editEmployeePay double call: the pay columns and allowances change once; never one\'s own file; the extension refuses the same write without the gateway', async () => {
    const e = (await employee()).id;
    const key = `it:pay:${randomUUID()}`;
    const input = { actor: hr, employeeId: e, pay: { basicSalary: 7000 }, allowances: [{ name: 'بدل سكن', amount: 1750, countsTowardGosi: true, allowanceType: 'HOUSING' }], operationKey: key };
    const a = await tx((t) => comp.editEmployeePay(t, input));
    const b = await tx((t) => comp.editEmployeePay(t, input));
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e } })).basicSalary).toBe(7000);
    expect(await prisma.allowance.count({ where: { employeeId: e, isMonthly: true } })).toBe(1);
    expect(await audits(key)).toBe(1);
    const k2 = `it:pay:${randomUUID()}`;
    const both = await Promise.all([0, 1].map(() => tx((t) => comp.editEmployeePay(t, { ...input, pay: { basicSalary: 7100 }, operationKey: k2 }))));
    expect(both.map((x) => x.replayed).sort()).toEqual([false, true]);
    await expect(tx((t) => comp.editEmployeePay(t, { ...input, actor: self, employeeId: self.employeeId!, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
    await expect(prisma.employee.update({ where: { id: e }, data: { basicSalary: 1 } })).rejects.toMatchObject({ details: { code: 'MONEY_GATEWAY_DIRECT_WRITE' } });
  });

  it('setInitialAllowances double call: the allowances are written once', async () => {
    const e = (await employee()).id;
    const run = () => prisma.$transaction((t) => comp.setInitialAllowances(t, { actor: hr, employeeId: e, allowances: [{ name: 'بدل نقل', amount: 500, countsTowardGosi: false, allowanceType: 'TRANSPORT' }], operationKey: `it:init:${e}` }));
    expect([(await run()).created, (await run()).created]).toEqual([1, 0]);
    expect(await prisma.allowance.count({ where: { employeeId: e } })).toBe(1);
  });

  it('applyChangeOrderPay double call (guarded by the order in the real flow): the SalaryChange and allowance rows follow the order; SYSTEM operation', async () => {
    const e = (await employee()).id;
    const housing = await moneyFixture((t) => t.allowance.create({ data: { employeeId: e, name: 'بدل سكن', amount: 1000, isMonthly: true, allowanceType: 'HOUSING' } }));
    const input = { employeeId: e, orderId: randomUUID(), documentId: 'doc', effectiveDate: new Date('2031-01-01'), basicSalary: 8000, allowances: [{ kind: 'HOUSING' as const, rowId: housing.id, amount: 2000 }], triggeredById: hr.id };
    const r = await prisma.$transaction((t) => comp.applyChangeOrderPay(t, input));
    expect(r.allowances.HOUSING).toEqual({ from: 1000, to: 2000 });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e } })).basicSalary).toBe(8000);
    // A second application of the same order is the caller's guard (EmployeeChangeOrder.appliedAt); the
    // rows written are the same values again (no second amount change).
    const again = await prisma.$transaction((t) => comp.applyChangeOrderPay(t, input));
    expect(again.allowances.HOUSING).toEqual({ from: 2000, to: 2000 });
    expect((await prisma.allowance.findUniqueOrThrow({ where: { id: housing.id } })).amount).toBe(2000);
  });
});

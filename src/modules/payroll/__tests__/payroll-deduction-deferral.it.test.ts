// BL-PAY-030 (RT-WFE-744) on a real PostgreSQL: a month whose pay cannot hold a deduction neither takes it
// nor links it on approval; the deduction stays payable, is offered by the next generated month (past the
// "approved before its month was generated" filter) and linked once by that month's approval. A deduction
// that fits is linked once. A double approval call (one key) replays.
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('payroll deduction deferral on PostgreSQL (BL-PAY-030)', { timeout: 240_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const payroll = await import('@/modules/payroll');
  const lib = await import('@/lib/payroll');
  const { moneyFixture } = await import('@/test/money-fixtures');
  const { approvePayrollMonth, runPayrollTransaction } = payroll;

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  const year = 2081;
  const M = 3; // March: 31 days
  let companyId = '';
  const actor = { id: '', role: 'HR_MANAGER', employeeId: null as string | null };

  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { nameArabic: `تأجيل ${tag}`, commercialRegNum: `DF${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    actor.id = (await prisma.user.create({ data: { email: `df-hr-${tag}@example.test`, passwordHash: 'x', role: 'HR_MANAGER' } })).id;
  });

  const at = (m: number, day: number) => new Date(Date.UTC(year, m - 1, day));
  const key = (m: number) => `${year}-${String(m).padStart(2, '0')}`;
  const generate = (month: number) => lib.generatePayrollMonth(prisma, { companyId, year, month, actor });
  const approve = (month: number, operationKey = `it:approve:${randomUUID()}`) =>
    runPayrollTransaction(prisma, (tx) => approvePayrollMonth(tx, { actor, companyId, year, month, operationKey, mode: 'ENFORCED' }));
  const lineOf = (employeeId: string, month: number) => prisma.payroll.findFirstOrThrow({ where: { employeeId, year, month } });
  const ded = (id: string) => prisma.deduction.findUniqueOrThrow({ where: { id } });
  const deduction = (employeeId: string, date: Date, amount: number) =>
    moneyFixture((tx) => tx.deduction.create({ data: { employeeId, date, amount, reason: 'مخالفة', status: 'DEDUCTED', approvedAt: new Date(Date.now() - 86_400_000) } }));

  it('month M cannot hold a deduction: not linked, still PAYABLE; month M+1 takes it and links it once; the one that fits is linked once', async () => {
    // Joins on 25 March: 7 of 31 days paid (6,000 x 7/31 = 1,354.84 gross).
    const emp = await employeeFixture({
      employeeId: `DF-${tag}`, firstNameArabic: 'موظف', lastNameArabic: 'مؤجل', nationality: 'SA', iqamaOrIdNumber: `DF${tag}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: at(M, 25),
      basicSalary: 6000, legalCompanyId: companyId, actualCompanyId: companyId,
    });
    const fits = await deduction(emp.id, at(M, 26), 100);
    const big = await deduction(emp.id, at(M, 27), 3000);

    await generate(M);
    const m = await lineOf(emp.id, M);
    const gross = m.basicSalary + m.totalAllowances + m.overtimeCost;
    expect(gross).toBeLessThan(3000);
    expect(m.violationsDeduction).toBe(100);
    expect(m.netSalary).toBeGreaterThan(0);
    expect(m.totalDeductions).toBeLessThanOrEqual(gross);
    expect(m.needsReview).toBe(true);
    expect(lib.reviewNoteCodes(m.reviewNote)).toContain('DEDUCTION_DEFERRED');
    expect((await ded(big.id)).payrollMonth).toBeNull(); // not reserved by the draft
    expect((await ded(big.id)).deferredPayrollMonth).toBe(key(M));
    expect((await ded(fits.id)).payrollMonth).toBe(key(M));

    const k = `it:approve:${randomUUID()}`;
    const first = await approve(M, k);
    const again = await approve(M, k); // double call, one key: replays, nothing linked twice
    expect(again.replayed).toBe(true);
    expect({ ...again, replayed: false }).toEqual(first);
    const bigAfterM = await ded(big.id);
    expect([bigAfterM.isLinkedToPayroll, bigAfterM.status, bigAfterM.payrollMonth]).toEqual([false, 'DEDUCTED', null]);
    const fitsAfterM = await ded(fits.id);
    expect([fitsAfterM.isLinkedToPayroll, fitsAfterM.payrollMonth]).toEqual([true, key(M)]);
    // What M recorded as collected is what its line took.
    const collectedM = await prisma.deduction.aggregate({ where: { employeeId: emp.id, payrollMonth: key(M), isLinkedToPayroll: true }, _sum: { amount: true } });
    expect(collectedM._sum.amount).toBe((await lineOf(emp.id, M)).violationsDeduction);

    // M+1 (a full month): the deferred deduction is offered again (it was approved before M was generated).
    await generate(M + 1);
    const n = await lineOf(emp.id, M + 1);
    expect(n.violationsDeduction).toBe(3000);
    expect((await ded(big.id)).payrollMonth).toBe(key(M + 1));
    const k2 = `it:approve:${randomUUID()}`;
    await approve(M + 1, k2);
    expect((await approve(M + 1, k2)).replayed).toBe(true);
    const bigAfter = await ded(big.id);
    expect([bigAfter.isLinkedToPayroll, bigAfter.payrollMonth]).toEqual([true, key(M + 1)]);
    // The one that fitted in M is untouched by M+1.
    const fitsAfter = await ded(fits.id);
    expect([fitsAfter.isLinkedToPayroll, fitsAfter.payrollMonth]).toEqual([true, key(M)]);

    // M+2: nothing is offered again (each deduction collected exactly once).
    await generate(M + 2);
    expect((await lineOf(emp.id, M + 2)).violationsDeduction).toBe(0);
    const linked = await prisma.deduction.findMany({ where: { employeeId: emp.id, isLinkedToPayroll: true }, select: { id: true } });
    expect(linked.map((r) => r.id).sort()).toEqual([big.id, fits.id].sort());
  });

  it('a draft generated before the fix (deductions above the pay, net clamped) cannot be approved: regenerate first', async () => {
    const mm = 8;
    const emp = await employeeFixture({
      employeeId: `DF2-${tag}`, firstNameArabic: 'موظف', lastNameArabic: 'قديم', nationality: 'SA', iqamaOrIdNumber: `DF2${tag}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
      basicSalary: 6000, legalCompanyId: companyId, actualCompanyId: companyId,
    });
    const big = await deduction(emp.id, at(mm, 5), 9000);
    await generate(mm);
    // Make the draft look like the old computation: the whole deduction counted and reserved, net 0.
    const draft = await lineOf(emp.id, mm);
    await moneyFixture(async (tx) => {
      await tx.payroll.update({ where: { id: draft.id }, data: { violationsDeduction: 9000, totalDeductions: draft.totalDeductions + 9000, netSalary: 0 } });
      await tx.deduction.update({ where: { id: big.id }, data: { payrollMonth: key(mm) } });
    });
    await expect(approve(mm)).rejects.toMatchObject({ status: 409 });
    expect((await ded(big.id)).isLinkedToPayroll).toBe(false);
    // Regenerated: deferred (larger than a whole month: flagged), the month approves, nothing linked.
    await generate(mm);
    const fresh = await lineOf(emp.id, mm);
    expect(fresh.violationsDeduction).toBe(0);
    expect(lib.reviewNoteCodes(fresh.reviewNote)).toEqual(expect.arrayContaining(['DEDUCTION_DEFERRED', 'DEDUCTION_OVER_MONTH']));
    await approve(mm);
    const after = await ded(big.id);
    expect([after.isLinkedToPayroll, after.payrollMonth, after.status]).toEqual([false, null, 'DEDUCTED']);
  });
});

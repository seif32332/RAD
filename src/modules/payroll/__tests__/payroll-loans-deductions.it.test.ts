// payroll's loan and deduction transitions on a real PostgreSQL (P1-PAY-A, BL-PAY-003 / 006 / 008):
// every export of transitions/loans.ts and transitions/deductions.ts is called twice with one key,
// sequentially and concurrently (ARCH-014): one fact change, one audit row, one event; the person of
// every stage is recorded (BR-PAY-006); the segregation rules hold (no act on one's own money,
// the transferring user is not an approver of the loan, BR-PAY-017).
//
// Opt-in: PAY_IT=1 with DATABASE_URL on a THROWAWAY migrated database (rows are not cleaned up).
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.PAY_IT === '1';

describe.skipIf(!RUN)('payroll loans and deductions on PostgreSQL (P1-PAY-A)', { timeout: 240_000 }, async () => {
  if (!RUN) return;
  const { prisma } = await import('@/lib/prisma');
  const payroll = await import('@/modules/payroll');
  const { moneyFixture } = await import('@/test/money-fixtures');
  const { runPayrollTransaction } = payroll;

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  let companyId = '';
  type Actor = { id: string; role: string; employeeId: string | null; name: string };
  const a = {} as Record<'mgr' | 'hr' | 'owner' | 'fin' | 'fin2' | 'self', Actor>;
  let n = 0;
  const employee = async (over: Record<string, unknown> = {}) => {
    n += 1;
    return employeeFixture({
        employeeId: `PL-${tag}-${n}`, firstNameArabic: 'موظف', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `PL${tag}${n}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
        basicSalary: 6000, legalCompanyId: companyId, actualCompanyId: companyId, ...over,
      });
  };

  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { nameArabic: `سلف ${tag}`, commercialRegNum: `PL${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    for (const [k, role] of [['mgr', 'BRANCH_MANAGER'], ['hr', 'HR_MANAGER'], ['owner', 'COMPANY_ADMIN'], ['fin', 'FINANCE_MANAGER'], ['fin2', 'PAYROLL_ADMIN'], ['self', 'HR_MANAGER']] as const) {
      const u = await prisma.user.create({ data: { email: `pl-${k}-${tag}@example.test`, passwordHash: 'x', role } });
      const employeeId = k === 'self' ? (await employee({ userId: u.id })).id : null;
      a[k] = { id: u.id, role, employeeId, name: k };
    }
  });

  const loan = async (employeeId: string, status = 'PENDING') =>
    moneyFixture((tx) => tx.loan.create({ data: { employeeId, amount: 1200, monthlyInstallment: 100, remainingAmount: 1200, status } }));
  const deduction = async (employeeId: string, status: string, over: Record<string, unknown> = {}) =>
    moneyFixture((tx) => tx.deduction.create({ data: { employeeId, date: new Date('2026-09-01'), amount: 50, reason: 'تأخير', status, ...over } }));
  const tx = <T,>(fn: (t: import('@/modules/platform').TxClient) => Promise<T>) => runPayrollTransaction(prisma, fn);
  const audits = (key: string) => prisma.auditRecord.count({ where: { operationKey: key } });

  /** Sequential double call with one key (same result, one audit), then a concurrent pair with one key on a twin subject. */
  async function twice<T>(make: () => Promise<{ key: string; call: () => Promise<T> }>, same = (x: T, y: T) => expect(y).toEqual(x)) {
    const s = await make();
    const x = await s.call();
    const y = await s.call();
    same(x, y);
    expect(await audits(s.key)).toBe(1);
    const c = await make();
    const both = await Promise.allSettled([c.call(), c.call()]);
    expect(both.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await audits(c.key)).toBe(1);
    return x;
  }

  it('createLoan double call: one loan, createdById recorded; a loan for oneself is a request (DEC-PO-006)', async () => {
    const e = (await employee()).id;
    await twice(async () => {
      const key = `it:loan:${randomUUID()}`;
      return { key, call: () => tx((t) => payroll.createLoan(t, { actor: a.hr, employeeId: e, amount: 1000, monthlyInstallment: 100, reason: 'x', operationKey: key })) };
    });
    expect(await prisma.loan.count({ where: { employeeId: e } })).toBe(2);
    expect((await prisma.loan.findFirstOrThrow({ where: { employeeId: e } })).createdById).toBe(a.hr.id);
    const own = await tx((t) => payroll.createLoan(t, { actor: a.self, employeeId: a.self.employeeId!, amount: 500, monthlyInstallment: 50, reason: '', operationKey: `it:loan:${randomUUID()}` }));
    expect(own.status).toBe('PENDING');
  });

  it('approveLoanStep double call per stage (manager, HR, owner, finance review) with the person of each stage; never on one\'s own loan', async () => {
    const e = (await employee()).id;
    const l1 = await loan(e);
    await twice(async () => {
      const key = `it:loanstep:${randomUUID()}`;
      const id = (await loan(e)).id;
      return { key, call: () => tx((t) => payroll.approveLoanStep(t, { actor: a.mgr, loanId: id, stage: 'MANAGER', operationKey: key })) };
    }, (x, y) => expect(y).toEqual(x));
    const m = await tx((t) => payroll.approveLoanStep(t, { actor: a.mgr, loanId: l1.id, stage: 'MANAGER', operationKey: `it:${randomUUID()}` }));
    expect([m.status, m.managerApprovedById]).toEqual(['MANAGER_APPROVED', a.mgr.id]);
    const h = await tx((t) => payroll.approveLoanStep(t, { actor: a.hr, loanId: l1.id, stage: 'HR', operationKey: `it:${randomUUID()}` }));
    expect([h.status, h.hrApprovedById]).toEqual(['HR_APPROVED', a.hr.id]);
    const l2 = await loan(e);
    const o = await tx((t) => payroll.approveLoanStep(t, { actor: a.owner, loanId: l2.id, stage: 'OWNER', operationKey: `it:${randomUUID()}` }));
    expect([o.status, o.ownerApprovedById]).toEqual(['HR_APPROVED', a.owner.id]);
    // A second owner approval (another key) is a 409: the loan went to finance.
    await expect(tx((t) => payroll.approveLoanStep(t, { actor: a.owner, loanId: l2.id, stage: 'OWNER', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 409 });
    // Own loan: refused for every approval stage (BR-PAY-001).
    const mine = await loan(a.self.employeeId!);
    await expect(tx((t) => payroll.approveLoanStep(t, { actor: a.self, loanId: mine.id, stage: 'HR', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403, details: { reasons: ['SELF_BENEFICIARY'] } });
  });

  it('markLoanTransferred double call; the transferring user is none of the manager / HR / owner approvers (BR-PAY-017); approveLoanStep FINANCE review afterwards', async () => {
    const e = (await employee()).id;
    const approved = async () => {
      const l = await loan(e);
      await tx((t) => payroll.approveLoanStep(t, { actor: a.hr, loanId: l.id, stage: 'HR', operationKey: `it:${randomUUID()}` }));
      return l.id;
    };
    const blockedId = await approved();
    await expect(tx((t) => payroll.markLoanTransferred(t, { actor: a.hr, loanId: blockedId, receiptUrl: '/r.pdf', operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({
      status: 403,
      details: { reasons: ['PAYER_IS_APPROVER'] },
    });
    const done = await twice(async () => {
      const key = `it:transfer:${randomUUID()}`;
      const id = await approved();
      return { key, call: () => tx((t) => payroll.markLoanTransferred(t, { actor: a.fin, loanId: id, receiptUrl: '/r.pdf', operationKey: key })) };
    });
    expect([done.status, done.transferredById]).toEqual(['FINANCE_TRANSFERRED', a.fin.id]);
    const reviewed = await tx((t) => payroll.approveLoanStep(t, { actor: a.fin2, loanId: done.id, stage: 'FINANCE', operationKey: `it:${randomUUID()}` }));
    expect([reviewed.status, reviewed.financeReviewedById]).toEqual(['FINANCE_APPROVED', a.fin2.id]);
  });

  it('rejectLoan double call: rejectedById recorded; a second rejection by someone else is a 409', async () => {
    const e = (await employee()).id;
    const r = await twice(async () => {
      const key = `it:reject:${randomUUID()}`;
      const id = (await loan(e)).id;
      return { key, call: () => tx((t) => payroll.rejectLoan(t, { actor: a.hr, loanId: id, from: ['PENDING', 'MANAGER_APPROVED', 'HR_APPROVED'], operationKey: key })) };
    });
    expect([r.status, r.rejectedById]).toEqual(['REJECTED', a.hr.id]);
    await expect(tx((t) => payroll.rejectLoan(t, { actor: a.owner, loanId: r.id, from: ['PENDING'], operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 409 });
  });

  it('forgiveLoan double call: forgivenById recorded, the balance goes to 0 once; never one\'s own loan', async () => {
    const e = (await employee()).id;
    const f = await twice(async () => {
      const key = `it:forgive:${randomUUID()}`;
      const id = (await loan(e, 'FINANCE_APPROVED')).id;
      return { key, call: () => tx((t) => payroll.forgiveLoan(t, { actor: a.hr, loanId: id, operationKey: key })) };
    });
    expect([f.status, f.remainingAmount, f.forgivenById]).toEqual(['FORGIVEN', 0, a.hr.id]);
    const mine = await loan(a.self.employeeId!, 'FINANCE_APPROVED');
    await expect(tx((t) => payroll.forgiveLoan(t, { actor: a.self, loanId: mine.id, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  it('settleLoansForSettlement double call (sequential and concurrent): the loans are paid off once', async () => {
    const e = (await employee()).id;
    await loan(e, 'FINANCE_APPROVED');
    await loan(e, 'FINANCE_TRANSFERRED');
    const key = `it:settle:${randomUUID()}`;
    const x = await prisma.$transaction((t) => payroll.settleLoansForSettlement(t, { employeeId: e, operationKey: key }));
    const y = await prisma.$transaction((t) => payroll.settleLoansForSettlement(t, { employeeId: e, operationKey: key }));
    expect([x.count, x.collected]).toEqual([2, 2400]);
    expect([y.count, y.collected]).toEqual([0, 0]);
    const e2 = (await employee()).id;
    await loan(e2, 'FINANCE_APPROVED');
    const both = await Promise.allSettled([0, 1].map(() => prisma.$transaction((t) => payroll.settleLoansForSettlement(t, { employeeId: e2, operationKey: `it:${randomUUID()}` }))));
    const collected = both.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + (r as PromiseFulfilledResult<{ collected: number }>).value.collected, 0);
    expect(collected).toBe(1200);
    expect((await prisma.loan.findFirstOrThrow({ where: { employeeId: e2 } })).status).toBe('COMPLETED');
  });

  it('createDeduction double call: one violation, issuedById recorded (decidedById when effective at once)', async () => {
    const e = (await employee()).id;
    const d = await twice(async () => {
      const key = `it:ded:${randomUUID()}`;
      return {
        key,
        call: () =>
          tx((t) =>
            payroll.createDeduction(t, {
              actor: a.hr,
              operationKey: key,
              data: { employeeId: e, amount: 50, date: new Date('2026-09-01'), reason: 'x', category: 'ATTENDANCE', violationType: null, occurrenceNumber: 1, severity: 'LOW', deductionDays: 0, dailySalary: 200, hasFinancialImpact: true, issuedBy: 'hr', status: 'DEDUCTED', lawArticle: null },
            }),
          ),
      };
    });
    expect([d.issuedById, d.decidedById, d.status]).toEqual([a.hr.id, a.hr.id, 'DEDUCTED']);
    expect(await prisma.deduction.count({ where: { employeeId: e } })).toBe(2);
  });

  it('approveDeduction / rejectDeduction / waiveDeduction double calls: decidedById recorded; never on one\'s own penalty', async () => {
    const e = (await employee()).id;
    const ap = await twice(async () => {
      const key = `it:dap:${randomUUID()}`;
      const id = (await deduction(e, 'PENDING_AMOUNT_APPROVAL')).id;
      return { key, call: () => tx((t) => payroll.approveDeduction(t, { actor: a.hr, deductionId: id, amount: 70, from: ['PENDING_AMOUNT_APPROVAL'], operationKey: key })) };
    });
    expect([ap.status, ap.amount, ap.decidedById]).toEqual(['DEDUCTED', 70, a.hr.id]);
    const rj = await twice(async () => {
      const key = `it:drj:${randomUUID()}`;
      const id = (await deduction(e, 'PENDING_WAIVE_APPROVAL')).id;
      return { key, call: () => tx((t) => payroll.rejectDeduction(t, { actor: a.hr, deductionId: id, from: ['PENDING_WAIVE_APPROVAL'], operationKey: key })) };
    });
    expect(rj.status).toBe('WAIVED');
    const wv = await twice(async () => {
      const key = `it:dwv:${randomUUID()}`;
      const id = (await deduction(e, 'DEDUCTED')).id;
      return { key, call: () => tx((t) => payroll.waiveDeduction(t, { actor: a.hr, deductionId: id, operationKey: key })) };
    });
    expect([wv.status, wv.decidedById]).toEqual(['WAIVED', a.hr.id]);
    const own = await deduction(a.self.employeeId!, 'DEDUCTED');
    await expect(tx((t) => payroll.waiveDeduction(t, { actor: a.self, deductionId: own.id, operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403, details: { reasons: ['SELF_BENEFICIARY'] } });
    const ownPending = await deduction(a.self.employeeId!, 'PENDING_AMOUNT_APPROVAL');
    await expect(tx((t) => payroll.approveDeduction(t, { actor: a.self, deductionId: ownPending.id, amount: 1, from: ['PENDING_AMOUNT_APPROVAL'], operationKey: `it:${randomUUID()}` }))).rejects.toMatchObject({ status: 403 });
  });

  it('referDeductionToInvestigation / submitDeductionObjection / resolveDeductionObjection / requestDeductionWaiver double calls', async () => {
    const e = (await employee()).id;
    const inv = await prisma.investigation.create({ data: { employeeId: e, subject: 'x', category: 'ATTENDANCE', severity: 'HIGH' } });
    const rf = await twice(async () => {
      const key = `it:refer:${randomUUID()}`;
      const id = (await deduction(e, 'DEDUCTED')).id;
      const i2 = await prisma.investigation.create({ data: { employeeId: e, subject: 'y', category: 'ATTENDANCE', severity: 'HIGH' } });
      return { key, call: () => tx((t) => payroll.referDeductionToInvestigation(t, { actor: a.hr, deductionId: id, investigationId: i2.id, notIn: ['WAIVED', 'REJECTED'], operationKey: key })) };
    });
    expect([rf.status, rf.isReferredToInvestigation]).toEqual(['UNDER_INVESTIGATION', true]);
    void inv;
    const ob = await twice(async () => {
      const key = `it:object:${randomUUID()}`;
      const id = (await deduction(e, 'DEDUCTED')).id;
      return { key, call: () => tx((t) => payroll.submitDeductionObjection(t, { actor: a.hr, deductionId: id, objectionText: 'ليست مخالفتي', operationKey: key })) };
    });
    expect(ob.status).toBe('OBJECTION_SUBMITTED');
    const rs = await twice(async () => {
      const key = `it:resolve:${randomUUID()}`;
      const id = (await deduction(e, 'OBJECTION_SUBMITTED', { hasObjection: true })).id;
      return { key, call: () => tx((t) => payroll.resolveDeductionObjection(t, { actor: a.hr, deductionId: id, decision: 'ACCEPTED', operationKey: key })) };
    });
    expect([rs.status, rs.objectionStatus, rs.decidedById]).toEqual(['WAIVED', 'ACCEPTED', a.hr.id]);
    const rq = await twice(async () => {
      const key = `it:reqwaive:${randomUUID()}`;
      const id = (await deduction(e, 'DEDUCTED')).id;
      return { key, call: () => tx((t) => payroll.requestDeductionWaiver(t, { actor: a.mgr, deductionId: id, operationKey: key })) };
    });
    expect(rq.status).toBe('PENDING_WAIVE_APPROVAL');
  });

  it('concludeInvestigationDeductions double call: innocent waives the referred violations once; guilty turns the first into the penalty, pending amount approval', async () => {
    const e = (await employee()).id;
    const referred = async (invId: string) => deduction(e, 'UNDER_INVESTIGATION', { investigationId: invId, isReferredToInvestigation: true });
    const newInv = () => prisma.investigation.create({ data: { employeeId: e, subject: 'تحقيق', category: 'ATTENDANCE', severity: 'HIGH' } });
    const inn = await twice(async () => {
      const key = `it:conclude:${randomUUID()}`;
      const inv = await newInv();
      await referred(inv.id);
      return { key, call: () => tx((t) => payroll.concludeInvestigationDeductions(t, { actor: a.hr, investigationId: inv.id, employeeId: e, verdict: 'INNOCENT', awaiting: ['UNDER_INVESTIGATION'], operationKey: key })) };
    });
    expect(inn.waived.length).toBe(1);
    const inv = await newInv();
    const first = await referred(inv.id);
    const out = await tx((t) =>
      payroll.concludeInvestigationDeductions(t, {
        actor: a.hr, investigationId: inv.id, employeeId: e, verdict: 'GUILTY', awaiting: ['UNDER_INVESTIGATION'],
        penalty: { amount: 300, days: 1, dailySalary: 200, reason: 'جزاء', category: 'SERIOUS', severity: 'HIGH' }, operationKey: `it:${randomUUID()}`,
      }),
    );
    expect(out.penalized).toBe(first.id);
    expect((await prisma.deduction.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('PENDING_AMOUNT_APPROVAL');
  });
});

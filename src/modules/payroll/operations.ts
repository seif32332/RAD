// payroll's money operations (money.gateway, ARCH-004; pay-to-be.md BR-PAY-001 / 002 / 004, §11 as
// amended by ARC-PAY-A1 / A7 / A9). Each operation names its act, the tables and columns its writer may
// touch, and how the gateway finds the beneficiaries (employee ids) and the approvers (user ids) of the
// subject. The resolvers read payroll's own tables and the public read side of the modules below it
// (compensation: bonus approvers; time: overtime deciders), never another module's tables (ARCH-001).
import { bonusApproversOfLines } from '@/modules/compensation';
import { defineMoneyOperation, type TxClient } from '@/modules/platform';
import { overtimeApproversOfLines } from '@/modules/time';
import { payrollMonthKey } from '@/lib/payroll-core';

const DRAFT_EFFECTS = { Payroll: '*', LoanInstallment: '*', Deduction: ['payrollMonth'] } as const;

// ---------------------------------------------------------------------------------------------------
// The month of one company (ARC-PAY-A7)
// ---------------------------------------------------------------------------------------------------

export interface MonthSubject {
  companyId: string;
  year: number;
  month: number;
  /** Employees whose lines the act touches (approval: the lines it approves). */
  lineEmployeeIds?: readonly string[];
}

/** payroll.generate: a SYSTEM operation triggered by a registered person (ARC-PAY-A7, BR-PAY-018). */
export const PAYROLL_GENERATE = defineMoneyOperation<MonthSubject>({
  name: 'payroll.month.generate',
  owner: 'payroll',
  act: 'GENERATE',
  source: 'SYSTEM',
  writes: { ...DRAFT_EFFECTS, PayrollMonth: '*' },
});

/**
 * Approving the drafts of a company's month (BR-PAY-004 at month level until BL-PAY-008b): the approver
 * never approves his own line (BR-PAY-001; the line stays DRAFT, reserved for someone else).
 */
export const PAYROLL_APPROVE = defineMoneyOperation<MonthSubject>({
  name: 'payroll.month.approve',
  owner: 'payroll',
  act: 'APPROVE',
  source: 'USER',
  writes: {
    Payroll: ['status', 'approvedById', 'approvedAt'],
    PayrollMonth: '*',
    Loan: ['remainingAmount', 'status'],
    Deduction: ['isLinkedToPayroll'],
  },
  beneficiaries: async (_tx, input) => input.lineEmployeeIds ?? [],
});

/** Every approver of a month's lines and of their inputs (BR-PAY-002, DEC-PO-014). */
export async function monthApprovers(tx: TxClient, input: MonthSubject): Promise<string[]> {
  const month = await tx.payrollMonth.findUnique({ where: { companyId_year_month: { companyId: input.companyId, year: input.year, month: input.month } }, select: { id: true, approvedById: true } });
  if (!month) return [];
  const lines = await tx.payroll.findMany({ where: { payrollMonthId: month.id }, select: { id: true, employeeId: true, approvedById: true } });
  const lineIds = lines.map((l) => l.id);
  const [installments, deductions, bonuses, overtime] = await Promise.all([
    tx.loanInstallment.findMany({
      where: { payrollId: { in: lineIds } },
      select: { loan: { select: { managerApprovedById: true, hrApprovedById: true, ownerApprovedById: true, financeReviewedById: true } } },
    }),
    tx.deduction.findMany({
      where: { employeeId: { in: lines.map((l) => l.employeeId) }, payrollMonth: payrollMonthKey(input.year, input.month), isLinkedToPayroll: true },
      select: { decidedById: true },
    }),
    bonusApproversOfLines(tx, lineIds),
    overtimeApproversOfLines(tx, lineIds),
  ]);
  const ids = [
    month.approvedById,
    ...lines.map((l) => l.approvedById),
    ...installments.flatMap((i) => [i.loan.managerApprovedById, i.loan.hrApprovedById, i.loan.ownerApprovedById, i.loan.financeReviewedById]),
    ...deductions.map((d) => d.decidedById),
    ...bonuses,
    ...overtime,
  ];
  return [...new Set(ids.filter((x): x is string => !!x))];
}

/**
 * Recording the month paid (until BL-PAY-020 marks lines PAID from the signed bank file): the payer is
 * none of the approvers of the lines and their inputs (BR-PAY-002). Marking payroll lines paid is not a
 * beneficiary act (DEC-PO-015).
 */
export const PAYROLL_PAY = defineMoneyOperation<MonthSubject>({
  name: 'payroll.month.pay',
  owner: 'payroll',
  act: 'PAY',
  source: 'USER',
  notBeneficiary: false,
  writes: { Payroll: ['status', 'paidAt', 'paidById'], PayrollMonth: '*' },
  approvers: monthApprovers,
});

/** An employee's drafts from a month on are dropped (settlement approval, BR-LCY-014) — SYSTEM effect. */
export const PAYROLL_DRAFTS_DROP = defineMoneyOperation<{ employeeId: string }>({
  name: 'payroll.drafts.drop',
  owner: 'payroll',
  act: 'RELEASE',
  source: 'SYSTEM',
  writes: DRAFT_EFFECTS,
});

/** The payroll.employment consumer regenerates an employee's draft line (ARC-PAY-A9) — SYSTEM. */
export const PAYROLL_LINE_REGENERATE = defineMoneyOperation<MonthSubject>({
  name: 'payroll.line.regenerate',
  owner: 'payroll',
  act: 'GENERATE',
  source: 'SYSTEM',
  writes: { ...DRAFT_EFFECTS, PayrollMonth: '*' },
});

/** The employee's GOSI deduction (payroll's projection column, ARCH-003) edited in the file. */
export const GOSI_DEDUCTION_SET = defineMoneyOperation<{ employeeId: string }>({
  name: 'payroll.gosiDeduction.set',
  owner: 'payroll',
  act: 'APPLY_CHANGE',
  source: 'USER',
  writes: { Employee: ['gosiDeduction'] },
  beneficiaries: async (_tx, input) => [input.employeeId],
});

// ---------------------------------------------------------------------------------------------------
// Loans (pay-to-be §11 row 3, BR-PAY-017)
// ---------------------------------------------------------------------------------------------------

export interface LoanSubject {
  loanId: string;
}

async function loanEmployee(tx: TxClient, input: LoanSubject) {
  const loan = await tx.loan.findUnique({ where: { id: input.loanId }, select: { employeeId: true } });
  return loan ? [loan.employeeId] : [];
}

/** Filing a loan (for oneself too: a pending request, DEC-PO-006). */
export const LOAN_CREATE = defineMoneyOperation<{ employeeId: string }>({
  name: 'payroll.loan.create',
  owner: 'payroll',
  act: 'REQUEST',
  source: 'USER',
  writes: { Loan: '*' },
});

/** A manager / HR / owner approval step: never on one's own loan. */
export const LOAN_APPROVE = defineMoneyOperation<LoanSubject>({
  name: 'payroll.loan.approve',
  owner: 'payroll',
  act: 'APPROVE',
  source: 'USER',
  writes: { Loan: '*' },
  beneficiaries: loanEmployee,
});

/** A rejection of a loan still in decision; it zeroes the balance (BL-PAY-027, DEC-PO-113). */
export const LOAN_REJECT = defineMoneyOperation<LoanSubject>({
  name: 'payroll.loan.reject',
  owner: 'payroll',
  act: 'REJECT',
  source: 'USER',
  writes: { Loan: ['status', 'rejectedById', 'rejectedAt', 'remainingAmount'] },
});

/** Finance transfers the money: not the beneficiary, not a manager / HR / owner approver (BR-PAY-017). */
export const LOAN_TRANSFER = defineMoneyOperation<LoanSubject>({
  name: 'payroll.loan.transfer',
  owner: 'payroll',
  act: 'TRANSFER',
  source: 'USER',
  writes: { Loan: ['status', 'isFinanceTransferred', 'financeTransferredAt', 'receiptUrl', 'transferredById'] },
  beneficiaries: loanEmployee,
  approvers: async (tx, input) => {
    const loan = await tx.loan.findUnique({ where: { id: input.loanId }, select: { managerApprovedById: true, hrApprovedById: true, ownerApprovedById: true } });
    return loan ? [loan.managerApprovedById, loan.hrApprovedById, loan.ownerApprovedById] : [];
  },
});

/** The final finance review FINANCE_TRANSFERRED → FINANCE_APPROVED: any payroll user but the beneficiary (DEC-PO-008). */
export const LOAN_FINANCE_REVIEW = defineMoneyOperation<LoanSubject>({
  name: 'payroll.loan.financeReview',
  owner: 'payroll',
  act: 'APPROVE',
  source: 'USER',
  writes: { Loan: ['status', 'isFinanceApproved', 'financeApprovedAt', 'financeReviewedById'] },
  beneficiaries: loanEmployee,
});

export const LOAN_FORGIVE = defineMoneyOperation<LoanSubject>({
  name: 'payroll.loan.forgive',
  owner: 'payroll',
  act: 'FORGIVE',
  source: 'USER',
  writes: { Loan: ['isForgiven', 'remainingAmount', 'status', 'forgivenById'], ...DRAFT_EFFECTS },
  beneficiaries: loanEmployee,
});

/** The settlement pays off the employee's loans (effect of the settlement approval) — SYSTEM. */
export const LOAN_SETTLE = defineMoneyOperation<{ employeeId: string }>({
  name: 'payroll.loan.settleBySettlement',
  owner: 'payroll',
  act: 'SETTLE',
  source: 'SYSTEM',
  writes: { Loan: ['remainingAmount', 'status'] },
});

// ---------------------------------------------------------------------------------------------------
// Deductions / penalties (pay-to-be §11 row 4, BR-PAY-010)
// ---------------------------------------------------------------------------------------------------

export interface DeductionSubject {
  deductionId?: string;
  deductionIds?: readonly string[];
  employeeId?: string;
}

async function deductionEmployees(tx: TxClient, input: DeductionSubject) {
  const ids = [...(input.deductionIds ?? []), ...(input.deductionId ? [input.deductionId] : [])];
  const rows = ids.length ? await tx.deduction.findMany({ where: { id: { in: ids } }, select: { employeeId: true } }) : [];
  return [...rows.map((r) => r.employeeId), ...(input.employeeId ? [input.employeeId] : [])];
}

/** Issuing a violation (a penalty on someone is not self-dealing; the amount approval is guarded). */
export const DEDUCTION_CREATE = defineMoneyOperation<DeductionSubject>({
  name: 'payroll.deduction.create',
  owner: 'payroll',
  act: 'REQUEST',
  source: 'USER',
  writes: { Deduction: '*' },
});

/** The penalty stands (pricing / amount approval / refused waiver): not on one's own penalty. */
export const DEDUCTION_APPROVE = defineMoneyOperation<DeductionSubject>({
  name: 'payroll.deduction.approve',
  owner: 'payroll',
  act: 'APPROVE',
  source: 'USER',
  writes: { Deduction: '*' },
  beneficiaries: deductionEmployees,
});

/** The penalty is dropped (rejection, waiver, accepted objection, innocent verdict): never one's own. */
export const DEDUCTION_WAIVE = defineMoneyOperation<DeductionSubject>({
  name: 'payroll.deduction.waive',
  owner: 'payroll',
  act: 'WAIVE',
  source: 'USER',
  writes: { ...DRAFT_EFFECTS, Deduction: '*' },
  beneficiaries: deductionEmployees,
});

/** The penalty is suspended (referred to an investigation): never one's own. */
export const DEDUCTION_SUSPEND = defineMoneyOperation<DeductionSubject>({
  name: 'payroll.deduction.suspend',
  owner: 'payroll',
  act: 'SUSPEND',
  source: 'USER',
  writes: { ...DRAFT_EFFECTS, Deduction: '*' },
  beneficiaries: deductionEmployees,
});

/** The employee objects, or a manager asks HR to waive: a request (the decision is guarded). */
export const DEDUCTION_REQUEST = defineMoneyOperation<DeductionSubject>({
  name: 'payroll.deduction.request',
  owner: 'payroll',
  act: 'REQUEST',
  source: 'USER',
  writes: { ...DRAFT_EFFECTS, Deduction: '*' },
});

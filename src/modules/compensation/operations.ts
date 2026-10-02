// compensation's money operations (money.gateway, ARCH-004; ARC-PAY-A1: the gateway guards, compensation
// writes). P1-PAY-B: every change of an employee's pay or bank identity is a REQUEST
// (EmployeeFinancialChange, BR-PAY-009 / ARC-PAY-A2) decided by a second person; applying it opens a
// CompensationPeriod / BankIdentityPeriod (the facts, through platform/effective) and refreshes the
// Employee projection columns (ARC-PAY-A4). One-off bonuses (Allowance isMonthly=false) keep their
// P1-PAY-A operations until BL-PAY-007 makes them PENDING.
import { EMPLOYEE_MONEY_COLUMNS, defineMoneyOperation } from '@/modules/platform';

/** The Employee projection columns compensation writes (gosiDeduction is payroll's projection). */
const PROJECTION_COLUMNS = EMPLOYEE_MONEY_COLUMNS.filter((c) => c !== 'gosiDeduction');

export interface EmployeeSubject {
  employeeId: string;
}

const subject = async (_tx: unknown, input: EmployeeSubject) => [input.employeeId];

/** A one-off bonus, effective at once (BL-PAY-007 makes it PENDING): never to oneself (BR-PAY-001). */
export const BONUS_CREATE = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.bonus.create',
  owner: 'compensation',
  act: 'CREATE_EFFECTIVE',
  source: 'USER',
  writes: { Allowance: '*' },
  beneficiaries: subject,
});

/** payroll.generate reserves the due bonuses of a draft line; approval marks them paid; release undoes. */
export const BONUS_PAYROLL_LINK = defineMoneyOperation<{ payrollIds: readonly string[] }>({
  name: 'compensation.bonus.linkPayroll',
  owner: 'compensation',
  act: 'RELEASE',
  source: 'SYSTEM',
  writes: { Allowance: ['paidInPayrollId', 'payrollMonth', 'payrollYear', 'isPaid'] },
});

/**
 * Filing a financial change request (BR-PAY-009): a REQUEST, allowed for oneself (DEC-PO-006). Writes the
 * request only; nothing is in force until a second person decides it.
 */
export const FINANCIAL_CHANGE_REQUEST = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.financialChange.request',
  owner: 'compensation',
  act: 'REQUEST',
  source: 'USER',
  writes: { EmployeeFinancialChange: '*' },
});

/**
 * The second person's decision (DEC-PO-003 / 007): the decider is neither the requester nor the
 * employee (BR-PAY-001); SINGLE_OPERATOR lets it through as a recorded self-act (BR-PAY-020). The
 * application itself is FINANCIAL_CHANGE_APPLY (run in the same transaction when already due).
 */
export const FINANCIAL_CHANGE_DECIDE = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.financialChange.decide',
  owner: 'compensation',
  act: 'APPROVE',
  source: 'USER',
  writes: { EmployeeFinancialChange: '*' },
  beneficiaries: subject,
});

/** Rejecting a request: the same two-person rule as the approval (the beneficiary never decides his own). */
export const FINANCIAL_CHANGE_REJECT = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.financialChange.reject',
  owner: 'compensation',
  act: 'REJECT',
  source: 'USER',
  writes: { EmployeeFinancialChange: '*' },
});

/** The requester (or HR) withdraws a request not applied yet; the employee confirms a legacy IBAN request. */
export const FINANCIAL_CHANGE_CANCEL = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.financialChange.cancel',
  owner: 'compensation',
  act: 'REQUEST',
  source: 'USER',
  writes: { EmployeeFinancialChange: '*' },
});

/**
 * A decided change reaches its effective date (SYSTEM: the decision already passed the two-person
 * rule): compensation.applyDecision / applyBankIdentity open the period and refresh the projection.
 */
export const FINANCIAL_CHANGE_APPLY = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.financialChange.apply',
  owner: 'compensation',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { EmployeeFinancialChange: '*' },
});

/** employment.terminated: the pending and future changes after the last working day are cancelled (ARC-PAY-A2). */
export const FINANCIAL_CHANGE_EXIT_CANCEL = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.financialChange.exitCancel',
  owner: 'compensation',
  act: 'RELEASE',
  source: 'SYSTEM',
  writes: { EmployeeFinancialChange: '*' },
});

/**
 * compensation.applyDecision (SOURCE_OF_TRUTH: the sole writer of CompensationPeriod and of the Employee
 * pay projection): opens / supersedes the period from the effective date and projects today's values.
 * Called by an applied financial change, an approved decision letter (change order) or onboarding.
 */
export const COMPENSATION_APPLY = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.period.apply',
  owner: 'compensation',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { CompensationPeriod: '*', Employee: PROJECTION_COLUMNS, Allowance: '*', SalaryChange: '*' },
});

/** compensation.applyBankIdentity: the bank identity from the day it is applied (ADR-0001 #8), and its projection. */
export const BANK_IDENTITY_APPLY = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.bankIdentity.apply',
  owner: 'compensation',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { BankIdentityPeriod: '*', Employee: PROJECTION_COLUMNS },
});

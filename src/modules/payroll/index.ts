// Public API of the payroll module (DOMAIN_BOUNDARIES §5.1). Owns Payroll (the lines), PayrollMonth
// (one per legal company and month, ARC-PAY-A7), Loan, LoanInstallment and Deduction (§5.2), and the
// Employee projection gosiDeduction. Every write is a transition behind money.gateway (P1-PAY-A,
// ARCH-004). payroll sits above finance and below offboarding (§5.3): it calls time, compensation,
// lifecycle, people and platform; offboarding calls it (settlement approval); it learns of employment
// changes from the employment.* events (./consumers, BL-PAY-025).
//
// The computation of a month (reading employees, leave, overtime, loans, settlements) still lives in
// src/lib/payroll.ts and src/lib/payroll-core.ts (legacy code of this module, moved package by package):
// it builds a GenerationPlan and commits it here.
export {
  commitPayrollGeneration,
  approvePayrollMonth,
  markPayrollMonthPaid,
  setEmployeeGosiDeduction,
} from './transitions/month';
export type { GeneratedLine, GenerationPlan, GenerationResult, MonthActInput, ApproveMonthResult } from './transitions/month';
export { releaseDraftLines, releaseDeductionReservation, releaseLoanInstallmentsFromDrafts, dropEmployeeDraftsFrom } from './transitions/drafts';
export { createLoan, approveLoanStep, rejectLoan, markLoanTransferred, forgiveLoan, settleLoansForSettlement } from './transitions/loans';
export type { CreateLoanInput, SettledLoan } from './transitions/loans';
export {
  createDeduction,
  approveDeduction,
  rejectDeduction,
  waiveDeduction,
  referDeductionToInvestigation,
  submitDeductionObjection,
  resolveDeductionObjection,
  requestDeductionWaiver,
  concludeInvestigationDeductions,
} from './transitions/deductions';
export type { DeductionActor, CreateDeductionInput, InvestigationOutcomeInput, InvestigationOutcome } from './transitions/deductions';
export { loanStageRule, PAYROLL_MONTH_STATUS } from './policy';
export type { LoanStage } from './policy';
export { assertEmploymentGate, EmploymentChangePendingError, PAYROLL_EMPLOYMENT_CONSUMER, monthEnd } from './gate';
export { createPayrollEmploymentConsumer, PAYROLL_EMPLOYMENT_CONSUMER_DEF, PAYROLL_CONSUMERS, effectiveMonthOf } from './consumers';
export type { EmploymentConsumerDeps } from './consumers';
export { employmentChangeCheck, employmentChangeResults, INV_PAY_04_ID, EMPLOYMENT_CHANGE_CHECK, EMPLOYMENT_CONSUMPTION_DEAD_CHECK } from './invariants';
export { runPayrollTransaction } from './run';
export type { TxRunner } from './run';
export {
  PAYROLL_GENERATE,
  PAYROLL_APPROVE,
  PAYROLL_PAY,
  PAYROLL_DRAFTS_DROP,
  PAYROLL_LINE_REGENERATE,
  GOSI_DEDUCTION_SET,
  LOAN_CREATE,
  LOAN_APPROVE,
  LOAN_REJECT,
  LOAN_TRANSFER,
  LOAN_FINANCE_REVIEW,
  LOAN_FORGIVE,
  LOAN_SETTLE,
  DEDUCTION_CREATE,
  DEDUCTION_APPROVE,
  DEDUCTION_WAIVE,
  DEDUCTION_SUSPEND,
  DEDUCTION_REQUEST,
  monthApprovers,
} from './operations';

import { registerConsumer } from '@/modules/platform';
import { PAYROLL_CONSUMERS as CONSUMERS } from './consumers';

let registered = false;
/** Registers the payroll consumers with the platform dispatcher (once per process). */
export function registerPayrollConsumers(): void {
  if (registered) return;
  for (const c of CONSUMERS) registerConsumer(c);
  registered = true;
}

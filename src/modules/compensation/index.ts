// Public API of the compensation module (DOMAIN_BOUNDARIES §5.1). compensation owns the facts of pay:
// CompensationPeriod (basic salary + recurring allowances) and BankIdentityPeriod (the IBAN), written
// through platform/effective by compensation only (ARCH-012 / ARCH-021), the request that changes them
// (EmployeeFinancialChange, BR-PAY-009 / ARC-PAY-A2: decided by a second person, then applied) and the
// Employee projection columns (basicSalary, the recurring Allowance rows, ibanNumber, bankName,
// salaryPaymentMethod, payrollReady; ARC-PAY-A4), written by its projector only.
// Financial calculations read the facts (compensationSegments, effectiveContext(e, d).compensation),
// never Employee.basicSalary (ARCH-011). Every write runs behind money.gateway (ARCH-004).
import { activeAt, consumerRegistry, registerConsumer, type DateOnly, type PeriodReader, type PeriodView, type ReadOptions } from '@/modules/platform';
import { COMPENSATION_CONSUMERS as COMPENSATION_CONSUMERS_LIST } from './consumers';

/** The compensation period in force on `date` (or as recorded at `opts.asRecordedAt`). */
export function compensationAt(db: PeriodReader, employeeId: string, date: DateOnly, opts?: ReadOptions): Promise<PeriodView<'COMPENSATION'> | null> {
  return activeAt(db, 'COMPENSATION', employeeId, date, opts);
}

/** The bank identity in force on `date`. */
export function bankIdentityAt(db: PeriodReader, employeeId: string, date: DateOnly, opts?: ReadOptions): Promise<PeriodView<'BANK_IDENTITY'> | null> {
  return activeAt(db, 'BANK_IDENTITY', employeeId, date, opts);
}

// One-off bonuses (P1-PAY-A slice; BL-PAY-007 makes them PENDING).
export { createBonus, linkBonusesToPayroll, unlinkBonusesFromPayrolls, markBonusesPaid } from './transitions/bonuses';
export type { CreateBonusInput } from './transitions/bonuses';

// The facts and their projection (P1-PAY-B).
export { applyDecision, applyBankIdentity, applyChangeOrderPay } from './transitions/apply';
export type { ApplyDecisionInput, ApplyDecisionResult, ApplyBankIdentityInput, ApplyBankIdentityResult, ChangeOrderPayInput, PeriodSource } from './transitions/apply';

// The request (P1-PAY-B, BR-PAY-009).
export {
  requestFinancialChange,
  decideFinancialChange,
  applyFinancialChange,
  cancelFinancialChange,
  confirmLegacyFinancialChange,
  cancelFinancialChangesAfterExit,
} from './transitions/financial-change';
export type {
  RequestFinancialChangeInput,
  RequestFinancialChangeResult,
  DecideFinancialChangeInput,
  DecideFinancialChangeResult,
  ApplyFinancialChangeInput,
  CancelFinancialChangeInput,
} from './transitions/financial-change';
export {
  COMPENSATION_PERIOD_EVENT_TYPES,
  BANK_IDENTITY_OPENED_EVENT,
  FINANCIAL_CHANGE_FIELDS,
  FINANCIAL_CHANGE_SOURCES,
  FINANCIAL_CHANGE_STATUSES,
  OPEN_FINANCIAL_CHANGE_STATUSES,
  FINANCIAL_CHANGE_SELECT,
  IbanSelfServiceOnlyError,
  financialChangeView,
} from './model';
export type { FinancialChangeField, FinancialChangeSource, FinancialChangeStatus, FinancialChangeView } from './model';
export { allowanceLineOf, toPeriodAllowances, sameCompensation, monthlyTotal } from './allowances';
export type { RequestedAllowance, AllowanceLine } from './allowances';
export { ibanFingerprint, ibanLast4, maskedIban } from './bank';

export {
  FINANCIAL_CHANGE_REQUEST,
  FINANCIAL_CHANGE_DECIDE,
  FINANCIAL_CHANGE_REJECT,
  FINANCIAL_CHANGE_CANCEL,
  FINANCIAL_CHANGE_APPLY,
  FINANCIAL_CHANGE_EXIT_CANCEL,
  COMPENSATION_APPLY,
  BANK_IDENTITY_APPLY,
  BONUS_CREATE,
  BONUS_PAYROLL_LINK,
} from './operations';
export { bonusApproversOfLines, compensationSegments, compensationOnDay, compensationLineagesOf, listFinancialChanges } from './queries';
export type { CompensationSegment } from './queries';
export { runCompensationTransaction } from './run';
export { assertPayrollReady, EmployeeNotPayrollReadyError } from './ready';
export { applyDueFinancialChanges, applyFinancialChangesJob, dueApplyKey, openMissingCompensation, APPLY_FINANCIAL_CHANGES_JOB } from './jobs';
export { COMPENSATION_CONSUMERS, COMPENSATION_EXIT_CONSUMER, compensationExitConsumer } from './consumers';
export { INV_SAL_01_ID, LEGACY_READY_CATEGORY, payProjectionCheck, payProjectionResults } from './invariants';

/** Registers the consumers of compensation with the platform dispatcher (idempotent; the composition roots call it). */
export function registerCompensationConsumers(): void {
  for (const c of COMPENSATION_CONSUMERS_LIST) if (!consumerRegistry.list().some((r) => r.name === c.name)) registerConsumer(c);
}

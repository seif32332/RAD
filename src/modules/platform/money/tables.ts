// What money.gateway protects at run time (ARCH-004; pay-to-be.md §2, BR-PAY-018; ARC-PAY-A1).
//
// MONEY_TABLES: every write (create / update / upsert / delete, top level or nested, and raw SQL DML)
// to these tables must run inside a registered gateway operation whose context allows the table (and,
// when the operation lists fields, the columns written). Anything else is refused (fail closed).
//
// MONEY_COLUMNS: columns of other tables that carry money and are protected the same way:
//   - OvertimeRequest.paidInPayrollId / paidInSettlementId: the reservation links of payroll and of
//     the settlement; OvertimeRequest.status (BL-PAY-027, F9): the decision that makes overtime payable
//     is written by time.decideOvertime / time.assignOvertime only (a create may not carry a status
//     either: a new request takes the column default PENDING);
//   - the Employee money projection columns of ARCH-004 (config EMPLOYEE_MONEY_FIELDS), on every
//     write: UPDATE and, from P1-PAY-B on, CREATE too. A new employee starts without pay (the columns'
//     defaults) and gets it through EmployeeFinancialChange (BR-PAY-009, ARC-PAY-A4): the key is refused
//     whatever its value (fail closed, BR-PAY-018).
// Deleting an Employee is refused outside the gateway (its money rows would go with it, §2).
//
// The list is a runtime fact, not a company setting (ARC-PAY-A1). The conformance tests keep it equal
// to the constitution's config (src/test/architecture/config.ts MONEY_MODELS / EMPLOYEE_MONEY_FIELDS).

/**
 * Tables of ARCH-004 that exist in the schema today (MONEY_MODELS minus the planned ones). The period
 * tables CompensationPeriod and BankIdentityPeriod are written by platform/effective only (ARCH-012),
 * inside compensation's gateway operations (P1-PAY-B: applyDecision / applyBankIdentity).
 */
export const MONEY_TABLES = [
  'Payroll',
  'PayrollMonth',
  'Loan',
  'LoanInstallment',
  'Deduction',
  'Allowance',
  'SalaryChange',
  'Settlement',
  'PaymentRequest',
  'CompensationPeriod',
  'BankIdentityPeriod',
  'EmployeeFinancialChange',
] as const;
export type MoneyTable = (typeof MONEY_TABLES)[number];

/** The Employee money projection columns (ARCH-004, EMPLOYEE_MONEY_FIELDS). */
export const EMPLOYEE_MONEY_COLUMNS = [
  'basicSalary',
  'housingAllowance',
  'transportAllowance',
  'otherAllowances',
  'gosiDeduction',
  'ibanNumber',
  'bankName',
  'salaryPaymentMethod',
  'payrollReady',
] as const;

export interface ProtectedColumns {
  columns: readonly string[];
  /** 'update': update / updateMany / upsert.update only; 'all': creates too. */
  on: 'update' | 'all';
}

export const MONEY_COLUMNS: Readonly<Record<string, ProtectedColumns>> = Object.freeze({
  Employee: { columns: EMPLOYEE_MONEY_COLUMNS, on: 'all' },
  OvertimeRequest: { columns: ['paidInPayrollId', 'paidInSettlementId', 'status'], on: 'all' },
});

/** Tables whose DELETE is refused outside the gateway although they are not money tables. */
export const MONEY_GUARDED_DELETES: readonly string[] = ['Employee'];

export function isMoneyTable(model: string): boolean {
  return (MONEY_TABLES as readonly string[]).includes(model);
}

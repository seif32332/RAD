// What money.gateway protects at run time (ARCH-004; pay-to-be.md §2, BR-PAY-018; ARC-PAY-A1).
//
// MONEY_TABLES: every write (create / update / upsert / delete, top level or nested, and raw SQL DML)
// to these tables must run inside a registered gateway operation whose context allows the table (and,
// when the operation lists fields, the columns written). Anything else is refused (fail closed).
//
// MONEY_COLUMNS: columns of other tables that carry money and are protected the same way:
//   - OvertimeRequest.paidInPayrollId / paidInSettlementId: the reservation links of payroll and of
//     the settlement (the overtime row itself belongs to time; its approval is BL-PAY-007);
//   - the Employee money projection columns of ARCH-004 (config EMPLOYEE_MONEY_FIELDS), on UPDATE
//     writes. The CREATE of an employee is checked from P1-PAY-B on: a new employee then starts
//     without pay and gets it through EmployeeFinancialChange (BR-PAY-009, ARC-PAY-A4); until then a
//     new employee's first values are the creation form's (listed in the package report).
// Deleting an Employee is refused outside the gateway (its money rows would go with it, §2).
//
// The list is a runtime fact, not a company setting (ARC-PAY-A1). The conformance tests keep it equal
// to the constitution's config (src/test/architecture/config.ts MONEY_MODELS / EMPLOYEE_MONEY_FIELDS).

/**
 * Tables of ARCH-004 that exist in the schema today (MONEY_MODELS minus the planned ones). CompensationPeriod
 * is written by platform/effective only (ARCH-012); it joins with compensation.applyDecision (P1-PAY-B).
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
] as const;

export interface ProtectedColumns {
  columns: readonly string[];
  /** 'update': update / updateMany / upsert.update only; 'all': creates too. */
  on: 'update' | 'all';
}

export const MONEY_COLUMNS: Readonly<Record<string, ProtectedColumns>> = Object.freeze({
  Employee: { columns: EMPLOYEE_MONEY_COLUMNS, on: 'update' },
  OvertimeRequest: { columns: ['paidInPayrollId', 'paidInSettlementId'], on: 'all' },
});

/** Tables whose DELETE is refused outside the gateway although they are not money tables. */
export const MONEY_GUARDED_DELETES: readonly string[] = ['Employee'];

export function isMoneyTable(model: string): boolean {
  return (MONEY_TABLES as readonly string[]).includes(model);
}

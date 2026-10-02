// compensation's money operations (money.gateway, ARCH-004): allowances and one-off bonuses (Allowance),
// salary history (SalaryChange) and the Employee pay projection columns (basicSalary, the recurring
// allowance totals, the bank identity columns). EmployeeFinancialChange and CompensationPeriod replace
// the direct edits in P1-PAY-B (BR-PAY-009, ARC-PAY-A2); until then every edit is a named operation.
import { EMPLOYEE_MONEY_COLUMNS, defineMoneyOperation } from '@/modules/platform';

const PAY_COLUMNS = EMPLOYEE_MONEY_COLUMNS.filter((c) => c !== 'gosiDeduction'); // gosiDeduction is payroll's projection

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

/** HR edits an employee's pay in the file (BR-PAY-001: never one's own; P1-PAY-B turns it into a request). */
export const PAY_EDIT = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.pay.edit',
  owner: 'compensation',
  act: 'APPLY_CHANGE',
  source: 'USER',
  writes: { Employee: PAY_COLUMNS, Allowance: '*' },
  beneficiaries: subject,
});

/** The recurring allowances of a new employee, written with the creation. */
export const PAY_INITIAL = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.pay.initial',
  owner: 'compensation',
  act: 'CREATE_EFFECTIVE',
  source: 'USER',
  writes: { Allowance: '*' },
  beneficiaries: subject,
});

/**
 * An approved promotion / raise decision reaches its effective date (BL-PAY-003 note: applyChangeOrder
 * and the apply-employee-changes job): a SYSTEM operation applying an order approved by two people.
 */
export const CHANGE_ORDER_APPLY = defineMoneyOperation<EmployeeSubject>({
  name: 'compensation.changeOrder.apply',
  owner: 'compensation',
  act: 'APPLY_CHANGE',
  source: 'SYSTEM',
  writes: { Employee: ['basicSalary'], Allowance: '*', SalaryChange: '*' },
});

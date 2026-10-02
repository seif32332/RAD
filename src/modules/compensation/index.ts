// Public API of the compensation module (DOMAIN_BOUNDARIES §5.1). Owns CompensationPeriod
// (P1-FND-EFF), and later BankIdentityPeriod and EmployeeFinancialChange (P1-PAY-B). Skeleton: only
// the read side exists; compensation.applyDecision (the sole writer of CompensationPeriod and of the
// Employee salary projection, behind money.gateway, ARC-PAY-A1/A2) is P1-PAY-B. Legacy
// CompensationPeriod openings are written by platform's openLegacyPeriod (ARC-SYS-A3).
// Financial calculations read effectiveContext(e, d).compensation, never Employee.basicSalary (ARCH-011).
import { activeAt, type DateOnly, type PeriodReader, type PeriodView, type ReadOptions } from '@/modules/platform';

/** The compensation period in force on `date` (or as recorded at `opts.asRecordedAt`). */
export function compensationAt(db: PeriodReader, employeeId: string, date: DateOnly, opts?: ReadOptions): Promise<PeriodView<'COMPENSATION'> | null> {
  return activeAt(db, 'COMPENSATION', employeeId, date, opts);
}

// P1-PAY-A: the money writers of compensation behind money.gateway (Allowance, SalaryChange, the Employee
// pay projection columns). P1-PAY-B replaces the direct edits by EmployeeFinancialChange / applyDecision.
export {
  createBonus,
  linkBonusesToPayroll,
  unlinkBonusesFromPayrolls,
  markBonusesPaid,
  editEmployeePay,
  setInitialAllowances,
  applyChangeOrderPay,
} from './transitions';
export type { CreateBonusInput, EditEmployeePayInput, EmployeePayChange, RecurringAllowance, ChangeOrderPayInput } from './transitions';
export { BONUS_CREATE, BONUS_PAYROLL_LINK, PAY_EDIT, PAY_INITIAL, CHANGE_ORDER_APPLY } from './operations';
export { bonusApproversOfLines } from './queries';

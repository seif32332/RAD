// payrollEligible (BL-LCY-012, lcy-to-be.md BR-LCY-011): the ONE condition for an employee to have a
// payroll line in a month. The generator (src/lib/payroll.ts computeGenerationPlan) calls it; the month
// guard of BL-PAY-008b ("no APPROVED month while an eligible employee has no line") will call the same
// function, so there are never two definitions to keep equal (RT-LCY-304, RT-LCY-405).
//
// The date, not the state: the end of employment is lifecycle's employmentEnd (the last working day of
// an employee in NOTICE or TERMINATED), so an employee in NOTICE is prorated in the exit month and has
// no line after it, exactly like a TERMINATED one (RT-LCY-102). Conditions:
//   - joined by the month's end;
//   - not TERMINATED without a date (a legacy termination: not eligible, HR reviews it);
//   - employmentEnd empty or on / after the month's first day;
//   - not in or after the month of the last working day of an END_OF_SERVICE settlement of the
//     current employment period (the settlement pays that month; the caller passes the coverage
//     computed with the period scoping of settlementCoverage);
// "Days due > 0" is the generator's own check after the computation (a month with no due day still
// carries bonuses / overtime forward), and payrollReady joins with BL-PAY-008b.
import { employmentEnd, isSeparated, type EmploymentProjection } from '@/modules/lifecycle';

export type PayrollIneligibleReason = 'NOT_JOINED' | 'TERMINATED_WITHOUT_DATE' | 'ENDED_BEFORE_MONTH' | 'SETTLED_BY_EOS';

export interface PayrollEligibilityInput {
  employee: EmploymentProjection & { joinDate: Date };
  year: number;
  month: number;
  /** Last working day of an END_OF_SERVICE settlement of the current period (settlementCoverage().finalDay). */
  settlementFinalDay?: Date | null;
}

export type PayrollEligibility =
  | { eligible: true; employmentEnd: Date | null }
  | { eligible: false; reason: PayrollIneligibleReason; employmentEnd: Date | null };

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function payrollEligible(input: PayrollEligibilityInput): PayrollEligibility {
  const { employee, year, month } = input;
  const first = dayKey(new Date(Date.UTC(year, month - 1, 1)));
  const last = dayKey(new Date(Date.UTC(year, month, 0)));
  const end = employmentEnd(employee);
  if (dayKey(employee.joinDate) > last) return { eligible: false, reason: 'NOT_JOINED', employmentEnd: end };
  if (isSeparated(employee) && !employee.terminationDate) return { eligible: false, reason: 'TERMINATED_WITHOUT_DATE', employmentEnd: end };
  if (end && dayKey(end) < first) return { eligible: false, reason: 'ENDED_BEFORE_MONTH', employmentEnd: end };
  if (input.settlementFinalDay && dayKey(input.settlementFinalDay) <= last) return { eligible: false, reason: 'SETTLED_BY_EOS', employmentEnd: end };
  return { eligible: true, employmentEnd: end };
}

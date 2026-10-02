// The employment gate of payroll (BL-PAY-025 at MONTH level; ARC-PAY-A9): no approval of a company's
// month while an employment.* event of one of its employees, effective on or before the month's end, is
// not yet consumed by payroll.employment (the draft may not reflect a hire, an exit, a void…). The
// gate is keyed on (event, month): an event effective after the month does not concern it. A stuck
// consumption (DEAD) no longer holds the gate here: it surfaces as a blocking INV-PAY-04 discrepancy
// of that line and month (./invariants.ts), explainable by a second person, and the L4 gate stops the
// approval through it. The line-level gate is BL-PAY-008b.
import { HttpError } from '@/lib/http';
import { EMPLOYMENT_EVENT_TYPES } from '@/modules/lifecycle';
import { eventsNotConsumed, type TxClient } from '@/modules/platform';

/** The consumer name (DomainEvent consumption key: stable forever). */
export const PAYROLL_EMPLOYMENT_CONSUMER = 'payroll.employment';

/** 409 listing the employees whose employment change the draft does not reflect yet. */
export class EmploymentChangePendingError extends HttpError {
  readonly employeeIds: string[];
  constructor(employeeIds: string[], events: number) {
    super(409, 'لا يمكن اعتماد المسير الآن: توجد تغييرات توظيف لم تنعكس بعد على مسودة هذا الشهر (تُعاد مسودات الموظفين المعنيين آلياً خلال دقائق). أعد المحاولة بعد قليل.', {
      code: 'EMPLOYMENT_CHANGE_PENDING',
      employeeIds,
      events,
    });
    this.name = 'EmploymentChangePendingError';
    this.employeeIds = employeeIds;
  }
}

/** Last day of the month (UTC midnight, date-only convention). */
export function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

/** Throws EmploymentChangePendingError when an employment change of `employeeIds` is not consumed for the month. */
export async function assertEmploymentGate(tx: TxClient, scope: { year: number; month: number; employeeIds: readonly string[] }): Promise<void> {
  if (!scope.employeeIds.length) return;
  const pending = await eventsNotConsumed(tx, {
    consumer: PAYROLL_EMPLOYMENT_CONSUMER,
    types: EMPLOYMENT_EVENT_TYPES,
    aggregateType: 'Employee',
    aggregateIds: scope.employeeIds,
    effectiveOnOrBefore: monthEnd(scope.year, scope.month),
  });
  if (pending.length) throw new EmploymentChangePendingError([...new Set(pending.map((e) => e.aggregateId))].sort(), pending.length);
}

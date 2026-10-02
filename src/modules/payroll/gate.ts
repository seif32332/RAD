// The employment gate of payroll (BL-PAY-025 at MONTH level; ARC-PAY-A9): no approval of a company's
// month while an employment.* event of one of its employees, effective on or before the month's end, is
// not yet consumed by payroll.employment (the draft may not reflect a hire, an exit, a void…). The
// gate is keyed on (event, month): an event effective after the month does not concern it. A stuck
// consumption (DEAD) no longer holds the gate here: it surfaces as a blocking INV-PAY-04 discrepancy
// of that line and month (./invariants.ts), explainable by a second person, and the L4 gate stops the
// approval through it. The line-level gate is BL-PAY-008b.
// P1-PAY-B: the same gate holds while a pay change of an employee (a CompensationPeriod event of one of his
// period lineages, effective on or before the month's end) is not yet consumed by payroll.compensation.
import { HttpError } from '@/lib/http';
import { COMPENSATION_PERIOD_EVENT_TYPES, compensationLineagesOf } from '@/modules/compensation';
import { EMPLOYMENT_EVENT_TYPES } from '@/modules/lifecycle';
import { eventsNotConsumed, type TxClient } from '@/modules/platform';

/** The consumer name (DomainEvent consumption key: stable forever). */
export const PAYROLL_EMPLOYMENT_CONSUMER = 'payroll.employment';
/** The consumer of the CompensationPeriod events (P1-PAY-B; stable forever). */
export const PAYROLL_COMPENSATION_CONSUMER = 'payroll.compensation';

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
  const lineages = await compensationLineagesOf(tx, scope.employeeIds);
  const [employment, compensation] = await Promise.all([
    eventsNotConsumed(tx, {
      consumer: PAYROLL_EMPLOYMENT_CONSUMER,
      types: EMPLOYMENT_EVENT_TYPES,
      aggregateType: 'Employee',
      aggregateIds: scope.employeeIds,
      effectiveOnOrBefore: monthEnd(scope.year, scope.month),
    }),
    lineages.length
      ? eventsNotConsumed(tx, {
          consumer: PAYROLL_COMPENSATION_CONSUMER,
          types: COMPENSATION_PERIOD_EVENT_TYPES,
          aggregateType: 'CompensationPeriod',
          aggregateIds: lineages,
          effectiveOnOrBefore: monthEnd(scope.year, scope.month),
        })
      : Promise.resolve([]),
  ]);
  const employeeOf = (e: { aggregateId: string; payload: unknown }) => ((e.payload as { employeeId?: string } | null)?.employeeId ?? e.aggregateId);
  const pending = [...employment, ...compensation].map((e) => ({ ...e, aggregateId: employeeOf(e) }));
  if (pending.length) throw new EmploymentChangePendingError([...new Set(pending.map((e) => e.aggregateId))].sort(), pending.length);
}

/** 409 of a pay change dated inside a payroll month already approved or paid for the employee. */
export class PayrollMonthFinalizedError extends HttpError {
  constructor(month: string) {
    super(409, `تاريخ نفاذ الأجر يقع في شهر مسير معتمد أو مصروف لهذا الموظف (${month}). الفروق الرجعية لشهر معتمد لا تُعالج بعد (BL-PAY-008b)؛ اختر تاريخاً بعد آخر شهر معتمد.`, {
      code: 'PAYROLL_MONTH_FINALIZED',
      month,
    });
    this.name = 'PayrollMonthFinalizedError';
  }
}

/**
 * P1-PAY-B: a pay change of `employeeId` from `effectiveDate` ('YYYY-MM-DD') must not reach into a payroll
 * month already APPROVED or PAID for him (an approved number never changes, and the retro difference is
 * BL-PAY-008b): refused with PayrollMonthFinalizedError. compensation's decide takes it from its caller.
 */
export async function assertNoFinalizedPayrollFrom(tx: TxClient, employeeId: string, effectiveDate: string): Promise<void> {
  const year = Number(effectiveDate.slice(0, 4));
  const month = Number(effectiveDate.slice(5, 7));
  const line = await tx.payroll.findFirst({
    where: { employeeId, status: { not: 'DRAFT' }, OR: [{ year: { gt: year } }, { year, month: { gte: month } }] },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    select: { year: true, month: true },
  });
  if (line) throw new PayrollMonthFinalizedError(`${line.year}-${String(line.month).padStart(2, '0')}`);
}

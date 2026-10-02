// payroll.employment (BL-PAY-025 at month level; ARC-PAY-A9; ARC-LCY-A4: lifecycle never calls payroll,
// payroll learns of an employment change from the employment.* events). For the employee of the event
// and every payroll month from the event's effective month on:
//
//   - the employee's line is DRAFT, or the company's month is still open (DRAFT / CALCULATED) without a
//     line for him → the line is regenerated (recomputed from the current facts, added or dropped) in
//     THIS transaction, with the EventConsumption row (outcome REGENERATED);
//   - the line is APPROVED (not paid): nothing is recomputed (an approved number never changes); outcome
//     HELD. The INV-PAY-04 check reports the line and month as a blocking discrepancy ("employment change
//     not applied"): the reversal of the line by two people (reverseMoney, BL-PAY-008b) or an explanation
//     by a second person clears it;
//   - the line is PAID: outcome RETRO_ROUTED. Before BL-PAY-008b there is no retro-difference mechanism,
//     so the destination is an HR task: the INV-PAY-04 finding of that month (ARC-PAY-A9 "قبل BL-PAY-008b
//     … الوجهة مهمة لـHR"). payroll never reads or writes the settlement (offboarding sits above it).
// No PRE_CONSUMER watermark: every employment.* event is processed from the first (RT-SYS-653/658). A
// re-run of the consumer on the same event does nothing new (the dispatcher's at-most-once, and the
// regeneration's own operation key).
import { EMPLOYMENT_EVENT_TYPES } from '@/modules/lifecycle';
import { employeeForLifecycle } from '@/modules/people';
import type { DomainEventRecord, EventConsumer, ConsumerContext } from '@/modules/platform';
import { PAYROLL_STATUS } from '@/lib/constants';
import { PAYROLL_EMPLOYMENT_CONSUMER } from './gate';

type Target = { companyId: string; year: number; month: number };

/** 'YYYY-MM-DD' (or a Date) → { year, month } of the event's effective day. */
export function effectiveMonthOf(event: Pick<DomainEventRecord, 'payload' | 'effectiveDate' | 'occurredAt'>): { year: number; month: number } {
  const raw = (event.payload as { effectiveDate?: unknown } | null)?.effectiveDate;
  const d = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? new Date(`${raw.slice(0, 10)}T00:00:00.000Z`) : event.effectiveDate ?? event.occurredAt;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const fromMonth = (y: number, m: number) => ({ OR: [{ year: { gt: y } }, { year: y, month: { gte: m } }] });

export interface EmploymentConsumerDeps {
  /** Recomputes and commits one employee's line in one company's month (src/lib/payroll.ts). */
  regenerate: (ctx: ConsumerContext, target: Target & { employeeId: string }) => Promise<void>;
}

export function createPayrollEmploymentConsumer(deps?: EmploymentConsumerDeps): EventConsumer {
  return {
    name: PAYROLL_EMPLOYMENT_CONSUMER,
    eventTypes: EMPLOYMENT_EVENT_TYPES,
    // A regeneration reads the employee's whole month: give it room.
    timeoutMs: 60_000,
    async handle(event, ctx) {
      const { tx } = ctx;
      const employeeId = ((event.payload as { employeeId?: unknown } | null)?.employeeId as string | undefined) ?? event.aggregateId;
      const { year, month } = effectiveMonthOf(event);
      const [lines, emp] = await Promise.all([
        tx.payroll.findMany({ where: { employeeId, ...fromMonth(year, month) }, select: { companyId: true, year: true, month: true, status: true } }),
        employeeForLifecycle(tx, employeeId),
      ]);
      const key = (t: Target) => `${t.companyId}|${t.year}|${t.month}`;
      const regenerate = new Map<string, Target>();
      let held = 0;
      let retro = 0;
      for (const l of lines) {
        if (!l.companyId) continue; // a legacy line without a company: reported by the migration notice
        if (l.status === PAYROLL_STATUS.DRAFT) regenerate.set(key(l as Target), l as Target);
        else if (l.status === PAYROLL_STATUS.APPROVED) held++;
        else retro++;
      }
      // Open months of the employee's company without a line for him (a hire, a rehire, a cancelled exit).
      if (emp?.legalCompanyId) {
        const open = await tx.payrollMonth.findMany({
          where: { companyId: emp.legalCompanyId, status: { in: ['DRAFT', 'CALCULATED'] }, ...fromMonth(year, month) },
          select: { companyId: true, year: true, month: true },
        });
        const hasLine = new Set(lines.map((l) => `${l.companyId}|${l.year}|${l.month}`));
        for (const m of open) if (!hasLine.has(key(m))) regenerate.set(key(m), m);
      }
      if (regenerate.size) {
        const run = deps?.regenerate ?? (await import('@/lib/payroll')).regenerateEmployeeLineForConsumer;
        for (const t of [...regenerate.values()].sort((a, b) => a.year - b.year || a.month - b.month || a.companyId.localeCompare(b.companyId))) {
          await run(ctx, { ...t, employeeId });
        }
      }
      if (held) return { outcome: 'HELD' };
      if (retro) return { outcome: 'RETRO_ROUTED' };
      return { outcome: regenerate.size ? 'REGENERATED' : 'NOT_APPLICABLE' };
    },
  };
}

export const PAYROLL_EMPLOYMENT_CONSUMER_DEF = createPayrollEmploymentConsumer();
export const PAYROLL_CONSUMERS: readonly EventConsumer[] = [PAYROLL_EMPLOYMENT_CONSUMER_DEF];

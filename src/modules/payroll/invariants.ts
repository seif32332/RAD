// INV-PAY-04 check "employment change not applied" (BL-PAY-025; ARC-PAY-A9: "a stuck consumption shows as
// a blocking discrepancy linked to that line and that month, explainable, and does not extend to the
// following months"). INV-PAY-04 (paid days = entitlement days, no pay after the last working day) is an
// integrity invariant (DEC-PO-120): its findings block payroll.approve / export / pay of their company
// and month, and are closed by a second person's explanation or by fixing the line (reconcile then
// auto-closes them). Findings:
//   - DEAD consumption of payroll.employment: the event could not be applied at all → one finding on
//     the event, in the month it was stuck on (its effective month);
//   - outcome HELD: a line approved before the change, not paid → one finding per such line;
//   - outcome RETRO_ROUTED: a line paid before the change → one finding per such line: the HR task of
//     ARC-PAY-A9 until BL-PAY-008b routes the difference automatically.
// Read only (the reconcile snapshot runs it inside a READ ONLY transaction). Registered by the
// composition roots (src/jobs/consumers.ts) through platform.registerInvariantCheck.
import type { Prisma, PrismaClient } from '@prisma/client';
import type { ReconciliationEntity, ReconciliationResult } from '@/lib/reconciliation/checks';
import { EMPLOYMENT_EVENT_TYPES } from '@/modules/lifecycle';
import { consumptionsOf, type InvariantCheck } from '@/modules/platform';
import { PAYROLL_STATUS } from '@/lib/constants';
import { payrollMonthKey } from '@/lib/payroll-core';
import { effectiveMonthOf } from './consumers';
import { PAYROLL_EMPLOYMENT_CONSUMER } from './gate';

export const INV_PAY_04_ID = 'INV-PAY-04';
export const EMPLOYMENT_CHANGE_CHECK = 'employmentChangeNotApplied';
export const EMPLOYMENT_CONSUMPTION_DEAD_CHECK = 'employmentConsumptionDead';
const SAMPLE_SIZE = 20;
const NO_COMPANY = '(none)';

type Db = PrismaClient | Prisma.TransactionClient;

export async function employmentChangeResults(db: Db): Promise<ReconciliationResult[]> {
  const rows = await consumptionsOf(db, { consumer: PAYROLL_EMPLOYMENT_CONSUMER, types: EMPLOYMENT_EVENT_TYPES, statuses: ['DEAD'], outcomes: ['HELD', 'RETRO_ROUTED'] });
  const entities: ReconciliationEntity[] = [];
  const dead: ReconciliationEntity[] = [];
  const detail: Record<string, number> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    const { year, month } = effectiveMonthOf({ payload: r.payload, effectiveDate: r.effectiveDate, occurredAt: r.recordedAt });
    if (r.status === 'DEAD') {
      dead.push({ id: r.eventId, companyId: r.companyId, tag: `DEAD:${r.type}`, employeeId: r.aggregateId, period: payrollMonthKey(year, month) });
      continue;
    }
    const status = r.outcome === 'HELD' ? PAYROLL_STATUS.APPROVED : PAYROLL_STATUS.PAID;
    const lines = await db.payroll.findMany({
      where: {
        employeeId: r.aggregateId,
        status,
        OR: [{ year: { gt: year } }, { year, month: { gte: month } }],
        AND: [{ OR: [{ approvedAt: null }, { approvedAt: { lt: r.recordedAt } }] }],
      },
      select: { id: true, companyId: true, year: true, month: true },
    });
    for (const l of lines) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      entities.push({ id: l.id, companyId: l.companyId, tag: `${r.outcome}:${r.type}`, employeeId: r.aggregateId, period: payrollMonthKey(l.year, l.month) });
      detail[r.outcome ?? 'UNKNOWN'] = (detail[r.outcome ?? 'UNKNOWN'] ?? 0) + 1;
    }
  }
  const result = (check: string, entityType: string, rows: ReconciliationEntity[], labelAr: string, labelEn: string, note: string, d: Record<string, number>): ReconciliationResult => {
    const byCompany: Record<string, number> = {};
    for (const e of rows) byCompany[e.companyId ?? NO_COMPANY] = (byCompany[e.companyId ?? NO_COMPANY] ?? 0) + 1;
    return {
      invariant: INV_PAY_04_ID,
      check,
      severity: 'BLOCKING',
      labelAr,
      labelEn,
      entityType,
      count: rows.length,
      sampleIds: rows.slice(0, SAMPLE_SIZE).map((e) => e.id),
      byCompany,
      detail: d,
      note,
      approximation: null,
      entities: rows,
    };
  };
  return [
    result(
      EMPLOYMENT_CHANGE_CHECK,
      'Payroll',
      entities,
      'تغيير توظيف لم ينعكس على سطر مسير معتمد أو مصروف',
      'Employment change not applied to an approved or paid payroll line',
      'BL-PAY-025 (ARC-PAY-A9): HELD = reverse the approved line (two people) or explain; RETRO_ROUTED = HR task until BL-PAY-008b.',
      detail,
    ),
    result(
      EMPLOYMENT_CONSUMPTION_DEAD_CHECK,
      'DomainEvent',
      dead,
      'تغيير توظيف تعذر تطبيقه على المسير (استهلاك متعثر)',
      'Employment change the payroll consumer could not apply (dead consumption)',
      'BL-PAY-025 (ARC-PAY-A9): blocks the month it is stuck on only; fix and re-run, or explain.',
      { DEAD: dead.length },
    ),
  ];
}

/** The InvariantCheck handed to platform.registerInvariantCheck(INV_PAY_04_ID, …). */
export const employmentChangeCheck: InvariantCheck = (db) => employmentChangeResults(db as Db);

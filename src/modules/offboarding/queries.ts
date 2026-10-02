// Settlement readers of offboarding (owner of Settlement, DOMAIN_BOUNDARIES §5.2), BL-LCY-012 /
// BR-LCY-011: period scoping and void statuses. An END_OF_SERVICE settlement belongs to the employment
// period its last working day falls in; only those of the CURRENT period (lifecycle currentPeriod) count
// for "one end of service" and hasOpenEos. Rejected or reversed settlements (SETTLEMENT_VOID_STATUSES)
// never count. Without an employment period (legacy rows before LCY-J1) every settlement is current.
import type { Prisma } from '@prisma/client';
import { SETTLEMENT_VOID_STATUSES } from '@/lib/constants';
import { currentPeriod } from '@/modules/lifecycle';
import type { PeriodReader, TxClient } from '@/modules/platform';

/** Prisma filter: settlements of the period that starts on `periodStart` ('YYYY-MM-DD'; null = every settlement). */
export function settlementInPeriodWhere(periodStart: string | null): Prisma.SettlementWhereInput {
  if (!periodStart) return {};
  const d = new Date(`${periodStart}T00:00:00.000Z`);
  return { OR: [{ lastWorkingDate: { gte: d } }, { lastWorkingDate: null, createdAt: { gte: d } }] };
}

/** First day of the employee's current employment period, or null (none recorded yet). */
export async function currentPeriodStartOf(db: PeriodReader, employeeId: string): Promise<string | null> {
  return (await currentPeriod(db, employeeId))?.validFrom ?? null;
}

/**
 * Prisma filter: the END_OF_SERVICE settlements that still count for the employee: not void, of the
 * current employment period. Used by the "one end of service" guard of POST /api/settlements (the
 * pre-check and the re-check inside the transaction) and by hasOpenEos.
 */
export async function liveEndOfServiceWhere(db: PeriodReader, employeeId: string): Promise<Prisma.SettlementWhereInput> {
  const periodStart = await currentPeriodStartOf(db, employeeId);
  return {
    AND: [
      { employeeId, type: 'END_OF_SERVICE', status: { notIn: [...SETTLEMENT_VOID_STATUSES] } },
      settlementInPeriodWhere(periodStart),
    ],
  };
}

/** BR-LCY-010 hasOpenEos: an END_OF_SERVICE settlement, not rejected nor reversed, in the current period. */
export async function hasOpenEos(db: PeriodReader & Pick<TxClient, 'settlement'>, employeeId: string): Promise<boolean> {
  return (await db.settlement.count({ where: await liveEndOfServiceWhere(db, employeeId) })) > 0;
}

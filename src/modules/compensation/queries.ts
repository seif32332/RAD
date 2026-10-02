// compensation read side (DOMAIN_BOUNDARIES §5.1): what the modules above read instead of the Employee
// projection columns (ARCH-011) and the request list of the financial-change screens.
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CompensationAllowance } from '@/modules/platform';
import { DAY, FINANCIAL_CHANGE_SELECT, financialChangeView, type FinancialChangeStatus, type FinancialChangeView } from './model';

type Db = PrismaClient | Prisma.TransactionClient;

/** Who approved the bonuses the given payroll lines pay (BR-PAY-002: approvers of the line's inputs). */
export async function bonusApproversOfLines(db: Db, payrollIds: readonly string[]): Promise<string[]> {
  if (!payrollIds.length) return [];
  const rows = await db.allowance.findMany({
    where: { paidInPayrollId: { in: [...payrollIds] }, approvedById: { not: null } },
    select: { approvedById: true },
    distinct: ['approvedById'],
  });
  return rows.map((r) => r.approvedById as string);
}

/** One stretch of days of a month with one compensation (a CompensationPeriod clipped to the range). */
export interface CompensationSegment {
  periodId: string;
  /** First day, 'YYYY-MM-DD' (inclusive). */
  from: string;
  /** Last day, 'YYYY-MM-DD' (inclusive). */
  to: string;
  basicSalary: number;
  allowances: CompensationAllowance[];
  gosiBaseOverride: number | null;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const dayBefore = (d: Date) => dayKey(new Date(d.getTime() - 86_400_000));

/**
 * The compensation of each employee over [from, to] (inclusive day keys), from the facts
 * (CompensationPeriod in force, non-superseded): the segments in day order. An employee without a
 * period in the range is absent from the map (no pay is recorded for him: INV-EFF-02). The client may be
 * scoped (iam): the periods follow their employee's company.
 */
export async function compensationSegments(
  db: Pick<Db, 'compensationPeriod'>,
  employeeIds: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, CompensationSegment[]>> {
  const out = new Map<string, CompensationSegment[]>();
  if (!employeeIds.length) return out;
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new Error('compensationSegments: from / to must be YYYY-MM-DD with from <= to');
  const rows = await db.compensationPeriod.findMany({
    where: {
      employeeId: { in: [...new Set(employeeIds)] },
      supersededAt: null,
      validFrom: { lte: new Date(`${to}T00:00:00.000Z`) },
      OR: [{ validTo: null }, { validTo: { gt: new Date(`${from}T00:00:00.000Z`) } }],
    },
    orderBy: [{ employeeId: 'asc' }, { validFrom: 'asc' }],
    select: { id: true, employeeId: true, validFrom: true, validTo: true, basicSalary: true, allowances: true, gosiBaseOverride: true },
  });
  for (const r of rows) {
    const start = dayKey(r.validFrom) > from ? dayKey(r.validFrom) : from;
    const last = r.validTo ? dayBefore(r.validTo) : to;
    const end = last < to ? last : to;
    if (start > end) continue;
    const list = out.get(r.employeeId) ?? [];
    list.push({
      periodId: r.id,
      from: start,
      to: end,
      basicSalary: Number(r.basicSalary),
      allowances: (r.allowances ?? []) as unknown as CompensationAllowance[],
      gosiBaseOverride: r.gosiBaseOverride === null ? null : Number(r.gosiBaseOverride),
    });
    out.set(r.employeeId, list);
  }
  return out;
}

/** The compensation in force on `day` for each employee (the segment of that single day). */
export async function compensationOnDay(db: Pick<Db, 'compensationPeriod'>, employeeIds: readonly string[], day: string): Promise<Map<string, CompensationSegment>> {
  const segs = await compensationSegments(db, employeeIds, day, day);
  return new Map([...segs].map(([id, list]) => [id, list[0]]));
}

/** The lineages of the employees' compensation periods (the aggregate of the period events, for payroll's gate). */
export async function compensationLineagesOf(db: Pick<Db, 'compensationPeriod'>, employeeIds: readonly string[]): Promise<string[]> {
  if (!employeeIds.length) return [];
  const rows = await db.compensationPeriod.findMany({ where: { employeeId: { in: [...new Set(employeeIds)] } }, select: { lineageId: true }, distinct: ['lineageId'] });
  return rows.map((r) => r.lineageId);
}

/** The financial change requests of the client's scope (newest first), as safe views. */
export async function listFinancialChanges(
  db: Pick<Db, 'employeeFinancialChange'>,
  filter: { statuses?: readonly FinancialChangeStatus[]; employeeId?: string | null; batchKey?: string | null; take?: number },
): Promise<FinancialChangeView[]> {
  const rows = await db.employeeFinancialChange.findMany({
    where: {
      ...(filter.statuses?.length ? { status: { in: [...filter.statuses] } } : {}),
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.batchKey ? { batchKey: filter.batchKey } : {}),
    },
    orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
    take: Math.min(Math.max(filter.take ?? 200, 1), 500),
    select: FINANCIAL_CHANGE_SELECT,
  });
  return rows.map(financialChangeView);
}

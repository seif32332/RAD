// The canonical readers of lifecycle (BR-LCY-010; SOURCE_OF_TRUTH §3.1 "is the employee in service?").
// Every module asks these instead of reading isTerminated / employmentStatus itself (BL-LCY-009 moves
// the remaining readers). The BR-LCY-013 fallback (employmentState ?? isTerminated…) lives here only,
// as the ADR-0002 #5 baseline allowance, until Release C.
import type { EmploymentMigrationReview, EmploymentStateChange, Prisma } from '@prisma/client';
import { activeAt, lineageOf, periodsOf, toDateOnly, type DateOnly, type PeriodReader, type PeriodView, type ReadOptions, type TxClient } from '@/modules/platform';
import { addDayKey, effectiveState, type EmploymentState } from './states';

export { effectiveState };

/** The projection columns the readers need (a subset of Employee). */
export interface EmploymentProjection {
  employmentState?: EmploymentState | null;
  isTerminated: boolean;
  terminationDate: Date | null;
  joinDate?: Date;
}

const key = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** TERMINATED: the service ended (BR-LCY-010 isSeparated). */
export function isSeparated(e: EmploymentProjection): boolean {
  return effectiveState(e) === 'TERMINATED';
}

/** NOTICE: an approved exit whose last working day is still ahead (BR-LCY-010 isExiting). */
export function isExiting(e: EmploymentProjection): boolean {
  return effectiveState(e) === 'NOTICE';
}

/** The last working day when the employee is leaving or has left, else null (BR-LCY-010 employmentEnd). */
export function employmentEnd(e: EmploymentProjection): Date | null {
  return effectiveState(e) === 'ACTIVE' ? null : e.terminationDate;
}

/** In service on `day` (NOTICE included): joined on or before it and not past the last working day. */
export function isEmployedOn(e: EmploymentProjection & { joinDate: Date }, day: DateOnly): boolean {
  const d = key(toDateOnly(day, 'day')) as string;
  if ((key(e.joinDate) as string) > d) return false;
  if (isSeparated(e) && !e.terminationDate) return false; // a legacy termination without a date
  const end = key(employmentEnd(e));
  return end === null || end >= d;
}

/** May punch on `day`: not TERMINATED and in service that day (BR-LCY-010 canPunch). */
export function canPunch(e: EmploymentProjection & { joinDate: Date }, day: DateOnly): boolean {
  return !isSeparated(e) && isEmployedOn(e, day);
}

/** Prisma filter: in service now (ACTIVE or NOTICE), with the BR-LCY-013 reading of an empty projection. */
export function inServiceWhere(): Prisma.EmployeeWhereInput {
  return { OR: [{ employmentState: { in: ['ACTIVE', 'NOTICE'] } }, { employmentState: null, isTerminated: false }] };
}

/** Prisma filter: in service on `day` (headcount of that day, BR-LCY-010 headcountWhere). */
export function headcountWhere(day: DateOnly): Prisma.EmployeeWhereInput {
  const d = toDateOnly(day, 'day');
  return {
    joinDate: { lte: d },
    OR: [
      { employmentState: 'ACTIVE' },
      { employmentState: null, isTerminated: false },
      { employmentState: { in: ['NOTICE', 'TERMINATED'] }, terminationDate: { gte: d } },
      { employmentState: null, isTerminated: true, terminationDate: { gte: d } },
    ],
  };
}

/**
 * Prisma filter: in service on at least one day of [from, to] (BL-LCY-012, the payroll month): joined by
 * `to`, and no last working day before `from`. NOTICE counts until its last day; a TERMINATED row without
 * a date is never in service (as in the generator before, BR-LCY-011).
 */
export function employedDuringWhere(from: DateOnly, to: DateOnly): Prisma.EmployeeWhereInput {
  const start = toDateOnly(from, 'from');
  const end = toDateOnly(to, 'to');
  return {
    joinDate: { lte: end },
    OR: [
      { employmentState: 'ACTIVE' },
      { employmentState: null, isTerminated: false },
      { employmentState: { in: ['NOTICE', 'TERMINATED'] }, terminationDate: { gte: start } },
      { employmentState: null, isTerminated: true, terminationDate: { gte: start } },
    ],
  };
}

/** One employment period as the batch readers return it (dates 'YYYY-MM-DD'; validTo exclusive). */
export interface EmploymentSpan {
  validFrom: string;
  validTo: string | null;
}

/**
 * The active (not superseded) employment periods of many employees in one query, oldest first
 * (BL-LCY-012: payroll reads them for a whole month). Employees without a period are absent.
 */
export async function employmentSpansOf(db: Pick<TxClient, 'employmentPeriod'>, employeeIds: readonly string[]): Promise<Map<string, EmploymentSpan[]>> {
  const out = new Map<string, EmploymentSpan[]>();
  if (!employeeIds.length) return out;
  const rows = await db.employmentPeriod.findMany({
    where: { employeeId: { in: [...new Set(employeeIds)] }, supersededAt: null },
    select: { employeeId: true, validFrom: true, validTo: true },
    orderBy: [{ employeeId: 'asc' }, { validFrom: 'asc' }, { recordedAt: 'asc' }],
  });
  for (const r of rows) {
    const list = out.get(r.employeeId) ?? [];
    list.push({ validFrom: key(r.validFrom) as string, validTo: key(r.validTo) });
    out.set(r.employeeId, list);
  }
  return out;
}

/** The first day of the current period among `spans` (the open one, else the latest), or null (BR-LCY-010 currentPeriod). */
export function currentPeriodStart(spans: readonly EmploymentSpan[] | undefined): string | null {
  if (!spans?.length) return null;
  return (spans.find((p) => p.validTo === null) ?? spans[spans.length - 1]).validFrom;
}

/**
 * The days of [from, to] that fall BETWEEN two employment periods (a termination then a rehire, T4):
 * not in service, so not paid. Only the gaps between periods: the start (joinDate) and the end
 * (employmentEnd) stay with the projection. Inclusive 'YYYY-MM-DD' ranges.
 */
export function employmentGapsWithin(spans: readonly EmploymentSpan[] | undefined, from: DateOnly, to: DateOnly): { start: string; end: string }[] {
  if (!spans || spans.length < 2) return [];
  const lo = key(toDateOnly(from, 'from')) as string;
  const hi = key(toDateOnly(to, 'to')) as string;
  const out: { start: string; end: string }[] = [];
  for (let i = 1; i < spans.length; i++) {
    const prevEnd = spans[i - 1].validTo; // exclusive: the first day out of service
    if (!prevEnd) continue;
    const gapStart = prevEnd;
    const gapEnd = addDayKey(spans[i].validFrom, -1);
    if (gapEnd < gapStart) continue;
    const s = gapStart > lo ? gapStart : lo;
    const e = gapEnd < hi ? gapEnd : hi;
    if (s <= e) out.push({ start: s, end: e });
  }
  return out;
}

type StateReader = Pick<TxClient, 'employmentStateChange'>;

/** The latest state change of the employee (its `toState` is the projection, DEC-PO-119). */
export async function latestStateChange(db: StateReader, employeeId: string): Promise<EmploymentStateChange | null> {
  return db.employmentStateChange.findFirst({ where: { employeeId }, orderBy: { seq: 'desc' } });
}

/** The state history of the employee, in recording order (superseded rows included, marked by supersededBy). */
export async function stateHistory(db: StateReader, employeeId: string): Promise<(EmploymentStateChange & { supersededById: string | null })[]> {
  const rows = await db.employmentStateChange.findMany({
    where: { employeeId },
    orderBy: { seq: 'asc' },
    include: { supersededBy: { select: { id: true } } },
  });
  return rows.map(({ supersededBy, ...r }) => ({ ...r, supersededById: supersededBy?.id ?? null }));
}

/** The employment period of the employee now: the open one, else the latest (BR-LCY-010 currentPeriod). */
export async function currentPeriod(db: PeriodReader, employeeId: string): Promise<PeriodView<'EMPLOYMENT'> | null> {
  const all = await periodsOf(db, 'EMPLOYMENT', employeeId);
  return all.find((p) => p.validTo === null) ?? all[all.length - 1] ?? null;
}

/** Every active employment period of the employee (one per hire / rehire), oldest first. */
export function employmentPeriods(db: PeriodReader, employeeId: string, opts?: ReadOptions): Promise<PeriodView<'EMPLOYMENT'>[]> {
  return periodsOf(db, 'EMPLOYMENT', employeeId, opts);
}

/**
 * The employment period covering `date`; null = not in service. With `asRecordedAt: T` (ADR-0002 #4)
 * the end of each period is derived from the state changes recorded until T, not from the column
 * (whose validTo is edited in place, ADR-0001 #9): the last change of the lineage recorded by T gives
 * its end (last working day + 1; none while ACTIVE). A lineage without a change by T keeps the end it
 * was recorded with.
 */
export async function employmentAt(db: PeriodReader & StateReader, employeeId: string, date: DateOnly, opts?: ReadOptions): Promise<PeriodView<'EMPLOYMENT'> | null> {
  const t = opts?.asRecordedAt;
  if (!t) return activeAt(db, 'EMPLOYMENT', employeeId, date, opts);
  const day = key(toDateOnly(date, 'date')) as string;
  const periods = await periodsOf(db, 'EMPLOYMENT', employeeId, { asRecordedAt: t });
  const changes = await db.employmentStateChange.findMany({ where: { employeeId, recordedAt: { lte: t } }, orderBy: { seq: 'asc' } });
  const lastOf = new Map<string, EmploymentStateChange>();
  for (const c of changes) if (c.employmentLineageId) lastOf.set(c.employmentLineageId, c);
  const hits = periods
    .map((p) => {
      const c = lastOf.get(p.lineageId);
      if (!c || c.transition === 'VOID') return c?.transition === 'VOID' ? null : p;
      const end = c.toState === 'ACTIVE' ? null : c.terminationDate ? addDayKey(key(c.terminationDate) as string, 1) : p.validTo;
      return { ...p, validTo: end };
    })
    .filter((p): p is PeriodView<'EMPLOYMENT'> => !!p && p.validFrom <= day && (p.validTo === null || p.validTo > day));
  return hits[0] ?? null;
}

/** Every row of an employment lineage (its supersede chain), in recorded order. */
export function employmentLineage(db: PeriodReader, lineageId: string): Promise<PeriodView<'EMPLOYMENT'>[]> {
  return lineageOf(db, 'EMPLOYMENT', lineageId);
}

type ReviewReader = Pick<TxClient, 'employmentMigrationReview'>;

/**
 * The review items the LCY-J1 opening raised for the employee (EmploymentMigrationReview, DEC-PO-051 /
 * DEC-PO-128), oldest first; `open: true` keeps the unresolved ones. The HR list is BL-LCY-006.
 */
export function migrationReviews(db: ReviewReader, employeeId: string, opts: { open?: boolean } = {}): Promise<EmploymentMigrationReview[]> {
  return db.employmentMigrationReview.findMany({
    where: { employeeId, ...(opts.open ? { resolvedAt: null } : {}) },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
  });
}

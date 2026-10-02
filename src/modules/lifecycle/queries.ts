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

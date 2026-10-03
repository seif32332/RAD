// The canonical reads of the calendar module (SOURCE_OF_TRUTH row "نمط العمل، والعطل، ورمضان").
//
// dayType(e, d) composes platform.effectiveContext (the assignment in force that day: company, branch,
// work pattern) with the calendar's own tables (WorkSchedule = WorkPattern, HolidayCalendar,
// RamadanPeriod). It lives here, not in platform, because platform sits below calendar (§5.3) and must
// not read calendar tables; every module above calendar (leave, time, payroll) reads the day type
// through this module: `effectiveDay` returns effectiveContext + dayType in one value.
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  effectiveContext,
  toDateOnly,
  type DateOnly,
  type EffectiveContext,
  type EffectiveContextOptions,
  type PeriodReader,
} from '@/modules/platform';
import { classifyDay, patternDailyHours, type DayType } from './day-type';
import { DEFAULT_WORK_WEEKDAYS, type Weekday } from './weekdays';
import { companyWhere, requireCompanies, type CalendarCompanies } from './scope';

type Db = PrismaClient | Prisma.TransactionClient;
/** A client that can read the calendar tables. */
export type CalendarReader = Pick<Db, 'workSchedule' | 'holidayCalendar' | 'ramadanPeriod'>;
/** A client that can read the calendar tables and the effective periods (dayType). */
export type DayTypeReader = CalendarReader & PeriodReader;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Work patterns

const PATTERN_SELECT = {
  id: true,
  companyId: true,
  branchId: true,
  name: true,
  shiftType: true,
  startTime: true,
  endTime: true,
  startTime2: true,
  endTime2: true,
  flexibleHours: true,
  isExemptFromAttendance: true,
  workDays: true,
  workWeekdays: true,
  archivedAt: true,
  createdAt: true,
} as const;

export type WorkPatternView = Prisma.WorkScheduleGetPayload<{ select: typeof PATTERN_SELECT }>;

export function workPatternById(db: CalendarReader, id: string): Promise<WorkPatternView | null> {
  return db.workSchedule.findUnique({ where: { id }, select: PATTERN_SELECT });
}

/** The work patterns of the caller's companies (optionally one branch); archived ones on request. */
export function listWorkPatterns(
  db: CalendarReader,
  opts: { companyIds: CalendarCompanies; branchId?: string | null; includeArchived?: boolean },
): Promise<WorkPatternView[]> {
  const companyIds = requireCompanies(opts, 'listWorkPatterns');
  return db.workSchedule.findMany({
    where: { ...companyWhere(companyIds), ...(opts.branchId ? { branchId: opts.branchId } : {}), ...(opts.includeArchived ? {} : { archivedAt: null }) },
    select: PATTERN_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The legacy choice of a branch pattern from a typed name (the rule pickEmployeeSchedule applied to
 * Employee.workSchedule): the active pattern of the branch with that name (the oldest when several),
 * else the branch's only active pattern, else null. Used by the writers that still receive a name
 * (employee form, import, transfer) to store the FK, and mirrored by the 9z_calendar backfill.
 */
export async function resolveWorkPatternId(db: CalendarReader, branchId: string | null | undefined, name: string | null | undefined): Promise<string | null> {
  if (!branchId) return null;
  const rows = await db.workSchedule.findMany({
    where: { branchId, archivedAt: null },
    select: { id: true, name: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const wanted = name?.trim();
  if (wanted) {
    const match = rows.find((r) => r.name.trim() === wanted);
    if (match) return match.id;
  }
  return rows.length === 1 ? rows[0].id : null;
}

// ---------------------------------------------------------------------------------------------
// Holidays and Ramadan

export function listHolidays(db: CalendarReader, opts: { companyIds: CalendarCompanies; from?: DateOnly; to?: DateOnly; includeCancelled?: boolean }) {
  const companyIds = requireCompanies(opts, 'listHolidays');
  return db.holidayCalendar.findMany({
    where: {
      ...companyWhere(companyIds),
      ...(opts.includeCancelled ? {} : { cancelledAt: null }),
      ...(opts.to ? { startDate: { lte: toDateOnly(opts.to, 'to') } } : {}),
      ...(opts.from ? { endDate: { gte: toDateOnly(opts.from, 'from') } } : {}),
    },
    orderBy: [{ startDate: 'asc' }, { name: 'asc' }],
  });
}

export function listRamadanPeriods(db: CalendarReader, opts: { companyIds: CalendarCompanies }) {
  const companyIds = requireCompanies(opts, 'listRamadanPeriods');
  return db.ramadanPeriod.findMany({ where: companyWhere(companyIds), orderBy: [{ startDate: 'desc' }] });
}

// ---------------------------------------------------------------------------------------------
// dayType

export interface DayInfo {
  employeeId: string;
  date: string;
  /** The company whose calendar applies: the actual (work) company of the assignment, else the legal one. */
  companyId: string;
  type: DayType;
  isWorkingDay: boolean;
  weekend: boolean;
  /** Scheduled hours that day: 0 on a rest day or holiday, null when the pattern does not say. */
  scheduledHours: number | null;
  /** The employee is in service (an employment period covers the day). */
  inService: boolean;
  workPattern: { id: string; name: string; source: 'ASSIGNMENT' | 'BRANCH_ONLY' } | null;
  /** PATTERN: the pattern's workWeekdays; DEFAULT: no pattern or no weekdays on it (DEFAULT_WORK_WEEKDAYS). */
  weekdaysSource: 'PATTERN' | 'DEFAULT';
  holiday: { id: string; name: string; kind: string } | null;
  ramadan: { id: string; hijriYear: number; dailyHours: number } | null;
}

export interface DayTypeOptions extends EffectiveContextOptions {
  /** Working weekdays when the employee has no pattern with weekdays (default DEFAULT_WORK_WEEKDAYS). */
  defaultWeekdays?: readonly number[];
}

type HolidayRow = { id: string; name: string; kind: string; startDate: Date; endDate: Date };
type RamadanRow = { id: string; hijriYear: number; dailyHours: number; startDate: Date; endDate: Date };

/** Per-call cache: a range read loads each pattern, branch fallback and company calendar once. */
class CalendarCache {
  private patterns = new Map<string, Promise<WorkPatternView | null>>();
  private branchOnly = new Map<string, Promise<WorkPatternView | null>>();
  private holidays = new Map<string, Promise<HolidayRow[]>>();
  private ramadan = new Map<string, Promise<RamadanRow[]>>();
  constructor(
    private db: CalendarReader,
    private from: Date,
    private to: Date,
  ) {}

  pattern(id: string) {
    if (!this.patterns.has(id)) this.patterns.set(id, workPatternById(this.db, id));
    return this.patterns.get(id)!;
  }
  onlyPatternOfBranch(branchId: string) {
    if (!this.branchOnly.has(branchId)) {
      this.branchOnly.set(
        branchId,
        this.db.workSchedule
          .findMany({ where: { branchId, archivedAt: null }, select: PATTERN_SELECT, take: 2, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
          .then((rows) => (rows.length === 1 ? rows[0] : null)),
      );
    }
    return this.branchOnly.get(branchId)!;
  }
  holidaysOf(companyId: string) {
    if (!this.holidays.has(companyId)) {
      this.holidays.set(
        companyId,
        this.db.holidayCalendar.findMany({
          where: { companyId, cancelledAt: null, startDate: { lte: this.to }, endDate: { gte: this.from } },
          select: { id: true, name: true, kind: true, startDate: true, endDate: true },
          orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        }),
      );
    }
    return this.holidays.get(companyId)!;
  }
  ramadanOf(companyId: string) {
    if (!this.ramadan.has(companyId)) {
      this.ramadan.set(
        companyId,
        this.db.ramadanPeriod.findMany({
          where: { companyId, startDate: { lte: this.to }, endDate: { gte: this.from } },
          select: { id: true, hijriYear: true, dailyHours: true, startDate: true, endDate: true },
          orderBy: [{ startDate: 'asc' }],
        }),
      );
    }
    return this.ramadan.get(companyId)!;
  }
}

const covers = (row: { startDate: Date; endDate: Date }, day: Date) => row.startDate.getTime() <= day.getTime() && row.endDate.getTime() >= day.getTime();

async function dayFromContext(cache: CalendarCache, ctx: EffectiveContext, defaultWeekdays: readonly number[]): Promise<DayInfo | null> {
  const a = ctx.assignment;
  if (!a) return null; // no assignment that day: no company, so no calendar (the caller decides)
  const day = toDateOnly(ctx.date, 'date');
  const companyId = a.actualCompanyId ?? a.legalCompanyId;

  let pattern: WorkPatternView | null = null;
  let source: 'ASSIGNMENT' | 'BRANCH_ONLY' | null = null;
  if (a.workPatternId) {
    pattern = await cache.pattern(a.workPatternId);
    source = pattern ? 'ASSIGNMENT' : null;
  } else if (a.branchId) {
    pattern = await cache.onlyPatternOfBranch(a.branchId);
    source = pattern ? 'BRANCH_ONLY' : null;
  }

  const [holidays, ramadans] = await Promise.all([cache.holidaysOf(companyId), cache.ramadanOf(companyId)]);
  const holiday = holidays.find((h) => covers(h, day)) ?? null;
  const ramadan = ramadans.find((r) => covers(r, day)) ?? null;
  const patternWeekdays = pattern?.workWeekdays?.length ? pattern.workWeekdays : null;

  const c = classifyDay({
    weekday: day.getUTCDay() as Weekday,
    workWeekdays: patternWeekdays ?? defaultWeekdays,
    holiday,
    ramadan,
    patternHours: patternDailyHours(pattern),
  });
  return {
    employeeId: ctx.employeeId,
    date: ctx.date,
    companyId,
    ...c,
    inService: ctx.inService,
    workPattern: pattern && source ? { id: pattern.id, name: pattern.name, source } : null,
    weekdaysSource: patternWeekdays ? 'PATTERN' : 'DEFAULT',
    holiday: holiday ? { id: holiday.id, name: holiday.name, kind: holiday.kind } : null,
    ramadan: ramadan ? { id: ramadan.id, hijriYear: ramadan.hijriYear, dailyHours: ramadan.dailyHours } : null,
  };
}

/**
 * time.dayType(e, d) of SOURCE_OF_TRUTH: what kind of day `date` is for the employee, from the
 * assignment in force that day (or as recorded at opts.asRecordedAt). null when no assignment covers
 * the day (only possible in a cross-company context; a scoped caller gets EffectiveScopeError).
 */
export async function dayType(db: DayTypeReader, employeeId: string, date: DateOnly, opts: DayTypeOptions): Promise<DayInfo | null> {
  requireCompanies(opts, 'dayType');
  const day = toDateOnly(date, 'date');
  const ctx = await effectiveContext(db, employeeId, day, opts);
  return dayFromContext(new CalendarCache(db, day, day), ctx, opts.defaultWeekdays ?? DEFAULT_WORK_WEEKDAYS);
}

/** dayType for every day of [from, to] (both inclusive, at most 366 days). */
export async function dayTypesBetween(db: DayTypeReader, employeeId: string, from: DateOnly, to: DateOnly, opts: DayTypeOptions): Promise<(DayInfo | null)[]> {
  requireCompanies(opts, 'dayTypesBetween');
  const a = toDateOnly(from, 'from');
  const b = toDateOnly(to, 'to');
  const n = Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
  if (n < 1) throw new RangeError('dayTypesBetween: to is before from');
  if (n > 366) throw new RangeError('dayTypesBetween: at most 366 days');
  const cache = new CalendarCache(db, a, b);
  const out: (DayInfo | null)[] = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(a.getTime() + i * DAY_MS);
    const ctx = await effectiveContext(db, employeeId, day, opts);
    out.push(await dayFromContext(cache, ctx, opts.defaultWeekdays ?? DEFAULT_WORK_WEEKDAYS));
  }
  return out;
}

/** effectiveContext (DOMAIN_MODEL §1.3) with its dayType: the single read of "this employee, this day". */
export async function effectiveDay(db: DayTypeReader, employeeId: string, date: DateOnly, opts: DayTypeOptions): Promise<EffectiveContext & { dayType: DayInfo | null }> {
  requireCompanies(opts, 'effectiveDay');
  const day = toDateOnly(date, 'date');
  const ctx = await effectiveContext(db, employeeId, day, opts);
  const info = await dayFromContext(new CalendarCache(db, day, day), ctx, opts.defaultWeekdays ?? DEFAULT_WORK_WEEKDAYS);
  return { ...ctx, dayType: info };
}

/**
 * The date `days` working days after `from` (exclusive of `from`) in the company's calendar: the default working
 * weekdays (a company has no pattern of its own; employees' patterns are per employee) and the company's
 * non-cancelled holidays. For deadlines that belong to a company, not to one employee (the approval engine's
 * WorkingDaysPort, WFE-002). At most 366 calendar days are scanned.
 */
export async function addCompanyWorkingDays(db: CalendarReader, companyId: string, from: DateOnly, days: number, opts: { defaultWeekdays?: readonly number[] } = {}): Promise<Date> {
  if (!Number.isInteger(days) || days < 0) throw new RangeError('addCompanyWorkingDays: days must be a non-negative integer');
  const start = toDateOnly(from, 'from');
  if (days === 0) return start;
  const weekdays = opts.defaultWeekdays ?? DEFAULT_WORK_WEEKDAYS;
  const horizon = new Date(start.getTime() + 366 * DAY_MS);
  const holidays = await db.holidayCalendar.findMany({
    where: { companyId, cancelledAt: null, startDate: { lte: horizon }, endDate: { gt: start } },
    select: { startDate: true, endDate: true },
  });
  let left = days;
  for (let d = new Date(start.getTime() + DAY_MS); d.getTime() <= horizon.getTime(); d = new Date(d.getTime() + DAY_MS)) {
    if (!weekdays.includes(d.getUTCDay())) continue;
    if (holidays.some((h) => covers(h, d))) continue;
    left -= 1;
    if (left === 0) return d;
  }
  throw new RangeError('addCompanyWorkingDays: no such working day within a year');
}

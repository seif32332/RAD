// calendar transitions (P1-CAL): the sole writers of WorkSchedule (= WorkPattern), HolidayCalendar and
// RamadanPeriod (DOMAIN_BOUNDARIES §5.2). Each one runs through platform.runTransition: one
// transaction holding the operation-key claim, the change, its audit row and its event; a repeat of
// the same key (sequential or concurrent) returns the first result (LIFECYCLE_MODEL §2.2).
//
// Every rule value here is a per-company editable default (DEC-PO-116): the patterns, the holidays and
// the Ramadan dates and hours are typed by HR. The legal cap of the Ramadan hours (Labor Law Art. 98)
// is the rule RAMADAN_WORK_HOURS_PER_DAY_MAX (P1-RULE, rules.valueAt); calendar sits on the same
// layer as rules (§5.3) and cannot call it, so the caller passes the cap it read (`legalMaxDailyHours`).
import {
  audit,
  emitEvent,
  runTransition,
  toDateOnly,
  type AuditActor,
  type DateOnly,
  type RootClient,
  type TxClient,
} from '@/modules/platform';
import { CALENDAR_EVENTS } from './events';
import { OFFICIAL_SOURCE, officialFixedHolidays } from './sql/official';
import { assertCompanyInScope, type CalendarCompanies } from './scope';
import { normalizeWeekdays, parseWeekdays } from './weekdays';

export class CalendarInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarInputError';
  }
}

export class CalendarNotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`);
    this.name = 'CalendarNotFoundError';
  }
}

export class CalendarConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarConflictError';
  }
}

export interface CalendarOp {
  /** Idempotency-Key of the request, or derived from (actor, entity, action, version). */
  key: string;
  actor: AuditActor;
  reason?: string | null;
  ipAddress?: string | null;
}

const actorIdOf = (a: AuditActor) => (a.type === 'USER' ? a.id : null);
const DAY_MS = 86_400_000;

async function emit(tx: TxClient, op: CalendarOp, type: string, aggregateType: string, aggregateId: string, companyId: string, payload: Record<string, unknown>) {
  await emitEvent(tx, { type, aggregateType, aggregateId, companyId, actorId: actorIdOf(op.actor), idempotencyKey: `${op.key}:${type}`, payload });
}

// ---------------------------------------------------------------------------------------------
// Work patterns

export interface WorkPatternFields {
  name: string;
  shiftType?: 'ONE_SHIFT' | 'TWO_SHIFTS' | 'FLEXIBLE' | null;
  startTime?: string | null;
  endTime?: string | null;
  startTime2?: string | null;
  endTime2?: string | null;
  flexibleHours?: number | null;
  isExemptFromAttendance?: boolean | null;
  /** The label typed by HR ("الأحد, الاثنين, …"). */
  workDays?: string | null;
  /** Structured working days (0 = Sunday … 6 = Saturday); default: parsed from workDays. */
  workWeekdays?: readonly number[] | null;
}

function patternData(f: WorkPatternFields) {
  const name = f.name?.trim();
  if (!name) throw new CalendarInputError('work pattern name is required');
  const shiftType = f.shiftType ?? 'ONE_SHIFT';
  const flexible = shiftType === 'FLEXIBLE';
  const twoShifts = shiftType === 'TWO_SHIFTS';
  let weekdays: number[];
  try {
    weekdays = f.workWeekdays ? normalizeWeekdays(f.workWeekdays) : parseWeekdays(f.workDays);
  } catch (e) {
    throw new CalendarInputError((e as Error).message);
  }
  return {
    name,
    shiftType,
    startTime: flexible ? null : (f.startTime ?? null),
    endTime: flexible ? null : (f.endTime ?? null),
    startTime2: twoShifts ? (f.startTime2 ?? null) : null,
    endTime2: twoShifts ? (f.endTime2 ?? null) : null,
    workDays: f.workDays?.trim() || null,
    workWeekdays: weekdays,
    flexibleHours: flexible ? Math.round(f.flexibleHours ?? 0) : null,
    isExemptFromAttendance: f.isExemptFromAttendance ?? false,
  };
}

export interface SaveWorkPatternInput {
  /** Existing pattern to update; omitted = create. */
  id?: string | null;
  branchId: string;
  /** The branch's company (the caller read it from org; a DB trigger re-checks it). */
  companyId: string;
  pattern: WorkPatternFields;
  companyIds: CalendarCompanies;
}

/** Creates or updates one work pattern of a branch. */
export async function saveWorkPattern(prisma: RootClient, input: SaveWorkPatternInput, op: CalendarOp) {
  assertCompanyInScope(input.companyIds, input.companyId);
  const data = patternData(input.pattern);
  return runTransition(prisma, { key: op.key, operation: 'calendar.workPattern.save', actorId: actorIdOf(op.actor), companyId: input.companyId }, async (tx) => {
    let before = null;
    if (input.id) {
      before = await tx.workSchedule.findUnique({ where: { id: input.id } });
      if (!before || before.branchId !== input.branchId) throw new CalendarNotFoundError('work pattern', input.id);
      if (before.archivedAt) throw new CalendarConflictError(`work pattern ${input.id} is archived`);
    }
    const pattern = before
      ? await tx.workSchedule.update({ where: { id: before.id }, data })
      : await tx.workSchedule.create({ data: { ...data, branchId: input.branchId, companyId: input.companyId } });
    await audit(tx, {
      actor: op.actor,
      action: before ? 'calendar.workPattern.update' : 'calendar.workPattern.create',
      entity: { type: 'WorkSchedule', id: pattern.id, companyId: input.companyId },
      before,
      after: pattern,
      reason: op.reason ?? null,
      operationKey: op.key,
      ipAddress: op.ipAddress ?? null,
    });
    await emit(tx, op, CALENDAR_EVENTS.workPatternSaved, 'WorkSchedule', pattern.id, input.companyId, { patternId: pattern.id, branchId: input.branchId, created: !before });
    return { pattern, created: !before };
  });
}

export interface ReplaceBranchPatternsInput {
  branchId: string;
  companyId: string;
  /** The full list of the branch's active patterns: matched by id, else by name; the rest are archived. */
  patterns: (WorkPatternFields & { id?: string | null })[];
  companyIds: CalendarCompanies;
}

/**
 * Makes the branch's active patterns equal to `patterns` (the branch edit form). Unlike the former
 * delete-and-recreate, a kept pattern keeps its id (employees and assignment periods point to it) and
 * a removed one is archived, never deleted.
 */
export async function replaceBranchPatterns(prisma: RootClient, input: ReplaceBranchPatternsInput, op: CalendarOp) {
  assertCompanyInScope(input.companyIds, input.companyId);
  const wanted = input.patterns.map((p) => ({ id: p.id ?? null, data: patternData(p) }));
  return runTransition(prisma, { key: op.key, operation: 'calendar.workPattern.replaceBranch', actorId: actorIdOf(op.actor), companyId: input.companyId }, async (tx) => {
    const existing = await tx.workSchedule.findMany({ where: { branchId: input.branchId, archivedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const free = new Map(existing.map((e) => [e.id, e]));
    const created: string[] = [];
    const updated: string[] = [];
    for (const w of wanted) {
      const match = (w.id && free.get(w.id)) || [...free.values()].find((e) => e.name.trim() === w.data.name);
      if (match) {
        free.delete(match.id);
        await tx.workSchedule.update({ where: { id: match.id }, data: w.data });
        updated.push(match.id);
      } else {
        const row = await tx.workSchedule.create({ data: { ...w.data, branchId: input.branchId, companyId: input.companyId } });
        created.push(row.id);
      }
    }
    const archived = [...free.keys()];
    if (archived.length) await tx.workSchedule.updateMany({ where: { id: { in: archived }, archivedAt: null }, data: { archivedAt: new Date() } });
    const patterns = await tx.workSchedule.findMany({ where: { branchId: input.branchId, archivedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    await audit(tx, {
      actor: op.actor,
      action: 'calendar.workPattern.replaceBranch',
      entity: { type: 'WorkSchedule', id: input.branchId, companyId: input.companyId },
      before: existing,
      after: patterns,
      reason: op.reason ?? null,
      operationKey: op.key,
      ipAddress: op.ipAddress ?? null,
    });
    await emit(tx, op, CALENDAR_EVENTS.workPatternSaved, 'Branch', input.branchId, input.companyId, { branchId: input.branchId, created, updated, archived });
    return { patterns, created, updated, archived };
  });
}

/** Archives one pattern (the former DELETE): employees and periods that point to it keep their reference. */
export async function archiveWorkPattern(prisma: RootClient, input: { id: string; branchId?: string | null; companyIds: CalendarCompanies }, op: CalendarOp) {
  return runTransition(prisma, { key: op.key, operation: 'calendar.workPattern.archive', actorId: actorIdOf(op.actor) }, async (tx) => {
    const row = await tx.workSchedule.findUnique({ where: { id: input.id } });
    if (!row || (input.branchId && row.branchId !== input.branchId)) throw new CalendarNotFoundError('work pattern', input.id);
    assertCompanyInScope(input.companyIds, row.companyId);
    if (row.archivedAt) return { pattern: row, changed: false };
    const pattern = await tx.workSchedule.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    await audit(tx, { actor: op.actor, action: 'calendar.workPattern.archive', entity: { type: 'WorkSchedule', id: row.id, companyId: row.companyId }, before: row, after: pattern, reason: op.reason ?? null, operationKey: op.key, ipAddress: op.ipAddress ?? null });
    await emit(tx, op, CALENDAR_EVENTS.workPatternArchived, 'WorkSchedule', row.id, row.companyId, { patternId: row.id, branchId: row.branchId });
    return { pattern, changed: true };
  });
}

// ---------------------------------------------------------------------------------------------
// Holidays

export interface SaveHolidayInput {
  id?: string | null;
  companyId: string;
  name: string;
  startDate: DateOnly;
  /** Inclusive; default = startDate (one day). */
  endDate?: DateOnly | null;
  kind?: 'OFFICIAL' | 'COMPANY';
  source?: string | null;
  companyIds: CalendarCompanies;
}

function holidayData(input: SaveHolidayInput) {
  const name = input.name?.trim();
  if (!name) throw new CalendarInputError('holiday name is required');
  let start: Date;
  let end: Date;
  try {
    start = toDateOnly(input.startDate, 'startDate');
    end = input.endDate ? toDateOnly(input.endDate, 'endDate') : start;
  } catch (e) {
    throw new CalendarInputError((e as Error).message);
  }
  if (end.getTime() < start.getTime()) throw new CalendarInputError('endDate is before startDate');
  if ((end.getTime() - start.getTime()) / DAY_MS > 30) throw new CalendarInputError('a holiday lasts at most 31 days');
  return { name, startDate: start, endDate: end, kind: input.kind ?? 'COMPANY', source: input.source?.trim() || null };
}

/** Adds or edits one holiday of a company. */
export async function saveHoliday(prisma: RootClient, input: SaveHolidayInput, op: CalendarOp) {
  assertCompanyInScope(input.companyIds, input.companyId);
  const data = holidayData(input);
  return runTransition(prisma, { key: op.key, operation: 'calendar.holiday.save', actorId: actorIdOf(op.actor), companyId: input.companyId }, async (tx) => {
    let before = null;
    if (input.id) {
      before = await tx.holidayCalendar.findUnique({ where: { id: input.id } });
      if (!before || before.companyId !== input.companyId) throw new CalendarNotFoundError('holiday', input.id);
    }
    const clash = await tx.holidayCalendar.findUnique({ where: { companyId_name_startDate: { companyId: input.companyId, name: data.name, startDate: data.startDate } } });
    if (clash && clash.id !== before?.id) {
      if (!clash.cancelledAt) throw new CalendarConflictError(`holiday "${data.name}" already exists on that date`);
    }
    let holiday;
    if (before) {
      holiday = await tx.holidayCalendar.update({ where: { id: before.id }, data: { ...data, cancelledAt: null } });
    } else if (clash) {
      holiday = await tx.holidayCalendar.update({ where: { id: clash.id }, data: { ...data, cancelledAt: null } }); // re-activates a cancelled one
    } else {
      holiday = await tx.holidayCalendar.create({ data: { ...data, companyId: input.companyId, createdById: actorIdOf(op.actor) } });
    }
    await audit(tx, { actor: op.actor, action: before || clash ? 'calendar.holiday.update' : 'calendar.holiday.create', entity: { type: 'HolidayCalendar', id: holiday.id, companyId: input.companyId }, before: before ?? clash, after: holiday, reason: op.reason ?? null, operationKey: op.key, ipAddress: op.ipAddress ?? null });
    await emit(tx, op, CALENDAR_EVENTS.holidaySaved, 'HolidayCalendar', holiday.id, input.companyId, { holidayId: holiday.id, startDate: data.startDate.toISOString().slice(0, 10), endDate: data.endDate.toISOString().slice(0, 10) });
    return { holiday };
  });
}

/** Cancels a holiday (the row stays, for the history of the days it covered). */
export async function cancelHoliday(prisma: RootClient, input: { id: string; companyIds: CalendarCompanies }, op: CalendarOp) {
  return runTransition(prisma, { key: op.key, operation: 'calendar.holiday.cancel', actorId: actorIdOf(op.actor) }, async (tx) => {
    const row = await tx.holidayCalendar.findUnique({ where: { id: input.id } });
    if (!row) throw new CalendarNotFoundError('holiday', input.id);
    assertCompanyInScope(input.companyIds, row.companyId);
    if (row.cancelledAt) return { holiday: row, changed: false };
    const holiday = await tx.holidayCalendar.update({ where: { id: row.id }, data: { cancelledAt: new Date() } });
    await audit(tx, { actor: op.actor, action: 'calendar.holiday.cancel', entity: { type: 'HolidayCalendar', id: row.id, companyId: row.companyId }, before: row, after: holiday, reason: op.reason ?? null, operationKey: op.key, ipAddress: op.ipAddress ?? null });
    await emit(tx, op, CALENDAR_EVENTS.holidayCancelled, 'HolidayCalendar', row.id, row.companyId, { holidayId: row.id });
    return { holiday, changed: true };
  });
}

/**
 * Adds the fixed-date official holidays of `year` (Founding Day, National Day: the list is the SQL
 * function calendar_official_fixed_holidays of migration 9z_calendar) to a company, kind OFFICIAL,
 * skipping those it already has (same name and first day, cancelled ones included: HR's cancellation
 * stands). Hijri holidays (the two Eids) move every year and are announced: HR enters them.
 */
export async function seedOfficialHolidays(prisma: RootClient, input: { companyId: string; year: number; companyIds: CalendarCompanies }, op: CalendarOp) {
  assertCompanyInScope(input.companyIds, input.companyId);
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) throw new CalendarInputError('year must be between 2000 and 2100');
  return runTransition(prisma, { key: op.key, operation: 'calendar.holiday.seedOfficial', actorId: actorIdOf(op.actor), companyId: input.companyId }, async (tx) => {
    const rows = await officialFixedHolidays(tx, input.year);
    const created: string[] = [];
    let skipped = 0;
    for (const r of rows) {
      const startDate = toDateOnly(r.startDate, 'startDate');
      const exists = await tx.holidayCalendar.findUnique({ where: { companyId_name_startDate: { companyId: input.companyId, name: r.name, startDate } } });
      if (exists) {
        skipped++;
        continue;
      }
      const h = await tx.holidayCalendar.create({
        data: { companyId: input.companyId, name: r.name, startDate, endDate: toDateOnly(r.endDate, 'endDate'), kind: 'OFFICIAL', source: OFFICIAL_SOURCE, createdById: actorIdOf(op.actor) },
      });
      created.push(h.id);
      await emit(tx, { ...op, key: `${op.key}:${h.id}` }, CALENDAR_EVENTS.holidaySaved, 'HolidayCalendar', h.id, input.companyId, { holidayId: h.id, startDate: r.startDate, endDate: r.endDate });
    }
    await audit(tx, { actor: op.actor, action: 'calendar.holiday.seedOfficial', entity: { type: 'HolidayCalendar', id: null, companyId: input.companyId }, after: { year: input.year, created, skipped }, reason: op.reason ?? null, operationKey: op.key, ipAddress: op.ipAddress ?? null });
    return { created, skipped };
  });
}

// ---------------------------------------------------------------------------------------------
// Ramadan

export interface SaveRamadanInput {
  companyId: string;
  hijriYear: number;
  startDate: DateOnly;
  /** Inclusive (the last day of Ramadan). */
  endDate: DateOnly;
  dailyHours: number;
  /** The legal cap in force (rules.valueAt RAMADAN_WORK_HOURS_PER_DAY_MAX) as read by the caller; null = unknown. */
  legalMaxDailyHours: number | null;
  companyIds: CalendarCompanies;
}

/** Sets the Ramadan period of one Hijri year for a company (creates or replaces it). */
export async function saveRamadanPeriod(prisma: RootClient, input: SaveRamadanInput, op: CalendarOp) {
  assertCompanyInScope(input.companyIds, input.companyId);
  if (!Number.isInteger(input.hijriYear) || input.hijriYear < 1400 || input.hijriYear > 1600) throw new CalendarInputError('hijriYear must be between 1400 and 1600');
  let start: Date;
  let end: Date;
  try {
    start = toDateOnly(input.startDate, 'startDate');
    end = toDateOnly(input.endDate, 'endDate');
  } catch (e) {
    throw new CalendarInputError((e as Error).message);
  }
  const length = (end.getTime() - start.getTime()) / DAY_MS + 1;
  if (length < 29 || length > 30) throw new CalendarInputError('Ramadan lasts 29 or 30 days');
  if (!(input.dailyHours > 0) || input.dailyHours > 24) throw new CalendarInputError('dailyHours must be between 0 and 24');
  if (input.legalMaxDailyHours !== null && input.dailyHours > input.legalMaxDailyHours) {
    throw new CalendarInputError(`dailyHours ${input.dailyHours} exceeds the legal maximum ${input.legalMaxDailyHours}`);
  }
  const data = { startDate: start, endDate: end, dailyHours: Math.round(input.dailyHours * 100) / 100 };
  return runTransition(prisma, { key: op.key, operation: 'calendar.ramadan.save', actorId: actorIdOf(op.actor), companyId: input.companyId }, async (tx) => {
    const overlap = await tx.ramadanPeriod.findFirst({
      where: { companyId: input.companyId, hijriYear: { not: input.hijriYear }, startDate: { lte: end }, endDate: { gte: start } },
    });
    if (overlap) throw new CalendarConflictError(`overlaps the Ramadan period of ${overlap.hijriYear}`);
    const before = await tx.ramadanPeriod.findUnique({ where: { companyId_hijriYear: { companyId: input.companyId, hijriYear: input.hijriYear } } });
    const ramadan = before
      ? await tx.ramadanPeriod.update({ where: { id: before.id }, data })
      : await tx.ramadanPeriod.create({ data: { ...data, companyId: input.companyId, hijriYear: input.hijriYear, createdById: actorIdOf(op.actor) } });
    await audit(tx, { actor: op.actor, action: before ? 'calendar.ramadan.update' : 'calendar.ramadan.create', entity: { type: 'RamadanPeriod', id: ramadan.id, companyId: input.companyId }, before, after: ramadan, reason: op.reason ?? null, operationKey: op.key, ipAddress: op.ipAddress ?? null });
    await emit(tx, op, CALENDAR_EVENTS.ramadanSaved, 'RamadanPeriod', ramadan.id, input.companyId, { ramadanId: ramadan.id, hijriYear: input.hijriYear, dailyHours: data.dailyHours });
    return { ramadan, created: !before };
  });
}

/** Removes a Ramadan period (a wrong entry); the audit row keeps what it was. */
export async function removeRamadanPeriod(prisma: RootClient, input: { id: string; companyIds: CalendarCompanies }, op: CalendarOp) {
  return runTransition(prisma, { key: op.key, operation: 'calendar.ramadan.remove', actorId: actorIdOf(op.actor) }, async (tx) => {
    const row = await tx.ramadanPeriod.findUnique({ where: { id: input.id } });
    if (!row) throw new CalendarNotFoundError('Ramadan period', input.id);
    assertCompanyInScope(input.companyIds, row.companyId);
    await tx.ramadanPeriod.delete({ where: { id: row.id } });
    await audit(tx, { actor: op.actor, action: 'calendar.ramadan.remove', entity: { type: 'RamadanPeriod', id: row.id, companyId: row.companyId }, before: row, after: null, reason: op.reason ?? null, operationKey: op.key, ipAddress: op.ipAddress ?? null });
    await emit(tx, op, CALENDAR_EVENTS.ramadanRemoved, 'RamadanPeriod', row.id, row.companyId, { ramadanId: row.id, hijriYear: row.hijriYear });
    return { removed: row.id };
  });
}

// Public API of the calendar module (DOMAIN_BOUNDARIES §5.1, P1-CAL). Owns WorkSchedule (= the
// WorkPattern of §5.2), HolidayCalendar and RamadanPeriod. Sits on layer 1 with rules (§5.3): it may
// call platform and iam only, and leave / time / payroll read work days through it (dayType).
//
// SOURCE_OF_TRUTH "نمط العمل، والعطل، ورمضان": the facts are these tables, the sole writer is
// transitions.ts, the reader is dayType(e, d) (and effectiveDay = effectiveContext + dayType).
export {
  saveWorkPattern,
  replaceBranchPatterns,
  archiveWorkPattern,
  saveHoliday,
  cancelHoliday,
  seedOfficialHolidays,
  saveRamadanPeriod,
  removeRamadanPeriod,
  CalendarInputError,
  CalendarNotFoundError,
  CalendarConflictError,
} from './transitions';
export { OFFICIAL_SOURCE } from './sql/official';
export type { CalendarOp, WorkPatternFields, SaveWorkPatternInput, ReplaceBranchPatternsInput, SaveHolidayInput, SaveRamadanInput } from './transitions';

export {
  dayType,
  dayTypesBetween,
  effectiveDay,
  workPatternById,
  listWorkPatterns,
  resolveWorkPatternId,
  listHolidays,
  listRamadanPeriods,
  addCompanyWorkingDays,
} from './queries';
export type { DayInfo, DayTypeOptions, DayTypeReader, CalendarReader, WorkPatternView } from './queries';

export { classifyDay, patternDailyHours, DAY_TYPES } from './day-type';
export type { DayType, ClassifiedDay, ClassifyInput, PatternHoursInput } from './day-type';

export { parseWeekdays, normalizeWeekdays, formatWeekdays, WEEKDAY_NAMES_AR, DEFAULT_WORK_WEEKDAYS } from './weekdays';
export type { Weekday } from './weekdays';

export { CalendarScopeError, assertCompanyInScope, inScope } from './scope';
export type { CalendarCompanies } from './scope';

export { CALENDAR_EVENTS } from './events';
export type { CalendarEventType } from './events';

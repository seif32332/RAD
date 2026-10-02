// Events of the calendar module (DOMAIN_BOUNDARIES §5.5). Emitted in the transaction of the
// transition that produced them (LIFECYCLE_MODEL §2.1). Consumers to come: time (re-evaluate the
// open attendance days, P3-ATT) and leave (re-count working days of pending requests).
export const CALENDAR_EVENTS = {
  workPatternSaved: 'calendar.workPattern.saved',
  workPatternArchived: 'calendar.workPattern.archived',
  holidaySaved: 'calendar.holiday.saved',
  holidayCancelled: 'calendar.holiday.cancelled',
  ramadanSaved: 'calendar.ramadan.saved',
  ramadanRemoved: 'calendar.ramadan.removed',
} as const;

export type CalendarEventType = (typeof CALENDAR_EVENTS)[keyof typeof CALENDAR_EVENTS];

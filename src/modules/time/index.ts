// Public API of the time module (DOMAIN_BOUNDARIES §5.1). Owns Attendance, AttendancePunch, OvertimeRequest…
// (§5.2); this first slice (P1-PAY-A) holds the overtime money links and decisions behind money.gateway.
// time sits below payroll (§5.3): payroll reserves and releases overtime through these functions.
export {
  linkOvertimeToPayroll,
  unlinkOvertimeFromPayrolls,
  linkOvertimeToSettlement,
  unlinkOvertimeFromSettlement,
  decideOvertime,
  assignOvertime,
} from './transitions';
export type { DecideOvertimeInput, AssignOvertimeInput } from './transitions';
export { OVERTIME_PAYROLL_LINK, OVERTIME_SETTLEMENT_LINK, OVERTIME_DECIDE, OVERTIME_ASSIGN } from './operations';
export { overtimeApproversOfLines } from './queries';

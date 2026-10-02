// The events of lifecycle (DOMAIN_BOUNDARIES §5.5, ARC-LCY-A5). Emitted by transitionEmploymentState
// in the transition's transaction (outbox); consumers act after the commit (LIFECYCLE_MODEL §2.1).
// platform/effective also emits employment.periodOpened / periodClosed / periodSuperseded for the
// EmploymentPeriod rows the transition writes.
import type { EmploymentState, EmploymentTransition } from './states';

export const EMPLOYMENT_EVENT_TYPES = [
  'employment.hired',
  'employment.noticeStarted',
  'employment.exitCancelled',
  'employment.exitAmended',
  'employment.lastWorkingDayChanged',
  'employment.terminated',
  'employment.rehired',
  'employment.voided',
] as const;
export type EmploymentEventType = (typeof EMPLOYMENT_EVENT_TYPES)[number];

/** Minimal payload (ids and values, no personal data beyond the exit reason code, §2.4). */
export interface EmploymentEventPayload {
  stateChangeId: string;
  employeeId: string;
  employmentLineageId: string | null;
  periodId: string | null;
  transition: EmploymentTransition;
  fromState: EmploymentState | null;
  toState: EmploymentState;
  /** 'YYYY-MM-DD' */
  effectiveDate: string;
  terminationDate: string | null;
  exitReason: string | null;
  exitVoluntary: boolean | null;
  /** SELF_ACT_SINGLE_OPERATOR (N-LCY-005 goes to the owner's summary). */
  singleOperator: boolean;
  /** The act removed an eligible second person and fewer than two remain (N-LCY-006). */
  eligibleApproverRemoved: boolean;
}

/**
 * ARC-LCY-A5: the key is `employment:{stateChangeId}`. One state change can emit several events (D1:
 * exitAmended + lastWorkingDayChanged…): the first keeps the bare key, the others add their type.
 */
export function employmentEventKey(stateChangeId: string, type: string, index: number): string {
  return index === 0 ? `employment:${stateChangeId}` : `employment:${stateChangeId}:${type}`;
}

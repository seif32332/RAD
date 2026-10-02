// Public API of the lifecycle module (DOMAIN_BOUNDARIES §5.1). Owns EmploymentStateChange (the state
// fact, DEC-PO-119) with the EmploymentMigrationReview items of its SQL opening (DEC-PO-128), EmploymentPeriod (through platform/effective) and the Employee projections
// employmentState / isTerminated / terminationDate (+ the legacy employmentStatus mirror until
// BL-LCY-009); later ContractPeriod (BL-LCY-017). transitionEmploymentState is the sole writer
// (ARCH-005); callers pass their company scope and an operation key.
export {
  transitionEmploymentState,
  runEmploymentTransition,
} from './transitions';
export type { LifecycleActor, TransitionEmploymentStateInput, TransitionEmploymentStateResult, TransitionOutcome } from './transitions';

export {
  EMPLOYMENT_STATES,
  EXIT_REASON_CODES,
  NOTICE_STATE_RELEASED,
  TRANSITION_NAMES,
  TWO_PERSON_TRANSITIONS,
  EmploymentTransitionError,
  exitStateFor,
  isExitReasonCode,
  legacyStatusOf,
  planTransition,
} from './states';
export type { EmploymentCommand, EmploymentState, EmploymentTransition, ExitReasonCode, CurrentEmployment, TransitionPlan, PlanResult } from './states';

export {
  effectiveState,
  isSeparated,
  isExiting,
  employmentEnd,
  isEmployedOn,
  canPunch,
  inServiceWhere,
  headcountWhere,
  latestStateChange,
  stateHistory,
  currentPeriod,
  employmentPeriods,
  employmentAt,
  employmentLineage,
  migrationReviews,
} from './queries';
export type { EmploymentProjection } from './queries';

export { TERMINATE_ROLES, TwoPersonRequiredError, eligibleSecondPersons, decideTwoPerson, removesLastEligible } from './policy';
export type { PersonDecision } from './policy';

export { EMPLOYMENT_EVENT_TYPES, employmentEventKey } from './events';
export type { EmploymentEventType, EmploymentEventPayload } from './events';

export { lifecycleCompanies } from './scope';
export { LIFECYCLE_CONSUMERS } from './consumers';

export { noticeEndJob, stateOpeningJob, completeDueNotices, openMissingStates, EMPLOYMENT_NOTICE_END_JOB, EMPLOYMENT_STATE_OPENING_JOB } from './jobs';

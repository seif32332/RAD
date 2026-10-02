// platform/effective: the effective-period primitive (P1-FND-EFF, DOMAIN_MODEL §1.3). Exported to
// other modules through src/modules/platform/index.ts only.
export { PERIOD_KINDS, KIND_SPECS } from './kinds';
export type {
  PeriodKind,
  SupersedeReason,
  CompensationAllowance,
  CompensationAttrs,
  AssignmentAttrs,
  BankIdentityAttrs,
  PeriodAttrsByKind,
  PeriodReader,
} from './kinds';

export { toDateOnly, EffectivePeriodInputError } from './shape';
export type { DateOnly, PeriodView } from './shape';

export {
  openPeriod,
  supersedePeriod,
  closePeriod,
  activeAt,
  periodsOf,
  lineageOf,
  PeriodOverlapError,
  PeriodNotFoundError,
  PeriodAlreadySupersededError,
  PeriodInvariantError,
} from './periods';
export type {
  PeriodOp,
  OpenPeriodInput,
  PeriodResult,
  SupersedeInput,
  SupersedeResult,
  ClosePeriodInput,
  CloseResult,
  ReadOptions,
} from './periods';

export { openLegacyPeriod, backfillLegacyOpenings } from './legacy';
export type { OpenLegacyInput, OpenLegacyResult, BackfillRow } from './legacy';

export { effectiveContext, summarizeCompensation, EffectiveScopeError } from './context';
export type { EffectiveContext, EffectiveContextOptions, EmploymentOnDay, CompensationOnDay, AssignmentOnDay, BankOnDay } from './context';

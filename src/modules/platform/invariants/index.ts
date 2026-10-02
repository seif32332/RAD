// Invariant engine (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.2, §4.3): registry, reconcile, the L4 gate,
// the classification policy and the owner dashboard reads. Re-exported by '@/modules/platform'.
export * from './types';
export { INVARIANTS, invariantById, measuredInvariants, registerInvariantCheck, severityRank, effectiveSeverity, isBlocking, blockedOperations, IntegrityInvariantPolicyError } from './registry';
export { reconcile, takeInvariantSnapshot, recordInvariantResults, findingsOf, fingerprintOf, TENANT_LEVEL } from './reconcile';
export type { Finding, InvariantOutcome, InvariantSnapshot, SnapshotOptions, CompanyReconcileSummary } from './reconcile';
export { assertNoBlockingDiscrepancies, listBlockingDiscrepancies, blockingWhere, BlockingDiscrepanciesError, MAX_LISTED } from './gate';
export type { GateScope, Blocker } from './gate';
export {
  resolveOperatorMode,
  OPERATOR_MODE_SETTING,
  assertNotBeneficiary,
  needsSecondPerson,
  decideExplain,
  decideWaiver,
  decideApproveExplanation,
  decideApproveWaiver,
  decideRejectPending,
  decideOwnerConfirmation,
  decideResolve,
} from './policy';
export type { DiscrepancyActor, DiscrepancyState, Decision } from './policy';
export { integrityDashboard, discrepancyScopeOf, companyFilter } from './queries';
export type { DiscrepancyCompanies, DashboardOptions } from './queries';

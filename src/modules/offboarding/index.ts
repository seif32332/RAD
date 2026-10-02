// Public API of the offboarding module (DOMAIN_BOUNDARIES §5.1). Owns TerminationRequest and
// Settlement today (§5.2), ExitCase and its items with P3-OFF, and the Employee exit projection
// (exitReason / exitVoluntary). First slice (P1-LCY): the exit-reason projection and its consumer;
// then the settlement effect log SettlementEffect (DEC-PO-128).
// offboarding calls lifecycle down (transitionEmploymentState); lifecycle never calls offboarding.
import { registerConsumer } from '@/modules/platform';
import { OFFBOARDING_CONSUMERS } from './consumers';

export { projectExitReason, recordSettlementEffects } from './transitions';
export type { ProjectExitReasonResult, RecordSettlementEffects, RecordSettlementEffectsResult } from './transitions';
export { SETTLEMENT_EFFECT_KINDS, settlementEffects } from './effects';
export { currentPeriodStartOf, hasOpenEos, liveEndOfServiceWhere, settlementInPeriodWhere } from './queries';
export type { SettlementEffectInput, SettlementEffectKind } from './effects';
export { OFFBOARDING_CONSUMERS, EXIT_REASON_PROJECTION_CONSUMER, exitReasonProjection } from './consumers';

let registered = false;
/** Registers the offboarding consumers with the platform dispatcher (once per process). */
export function registerOffboardingConsumers(): void {
  if (registered) return;
  for (const c of OFFBOARDING_CONSUMERS) registerConsumer(c);
  registered = true;
}

// Consumers of lifecycle (DOMAIN_BOUNDARIES §5.5): lifecycle consumes NO event that changes the
// employment state. The modules above call it down (onboarding: HIRE / REHIRE / VOID; offboarding:
// EXIT, T1c, T3n, D1; ADR-0001 #4); nothing below may make it move.
//
// The notices of lcy-to-be.md §14 (N-LCY-001..008) are consumers of the employment.* events
// (ARC-LCY-A5). They are not built in P1-LCY: their recipients and channels (HR lists of BL-LCY-006,
// the owner summary and the Radeef channel of DEC-PO-022 / DEC-PO-040) arrive with those packages. The
// events already carry what they need (singleOperator for N-LCY-005, eligibleApproverRemoved for
// N-LCY-006).
import type { EventConsumer } from '@/modules/platform';

export const LIFECYCLE_CONSUMERS: readonly EventConsumer[] = Object.freeze([]);

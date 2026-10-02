// Consumers of offboarding (DOMAIN_BOUNDARIES §5.5). P1-LCY: the exit-reason projection follows every
// employment.* event (the transition records the reason on its fact; offboarding projects it).
import { EMPLOYMENT_EVENT_TYPES } from '@/modules/lifecycle';
import type { EventConsumer } from '@/modules/platform';
import { projectExitReason } from './transitions';

export const EXIT_REASON_PROJECTION_CONSUMER = 'offboarding.exitReasonProjection';

export const exitReasonProjection: EventConsumer = {
  name: EXIT_REASON_PROJECTION_CONSUMER,
  eventTypes: EMPLOYMENT_EVENT_TYPES,
  async handle(event, ctx) {
    const employeeId = (event.payload as { employeeId?: unknown } | null)?.employeeId;
    if (typeof employeeId !== 'string' || !employeeId) return { outcome: 'NOT_APPLICABLE' };
    const r = await projectExitReason(ctx.tx, employeeId, { key: ctx.operationKey, actor: { type: 'SYSTEM', id: EXIT_REASON_PROJECTION_CONSUMER } });
    return { outcome: r.changed ? 'APPLIED' : 'UNCHANGED' };
  },
};

export const OFFBOARDING_CONSUMERS: readonly EventConsumer[] = Object.freeze([exitReasonProjection]);

// Consumers of compensation (DOMAIN_BOUNDARIES §5.5; ARC-PAY-A2, ADR-0002 #6): when an employment ends,
// the pay changes that would start after the last working day are cancelled (they would open a period
// outside the employment). Runs after the lifecycle transition commits, at most once per event.
import { EMPLOYMENT_EVENT_TYPES } from '@/modules/lifecycle';
import type { EventConsumer } from '@/modules/platform';
import { cancelFinancialChangesAfterExit } from './transitions/financial-change';

export const COMPENSATION_EXIT_CONSUMER = 'compensation.employmentExit';
const TERMINATED = 'employment.terminated';
if (!(EMPLOYMENT_EVENT_TYPES as readonly string[]).includes(TERMINATED)) throw new Error('lifecycle no longer emits employment.terminated');

export const compensationExitConsumer: EventConsumer = {
  name: COMPENSATION_EXIT_CONSUMER,
  eventTypes: [TERMINATED],
  async handle(event, ctx) {
    const p = (event.payload ?? {}) as { employeeId?: unknown; terminationDate?: unknown };
    if (typeof p.employeeId !== 'string' || typeof p.terminationDate !== 'string') return { outcome: 'NOT_APPLICABLE' };
    const r = await cancelFinancialChangesAfterExit(ctx.tx, { employeeId: p.employeeId, lastWorkingDay: p.terminationDate.slice(0, 10), operationKey: ctx.operationKey });
    return { outcome: r.cancelled ? 'CANCELLED' : 'NOTHING_PENDING' };
  },
};

export const COMPENSATION_CONSUMERS: readonly EventConsumer[] = Object.freeze([compensationExitConsumer]);

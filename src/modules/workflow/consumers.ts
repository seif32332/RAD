// The engine's DomainEvent consumers (LIFECYCLE_MODEL §2.2: after the producer commits, in the consumer's own
// transaction). Registered by the composition root (src/jobs/consumers.ts) through registerWorkflowConsumers().
//
//   workflow.controlsModeRecheck   on iam.controls.modeChanged (X-WFE-012; wfe-to-be.md §12.1 "تغيّر controlsMode في
//                                  أي اتجاه", §12.5 step 3): every RUNNING or BLOCKED instance of THAT company is
//                                  rechecked (recheckWorkflow, a SystemContext of the company): the candidates of its
//                                  open tasks are resolved again under the new mode, so a step left with nobody in
//                                  ENFORCED leaves BLOCKED when SINGLE_OPERATOR admits its sole operator, and a
//                                  candidate admitted only by the single-operator exception is dropped when the company
//                                  becomes ENFORCED (BLOCKED when nobody else remains). Act time re-checks the mode
//                                  anyway (task.ts), so this consumer is about liveness, never about permission.
// Idempotent: each recheck's key is `wf:recheck:<instance>:controls:<event id>`, and the dispatcher runs a consumer
// once per event.
import { CONTROLS_MODE_CHANGED_EVENT, systemContext } from '@/modules/iam';
import { consumerRegistry, registerConsumer, type DomainEventRecord, type EventConsumer } from '@/modules/platform';
import { adapterOf } from './adapters';
import { recheckWorkflow } from './transitions/instance';

export const CONTROLS_RECHECK_CONSUMER = 'workflow.controlsModeRecheck';
export const controlsModeRecheckConsumer: EventConsumer = {
  name: CONTROLS_RECHECK_CONSUMER,
  eventTypes: [CONTROLS_MODE_CHANGED_EVENT],
  timeoutMs: 300_000,
  async handle(event: DomainEventRecord, ctx) {
    const p = (event.payload ?? {}) as { companyId?: unknown };
    const companyId = typeof p.companyId === 'string' && p.companyId ? p.companyId : event.companyId;
    if (!companyId) return { outcome: 'NO_COMPANY' };
    const rows = await ctx.tx.workflowInstance.findMany({
      where: { companyId, status: { in: ['RUNNING', 'BLOCKED'] } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, requestType: true },
    });
    // An instance whose type has no adapter in this process cannot be resolved here (the engine would refuse it):
    // it is left for the process that registers it rather than failing every other recheck of the company.
    const mine = rows.filter((r) => adapterOf(r.requestType));
    if (!mine.length) return { outcome: 'NOTHING_OPEN' };
    const sys = systemContext(CONTROLS_RECHECK_CONSUMER, companyId);
    for (const r of mine) await recheckWorkflow(ctx.tx, { ctx: sys, instanceId: r.id, callerKey: `controls:${event.id}` });
    return { outcome: 'RECHECKED' };
  },
};

export const WORKFLOW_CONSUMERS: readonly EventConsumer[] = Object.freeze([controlsModeRecheckConsumer]);

/** Registers the engine's consumers (src/jobs/consumers.ts), once. */
export function registerWorkflowConsumers(): void {
  for (const c of WORKFLOW_CONSUMERS) if (!consumerRegistry.list().some((r) => r.name === c.name)) registerConsumer(c);
}

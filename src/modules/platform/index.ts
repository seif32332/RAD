// Public API of the platform module (DOMAIN_BOUNDARIES §5.1): other modules and legacy code import
// from '@/modules/platform' only, never from its files. platform sits at the bottom of the dependency
// order (§5.3) and imports no other module.
export { emitEvent, validateEventInput, EVENT_TYPE_PATTERN, EventKeyConflictError } from './events';
export type { EmitEventInput, DomainEventRecord } from './events';

export { idempotent, runTransition, OperationKeyConflictError } from './operations';
export type { OperationSpec, OperationOutcome, IdempotentOptions, RunTransitionOptions } from './operations';

export {
  ConsumerRegistry,
  consumerRegistry,
  registerConsumer,
  runConsumers,
  retryDelayMs,
  CONSUMER_NAME_PATTERN,
  OUTCOME_PATTERN,
  DEFAULT_OUTCOME,
} from './dispatcher';
export type { EventConsumer, ConsumerContext, ConsumerResult, RunConsumersOptions, RunConsumersResult } from './dispatcher';

export { eventsNotConsumed, consumptionsOf } from './consumption';
export type { EventConsumptionView, ConsumptionQuery } from './consumption';

export { audit, auditTrailOf, legacyAuditOf } from './audit';
export type { AuditActor, AuditInput, AuditTrailRow, LegacyAuditRow } from './audit';

export { redact, isSensitiveKey } from './redact';

export { assertTransactionClient, NotInTransactionError } from './tx';
export type { TxClient, RootClient } from './tx';

// Effective periods (P1-FND-EFF): the only writer of the period tables (ARCH-012), called by the
// module that owns each kind (lifecycle, compensation, org), and effectiveContext for every reader.
export * from './effective';

// Invariant engine (P1-FND-INV): registry, reconcile, the L4 gate every approval and payment calls,
// the discrepancy transitions and the owner dashboard reads.
export * from './invariants';
export {
  explainDiscrepancy,
  approveDiscrepancyExplanation,
  requestDiscrepancyWaiver,
  approveDiscrepancyWaiver,
  rejectDiscrepancyAction,
  resolveDiscrepancy,
  confirmSingleOperatorAct,
} from './transitions/discrepancy';
export type { DiscrepancyTransitionResult } from './transitions/discrepancy';

// money.gateway (P1-PAY-A, ARCH-004): the guard of every money operation and the Prisma extension that
// refuses a money write outside one (installed on the one client in src/lib/prisma.ts).
export * from './money';

// Background jobs (P1-FND-JOBS, DEC-PO-121): the runner (JobRun, no double run, company scope, dry
// run) and the platform's own jobs (outbox-dispatch, domain-events). The CLI is src/jobs/cli.ts.
export * from './jobs';

// The tenant's controls mode (BL-PAY-021, BR-PAY-020): the one resolver (registered by iam, ENFORCED when
// none is), and the platform reads of the owner digest.
export {
  registerOperatorModeResolver,
  operatorModeResolverOwner,
  resolveOperatorMode,
  SELF_ACT_ACTION,
  selfActRecords,
  auditActionCounts,
  auditRecordsOf,
  pendingOwnerConfirmations,
  discrepancySelfActCounts,
  latestEventOf,
  eventsOf,
  outboxByPrefix,
} from './controls';
export type { OperatorModeResolver, Period, SelfActRecord, PendingOwnerConfirmation } from './controls';
export { enqueueEmails, isOutboxEmailAddress } from './notifications';
export type { OutboxEmail } from './notifications';

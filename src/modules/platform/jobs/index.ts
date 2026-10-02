// Background jobs (P1-FND-JOBS): the runner and the platform's own jobs. Public through the platform
// index (DOMAIN_BOUNDARIES §5.1).
export {
  runJob,
  defineJobs,
  jobDetailsJson,
  JobRegistryError,
  JOB_NAME_PATTERN,
  STALE_RUN_MS,
} from './runner';
export type { JobContext, JobDefinition, JobEnv, JobScopes, JobSummary, JobRunResult, RunJobOptions } from './runner';

export {
  createOutboxDispatchJob,
  dispatchOutbox,
  outboxSendConfig,
  outboxExpiryCutoff,
  outboxExpirableWhere,
  classifySendError,
  OUTBOX_DISPATCH_JOB,
} from './outbox';
export type { OutboxSendConfig, OutboxDispatchOptions, MailTransport } from './outbox';

export { createDomainEventsJob, DOMAIN_EVENTS_JOB } from './domain-events';
export { createReconcileJob, RECONCILE_JOB } from './reconcile';
export type { DomainEventsJobOptions } from './domain-events';

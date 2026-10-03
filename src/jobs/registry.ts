// Every scheduled job (P1-FND-JOBS, DEC-PO-121; LIFECYCLE_MODEL §2.5). A job is defined by the
// module that owns its rule and only listed here: this file holds no business rule (ARCH-008).
//
// Adding a job (ARCH-018, enforced by src/lib/__tests__/ops-job-timers.test.ts):
//   1. export its JobDefinition from the owning module and add it below;
//   2. add ops/systemd/radeef-jobs@<name>.timer and the name to JOB_RE in ops/run-jobs.sh;
//   3. a job that must see every company at once is also declared in iam CROSS_COMPANY_JOBS
//      (a reviewed list; src/jobs/__tests__/registry.test.ts keeps the two equal).
import { deactivateTerminatedJob, outboxRecipientStillActive } from '@/lib/access';
import { expiryDigestJob } from '@/lib/alerts-digest';
import { applyEmployeeChangesJob } from '@/lib/documents/change-orders';
import { documentsIntegrityJob, documentsRetentionJob } from '@/lib/documents/jobs';
import { purgeAttendanceBiometricsJob } from '@/lib/self-attendance-retention';
import { credentialOutboxRender, type SystemContext } from '@/modules/iam';
import { noticeEndJob, stateOpeningJob } from '@/modules/lifecycle';
import { applyFinancialChangesJob } from '@/modules/compensation';
import { createDomainEventsJob, createOutboxDispatchJob, createReconcileJob, defineJobs, type JobDefinition } from '@/modules/platform';
// DomainEvent consumers register themselves when their module's consumers.ts is imported. List each
// module's consumers file here (none exists yet) so the domain-events job knows them.
import './consumers';

export const JOBS: readonly JobDefinition<SystemContext>[] = defineJobs<SystemContext>([
  createReconcileJob<SystemContext>(),
  expiryDigestJob,
  deactivateTerminatedJob,
  // BL-PAY-005: credential links are stored as a placeholder and rendered only at send time.
  createOutboxDispatchJob<SystemContext>({ shouldSend: outboxRecipientStillActive, render: credentialOutboxRender }),
  purgeAttendanceBiometricsJob,
  documentsRetentionJob,
  documentsIntegrityJob,
  applyEmployeeChangesJob,
  applyFinancialChangesJob,
  createDomainEventsJob<SystemContext>(),
  noticeEndJob,
  stateOpeningJob,
]);

export const JOB_NAMES: readonly string[] = Object.freeze(JOBS.map((j) => j.name));

export function jobByName(name: string): JobDefinition<SystemContext> | undefined {
  return JOBS.find((j) => j.name === name);
}

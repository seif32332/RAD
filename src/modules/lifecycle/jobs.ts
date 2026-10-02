// The scheduled jobs of lifecycle (P1-FND-JOBS: the job only selects and calls the module, ARCH-008).
//
//   employment-notice-end   T2 (BR-LCY-003, ARC-LCY-A6): every day after midnight in Riyadh, each
//                           employee in NOTICE whose last working day has passed becomes TERMINATED
//                           through transitionEmploymentState, one company at a time. Key
//                           lcy.noticeEnd:{lineage}:{last day} (a later D1 postponement gets its own).
//   employment-state-opening  LCY-J1 repeated "until no empty row remains" (lcy-to-be.md §17): opens the
//                           state of the employees created since the migration (lifecycle_open_state of
//                           9y, the single definition). Until onboarding calls lifecycle HIRE
//                           (BL-ONB-004), new hires get their opening from here or from their first
//                           transition.
import { todayKey } from '@/lib/dates';
import type { SystemContext } from '@/modules/iam';
import { listEmployeeIds } from '@/modules/people';
import { toDateOnly, type JobDefinition, type JobSummary, type RootClient } from '@/modules/platform';
import { latestStateChange } from './queries';
import { callBackfillStateOpenings } from './sql/opening';
import { runEmploymentTransition } from './transitions';

export const EMPLOYMENT_NOTICE_END_JOB = 'employment-notice-end';
export const EMPLOYMENT_STATE_OPENING_JOB = 'employment-state-opening';

/** T2 for one company. Failures of one employee are counted and do not stop the others. */
export async function completeDueNotices(db: RootClient, companyId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<JobSummary> {
  const now = opts.now ?? new Date();
  const today = todayKey(now);
  const due = await listEmployeeIds(db, { employmentState: 'NOTICE', terminationDate: { lt: toDateOnly(today, 'today') } }, [companyId]);
  const summary = { due: due.length, terminated: 0, replayed: 0, unchanged: 0, failed: 0, failures: [] as { employeeId: string; error: string }[] };
  if (opts.dryRun) return { ...summary, dryRun: true };
  for (const employeeId of due) {
    try {
      const latest = await latestStateChange(db, employeeId);
      const lastDay = latest?.terminationDate?.toISOString().slice(0, 10) ?? 'none';
      const r = await runEmploymentTransition(db, {
        employeeId,
        command: 'NOTICE_END',
        source: { type: 'SYSTEM', id: EMPLOYMENT_NOTICE_END_JOB },
        actor: { type: 'SYSTEM', id: EMPLOYMENT_NOTICE_END_JOB },
        operationKey: `lcy.noticeEnd:${latest?.employmentLineageId ?? employeeId}:${lastDay}`,
        companyIds: [companyId],
        now,
      });
      if (r.replayed) summary.replayed += 1;
      else if (r.changed) summary.terminated += 1;
      else summary.unchanged += 1;
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({ employeeId, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  if (summary.failed) throw Object.assign(new Error(`${summary.failed} notice(s) could not be ended`), { details: summary });
  return summary;
}

/** LCY-J1 for one company (idempotent). */
export async function openMissingStates(db: RootClient, companyId: string, opts: { dryRun?: boolean } = {}): Promise<JobSummary> {
  const missing = await listEmployeeIds(db, { employmentStateChanges: { none: {} } }, [companyId]);
  if (opts.dryRun || !missing.length) return { missing: missing.length, ...(opts.dryRun ? { dryRun: true } : {}) };
  const rows = await db.$transaction((tx) => callBackfillStateOpenings(tx, [companyId], `job:${EMPLOYMENT_STATE_OPENING_JOB}`), { timeout: 120_000 });
  return { missing: missing.length, results: rows.map((r) => ({ outcome: r.outcome, review: r.review, employees: r.employees })) };
}

export const noticeEndJob: JobDefinition<SystemContext> = {
  name: EMPLOYMENT_NOTICE_END_JOB,
  description: 'T2: employees in NOTICE whose last working day has passed become TERMINATED (per company)',
  crossCompany: false,
  run: async (ctx) => ctx.forEachCompany((_scope, companyId) => completeDueNotices(ctx.db, companyId, { now: ctx.now, dryRun: ctx.dryRun })),
};

export const stateOpeningJob: JobDefinition<SystemContext> = {
  name: EMPLOYMENT_STATE_OPENING_JOB,
  description: 'LCY-J1: opens the employment state of employees that have none yet (per company)',
  crossCompany: false,
  run: async (ctx) => ctx.forEachCompany((_scope, companyId) => openMissingStates(ctx.db, companyId, { dryRun: ctx.dryRun })),
};

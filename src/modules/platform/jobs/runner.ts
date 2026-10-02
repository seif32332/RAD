// The background-job runner (P1-FND-JOBS, DEC-PO-121; LIFECYCLE_MODEL §2.5, DOMAIN_BOUNDARIES §5.4.2).
//
// A job is a definition { name, crossCompany, run(ctx) } exported by the module that owns its rule;
// the runner only records the run and hands the job its company scope:
//  - JobRun row per run: RUNNING -> SUCCEEDED | FAILED, details = JSON summary without personal data.
//  - No double run: a second run of the same job while one is RUNNING is skipped. The check and the
//    RUNNING row are one step under an advisory lock (two processes started together cannot both run).
//    A RUNNING row older than STALE_RUN_MS is marked FAILED ("abandoned").
//  - Company scope: a per-company job gets ctx.forEachCompany (one SystemContext per company, in turn;
//    a company that fails is recorded and the others still run; the run then FAILS). A job declared
//    cross-company (iam CROSS_COMPANY_JOBS) gets ctx.scope over every company.
//  - Dry run: ctx.dryRun; the job reports what it would do and changes nothing (the JobRun row is
//    still written, so a dry run and a real run never overlap).
// platform sits below iam (§5.3), so the scope constructors are injected (JobScopes) by the
// composition root (src/jobs), which wires iam.systemContext / iam.forEachCompany and org's companies.
import { lockJobStart } from '../sql/jobs';
import type { RootClient } from '../tx';

export const JOB_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** A RUNNING row older than this is considered abandoned (the process died). */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

export type JobSummary = Record<string, unknown>;
/** The environment a job reads (process.env in production; any plain object in tests). */
export type JobEnv = Record<string, string | undefined>;

export interface JobContext<S> {
  job: string;
  db: RootClient;
  dryRun: boolean;
  /** Business "now" (tests move it); the lock uses the real clock. */
  now: Date;
  env: JobEnv;
  /** Cross-company jobs: the job's context over every company. Per-company jobs: null. */
  scope: S | null;
  /**
   * Runs `fn` once per company of the tenant with that company's context, in turn. A company whose
   * `fn` throws is recorded (JobRun details.companyFailures) and does not stop the others; the run
   * is FAILED at the end. Returns the results of the companies that succeeded.
   */
  forEachCompany<T>(fn: (scope: S, companyId: string) => Promise<T>): Promise<Record<string, T>>;
}

export interface JobDefinition<S = unknown> {
  /** kebab-case, stable forever: the JobRun.job value, the systemd timer and ops/run-jobs.sh use it. */
  name: string;
  /** One line for --list and the runbook. */
  description: string;
  /** Declared cross-company (must match iam CROSS_COMPANY_JOBS). */
  crossCompany: boolean;
  run(ctx: JobContext<S>): Promise<JobSummary>;
}

/** Scope constructors for the runner (implemented with iam and org by the composition root). */
export interface JobScopes<S> {
  /** The tenant's companies. */
  companyIds(db: RootClient): Promise<string[]>;
  forEachCompany<T>(companyIds: readonly string[], job: string, fn: (scope: S, companyId: string) => Promise<T>): Promise<unknown>;
  /** The context of a cross-company job over every company (throws for a job not declared cross-company). */
  crossCompany(job: string): S;
}

export interface RunJobOptions {
  dryRun?: boolean;
  now?: Date;
  env?: JobEnv;
}

export type JobRunResult =
  | { skipped: true; reason: string }
  | { jobRunId: string; status: 'SUCCEEDED'; details: JobSummary }
  | { jobRunId: string; status: 'FAILED'; error: string; details?: JobSummary };

export class JobRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRegistryError';
  }
}

/** Checks a set of definitions (unique kebab names, a run function) and returns it frozen. */
export function defineJobs<S>(defs: readonly JobDefinition<S>[]): readonly JobDefinition<S>[] {
  const seen = new Set<string>();
  for (const d of defs) {
    if (!JOB_NAME_PATTERN.test(d.name)) throw new JobRegistryError(`Invalid job name "${d.name}": expected kebab-case`);
    if (seen.has(d.name)) throw new JobRegistryError(`Job "${d.name}" is defined twice`);
    if (typeof d.run !== 'function') throw new JobRegistryError(`Job "${d.name}" has no run()`);
    seen.add(d.name);
  }
  return Object.freeze([...defs]);
}

function errorText(err: unknown): string {
  return String((err instanceof Error ? err.message : err) || err).slice(0, 1000);
}

/** JSON for JobRun.details (bigint as string). */
export function jobDetailsJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

type StartResult = { run: { id: string } } | { running: { id: string } };

async function startRun(db: RootClient, job: string): Promise<StartResult> {
  return db.$transaction(async (tx) => {
    await lockJobStart(tx, job);
    await tx.jobRun.updateMany({
      where: { job, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } },
      data: { status: 'FAILED', finishedAt: new Date(), details: jobDetailsJson({ error: `abandoned (still RUNNING after ${STALE_RUN_MS / 3_600_000}h)` }) },
    });
    const running = await tx.jobRun.findFirst({ where: { job, status: 'RUNNING' }, select: { id: true } });
    if (running) return { running };
    return { run: await tx.jobRun.create({ data: { job, status: 'RUNNING' }, select: { id: true } }) };
  });
}

/** Runs one job: lock, JobRun row, company scope, summary. Never throws for a job failure. */
export async function runJob<S>(db: RootClient, def: JobDefinition<S>, scopes: JobScopes<S>, opts: RunJobOptions = {}): Promise<JobRunResult> {
  const start = await startRun(db, def.name);
  if ('running' in start) return { skipped: true, reason: `another ${def.name} run is in progress (JobRun ${start.running.id})` };
  const runId = start.run.id;

  const companyFailures: Record<string, string> = {};
  let details: JobSummary | undefined;
  try {
    const ctx: JobContext<S> = {
      job: def.name,
      db,
      dryRun: !!opts.dryRun,
      now: opts.now ?? new Date(),
      env: opts.env ?? process.env,
      scope: def.crossCompany ? scopes.crossCompany(def.name) : null,
      async forEachCompany<T>(fn: (scope: S, companyId: string) => Promise<T>) {
        const out: Record<string, T> = {};
        const ids = await scopes.companyIds(db);
        await scopes.forEachCompany(ids, def.name, async (scope, companyId) => {
          try {
            out[companyId] = await fn(scope, companyId);
          } catch (err) {
            companyFailures[companyId] = errorText(err);
          }
        });
        return out;
      },
    };
    details = await def.run(ctx);
    const failed = Object.keys(companyFailures);
    if (failed.length) {
      const error = `failed for ${failed.length} compan${failed.length === 1 ? 'y' : 'ies'}`;
      await db.jobRun.update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: new Date(), details: jobDetailsJson({ ...details, error, companyFailures }) } });
      return { jobRunId: runId, status: 'FAILED', error, details: { ...details, companyFailures } };
    }
    await db.jobRun.update({ where: { id: runId }, data: { status: 'SUCCEEDED', finishedAt: new Date(), details: jobDetailsJson(details) } });
    return { jobRunId: runId, status: 'SUCCEEDED', details };
  } catch (err) {
    const error = errorText(err);
    const failures = Object.keys(companyFailures).length ? { companyFailures } : {};
    await db.jobRun
      .update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: new Date(), details: jobDetailsJson({ error, ...failures }) } })
      .catch(() => undefined);
    return { jobRunId: runId, status: 'FAILED', error, ...(details ? { details } : {}) };
  }
}

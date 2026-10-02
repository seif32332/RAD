// The job runner (P1-FND-JOBS) without a database: JobRun recording, the no-double-run rule, company
// scope and dry run. The same rules against PostgreSQL (real lock, concurrency): jobs.it.test.ts.
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { defineJobs, JobRegistryError, runJob, STALE_RUN_MS, type JobContext, type JobDefinition, type JobScopes } from '@/modules/platform';

interface Row {
  id: string;
  job: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  details: string | null;
}

/** In-memory JobRun table with the calls the runner makes. */
function fakeDb() {
  const rows: Row[] = [];
  let n = 0;
  const matches = (r: Row, where: { job?: string; status?: string; startedAt?: { lt: Date } }) =>
    (!where.job || r.job === where.job) && (!where.status || r.status === where.status) && (!where.startedAt || r.startedAt < where.startedAt.lt);
  const jobRun = {
    updateMany: async ({ where, data }: { where: Parameters<typeof matches>[1]; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    findFirst: async ({ where }: { where: Parameters<typeof matches>[1] }) => rows.find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: { job: string; status: string } }) => {
      const r: Row = { id: `run-${++n}`, job: data.job, status: data.status, startedAt: new Date(), finishedAt: null, details: null };
      rows.push(r);
      return { id: r.id };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
  };
  const locks: string[] = [];
  const tx = { jobRun, $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => (locks.push(String(v[0])), 1) };
  const db = { jobRun, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { db: db as unknown as PrismaClient, rows, locks };
}

type Scope = { companies: string[] | 'ALL'; job: string };
function scopes(companies: string[], crossCompanyJobs: string[] = []): JobScopes<Scope> & { visited: string[] } {
  const visited: string[] = [];
  return {
    visited,
    companyIds: async () => companies,
    forEachCompany: async (ids, job, fn) => {
      for (const id of ids) {
        visited.push(id);
        await fn({ companies: [id], job }, id);
      }
    },
    crossCompany: (job) => {
      if (!crossCompanyJobs.includes(job)) throw new Error(`systemContext: job "${job}" is not declared cross-company`);
      return { companies: 'ALL', job };
    },
  };
}

function job(name: string, run: (ctx: JobContext<Scope>) => Promise<Record<string, unknown>>, crossCompany = false): JobDefinition<Scope> {
  return { name, description: name, crossCompany, run };
}

describe('job runner', () => {
  it('records a JobRun row RUNNING -> SUCCEEDED with the JSON summary, under the start lock', async () => {
    const { db, rows, locks } = fakeDb();
    const r = await runJob(db, job('demo', async () => ({ done: 3, big: BigInt(7) })), scopes([]));
    expect(r).toMatchObject({ status: 'SUCCEEDED', details: { done: 3 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job: 'demo', status: 'SUCCEEDED' });
    expect(JSON.parse(rows[0].details!)).toEqual({ done: 3, big: '7' });
    expect(rows[0].finishedAt).toBeInstanceOf(Date);
    expect(locks).toEqual(['jobrun/demo']);
  });

  it('a failing job is FAILED with the error text, and never throws to the caller', async () => {
    const { db, rows } = fakeDb();
    const r = await runJob(db, job('boom', async () => { throw new Error('disk not mounted'); }), scopes([]));
    expect(r).toMatchObject({ status: 'FAILED', error: 'disk not mounted' });
    expect(rows[0].status).toBe('FAILED');
    expect(JSON.parse(rows[0].details!)).toEqual({ error: 'disk not mounted' });
  });

  it('double call: a second run while one is RUNNING is skipped (no second JobRun, the job does not run twice)', async () => {
    const { db, rows } = fakeDb();
    let calls = 0;
    let release!: () => void;
    const slow = job('slow', async () => {
      calls += 1;
      await new Promise<void>((r) => (release = r));
      return {};
    });
    const first = runJob(db, slow, scopes([]));
    await new Promise((r) => setTimeout(r, 5));
    const second = await runJob(db, slow, scopes([]));
    expect(second).toMatchObject({ skipped: true });
    release();
    expect(await first).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls).toBe(1);
    expect(rows).toHaveLength(1);
    // Once finished, the next run starts normally.
    const third = runJob(db, slow, scopes([]));
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(await third).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls).toBe(2);
  });

  it('a RUNNING row older than the stale limit is marked FAILED (abandoned) and does not block', async () => {
    const { db, rows } = fakeDb();
    rows.push({ id: 'old', job: 'demo', status: 'RUNNING', startedAt: new Date(Date.now() - STALE_RUN_MS - 1000), finishedAt: null, details: null });
    const r = await runJob(db, job('demo', async () => ({})), scopes([]));
    expect(r).toMatchObject({ status: 'SUCCEEDED' });
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].details).toMatch(/abandoned/);
  });

  it('dry run is passed to the job (and still recorded)', async () => {
    const { db, rows } = fakeDb();
    const seen: boolean[] = [];
    await runJob(db, job('demo', async (ctx) => (seen.push(ctx.dryRun), { dryRun: ctx.dryRun })), scopes([]), { dryRun: true });
    await runJob(db, job('demo', async (ctx) => (seen.push(ctx.dryRun), {})), scopes([]));
    expect(seen).toEqual([true, false]);
    expect(rows.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
  });

  it('per company: one context per company, no cross-company scope', async () => {
    const { db } = fakeDb();
    const s = scopes(['c1', 'c2', 'c3']);
    let scope: unknown = 'unset';
    const r = await runJob(
      db,
      job('per-company', async (ctx) => {
        scope = ctx.scope;
        const out = await ctx.forEachCompany(async (sc, id) => ({ id, companies: sc.companies }));
        return { out };
      }),
      s,
    );
    expect(scope).toBeNull();
    expect(s.visited).toEqual(['c1', 'c2', 'c3']);
    expect(r).toMatchObject({ status: 'SUCCEEDED', details: { out: { c1: { companies: ['c1'] }, c3: { companies: ['c3'] } } } });
  });

  it('a failing company does not stop the others; the run is FAILED with the company named', async () => {
    const { db, rows } = fakeDb();
    const done: string[] = [];
    const r = await runJob(
      db,
      job('per-company', async (ctx) => {
        const out = await ctx.forEachCompany(async (_sc, id) => {
          if (id === 'c2') throw new Error('c2 is broken');
          done.push(id);
          return 1;
        });
        return { companies: Object.keys(out).length };
      }),
      scopes(['c1', 'c2', 'c3']),
    );
    expect(done).toEqual(['c1', 'c3']);
    expect(r).toMatchObject({ status: 'FAILED', error: 'failed for 1 company', details: { companies: 2, companyFailures: { c2: 'c2 is broken' } } });
    expect(JSON.parse(rows[0].details!)).toMatchObject({ companies: 2, companyFailures: { c2: 'c2 is broken' } });
  });

  it('cross-company: the job gets the all-companies scope; an undeclared job is refused', async () => {
    const { db } = fakeDb();
    const declared = await runJob(db, job('outbox-like', async (ctx) => ({ scope: ctx.scope }), true), scopes([], ['outbox-like']));
    expect(declared).toMatchObject({ status: 'SUCCEEDED', details: { scope: { companies: 'ALL', job: 'outbox-like' } } });
    const undeclared = await runJob(db, job('sneaky', async () => ({ ran: true }), true), scopes([], ['outbox-like']));
    expect(undeclared).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/not declared cross-company/) });
  });
});

describe('defineJobs', () => {
  it('refuses a non kebab-case name, a duplicate and a job without run()', () => {
    const ok = job('a-job', async () => ({}));
    expect(defineJobs([ok])).toHaveLength(1);
    expect(() => defineJobs([job('Bad_Name', async () => ({}))])).toThrow(JobRegistryError);
    expect(() => defineJobs([ok, ok])).toThrow(/twice/);
    expect(() => defineJobs([{ ...ok, run: undefined as never }])).toThrow(/no run/);
  });
});

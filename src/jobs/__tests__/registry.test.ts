// The job registry, the CLI and the bundle that plain node runs (P1-FND-JOBS, DEC-PO-121).
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CROSS_COMPANY_JOBS } from '@/modules/iam';
import { JOB_NAME_PATTERN } from '@/modules/platform';
import { main, withConnectionLimit } from '../cli';
import { JOB_NAMES, JOBS } from '../registry';
import { ALLOWED_PACKAGES, buildJobsBundle } from '../../../scripts/build-jobs.mjs';

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) } };
}

describe('job registry', () => {
  it('names are unique kebab-case, and include the jobs of every owning module', () => {
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
    for (const n of JOB_NAMES) expect(n).toMatch(JOB_NAME_PATTERN);
    expect([...JOB_NAMES].sort()).toEqual(
      ['apply-employee-changes', 'deactivate-terminated', 'documents-integrity', 'documents-retention', 'domain-events', 'expiry-digest', 'outbox-dispatch', 'purge-attendance-biometrics', 'reconcile', 'employment-notice-end', 'employment-state-opening'].sort(),
    );
  });

  it('a job is cross-company exactly when iam CROSS_COMPANY_JOBS declares it (DOMAIN_BOUNDARIES §5.4.2)', () => {
    for (const j of JOBS) expect(j.crossCompany, j.name).toBe(CROSS_COMPANY_JOBS.includes(j.name));
    for (const name of CROSS_COMPANY_JOBS) expect(JOB_NAMES).toContain(name);
  });
});

describe('jobs CLI', () => {
  it('--list prints every job with its scope', async () => {
    const c = capture();
    expect(await main(['--list'], {}, c.out)).toBe(0);
    expect(c.lines.map((l) => l.split('\t')[0])).toEqual([...JOB_NAMES]);
    expect(c.lines.find((l) => l.startsWith('outbox-dispatch\t'))).toContain('cross-company');
    expect(c.lines.find((l) => l.startsWith('documents-retention\t'))).toContain('company-scoped');
  });

  it('usage errors exit 2: unknown job, unknown flag, missing DATABASE_URL (nothing runs)', async () => {
    for (const argv of [[], ['nope'], ['expiry-digest', '--force']]) {
      const c = capture();
      expect(await main(argv, { DATABASE_URL: 'postgresql://x' }, c.out)).toBe(2);
      expect(c.errors[0]).toMatch(/^usage:/);
    }
    const c = capture();
    expect(await main(['expiry-digest', '--dry-run'], {}, c.out)).toBe(2);
    expect(c.errors[0]).toMatch(/DATABASE_URL is not set/);
  });

  it('caps the pool of the job process at 2 connections before any client exists', async () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://u:p@h/d?connection_limit=10' };
    await main(['nope'], env, capture().out);
    expect(env.DATABASE_URL).toBe('postgresql://u:p@h/d?connection_limit=2');
    expect(withConnectionLimit('postgresql://u:p@h/d')).toBe('postgresql://u:p@h/d?connection_limit=2');
  });
});

describe('jobs bundle (scripts/build-jobs.mjs)', { timeout: 60_000 }, () => {
  it('builds from src/jobs/cli.ts, needs only the packages the runtime image ships, and runs under plain node', async () => {
    const { bundle, modules, externals } = buildJobsBundle();
    expect(modules).toContain('src/jobs/registry.ts');
    expect(modules).toContain('src/lib/documents/change-orders.ts');
    expect(modules.some((m) => m.startsWith('node_modules/'))).toBe(false);
    for (const p of externals) expect(ALLOWED_PACKAGES).toContain(p);
    // Inside the repo so that its packages resolve like they do from dist/jobs/ (node_modules above).
    const dir = join(process.cwd(), 'node_modules', '.cache', 'radeef-jobs-bundle-test');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `jobs-${process.pid}.cjs`);
    writeFileSync(file, bundle);
    try {
      const loaded = createRequire(file)(file) as { main: typeof main };
      const c = capture();
      // --list loads every module of the bundle with node's own loader (not vitest's).
      expect(await loaded.main(['--list'], {}, c.out)).toBe(0);
      expect(c.lines.map((l) => l.split('\t')[0])).toEqual([...JOB_NAMES]);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('refuses a package the runtime image does not ship', () => {
    expect(() => buildJobsBundle({ allowed: ['@prisma/client'] })).toThrow(/does not ship:[\s\S]*nodemailer/);
  });
});

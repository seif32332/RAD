// Command line of the background jobs (DEC-009: a CLI, never an HTTP endpoint — nginx proxies every
// request from 127.0.0.1, so an "internal-only" route cannot be told apart from the internet).
// Built into dist/jobs/jobs.cjs by scripts/build-jobs.mjs and started by scripts/jobs.mjs:
//
//   node --env-file=/etc/radeef/<tenant>.env scripts/jobs.mjs <job> [--dry-run]
//   node scripts/jobs.mjs --list
//
// Exit codes: 0 ok (or skipped: another run in progress), 1 job failed, 2 usage error.
//
// No static value import on purpose (type imports are erased): the Prisma pool must be capped (connection_limit) in DATABASE_URL
// before any module creates the client (src/lib/prisma.ts).

import type { JobEnv } from '@/modules/platform';

/** Prisma pool of a job process (DEC-009: tenants x (app pool + job pool) must fit max_connections). */
export const JOB_CONNECTION_LIMIT = 2;

/** Sets Prisma's connection_limit on a database URL (replacing any existing value). */
export function withConnectionLimit(url: string, limit = JOB_CONNECTION_LIMIT): string {
  if (!url) return url;
  const [base, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !p.startsWith('connection_limit='));
  params.push(`connection_limit=${limit}`);
  return `${base}?${params.join('&')}`;
}

type Out = Pick<Console, 'log' | 'error'>;

export async function main(argv: readonly string[], env: JobEnv = process.env, out: Out = console): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [job] = argv.filter((a) => !a.startsWith('--'));
  if (env.DATABASE_URL) env.DATABASE_URL = withConnectionLimit(env.DATABASE_URL);

  const { JOBS, jobByName } = await import('./registry');
  if (flags.has('--list')) {
    for (const j of JOBS) out.log(`${j.name}\t${j.crossCompany ? 'cross-company' : 'company-scoped'}\t${j.description}`);
    return 0;
  }
  const def = job ? jobByName(job) : undefined;
  const unknownFlag = [...flags].find((f) => f !== '--dry-run');
  if (!def || unknownFlag) {
    out.error(`usage: node --env-file=<tenant.env> scripts/jobs.mjs <${JOBS.map((j) => j.name).join('|')}> [--dry-run] | --list`);
    return 2;
  }
  if (!env.DATABASE_URL) {
    out.error('[jobs] DATABASE_URL is not set (use node --env-file=/etc/radeef/<tenant>.env)');
    return 2;
  }

  const [{ prisma }, { runRegisteredJob }] = await Promise.all([import('@/lib/prisma'), import('./run')]);
  try {
    const result = await runRegisteredJob(prisma, def.name, { dryRun: flags.has('--dry-run'), env });
    out.log(JSON.stringify({ job: def.name, at: new Date().toISOString(), ...result }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return 'status' in result && result.status === 'FAILED' ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

// Runs a registered job by name with the SystemContext scopes (the CLI and the tests use it).
import type { PrismaClient } from '@prisma/client';
import { runJob, type JobRunResult, type RunJobOptions } from '@/modules/platform';
import { jobByName } from './registry';
import { systemJobScopes } from './scopes';

export async function runRegisteredJob(db: PrismaClient, name: string, opts: RunJobOptions = {}): Promise<JobRunResult> {
  const def = jobByName(name);
  if (!def) throw new Error(`unknown job "${name}"`);
  return runJob(db, def, systemJobScopes, opts);
}

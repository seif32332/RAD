#!/usr/bin/env node
/**
 * Radeef HRMS — background jobs (DEC-009). Launcher only (ARCH-008, DEC-PO-121): the jobs are the
 * modules' own TypeScript code, listed in src/jobs/registry.ts and compiled by `npm run build:jobs`
 * (part of `npm run build`) into dist/jobs/jobs.cjs. This file loads that bundle and nothing else.
 *
 *   node --env-file=/etc/radeef/<tenant>.env scripts/jobs.mjs <job> [--dry-run]
 *   node scripts/jobs.mjs --list          every job, its company scope and what it does
 *
 * Every run writes a JobRun row; a second run of a job while one is RUNNING is skipped; the Prisma
 * pool is capped at connection_limit=2 (src/jobs/cli.ts, src/modules/platform/jobs).
 * Exit codes: 0 ok (or skipped), 1 job failed, 2 usage error or missing build.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const bundle = fileURLToPath(new URL('../dist/jobs/jobs.cjs', import.meta.url));

if (!existsSync(bundle)) {
  console.error(`[jobs] ${bundle} not found: build it with \`npm run build:jobs\` (part of \`npm run build\`)`);
  process.exitCode = 2;
} else {
  const { main } = createRequire(import.meta.url)(bundle);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('[jobs] fatal:', err && err.message);
      process.exitCode = 1;
    },
  );
}

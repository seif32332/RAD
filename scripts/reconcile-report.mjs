#!/usr/bin/env node
/**
 * Radeef HRMS — read-only reconciliation report (master plan P0-10).
 *
 *   node --env-file=/etc/radeef/<tenant>.env scripts/reconcile-report.mjs [--json]
 *
 * Measures INV-LCY-01, INV-ORG-01, INV-PAY-01, INV-PAY-02 and INV-DOC-01
 * (docs/architecture/ARCHITECTURE_INVARIANTS.md) on the tenant's current data. Report only: it
 * blocks nothing and writes nothing (no JobRun, no Discrepancy, no email). All reads run in one
 * REPEATABLE READ, READ ONLY transaction, so PostgreSQL refuses any write.
 *
 * Output: the JSON report on stdout; a bilingual summary on stderr (omitted with --json).
 * UPLOAD_DIR (from the env file) enables re-hashing the issued PDFs for INV-DOC-01.
 *
 * The rules live in scripts/lib/reconciliation-checks.mjs (imported by the app through
 * src/lib/reconciliation/checks.ts); this file only wires the database and prints.
 *
 * Exit codes: 0 report produced (even with violations), 1 error, 2 usage error.
 */
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { formatSummary, runReconciliationReadOnly } from './lib/reconciliation-checks.mjs';

const CONNECTION_LIMIT = 2;

function withConnectionLimit(url) {
  const [base, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !p.startsWith('connection_limit='));
  params.push(`connection_limit=${CONNECTION_LIMIT}`);
  return `${base}?${params.join('&')}`;
}

async function main(argv) {
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length) {
    console.error('usage: node --env-file=<tenant.env> scripts/reconcile-report.mjs [--json]');
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[reconcile] DATABASE_URL is not set (use node --env-file=/etc/radeef/<tenant>.env)');
    return 2;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: withConnectionLimit(process.env.DATABASE_URL) } } });
  try {
    const report = await runReconciliationReadOnly(prisma, { uploadDir: process.env.UPLOAD_DIR });
    if (!argv.includes('--json')) console.error(formatSummary(report) + '\n');
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('[reconcile] fatal:', err && err.message);
      process.exitCode = 1;
    },
  );
}

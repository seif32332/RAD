// Scheduled jobs of the document engine (P1-FND-JOBS; docs/document-engine ADR-001 DOC-07 / DOC-09,
// RUNBOOK §6.2). Same code as the application: the event chain of events.ts, the storage layout of
// storage.ts.
//
//  documents-retention  per company (IssuedDocument.legalCompanyId): `document_retention_years`
//                       (owner decision: 10) after the employee's end of service, deletes the issued
//                       PDF and clears the snapshot content; candidate documents (job offers) are kept
//                       `candidate_document_retention_years` (2) after issuance. The IssuedDocument row
//                       stays (number, type, company, dates, hash) so the verification page answers
//                       "retention period ended". Needs UPLOAD_DIR.
//  documents-integrity  cross-company (one hash chain per tenant): walks the DocumentEvent chain and
//                       re-hashes the stored PDFs against pdfSha256; any problem fails the run and
//                       queues one email per alert recipient per day.
import 'server-only';
import path from 'path';
import { readFile, stat, unlink } from 'fs/promises';
import type { PrismaClient } from '@prisma/client';
import { alertRecipients } from '@/lib/access';
import { todayKey } from '@/lib/dates';
import { scopeWhere, type SystemContext } from '@/modules/iam';
import { enqueueEmails, type JobDefinition, type JobEnv, type JobSummary } from '@/modules/platform';
import { sha256Hex } from './core';
import { appendEvent, verifyEventChain } from './events';
import { DOCS_DIR_NAME } from './storage';

export const DOCUMENTS_RETENTION_JOB = 'documents-retention';
export const DOCUMENTS_INTEGRITY_JOB = 'documents-integrity';
export const DOCUMENT_RETENTION_SETTING = 'document_retention_years';
export const CANDIDATE_DOCUMENT_RETENTION_SETTING = 'candidate_document_retention_years';

const STORED_DOC_RE = /^\d{4}\/[0-9a-f-]{36}\.pdf$/;
/** Same format as storage.ts writes ("<yyyy>/<uuid>.pdf"). */
export function isStoredDocumentName(name: string | null | undefined): name is string {
  return typeof name === 'string' && STORED_DOC_RE.test(name);
}

/** Retention in whole years from a SystemSetting value (bounds 1..50), else the fallback. */
export function parseRetentionYears(raw: string | null | undefined, fallback = 10): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : fallback;
}

function documentsDir(env: JobEnv): string {
  const uploadDir = String(env.UPLOAD_DIR || '').trim();
  if (!uploadDir) throw new Error('UPLOAD_DIR is not set in the tenant env file: refusing to guess where issued documents are');
  return path.join(path.resolve(uploadDir), DOCS_DIR_NAME);
}

function yearsBefore(now: Date, years: number): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/** documents-retention for the companies of `ctx` (one company per run of forEachCompany). */
export async function purgeRetainedDocuments(db: PrismaClient, ctx: SystemContext, opts: { dryRun?: boolean; now?: Date; env?: JobEnv } = {}): Promise<JobSummary> {
  const now = opts.now ?? new Date();
  const dir = documentsDir(opts.env ?? process.env);
  const settings = await db.systemSetting.findMany({ where: { key: { in: [DOCUMENT_RETENTION_SETTING, CANDIDATE_DOCUMENT_RETENTION_SETTING] } }, select: { key: true, value: true } });
  const value = (key: string) => settings.find((s) => s.key === key)?.value;
  const years = parseRetentionYears(value(DOCUMENT_RETENTION_SETTING));
  const candidateYears = parseRetentionYears(value(CANDIDATE_DOCUMENT_RETENTION_SETTING), 2);
  const cutoff = yearsBefore(now, years);
  const candidateCutoff = yearsBefore(now, candidateYears);
  const company = scopeWhere(ctx, 'IssuedDocument');
  const due = await db.issuedDocument.findMany({
    where: {
      AND: [
        {
          purgedAt: null,
          OR: [
            { employee: { isTerminated: true, terminationDate: { not: null, lte: cutoff } } },
            { jobApplicationId: { not: null }, issuedAt: { lte: candidateCutoff } },
          ],
        },
        ...(company ? [company] : []),
      ],
    },
    select: { id: true, requestId: true, storedName: true },
    take: 500,
  });
  const summary = { retentionYears: years, cutoff: cutoff.toISOString().slice(0, 10), candidateRetentionYears: candidateYears, due: due.length, purged: 0, missingFiles: 0 };
  if (opts.dryRun || !due.length) return { ...summary, dryRun: !!opts.dryRun };
  const dirExists = await stat(dir).then((s) => s.isDirectory(), () => false);
  if (!dirExists) throw new Error(`${dir} not found while documents are due for purge (is the uploads volume mounted?)`);

  for (const d of due) {
    // Database first (the row keeps its hash); then the file. A crash between the two leaves an orphan
    // file that documents-integrity reports, never a row pointing at nothing.
    const purged = await db.$transaction(async (tx) => {
      const moved = await tx.issuedDocument.updateMany({ where: { id: d.id, purgedAt: null }, data: { purgedAt: now } });
      if (moved.count !== 1) return false; // purged meanwhile (a concurrent or repeated run)
      await tx.documentSnapshot.updateMany({ where: { requestId: d.requestId, purgedAt: null }, data: { data: '{}', brand: '{}', purgedAt: now } });
      // The employee's comment on a warning is personal data too; the acknowledgement itself stays as evidence.
      const ack = await tx.documentAcknowledgement.findUnique({ where: { documentId: d.id }, select: { id: true, comment: true } });
      if (ack?.comment != null) await tx.documentAcknowledgement.update({ where: { id: ack.id }, data: { comment: null } });
      await appendEvent(tx, { type: 'PURGED', documentId: d.id, requestId: d.requestId, meta: { reason: 'RETENTION', years } });
      return true;
    });
    if (!purged) continue;
    if (isStoredDocumentName(d.storedName)) {
      try {
        await unlink(path.join(dir, ...d.storedName.split('/')));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') summary.missingFiles += 1;
        else throw err;
      }
    }
    summary.purged += 1;
  }
  return summary;
}

export const documentsRetentionJob: JobDefinition<SystemContext> = {
  name: DOCUMENTS_RETENTION_JOB,
  description: 'Deletes issued PDFs and clears snapshots after the retention period, company by company (needs UPLOAD_DIR)',
  crossCompany: false,
  async run(ctx) {
    const byCompany = await ctx.forEachCompany((scope) => purgeRetainedDocuments(ctx.db, scope, { dryRun: ctx.dryRun, now: ctx.now, env: ctx.env }));
    const sum = (k: 'due' | 'purged' | 'missingFiles') => Object.values(byCompany).reduce((s, r) => s + (Number(r[k]) || 0), 0);
    return { companies: Object.keys(byCompany).length, due: sum('due'), purged: sum('purged'), missingFiles: sum('missingFiles'), ...(ctx.dryRun ? { dryRun: true } : {}), byCompany };
  },
};

/** documents-integrity (whole tenant: the event chain is one chain). */
export async function checkDocumentsIntegrity(db: PrismaClient, opts: { dryRun?: boolean; now?: Date; env?: JobEnv } = {}): Promise<JobSummary> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const dir = documentsDir(env);
  const max = Math.min(Math.max(Number(env.DOCUMENTS_INTEGRITY_MAX) || 2000, 1), 100000);
  const chain = await verifyEventChain(db);
  const docs = await db.issuedDocument.findMany({
    where: { purgedAt: null },
    select: { number: true, storedName: true, pdfSha256: true },
    orderBy: { issuedAt: 'asc' },
    take: max,
  });
  const problems: string[] = [];
  if (chain.brokenAtSeq !== null) problems.push(`event chain broken at seq ${chain.brokenAtSeq}`);
  let checked = 0;
  for (const d of docs) {
    if (!isStoredDocumentName(d.storedName)) {
      problems.push(`${d.number}: invalid stored name`);
      continue;
    }
    try {
      const buf = await readFile(path.join(dir, ...d.storedName.split('/')));
      if (sha256Hex(buf) !== d.pdfSha256) problems.push(`${d.number}: file does not match its recorded hash`);
    } catch (err) {
      problems.push(`${d.number}: ${(err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file missing' : 'unreadable'}`);
    }
    checked += 1;
  }
  const summary = { eventsChecked: chain.checked, chainIntact: chain.brokenAtSeq === null, filesChecked: checked, problems: problems.slice(0, 50), problemCount: problems.length };
  if (problems.length && !opts.dryRun) {
    const { users } = await alertRecipients(db);
    const dayKey = todayKey(now);
    const base = String(env.APP_URL || env.NEXTAUTH_URL || '').trim().replace(/\/+$/, '');
    const login = /^https?:\/\/[^\s"'<>]+$/.test(base) ? `${base}/login` : null;
    const body = `فحص سلامة المستندات الرسمية وجد ${problems.length} مشكلة (سلسلة الأحداث أو ملفات لا تطابق بصماتها). التفاصيل في JobRun (documents-integrity)، وتحتاج مراجعة فورية.${login ? `\n\n${login}` : ''}`;
    await enqueueEmails(
      db,
      users.map((u) => ({ idempotencyKey: `documents-integrity:${u.id}:${dayKey}`, recipient: u.email, subject: 'رديف: تنبيه سلامة المستندات الرسمية', body })),
    );
    throw new Error(`integrity problems: ${JSON.stringify(summary)}`.slice(0, 1000));
  }
  return summary;
}

export const documentsIntegrityJob: JobDefinition<SystemContext> = {
  name: DOCUMENTS_INTEGRITY_JOB,
  description: 'Verifies the document event chain and the stored PDFs against their hashes; alerts the admins on a problem',
  crossCompany: true,
  run: (ctx) => checkDocumentsIntegrity(ctx.db, { dryRun: ctx.dryRun, now: ctx.now, env: ctx.env }),
};

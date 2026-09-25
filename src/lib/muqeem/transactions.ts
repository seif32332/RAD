// Idempotent, audited execution of Muqeem operations (server-only).
//
// Every MUTATING Muqeem call must go through runMuqeemTransaction():
//
//   const { alreadyDone, transaction, result } = await runMuqeemTransaction({
//     operation: 'EXIT_REENTRY_ISSUE',
//     idempotencyKey: muqeemIdempotencyKey('EXIT_REENTRY_ISSUE', 'visa', visa.id),
//     companyId, employeeId, entity: { type: 'VISA', id: visa.id },
//     user, ipAddress: getClientIp(req),
//     requestSummary: { iqamaLast4: iqama.slice(-4), visaType: 1, visaDuration: 60 },
//     execute: (client) => client.issueExitReentry({ iqamaNumber: iqama, visaType: 1, visaDuration: 60 }),
//     extractRef: (r) => r.visaNumber,
//     extractPdf: (r) => r.ervisaPDF ?? null,
//   });
//
// Rules (MuqeemTransaction.idempotencyKey is unique):
//   - no row          -> insert PENDING, call Muqeem;
//   - SUCCEEDED row   -> return { alreadyDone: true } WITHOUT calling Muqeem;
//   - PENDING/UNKNOWN -> 409: a previous identical request has an undetermined outcome; it must be
//                        reconciled (reconcileTransaction) after checking Muqeem's interactive services
//                        report. Never retried automatically: that could issue a second visa / fee.
//                        (A PENDING row younger than IN_FLIGHT_MS answers "in progress now", inProgress: true.)
//   - FAILED row      -> the same row is reused (reset to PENDING, with THIS request's summary) and
//                        Muqeem is called again.
// Key the operation on the BASE state it changes (e.g. employee + current iqama expiry), never on the
// requested new value: two different requests on the same base must collide on the unique key, or
// both would reach Muqeem (two fees). The caller compares the stored requestSummary with its own
// request when it gets { alreadyDone: true }.
// Outcomes: success -> SUCCEEDED (+ externalRef, redacted responseSummary, PDF saved as an IDENTITY
// UploadedFile); REJECTED / AUTH / UNAVAILABLE / NOT_* -> FAILED; UNKNOWN_OUTCOME -> UNKNOWN.
// Passwords and tokens are never stored: summaries go through redact() and long strings are dropped.
import 'server-only';
import path from 'path';
import { unlink } from 'fs/promises';
import type { MuqeemTransaction } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { logAudit, redact } from '@/lib/audit';
import { HttpError, badRequest, conflict, forbidden, notFound } from '@/lib/http';
import { getUploadDir, matchesSignature, registryMimeType, saveUpload } from '@/lib/storage';
import { createMuqeemClient, type MuqeemClient } from './client';
import { MuqeemError, redactSecrets } from './errors';
import { IN_FLIGHT_MESSAGE, isInFlightPending } from './tx-rules';

export const MUQEEM_TX_STATUS = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  /** The call may have been executed (timeout / reset after sending): reconcile before retrying. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type MuqeemTxStatus = (typeof MUQEEM_TX_STATUS)[keyof typeof MUQEEM_TX_STATUS];

/** MuqeemTransaction.operation values (one per mutating Muqeem service). */
export const MUQEEM_OPERATIONS = [
  'EXIT_REENTRY_ISSUE',
  'EXIT_REENTRY_EXTEND',
  'EXIT_REENTRY_CANCEL',
  'EXIT_REENTRY_REPRINT',
  'FINAL_EXIT_ISSUE',
  'FINAL_EXIT_CANCEL',
  'FINAL_EXIT_PROBATION_ISSUE',
  'IQAMA_RENEW',
  'IQAMA_ISSUE',
  'IQAMA_TRANSFER',
  'IQAMA_REPLACEMENT',
  'IQAMA_REPORT_MISSING',
  'RESIDENT_DROP',
  'PASSPORT_RENEW',
  'PASSPORT_EXTEND',
  'OCCUPATION_CHANGE',
  'TRANSLATED_NAME_UPDATE',
  'VISIT_VISA_EXTEND',
] as const;
export type MuqeemOperation = (typeof MUQEEM_OPERATIONS)[number];

/** Business entity a transaction acts on (MuqeemTransaction.entityType / entityId). */
export interface MuqeemEntityRef {
  /** e.g. 'VISA', 'EMPLOYEE', 'SETTLEMENT'. */
  type: string;
  id: string;
}

export interface RunMuqeemTransactionInput<T> {
  operation: MuqeemOperation;
  /** Unique per business action, e.g. muqeemIdempotencyKey('EXIT_REENTRY_ISSUE', 'visa', visaId). */
  idempotencyKey: string;
  companyId: string;
  employeeId?: string | null;
  entity?: MuqeemEntityRef | null;
  user: AuthUser;
  ipAddress?: string | null;
  /** What is being asked, ALREADY minimized/redacted by the caller (no passwords/tokens). Stored as JSON. */
  requestSummary: Record<string, unknown>;
  /** Performs the Muqeem call(s). Only called when the transaction was claimed. */
  execute: (client: MuqeemClient) => Promise<T>;
  /** External reference to store (visa number, iqama version...). */
  extractRef?: (result: T) => string | null | undefined;
  /** Base64 PDF returned by Muqeem (e.g. ervisaPDF), saved as an IDENTITY document of the employee. */
  extractPdf?: (result: T) => string | null | undefined;
}

export type RunMuqeemTransactionResult<T> =
  | { alreadyDone: true; transaction: MuqeemTransaction; result: null }
  | { alreadyDone: false; transaction: MuqeemTransaction; result: T };

/** PENDING rows older than this can be reconciled (the process that owned them is gone). */
export const STALE_PENDING_MS = 10 * 60_000;
const MAX_KEY_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 8_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Keys never written to request/response summaries (in addition to audit.ts' list). */
const EXTRA_SECRET_KEYS = new Set(['id_token', 'idtoken', 'authorization', 'app-key', 'appkey', 'app_key', 'x-integrator-id', 'integratorid']);
/** Keys whose (large) values are replaced by a placeholder. */
const BLOB_KEYS = new Set(['ervisapdf', 'pdf', 'file', 'document', 'content64']);

/**
 * Passport number fields (passportNumber, newPassportNumber, passport_number, passportNo...): only
 * their last 4 characters are stored, like the iqama in request summaries (Muqeem's responses echo
 * the resident's passport, e.g. the exit/re-entry extension).
 */
const PASSPORT_KEY_RE = /passport_?(number|no)$/i;

function maskDocumentNumber(value: string): string {
  const v = value.trim();
  return v.length > 4 ? `…${v.slice(-4)}` : v;
}

/** Stable idempotency key: 'OPERATION:part1:part2' (parts trimmed; empty parts rejected). */
export function muqeemIdempotencyKey(operation: MuqeemOperation, ...parts: (string | number)[]): string {
  const clean = parts.map((p) => String(p).trim());
  if (!clean.length || clean.some((p) => !p)) throw badRequest('مفتاح عدم التكرار غير صالح');
  const key = [operation, ...clean].join(':');
  if (key.length > MAX_KEY_LENGTH) throw badRequest('مفتاح عدم التكرار طويل جداً');
  return key;
}

/** JSON summary without secrets or blobs (strings > 500 chars are elided), capped at 8 000 chars. */
export function summarizeForStorage(value: unknown): string | null {
  if (value === undefined) return null;
  const strip = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > 500 ? `[${v.length} chars omitted]` : v;
    if (depth > 5 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => strip(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (EXTRA_SECRET_KEYS.has(lk)) out[k] = '[REDACTED]';
      else if (BLOB_KEYS.has(lk) && typeof val === 'string') out[k] = val ? `[${val.length} chars omitted]` : '';
      else if (PASSPORT_KEY_RE.test(k) && (typeof val === 'string' || typeof val === 'number')) out[k] = maskDocumentNumber(String(val));
      else out[k] = strip(val, depth + 1);
    }
    return out;
  };
  let json = JSON.stringify(redact(strip(value, 0))) ?? 'null';
  json = redactSecrets(json);
  return json.length > MAX_SUMMARY_LENGTH ? `${json.slice(0, MAX_SUMMARY_LENGTH)}…` : json;
}

function undeterminedConflict(row: Pick<MuqeemTransaction, 'id' | 'status' | 'createdAt'>): HttpError {
  // A PENDING row created moments ago is the same request still running (double click, two tabs,
  // two operators): say so plainly. Still a blocking 409.
  if (isInFlightPending(row)) {
    return conflict(IN_FLIGHT_MESSAGE, { muqeemTransactionId: row.id, status: row.status, createdAt: row.createdAt, inProgress: true });
  }
  return conflict(
    'يوجد طلب مطابق سابق على منصة مقيم لم تُحسم نتيجته بعد (قد يكون قيد التنفيذ أو انقطع الاتصال أثناءه). ' +
      'لا تُعِد المحاولة: تحقق أولاً من تقرير الخدمات التفاعلية في مقيم، ثم قم بتسوية العملية (نجحت / فشلت) قبل إعادة الطلب.',
    { muqeemTransactionId: row.id, status: row.status, createdAt: row.createdAt },
  );
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

type Decision = { kind: 'done'; row: MuqeemTransaction } | { kind: 'retry-failed'; row: MuqeemTransaction };

/** What to do with an existing row for the same key. Throws for PENDING/UNKNOWN and mismatches. */
function decideExisting(row: MuqeemTransaction, operation: string, companyId: string): Decision {
  if (row.operation !== operation || (row.companyId ?? null) !== companyId) {
    throw conflict('مفتاح عدم التكرار مستخدم لعملية أخرى على مقيم', { muqeemTransactionId: row.id });
  }
  if (row.status === MUQEEM_TX_STATUS.SUCCEEDED) return { kind: 'done', row };
  if (row.status === MUQEEM_TX_STATUS.FAILED) return { kind: 'retry-failed', row };
  throw undeterminedConflict(row);
}

interface PdfContext {
  operation: string;
  externalRef: string | null;
  employeeId: string | null;
  userId: string;
}

/** Saves a base64 PDF as a registered UploadedFile (category IDENTITY). Returns its /api/files URL. */
async function storePdf(base64: string, ctx: PdfContext): Promise<string> {
  const clean = base64.replace(/^data:application\/pdf;base64,/i, '').replace(/\s+/g, '');
  const data = new Uint8Array(Buffer.from(clean, 'base64'));
  if (!data.byteLength) throw new Error('empty PDF');
  if (data.byteLength > MAX_PDF_BYTES) throw new Error('PDF too large');
  if (!matchesSignature('pdf', data)) throw new Error('returned document is not a PDF');
  const { storedName, url } = await saveUpload(data, 'pdf');
  const ref = (ctx.externalRef ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  try {
    await prisma.uploadedFile.create({
      data: {
        storedName,
        originalName: `muqeem-${ctx.operation.toLowerCase()}${ref ? `-${ref}` : ''}.pdf`,
        mimeType: registryMimeType(storedName),
        size: data.byteLength,
        isPublic: false,
        uploadedById: ctx.userId,
        employeeId: ctx.employeeId,
        category: 'IDENTITY',
      },
    });
  } catch (err) {
    await unlink(path.join(getUploadDir(), storedName)).catch(() => undefined);
    throw err;
  }
  return url;
}

/**
 * Runs one mutating Muqeem operation exactly once per idempotencyKey (see the file header).
 * Throws: HttpError 409 (undetermined previous attempt / key reused), MuqeemError (NOT_CONFIGURED,
 * NOT_LINKED: nothing recorded; REJECTED/AUTH/UNAVAILABLE: row FAILED; UNKNOWN_OUTCOME: row UNKNOWN),
 * or whatever `execute` throws (row FAILED if nothing was sent to Muqeem, else UNKNOWN).
 */
export async function runMuqeemTransaction<T>(input: RunMuqeemTransactionInput<T>): Promise<RunMuqeemTransactionResult<T>> {
  const key = input.idempotencyKey?.trim();
  if (!key || key.length > MAX_KEY_LENGTH) throw badRequest('مفتاح عدم التكرار غير صالح');

  // 1. Replay / conflict check before touching Muqeem or its credentials.
  const existing = await prisma.muqeemTransaction.findUnique({ where: { idempotencyKey: key } });
  let retryRow: MuqeemTransaction | null = null;
  if (existing) {
    const d = decideExisting(existing, input.operation, input.companyId);
    if (d.kind === 'done') return { alreadyDone: true, transaction: d.row, result: null };
    retryRow = d.row;
  }

  // 2. Configuration / link errors surface here, before any row is written.
  const client = await createMuqeemClient({ companyId: input.companyId });

  // 3. Claim the key (insert PENDING, or flip our FAILED row back to PENDING atomically).
  const requestSummary = summarizeForStorage(input.requestSummary);
  const claimData = {
    status: MUQEEM_TX_STATUS.PENDING,
    employeeId: input.employeeId ?? null,
    entityType: input.entity?.type ?? null,
    entityId: input.entity?.id ?? null,
    requestSummary,
    requestedById: input.user.id,
    externalRef: null,
    httpStatus: null,
    errorMessage: null,
    responseSummary: null,
    documentUrl: null,
    completedAt: null,
    // Reset on a retry too: the stale-PENDING rule of reconcileTransaction() measures from here.
    createdAt: new Date(),
  };

  let tx: MuqeemTransaction | null = null;
  for (let attempt = 0; attempt < 3 && !tx; attempt++) {
    if (retryRow) {
      const claimed = await prisma.muqeemTransaction.updateMany({
        where: { id: retryRow.id, status: MUQEEM_TX_STATUS.FAILED },
        data: claimData,
      });
      if (claimed.count === 1) {
        tx = await prisma.muqeemTransaction.findUnique({ where: { id: retryRow.id } });
        break;
      }
    } else {
      try {
        tx = await prisma.muqeemTransaction.create({
          data: { ...claimData, idempotencyKey: key, operation: input.operation, companyId: input.companyId },
        });
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    // Lost a race: look at the row again.
    const row = await prisma.muqeemTransaction.findUnique({ where: { idempotencyKey: key } });
    if (!row) continue;
    const d = decideExisting(row, input.operation, input.companyId);
    if (d.kind === 'done') return { alreadyDone: true, transaction: d.row, result: null };
    retryRow = d.row;
  }
  if (!tx) throw conflict('تعذر حجز العملية بسبب طلب متزامن، أعد تحميل الصفحة وحاول مجدداً');

  // 4. Call Muqeem.
  let result: T;
  try {
    result = await input.execute(client);
  } catch (err) {
    await recordFailure(tx, err, client.mutationsSent, input);
    throw err;
  }

  // 5. Success: reference, PDF, summary.
  const externalRef = safeString(input.extractRef?.(result));
  let documentUrl: string | null = null;
  let pdfError: string | null = null;
  const pdf = safeString(input.extractPdf?.(result), Number.MAX_SAFE_INTEGER);
  if (pdf) {
    try {
      documentUrl = await storePdf(pdf, { operation: input.operation, externalRef, employeeId: input.employeeId ?? null, userId: input.user.id });
    } catch (err) {
      // The operation WAS executed: never turn this into a failure; keep the reason for HR.
      pdfError = err instanceof Error ? err.message : 'pdf error';
      console.error(`[muqeem] ${input.operation}: could not store the returned PDF:`, pdfError);
    }
  }

  const responseSummary = summarizeForStorage(pdfError ? { response: result, pdfError } : result);
  let done: MuqeemTransaction;
  try {
    done = await prisma.muqeemTransaction.update({
      where: { id: tx.id },
      data: {
        status: MUQEEM_TX_STATUS.SUCCEEDED,
        externalRef,
        httpStatus: 200,
        responseSummary,
        documentUrl,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    // Executed on Muqeem but not recorded: the row stays PENDING, so any retry is blocked until
    // it is reconciled. Tell the user the truth.
    console.error(`[muqeem] ${input.operation}: executed but the result could not be saved:`, err);
    throw new HttpError(
      500,
      `تم تنفيذ العملية في مقيم${externalRef ? ` (المرجع: ${externalRef})` : ''} لكن تعذر حفظ نتيجتها في النظام. لا تُعِد الطلب؛ قم بتسوية العملية يدوياً.`,
      { muqeemTransactionId: tx.id, externalRef },
    );
  }

  await logAudit({
    userId: input.user.id,
    action: 'UPDATE',
    entityType: 'MuqeemTransaction',
    entityId: done.id,
    details: {
      muqeemOperation: input.operation,
      status: done.status,
      companyId: input.companyId,
      employeeId: input.employeeId ?? null,
      entityType: done.entityType,
      entityId: done.entityId,
      externalRef,
      document: documentUrl ? 'saved' : pdf ? 'save-failed' : 'none',
    },
    ipAddress: input.ipAddress ?? null,
  });

  return { alreadyDone: false, transaction: done, result };
}

function safeString(v: unknown, max = 200): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

async function recordFailure<T>(tx: MuqeemTransaction, err: unknown, mutationsSent: number, input: RunMuqeemTransactionInput<T>): Promise<void> {
  let status: MuqeemTxStatus;
  let message: string;
  let httpStatus: number | null = null;
  let errorKind: string;
  if (err instanceof MuqeemError) {
    status = err.kind === 'UNKNOWN_OUTCOME' ? MUQEEM_TX_STATUS.UNKNOWN : MUQEEM_TX_STATUS.FAILED;
    message = err.upstreamMessage ? `${err.kind}: ${err.upstreamMessage}` : `${err.kind}: ${err.message}`;
    httpStatus = err.upstreamStatus;
    errorKind = err.kind;
  } else {
    // Not a classified Muqeem failure (validation, bug...). If a mutating request already left, we
    // cannot know whether Muqeem executed it.
    status = mutationsSent > 0 ? MUQEEM_TX_STATUS.UNKNOWN : MUQEEM_TX_STATUS.FAILED;
    message = err instanceof HttpError ? err.message : 'خطأ داخلي أثناء تنفيذ العملية';
    errorKind = err instanceof HttpError ? `HTTP_${err.status}` : 'INTERNAL';
    if (!(err instanceof HttpError)) console.error(`[muqeem] ${input.operation}: unexpected error`, err);
  }
  message = redactSecrets(message).slice(0, 2000);
  try {
    await prisma.muqeemTransaction.update({
      where: { id: tx.id },
      data: { status, errorMessage: message, httpStatus, completedAt: new Date() },
    });
  } catch (dbErr) {
    // The row stays PENDING (blocks retries until reconciled): safe default.
    console.error(`[muqeem] ${input.operation}: could not record the failure:`, dbErr);
  }
  await logAudit({
    userId: input.user.id,
    action: 'UPDATE',
    entityType: 'MuqeemTransaction',
    entityId: tx.id,
    details: {
      muqeemOperation: input.operation,
      status,
      errorKind,
      companyId: input.companyId,
      employeeId: input.employeeId ?? null,
      entityType: input.entity?.type ?? null,
      entityId: input.entity?.id ?? null,
    },
    ipAddress: input.ipAddress ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reconciliation of undetermined outcomes
// ---------------------------------------------------------------------------

/** HR's verdict after checking Muqeem (interactive services report / Muqeem portal). */
export type MuqeemReconcileOutcome =
  | {
      status: 'SUCCEEDED';
      externalRef?: string | null;
      note?: string | null;
      /** What the operator read on Muqeem (e.g. { newIqamaExpiryDate }); kept in responseSummary.reconciliation.details. */
      details?: Record<string, unknown> | null;
    }
  | { status: 'FAILED'; note?: string | null };

/**
 * Marks an UNKNOWN transaction (or a PENDING one older than STALE_PENDING_MS) as SUCCEEDED (with the
 * reference found on Muqeem) or FAILED (a new attempt with the same key becomes possible).
 * Restricted to ROLE_GROUPS.GOV. Audited. Side effects on business records (e.g. updating the Visa)
 * are the calling feature's job.
 */
export async function reconcileTransaction(
  id: string,
  outcome: MuqeemReconcileOutcome,
  user: AuthUser,
  ipAddress?: string | null,
): Promise<MuqeemTransaction> {
  if (!(ROLE_GROUPS.GOV as readonly string[]).includes(user.role)) throw forbidden();
  if (outcome.status !== 'SUCCEEDED' && outcome.status !== 'FAILED') throw badRequest('نتيجة التسوية غير صالحة');

  const row = await prisma.muqeemTransaction.findUnique({ where: { id } });
  if (!row) throw notFound('عملية مقيم غير موجودة');
  const stalePending = row.status === MUQEEM_TX_STATUS.PENDING && Date.now() - row.createdAt.getTime() > STALE_PENDING_MS;
  if (row.status !== MUQEEM_TX_STATUS.UNKNOWN && !stalePending) {
    throw conflict(
      row.status === MUQEEM_TX_STATUS.PENDING
        ? 'العملية ما زالت قيد التنفيذ، انتظر بضع دقائق قبل تسويتها'
        : 'لا يمكن تسوية إلا العمليات غير محسومة النتيجة',
      { status: row.status },
    );
  }

  const note = safeString(outcome.note, 1000);
  const externalRef = outcome.status === 'SUCCEEDED' ? (safeString(outcome.externalRef) ?? row.externalRef) : row.externalRef;
  const details = outcome.status === 'SUCCEEDED' && outcome.details ? outcome.details : null;
  const reconciliation = { previousStatus: row.status, by: user.id, at: new Date().toISOString(), note, ...(details ? { details } : {}) };
  let previous: unknown = null;
  try {
    previous = row.responseSummary ? JSON.parse(row.responseSummary) : null;
  } catch {
    previous = row.responseSummary;
  }

  const updated = await prisma.muqeemTransaction.updateMany({
    where: { id, status: row.status },
    data: {
      status: outcome.status,
      externalRef,
      // FAILED: the reconcile note (displayed through displayMuqeemError / describeTxError).
      // SUCCEEDED: the old UNKNOWN_OUTCOME / timeout message no longer describes the row.
      errorMessage: outcome.status === 'FAILED' ? `RECONCILED_FAILED${note ? `: ${note}` : ''}` : null,
      responseSummary: summarizeForStorage({ reconciliation, previous }),
      completedAt: new Date(),
    },
  });
  if (updated.count !== 1) throw conflict('تغيرت حالة العملية أثناء التسوية، أعد تحميل الصفحة');

  const fresh = await prisma.muqeemTransaction.findUnique({ where: { id } });
  if (!fresh) throw notFound('عملية مقيم غير موجودة');

  await logAudit({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'MuqeemTransaction',
    entityId: id,
    details: {
      muqeemOperation: row.operation,
      status: outcome.status,
      reconciled: true,
      previousStatus: row.status,
      externalRef,
      employeeId: row.employeeId,
      entityType: row.entityType,
      entityId: row.entityId,
    },
    ipAddress: ipAddress ?? null,
  });
  return fresh;
}

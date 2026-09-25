// Muqeem (مقيم) services for one employee: iqama renewal, passport updates, reconciliation.
//
// GET  -> integration / link status, eligibility and the employee's recent Muqeem transactions.
// POST -> { action: 'RENEW_IQAMA' | 'RENEW_PASSPORT' | 'EXTEND_PASSPORT' | 'RECONCILE', confirmed: true, ... }
//
// Safety rules (docs/integrations/muqeem/README.md §5):
//   - GOV operators only (ROLE_GROUPS.GOV). The account used is the one of the employee's LEGAL
//     company (the sponsor); Saudi employees are not residents and are refused.
//   - every mutating call goes through runMuqeemTransaction with a deterministic key built on the
//     BASE state (employee + current expiry / passport, never the requested duration or date), so a
//     double click, a retry or two operators sending different values at once never reach Muqeem
//     twice; the client also sends what it displayed (current expiry / passport) and a stale
//     request is answered from the stored result (saying so when it asked for other values).
//   - passport numbers are stored masked (last 4) in MuqeemTransaction.requestSummary; settling a
//     new-passport update as executed requires re-entering the new number (last 4 must match).
//   - a PENDING / UNKNOWN transaction for the same document blocks any new call (and the manual
//     renewal of that document) until it is reconciled here (action RECONCILE).
//
// Payment rule for the iqama renewal (decision): the manual renewals queue does not require a
// payment request (it is optional), but while one is open (PENDING_OWNER / PENDING_FINANCE) the
// document cannot be renewed from the queue. The Muqeem renewal keeps exactly that rule: it is
// refused while a fee request for the iqama is unpaid, and allowed otherwise. On success it writes
// the same trail as the manual renewal: RenewalArchive RENEWED, PAID requests -> COMPLETED,
// PENDING_PAYMENT markers removed, audit 'CREATE RenewalArchive'.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { MuqeemTransaction, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { dateKey, todayKey } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import {
  IN_FLIGHT_MESSAGE,
  IQAMA_DURATIONS_MONTHS,
  MuqeemError,
  isInFlightPending,
  STALE_PENDING_MS,
  muqeemConfig,
  muqeemIdempotencyKey,
  parseMuqeemGregorian,
  reconcileTransaction,
  runMuqeemTransaction,
  toApiError,
  type IqamaDurationMonths,
  type RunMuqeemTransactionInput,
  type RunMuqeemTransactionResult,
} from '@/lib/muqeem';
import {
  MUQEEM_OPERATION_LABELS,
  MUQEEM_TX_STATUS_LABELS,
  OPERATION_GROUPS,
  PASSPORT_NUMBER_RE,
  differentRequestNotice,
  displayMuqeemError,
  docLast4,
  ltr,
  recordStateSentence,
  summaryPassportLast4,
  iqamaExpiryFromResponseSummary,
  muqeemResultMessage,
  iqamaRenewKeyParts,
  isDateKey,
  isEmployeeMuqeemOperation,
  isIqamaDuration,
  isUnresolvedStatus,
  muqeemEligibility,
  parseStoredSummary,
  passportExtendKeyParts,
  passportRenewKeyParts,
  passportsEqual,
  summaryString,
  unpaidRenewalBlock,
  validatePassportExtend,
  validatePassportRenew,
  UNPAID_RENEWAL_PAYMENT_STATUSES,
  type ApplyState,
  type EmployeeMuqeemOperation,
} from './logic';
import {
  UNRESOLVED_MUQEEM_MESSAGE,
  closeRenewalPaymentMarkers,
  findUnresolvedMuqeemTransaction,
  lockRenewalDocument,
} from './renewal-record';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const EMPLOYEE_SELECT = {
  id: true,
  firstNameArabic: true,
  lastNameArabic: true,
  nationality: true,
  iqamaOrIdNumber: true,
  iqamaOrIdExp: true,
  passportNumber: true,
  passportExp: true,
  isTerminated: true,
  legalCompanyId: true,
  legalCompany: { select: { id: true, nameArabic: true, moiNumber: true, muqeemPlatformId: true } },
} satisfies Prisma.EmployeeSelect;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

const RECENT_TRANSACTIONS = 20;

/** Same as reconcileTransaction() and every other Muqeem reconcile path (visas, settlements, generic). */
const RECONCILE_ROLES = ROLE_GROUPS.GOV;

async function loadEmployee(id: string): Promise<EmployeeRow> {
  const employee = await prisma.employee.findUnique({ where: { id }, select: EMPLOYEE_SELECT });
  if (!employee) throw notFound('الموظف غير موجود');
  return employee;
}

const fullName = (e: Pick<EmployeeRow, 'firstNameArabic' | 'lastNameArabic'>) => `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim();

function eligibilityOf(employee: EmployeeRow) {
  return muqeemEligibility({
    nationality: employee.nationality,
    iqamaOrIdNumber: employee.iqamaOrIdNumber,
    legalCompany: employee.legalCompany,
    integrationUsable: muqeemConfig().usable,
  });
}

/** Throws the right error when Muqeem cannot be used for this employee. Returns the company id. */
function assertEligible(employee: EmployeeRow): string {
  const e = eligibilityOf(employee);
  if (e.eligible && employee.legalCompanyId) return employee.legalCompanyId;
  const message = e.message ?? 'لا يمكن استخدام منصة مقيم لهذا الموظف';
  switch (e.reason) {
    case 'NO_LEGAL_COMPANY':
    case 'NOT_LINKED':
      throw new HttpError(409, message, { muqeemKind: 'NOT_LINKED', code: e.reason });
    case 'NOT_CONFIGURED':
      throw new MuqeemError('NOT_CONFIGURED').toHttpError();
    default:
      throw badRequest(message, { code: e.reason });
  }
}

/** 409 when a Muqeem transaction on the same document(s) has an undetermined outcome. */
async function assertNoUnresolved(employeeId: string, operation: EmployeeMuqeemOperation): Promise<void> {
  const row = await findUnresolvedMuqeemTransaction(prisma, employeeId, OPERATION_GROUPS[operation]);
  if (row && isInFlightPending(row)) {
    // Created moments ago: the same request is running right now (double click / two operators).
    throw conflict(IN_FLIGHT_MESSAGE, {
      code: 'MUQEEM_UNRESOLVED',
      inProgress: true,
      muqeemTransactionId: row.id,
      operation: row.operation,
      status: row.status,
      createdAt: row.createdAt,
    });
  }
  if (row) {
    throw conflict(UNRESOLVED_MUQEEM_MESSAGE, {
      code: 'MUQEEM_UNRESOLVED',
      muqeemTransactionId: row.id,
      operation: row.operation,
      status: row.status,
      createdAt: row.createdAt,
    });
  }
}

/** runMuqeemTransaction, with the transaction id added to Muqeem errors (for the UNKNOWN banner). */
async function runGuarded<T>(input: RunMuqeemTransactionInput<T>): Promise<RunMuqeemTransactionResult<T>> {
  try {
    return await runMuqeemTransaction(input);
  } catch (err) {
    if (err instanceof MuqeemError && err.kind !== 'NOT_CONFIGURED' && err.kind !== 'NOT_LINKED') {
      const row = await prisma.muqeemTransaction
        .findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, status: true } })
        .catch(() => null);
      throw new HttpError(err.status, err.message, {
        muqeemKind: err.kind,
        upstreamStatus: err.upstreamStatus,
        outcomeUnknown: err.outcomeUnknown,
        muqeemTransactionId: row?.id ?? null,
        status: row?.status ?? null,
      });
    }
    throw toApiError(err);
  }
}

/** Existing transaction for a key (used to answer a stale / repeated request without calling Muqeem). */
function findByKey(idempotencyKey: string): Promise<MuqeemTransaction | null> {
  return prisma.muqeemTransaction.findUnique({ where: { idempotencyKey } });
}

// ---------------------------------------------------------------------------
// Applying the result to the employee (same trail as the manual renewal)
// ---------------------------------------------------------------------------

interface ApplyInput {
  employeeId: string;
  documentType: 'IQAMA' | 'PASSPORT';
  /** True when the row still holds what the Muqeem request was based on (else nothing is written). */
  guard: (row: { iqamaOrIdExp: Date; passportNumber: string | null; passportExp: Date | null }) => boolean;
  data: Prisma.EmployeeUpdateInput;
  oldExp: (row: { iqamaOrIdExp: Date; passportExp: Date | null }) => Date | null;
  newExp: Date;
  notes: string;
  attachmentUrl: string | null;
  user: AuthUser;
  ipAddress: string;
  auditExtra: Record<string, unknown>;
}

/** Writes the result in one DB transaction (see ApplyState for the outcomes). */
async function applyEmployeeRenewal(p: ApplyInput): Promise<ApplyState> {
  const result = await prisma.$transaction(async (tx) => {
    await lockRenewalDocument(tx, p.employeeId, p.documentType);
    const row = await tx.employee.findUnique({
      where: { id: p.employeeId },
      select: { iqamaOrIdExp: true, passportNumber: true, passportExp: true },
    });
    if (!row) throw notFound('الموظف غير موجود');
    if (!p.guard(row)) {
      // A concurrent identical request (double click answered from the stored result) may already
      // have written exactly this result: the record is up to date, nothing more to write.
      const newPassport = typeof p.data.passportNumber === 'string' ? p.data.passportNumber : null;
      const alreadyThere =
        p.documentType === 'IQAMA'
          ? dateKey(row.iqamaOrIdExp) === dateKey(p.newExp)
          : dateKey(row.passportExp) === dateKey(p.newExp) && (!newPassport || passportsEqual(row.passportNumber, newPassport));
      return { state: (alreadyThere ? 'already' : 'changed') as ApplyState, archiveId: null as string | null, oldExp: null as Date | null };
    }
    const oldExp = p.oldExp(row);
    await tx.employee.update({ where: { id: p.employeeId }, data: p.data, select: { id: true } });
    const archive = await tx.renewalArchive.create({
      data: {
        entityType: 'EMPLOYEE',
        entityId: p.employeeId,
        documentType: p.documentType,
        action: 'RENEWED',
        oldExpDate: oldExp,
        newExpDate: p.newExp,
        attachmentUrl: p.attachmentUrl,
        notes: p.notes.slice(0, 2000),
      },
      select: { id: true },
    });
    await closeRenewalPaymentMarkers(tx, p.employeeId, p.documentType);
    return { state: 'written' as ApplyState, archiveId: archive.id as string | null, oldExp };
  });

  if (result.state === 'written' && result.archiveId) {
    await logAudit({
      userId: p.user.id,
      action: 'CREATE',
      entityType: 'RenewalArchive',
      entityId: result.archiveId,
      details: {
        renewalAction: 'RENEWED',
        entityType: 'EMPLOYEE',
        entityId: p.employeeId,
        documentType: p.documentType,
        oldExpDate: dateKey(result.oldExp),
        newExpDate: dateKey(p.newExp),
        paymentRequestId: null,
        via: 'MUQEEM',
        ...p.auditExtra,
      },
      ipAddress: p.ipAddress,
    });
  }
  return result.state;
}

/** Wraps the DB update that follows an EXECUTED Muqeem operation: never report it as not done. */
async function applyAfterMuqeem(p: ApplyInput, txId: string, retryHint: string): Promise<ApplyState> {
  try {
    return await applyEmployeeRenewal(p);
  } catch (err) {
    console.error('[employees/muqeem] executed on Muqeem but the employee could not be updated:', err);
    throw new HttpError(500, `تم تنفيذ العملية في منصة مقيم لكن تعذر تحديث بيانات الموظف في النظام. ${retryHint}`, {
      muqeemTransactionId: txId,
      code: 'MUQEEM_DONE_DB_FAILED',
    });
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const canSettle = (RECONCILE_ROLES as readonly string[]).includes(user.role);
    const { id } = await params;
    const employee = await loadEmployee(id);
    const config = muqeemConfig();

    const [rows, payments] = await Promise.all([
      prisma.muqeemTransaction.findMany({
        where: { employeeId: id },
        orderBy: { createdAt: 'desc' },
        take: RECENT_TRANSACTIONS,
      }),
      prisma.paymentRequest.findMany({
        where: { entityId: id, documentType: 'IQAMA', status: { in: [...UNPAID_RENEWAL_PAYMENT_STATUSES] } },
        select: { status: true },
      }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.requestedById).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const userName = new Map(users.map((u) => [u.id, u.name || u.email]));
    const now = Date.now();

    const transactions = rows.map((r) => {
      const stalePending = r.status === 'PENDING' && now - r.createdAt.getTime() > STALE_PENDING_MS;
      return {
        id: r.id,
        operation: r.operation,
        operationLabel: MUQEEM_OPERATION_LABELS[r.operation] ?? r.operation,
        status: r.status,
        statusLabel: MUQEEM_TX_STATUS_LABELS[r.status] ?? r.status,
        unresolved: isUnresolvedStatus(r.status),
        canReconcile: canSettle && isEmployeeMuqeemOperation(r.operation) && (r.status === 'UNKNOWN' || stalePending),
        externalRef: r.externalRef,
        // Only a failure's reason is shown: an UNKNOWN row gets the reconcile guidance instead, and a
        // reconciled SUCCEEDED row keeps its old timeout message in the column.
        errorMessage: r.status === 'FAILED' ? displayMuqeemError(r.errorMessage) : null,
        reconciled: !!parseStoredSummary(r.responseSummary)?.reconciliation,
        newPassportLast4: r.operation === 'PASSPORT_RENEW' ? summaryPassportLast4(parseStoredSummary(r.requestSummary), 'newPassportNumber') : null,
        documentUrl: r.documentUrl,
        requestedBy: r.requestedById ? (userName.get(r.requestedById) ?? null) : null,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      };
    });

    const legal = employee.legalCompany;
    return NextResponse.json({
      employee: {
        id: employee.id,
        name: fullName(employee),
        isTerminated: employee.isTerminated,
        iqamaNumber: employee.iqamaOrIdNumber,
        iqamaExp: dateKey(employee.iqamaOrIdExp),
        passportNumber: employee.passportNumber,
        passportExp: dateKey(employee.passportExp),
      },
      company: legal ? { id: legal.id, name: legal.nameArabic, linked: !!legal.moiNumber?.trim() && !!legal.muqeemPlatformId } : null,
      integration: { enabled: config.enabled, usable: config.usable },
      canReconcile: canSettle,
      eligibility: eligibilityOf(employee),
      iqamaDurations: IQAMA_DURATIONS_MONTHS,
      unpaidRenewalPayment: unpaidRenewalBlock(payments.map((p) => p.status)),
      transactions,
    });
  } catch (err) {
    return handleApiError(toApiError(err), 'employees/[id]/muqeem:GET');
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const confirmed = z.literal(true, {
  errorMap: () => ({ message: 'يجب تأكيد العملية صراحةً قبل تنفيذها على منصة مقيم' }),
});
const dateText = z.string().trim().max(10);

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('RENEW_IQAMA'),
    iqamaDuration: z.coerce.string().refine(isIqamaDuration, `مدة التجديد يجب أن تكون إحدى القيم: ${IQAMA_DURATIONS_MONTHS.join('، ')} شهراً`),
    /** The iqama expiry the user saw ('YYYY-MM-DD'). */
    expectedIqamaExp: z.string().trim().refine(isDateKey, 'تاريخ انتهاء الإقامة الحالي غير صالح'),
    confirmed,
  }),
  z.object({
    action: z.literal('RENEW_PASSPORT'),
    /** The current passport number the user saw. */
    expectedPassportNumber: z.string().trim().max(50),
    /** The current passport expiry the user saw ('YYYY-MM-DD' / null). Part of the key; the stored one is used when absent. */
    expectedPassportExp: z.string().trim().max(10).nullable().optional(),
    newPassportNumber: z.string().trim().max(50),
    newPassportIssueDate: dateText,
    newPassportExpiryDate: dateText,
    newPassportIssueLocation: z.string().trim().max(200),
    confirmed,
  }),
  z.object({
    action: z.literal('EXTEND_PASSPORT'),
    expectedPassportNumber: z.string().trim().max(50),
    /** The passport expiry the user saw ('YYYY-MM-DD' or null when none was recorded). */
    expectedPassportExp: z.string().trim().max(10).nullable().optional(),
    newPassportExpiryDate: dateText,
    confirmed,
  }),
  z.object({
    action: z.literal('RECONCILE'),
    transactionId: z.string().trim().min(1).max(100),
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    externalRef: z.string().trim().max(200).nullable().optional(),
    /** Required to settle an iqama renewal as executed: the new expiry shown in Muqeem. */
    newIqamaExpiryDate: z.string().trim().max(10).nullable().optional(),
    /**
     * Required to settle a new-passport update as executed: the new passport number, re-entered by
     * the operator (only its last 4 characters are stored in the transaction; they must match).
     */
    newPassportNumber: z.string().trim().max(50).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    confirmed,
  }),
]);

type Body = z.infer<typeof bodySchema>;

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const { id } = await params;
    const body = await parseBody(req, bodySchema);
    const employee = await loadEmployee(id);
    const ip = getClientIp(req);

    let response: Record<string, unknown>;
    switch (body.action) {
      case 'RENEW_IQAMA':
        response = await renewIqama(employee, body, user, ip);
        break;
      case 'RENEW_PASSPORT':
        response = await renewPassport(employee, body, user, ip);
        break;
      case 'EXTEND_PASSPORT':
        response = await extendPassport(employee, body, user, ip);
        break;
      case 'RECONCILE':
        response = await reconcile(employee, body, user, ip);
        break;
    }
    return NextResponse.json({ success: true, ...response });
  } catch (err) {
    return handleApiError(toApiError(err), 'employees/[id]/muqeem:POST');
  }
}

// Idempotency keys are built on the BASE state (logic.ts): a request answered from an operation
// already executed on the same base (alreadyDone) may have asked for other values. Then the answer
// says so (differentRequest: true) and only the EXECUTED result is ever applied to the employee.

// ---------------------------------------------------------------------------
// RENEW_IQAMA
// ---------------------------------------------------------------------------

async function renewIqama(
  employee: EmployeeRow,
  body: Extract<Body, { action: 'RENEW_IQAMA' }>,
  user: AuthUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const companyId = assertEligible(employee);
  const duration = body.iqamaDuration as IqamaDurationMonths;
  const expected = body.expectedIqamaExp;
  const key = muqeemIdempotencyKey('IQAMA_RENEW', ...iqamaRenewKeyParts(employee.id, expected));

  // A stale page (the date changed since it was shown): answer from the stored result, never call again.
  if (dateKey(employee.iqamaOrIdExp) !== expected) {
    const prev = await findByKey(key);
    if (prev?.status === 'SUCCEEDED') {
      const current = dateKey(employee.iqamaOrIdExp);
      const notice = differentRequestNotice('IQAMA_RENEW', parseStoredSummary(prev.requestSummary), { iqamaDuration: duration });
      return {
        alreadyDone: true,
        applied: false,
        differentRequest: !!notice,
        muqeemTransactionId: prev.id,
        externalRef: prev.externalRef,
        newExpiryDate: current,
        message: `${notice ?? 'سبق تنفيذ هذا التجديد في منصة مقيم؛ لم يُرسل طلب جديد.'} تاريخ انتهاء الإقامة المسجل في النظام الآن ${current ? ltr(current) : 'غير محدد'}.`,
      };
    }
    throw conflict('تغيّر تاريخ انتهاء الإقامة منذ فتح الصفحة. حدّث الصفحة وتحقق من التاريخ قبل التجديد.', { code: 'STALE_EXPIRY' });
  }

  await assertNoUnresolved(employee.id, 'IQAMA_RENEW');

  const payments = await prisma.paymentRequest.findMany({
    where: { entityId: employee.id, documentType: 'IQAMA', status: { in: [...UNPAID_RENEWAL_PAYMENT_STATUSES] } },
    select: { status: true },
  });
  const unpaid = unpaidRenewalBlock(payments.map((p) => p.status));
  if (unpaid) throw conflict(unpaid, { code: 'RENEWAL_FEE_UNPAID' });

  const iqama = employee.iqamaOrIdNumber;
  const run = await runGuarded({
    operation: 'IQAMA_RENEW',
    idempotencyKey: key,
    companyId,
    employeeId: employee.id,
    entity: { type: 'EMPLOYEE', id: employee.id },
    user,
    ipAddress: ip,
    requestSummary: { iqamaLast4: iqama.slice(-4), iqamaDuration: duration, currentIqamaExpiry: expected },
    execute: (client) => client.renewIqama({ iqamaNumber: iqama, iqamaDuration: duration }),
    extractRef: (r) => r?.versionNumber,
  });

  const stored = parseStoredSummary(run.transaction.requestSummary);
  const notice = run.alreadyDone ? differentRequestNotice('IQAMA_RENEW', stored, { iqamaDuration: duration }) : null;
  // The duration actually executed on Muqeem (the stored one when this request was answered from it).
  const executedDuration = run.alreadyDone ? (summaryString(stored, 'iqamaDuration') ?? duration) : duration;

  const newKey = run.alreadyDone
    ? iqamaExpiryFromResponseSummary(run.transaction.responseSummary)
    : (() => {
        const d = parseMuqeemGregorian(run.result?.newIqamaExpiryDateGre);
        return d ? dateKey(d) : null;
      })();

  const base = {
    alreadyDone: run.alreadyDone,
    differentRequest: !!notice,
    muqeemTransactionId: run.transaction.id,
    externalRef: run.transaction.externalRef,
  };
  if (!newKey) {
    return {
      ...base,
      applied: false,
      newExpiryDate: null,
      message: notice
        ? `${notice} ${recordStateSentence('IQAMA_RENEW', null, null)}`
        : run.alreadyDone
          ? 'سبق تسجيل هذا التجديد كمنفذ في مقيم، لكن لا يتوفر تاريخ الانتهاء الجديد في النظام. أدخل التاريخ الموجود في مقيم يدوياً من شاشة التجديدات.'
          : 'تم التجديد في منصة مقيم لكنها لم تُرجع تاريخ انتهاء صالحاً. أدخل التاريخ الموجود في مقيم يدوياً من شاشة التجديدات، ولا تُعِد التجديد.',
    };
  }

  // Record still on the base expiry (e.g. the row was settled elsewhere): the EXECUTED result is written.
  const newExp = new Date(`${newKey}T00:00:00.000Z`);
  const state = await applyAfterMuqeem(
    {
      employeeId: employee.id,
      documentType: 'IQAMA',
      guard: (row) => dateKey(row.iqamaOrIdExp) === expected,
      data: { iqamaOrIdExp: newExp },
      oldExp: (row) => row.iqamaOrIdExp,
      newExp,
      notes: `تجديد عبر منصة مقيم لمدة ${executedDuration} شهراً${run.transaction.externalRef ? ` (رقم نسخة الإقامة ${run.transaction.externalRef})` : ''} — معاملة مقيم ${run.transaction.id}`,
      attachmentUrl: run.transaction.documentUrl,
      user,
      ipAddress: ip,
      auditExtra: { muqeemTransactionId: run.transaction.id, iqamaDuration: executedDuration, alreadyDone: run.alreadyDone },
    },
    run.transaction.id,
    'أعد الطلب نفسه (بنفس المدة) لإكمال التحديث: لن يُرسل إلى مقيم مرة أخرى.',
  );

  return {
    ...base,
    applied: state !== 'changed',
    newExpiryDate: newKey,
    message: notice ? `${notice} ${recordStateSentence('IQAMA_RENEW', state, newKey)}` : muqeemResultMessage('IQAMA_RENEW', state, run.alreadyDone, newKey),
  };
}

// ---------------------------------------------------------------------------
// RENEW_PASSPORT (new passport)
// ---------------------------------------------------------------------------

async function renewPassport(
  employee: EmployeeRow,
  body: Extract<Body, { action: 'RENEW_PASSPORT' }>,
  user: AuthUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const companyId = assertEligible(employee);
  const expected = body.expectedPassportNumber;
  const newNumber = body.newPassportNumber.toUpperCase();
  if (!expected) throw badRequest('لا يوجد رقم جواز حالي مسجل للموظف، ومقيم يشترطه لتحديث الجواز. أدخله أولاً من تعديل بيانات الموظف.');
  const currentExp = dateKey(employee.passportExp);
  // Base expiry: the one the user saw (a client that does not send it: the recorded one).
  const baseExp = body.expectedPassportExp !== undefined ? body.expectedPassportExp || null : currentExp;
  const key = muqeemIdempotencyKey('PASSPORT_RENEW', ...passportRenewKeyParts(employee.id, expected, baseExp));
  const requested = {
    newPassportNumber: newNumber,
    newPassportIssueDate: body.newPassportIssueDate,
    newPassportExpiryDate: body.newPassportExpiryDate,
    newPassportIssueLocation: body.newPassportIssueLocation,
  };

  if (!passportsEqual(employee.passportNumber, expected) || currentExp !== baseExp) {
    const prev = await findByKey(key);
    if (prev?.status === 'SUCCEEDED') {
      const notice = differentRequestNotice('PASSPORT_RENEW', parseStoredSummary(prev.requestSummary), requested);
      return {
        alreadyDone: true,
        applied: false,
        differentRequest: !!notice,
        muqeemTransactionId: prev.id,
        message: notice ?? 'سبق تحديث بيانات هذا الجواز في منصة مقيم؛ لم يُرسل طلب جديد.',
      };
    }
    throw conflict('تغيّر رقم الجواز المسجل للموظف منذ فتح الصفحة. حدّث الصفحة وتحقق من البيانات.', { code: 'STALE_PASSPORT' });
  }

  const errors = validatePassportRenew(
    {
      currentPassportNumber: employee.passportNumber,
      newPassportNumber: newNumber,
      newPassportIssueDate: body.newPassportIssueDate,
      newPassportExpiryDate: body.newPassportExpiryDate,
      newPassportIssueLocation: body.newPassportIssueLocation,
    },
    todayKey(),
  );
  if (errors.length) throw badRequest(errors.join(' '), { errors });

  await assertNoUnresolved(employee.id, 'PASSPORT_RENEW');

  const current = (employee.passportNumber ?? '').trim();
  const location = body.newPassportIssueLocation.trim();
  const run = await runGuarded({
    operation: 'PASSPORT_RENEW',
    idempotencyKey: key,
    companyId,
    employeeId: employee.id,
    entity: { type: 'EMPLOYEE', id: employee.id },
    user,
    ipAddress: ip,
    // Passport numbers are stored masked (last 4), like the iqama.
    requestSummary: {
      iqamaLast4: employee.iqamaOrIdNumber.slice(-4),
      currentPassportNumberLast4: docLast4(current),
      currentPassportExpiry: currentExp,
      newPassportNumberLast4: docLast4(newNumber),
      newPassportIssueDate: body.newPassportIssueDate,
      newPassportExpiryDate: body.newPassportExpiryDate,
      newPassportIssueLocation: location,
    },
    execute: (client) =>
      client.renewPassport({
        iqamaNumber: employee.iqamaOrIdNumber,
        passportNumber: current,
        newPassportNumber: newNumber,
        newPassportIssueDate: body.newPassportIssueDate,
        newPassportExpiryDate: body.newPassportExpiryDate,
        newPassportIssueLocation: location,
      }),
  });

  const stored = parseStoredSummary(run.transaction.requestSummary);
  const notice = run.alreadyDone ? differentRequestNotice('PASSPORT_RENEW', stored, requested) : null;
  if (notice) {
    // Executed on Muqeem with OTHER passport data, of which only the last 4 are stored: never write
    // this request's passport; report whether the record already holds the executed one.
    const storedLast4 = summaryPassportLast4(stored, 'newPassportNumber');
    const storedExp = summaryString(stored, 'newPassportExpiryDate');
    const fresh = await prisma.employee.findUnique({ where: { id: employee.id }, select: { passportNumber: true, passportExp: true } });
    const already = !!fresh && !!storedLast4 && docLast4(fresh.passportNumber) === storedLast4 && (!storedExp || dateKey(fresh.passportExp) === storedExp);
    return {
      alreadyDone: true,
      applied: already,
      differentRequest: true,
      muqeemTransactionId: run.transaction.id,
      message: `${notice} ${recordStateSentence('PASSPORT_RENEW', already ? 'already' : null, storedExp)}`,
    };
  }

  const newExp = new Date(`${body.newPassportExpiryDate}T00:00:00.000Z`);
  const state = await applyAfterMuqeem(
    passportApply(employee.id, current, newNumber, newExp, run.transaction.id, user, ip, 'RENEW', `تحديث بيانات الجواز عبر منصة مقيم (جواز جديد صادر من ${location} بتاريخ ${body.newPassportIssueDate})`),
    run.transaction.id,
    'أعد الطلب نفسه بنفس البيانات لإكمال التحديث: لن يُرسل إلى مقيم مرة أخرى.',
  );

  return {
    alreadyDone: run.alreadyDone,
    differentRequest: false,
    applied: state !== 'changed',
    muqeemTransactionId: run.transaction.id,
    message: muqeemResultMessage('PASSPORT_RENEW', state, run.alreadyDone, body.newPassportExpiryDate),
  };
}

function passportApply(
  employeeId: string,
  expectedPassport: string,
  newPassport: string | null,
  newExp: Date,
  txId: string,
  user: AuthUser,
  ip: string,
  kind: 'RENEW' | 'EXTEND',
  notes: string,
  expectedExp?: string | null,
): ApplyInput {
  return {
    employeeId,
    documentType: 'PASSPORT',
    guard: (row) =>
      passportsEqual(row.passportNumber, expectedPassport) && (expectedExp === undefined || dateKey(row.passportExp) === (expectedExp ?? null)),
    data: newPassport ? { passportNumber: newPassport, passportExp: newExp } : { passportExp: newExp },
    oldExp: (row) => row.passportExp,
    newExp,
    notes: `${notes} — معاملة مقيم ${txId}`,
    attachmentUrl: null,
    user,
    ipAddress: ip,
    auditExtra: {
      muqeemTransactionId: txId,
      passportChange: kind,
      oldPassportLast4: expectedPassport.slice(-4),
      ...(newPassport ? { newPassportLast4: newPassport.slice(-4) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// EXTEND_PASSPORT
// ---------------------------------------------------------------------------

async function extendPassport(
  employee: EmployeeRow,
  body: Extract<Body, { action: 'EXTEND_PASSPORT' }>,
  user: AuthUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const companyId = assertEligible(employee);
  const expectedNumber = body.expectedPassportNumber;
  const expectedExp = body.expectedPassportExp ? body.expectedPassportExp : null;
  if (!expectedNumber) throw badRequest('لا يوجد رقم جواز مسجل للموظف، ومقيم يشترطه لتمديد الصلاحية. أدخله أولاً من تعديل بيانات الموظف.');
  if (!isDateKey(body.newPassportExpiryDate)) throw badRequest('تاريخ الانتهاء الجديد للجواز غير صالح.');
  const key = muqeemIdempotencyKey('PASSPORT_EXTEND', ...passportExtendKeyParts(employee.id, expectedNumber, expectedExp));
  const requested = { newPassportExpiryDate: body.newPassportExpiryDate };

  if (!passportsEqual(employee.passportNumber, expectedNumber) || dateKey(employee.passportExp) !== expectedExp) {
    const prev = await findByKey(key);
    if (prev?.status === 'SUCCEEDED') {
      const notice = differentRequestNotice('PASSPORT_EXTEND', parseStoredSummary(prev.requestSummary), requested);
      return {
        alreadyDone: true,
        applied: false,
        differentRequest: !!notice,
        muqeemTransactionId: prev.id,
        message: notice ?? 'سبق تمديد صلاحية هذا الجواز في منصة مقيم؛ لم يُرسل طلب جديد.',
      };
    }
    throw conflict('تغيّرت بيانات الجواز المسجلة للموظف منذ فتح الصفحة. حدّث الصفحة وتحقق من البيانات.', { code: 'STALE_PASSPORT' });
  }

  const errors = validatePassportExtend(
    { currentPassportNumber: employee.passportNumber, currentPassportExp: dateKey(employee.passportExp), newPassportExpiryDate: body.newPassportExpiryDate },
    todayKey(),
  );
  if (errors.length) throw badRequest(errors.join(' '), { errors });

  await assertNoUnresolved(employee.id, 'PASSPORT_EXTEND');

  const passport = (employee.passportNumber ?? '').trim();
  const run = await runGuarded({
    operation: 'PASSPORT_EXTEND',
    idempotencyKey: key,
    companyId,
    employeeId: employee.id,
    entity: { type: 'EMPLOYEE', id: employee.id },
    user,
    ipAddress: ip,
    requestSummary: {
      iqamaLast4: employee.iqamaOrIdNumber.slice(-4),
      passportNumberLast4: docLast4(passport),
      currentPassportExpiry: expectedExp,
      newPassportExpiryDate: body.newPassportExpiryDate,
    },
    execute: (client) =>
      client.extendPassportValidity({
        iqamaNumber: employee.iqamaOrIdNumber,
        passportNumber: passport,
        newPassportExpiryDate: body.newPassportExpiryDate,
      }),
  });

  const stored = parseStoredSummary(run.transaction.requestSummary);
  const notice = run.alreadyDone ? differentRequestNotice('PASSPORT_EXTEND', stored, requested) : null;
  // The date actually executed on Muqeem (the stored one when this request was answered from it).
  const executedExp = notice ? summaryString(stored, 'newPassportExpiryDate') : body.newPassportExpiryDate;
  if (!executedExp || !isDateKey(executedExp)) {
    return {
      alreadyDone: true,
      applied: false,
      differentRequest: true,
      muqeemTransactionId: run.transaction.id,
      message: `${notice ?? ''} ${recordStateSentence('PASSPORT_EXTEND', null, null)}`.trim(),
    };
  }

  // Record still on the base (passport + expiry): the EXECUTED date is written.
  const newExp = new Date(`${executedExp}T00:00:00.000Z`);
  const state = await applyAfterMuqeem(
    passportApply(employee.id, passport, null, newExp, run.transaction.id, user, ip, 'EXTEND', 'تمديد صلاحية الجواز عبر منصة مقيم', expectedExp),
    run.transaction.id,
    'أعد الطلب نفسه بنفس التاريخ لإكمال التحديث: لن يُرسل إلى مقيم مرة أخرى.',
  );

  return {
    alreadyDone: run.alreadyDone,
    differentRequest: !!notice,
    applied: state !== 'changed',
    muqeemTransactionId: run.transaction.id,
    message: notice
      ? `${notice} ${recordStateSentence('PASSPORT_EXTEND', state, executedExp)}`
      : muqeemResultMessage('PASSPORT_EXTEND', state, run.alreadyDone, executedExp),
  };
}

// ---------------------------------------------------------------------------
// RECONCILE (after checking Muqeem's interactive services report / portal)
// ---------------------------------------------------------------------------

async function reconcile(
  employee: EmployeeRow,
  body: Extract<Body, { action: 'RECONCILE' }>,
  user: AuthUser,
  ip: string,
): Promise<Record<string, unknown>> {
  // POST already requires ROLE_GROUPS.GOV (= RECONCILE_ROLES, like reconcileTransaction()).
  if (!body.note || body.note.length < 3) throw badRequest('اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم (3 أحرف على الأقل).');
  const row = await prisma.muqeemTransaction.findUnique({ where: { id: body.transactionId } });
  if (!row || row.employeeId !== employee.id) throw notFound('عملية مقيم غير موجودة لهذا الموظف');
  if (!isEmployeeMuqeemOperation(row.operation)) {
    throw badRequest('تُسوّى هذه العملية من الشاشة الخاصة بها (التأشيرات / الخروج النهائي)، لا من ملف الموظف.');
  }
  const summary = parseStoredSummary(row.requestSummary);

  let newIqamaKey: string | null = null;
  if (body.outcome === 'SUCCEEDED' && row.operation === 'IQAMA_RENEW') {
    newIqamaKey = body.newIqamaExpiryDate?.trim() || null;
    if (!newIqamaKey || !isDateKey(newIqamaKey)) {
      throw badRequest('أدخل تاريخ انتهاء الإقامة الجديد كما يظهر في منصة مقيم لتسجيل التجديد كمنفذ.');
    }
    const oldKey = summaryString(summary, 'currentIqamaExpiry');
    if (oldKey && newIqamaKey <= oldKey) throw badRequest('تاريخ الانتهاء الجديد يجب أن يكون بعد تاريخ الانتهاء السابق للإقامة.');
  }

  // Only the last 4 of the new passport are stored: the operator re-enters the full number.
  let newPassport: string | null = null;
  if (body.outcome === 'SUCCEEDED' && row.operation === 'PASSPORT_RENEW') {
    newPassport = body.newPassportNumber?.trim().toUpperCase() || null;
    if (!newPassport || !PASSPORT_NUMBER_RE.test(newPassport)) {
      throw badRequest('أدخل رقم الجواز الجديد كما هو مسجل في مقيم (حروف إنجليزية وأرقام حتى 15 خانة) لتسجيل التحديث كمنفذ.');
    }
    const storedLast4 = summaryPassportLast4(summary, 'newPassportNumber');
    if (storedLast4 && docLast4(newPassport) !== storedLast4) {
      throw badRequest(`رقم الجواز الجديد المُدخل لا يطابق الطلب الأصلي (آخر 4 خانات فيه ${ltr(storedLast4)}). تحقق من الرقم في مقيم.`);
    }
  }

  const done = await reconcileTransaction(
    row.id,
    body.outcome === 'SUCCEEDED'
      ? {
          status: 'SUCCEEDED',
          externalRef: body.externalRef ?? null,
          note: body.note ?? null,
          // Kept with the row, so a later request on the same base can apply the executed result.
          details: newIqamaKey ? { newIqamaExpiryDate: newIqamaKey } : null,
        }
      : { status: 'FAILED', note: body.note ?? null },
    user,
    ip,
  );

  if (body.outcome === 'FAILED') {
    return {
      reconciled: true,
      applied: false,
      muqeemTransactionId: done.id,
      message: 'تمت التسوية: سُجّلت العملية «لم تُنفذ في مقيم». يمكن إعادة الطلب الآن عند الحاجة.',
    };
  }

  const txId = done.id;
  const retryHint = 'حدّث البيانات يدوياً من شاشة التجديدات أو تعديل بيانات الموظف.';
  const note = body.note ? ` — ملاحظة التسوية: ${body.note}` : '';
  /** The employee's current passport when its last 4 match the stored ones, else '' (the guard then fails). */
  const basePassport = (storedLast4: string | null) =>
    storedLast4 && docLast4(employee.passportNumber) === storedLast4 ? (employee.passportNumber ?? '').trim() : '';
  let state: ApplyState | null = null;
  let missing = false;
  if (row.operation === 'IQAMA_RENEW' && newIqamaKey) {
    const oldKey = summaryString(summary, 'currentIqamaExpiry');
    const newExp = new Date(`${newIqamaKey}T00:00:00.000Z`);
    if (!oldKey) missing = true;
    else {
      state = await applyAfterMuqeem(
        {
          employeeId: employee.id,
          documentType: 'IQAMA',
          guard: (r) => dateKey(r.iqamaOrIdExp) === oldKey,
          data: { iqamaOrIdExp: newExp },
          oldExp: (r) => r.iqamaOrIdExp,
          newExp,
          notes: `تجديد عبر منصة مقيم (مُسوّى يدوياً بعد نتيجة غير معروفة)${note} — معاملة مقيم ${txId}`,
          attachmentUrl: null,
          user,
          ipAddress: ip,
          auditExtra: { muqeemTransactionId: txId, reconciled: true },
        },
        txId,
        retryHint,
      );
    }
  } else if (row.operation === 'PASSPORT_RENEW') {
    const currentLast4 = summaryPassportLast4(summary, 'currentPassportNumber');
    const exp = summaryString(summary, 'newPassportExpiryDate');
    if (!currentLast4 || !newPassport || !exp || !isDateKey(exp)) missing = true;
    else {
      const oldExp = summary && 'currentPassportExpiry' in summary ? summaryString(summary, 'currentPassportExpiry') : undefined;
      state = await applyAfterMuqeem(
        passportApply(employee.id, basePassport(currentLast4), newPassport, new Date(`${exp}T00:00:00.000Z`), txId, user, ip, 'RENEW', `تحديث بيانات الجواز عبر منصة مقيم (مُسوّى يدوياً)${note}`, oldExp),
        txId,
        retryHint,
      );
    }
  } else if (row.operation === 'PASSPORT_EXTEND') {
    const passportLast4 = summaryPassportLast4(summary, 'passportNumber');
    const exp = summaryString(summary, 'newPassportExpiryDate');
    const oldExp = summaryString(summary, 'currentPassportExpiry');
    if (!passportLast4 || !exp || !isDateKey(exp)) missing = true;
    else {
      state = await applyAfterMuqeem(
        passportApply(employee.id, basePassport(passportLast4), null, new Date(`${exp}T00:00:00.000Z`), txId, user, ip, 'EXTEND', `تمديد صلاحية الجواز عبر منصة مقيم (مُسوّى يدوياً)${note}`, oldExp),
        txId,
        retryHint,
      );
    }
  }

  const applied = state === 'written' || state === 'already';
  return {
    reconciled: true,
    applied,
    muqeemTransactionId: txId,
    message: applied
      ? state === 'written'
        ? 'تمت التسوية: سُجّلت العملية «نُفذت في مقيم» وحُدّثت بيانات الموظف وفقها.'
        : 'تمت التسوية: سُجّلت العملية «نُفذت في مقيم»، وبيانات الموظف محدَّثة بالفعل.'
      : missing
        ? 'تمت التسوية: سُجّلت العملية «نُفذت في مقيم»، لكن لا تتوفر بيانات كافية لتحديث ملف الموظف تلقائياً. حدّثه يدوياً.'
        : 'تمت التسوية: سُجّلت العملية «نُفذت في مقيم». لم تُعدَّل بيانات الموظف لأنها تغيّرت منذ إرسال الطلب؛ راجعها يدوياً.',
  };
}

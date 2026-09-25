// Final exit visa (خروج نهائي) through Muqeem, from an END_OF_SERVICE settlement.
//
// GET  /api/settlements/[id]/muqeem  -> eligibility, blockers, open-obligation warnings, the
//      FINAL_EXIT_* Muqeem transactions of the settlement and the derived state.
// POST /api/settlements/[id]/muqeem
//      { action: 'ISSUE_FINAL_EXIT', confirm: true }
//      { action: 'CANCEL_FINAL_EXIT', confirm: true, visaNumber }
//      { action: 'RECONCILE', transactionId, outcome: 'SUCCEEDED' | 'FAILED', visaNumber?, note? }
//      { action: 'SYNC_VISA_RECORD' }  (no Muqeem call: rewrites the Visa row of an issued visa)
//
// Safety: GOV operators only; every Muqeem call goes through runMuqeemTransaction with a
// deterministic key (per settlement + issue generation / per visa number), so a double click or a
// retry never issues twice; UNKNOWN outcomes block every new action until reconciled.
// The business Visa row is written AFTER Muqeem succeeded, in one DB transaction.
// Probation-period final exit (/final-exit/issue/probation-period) is NOT handled here.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import { LOAN_DEDUCTIBLE_STATUSES, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { HttpError, badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { dateKey } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { leaveTypeLabel } from '@/lib/leave';
import { zId } from '@/lib/validation';
import {
  MUQEEM_ERROR_HTTP_STATUS,
  MuqeemError,
  muqeemConfig,
  muqeemIdempotencyKey,
  reconcileTransaction,
  runMuqeemTransaction,
  toApiError,
  type FinalExitIssueResponse,
} from '@/lib/muqeem';
import { openObligationWarnings, type OpenObligations } from '@/app/api/settlements/route';
import {
  FINAL_EXIT_CANCEL_OP,
  FINAL_EXIT_ENTITY_TYPE,
  FINAL_EXIT_ISSUE_OP,
  FINAL_EXIT_VISA_TYPE,
  cancelBlockers,
  cancelKeyParts,
  cancelledVisaNumber,
  deriveFinalExitState,
  extractFinalExitDetails,
  finalExitExtraWarnings,
  isReconcilable,
  issueBlockers,
  issueKeyParts,
  normalizeVisaNumberInput,
  parseSummary,
  type FinalExitBlock,
  type FinalExitState,
  type FinalExitTx,
} from './_logic';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Who may read the Muqeem state of a settlement (settlement readers + GOV operators). */
const READ_ROLES = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.OWNER, ...ROLE_GROUPS.FINANCE, ...ROLE_GROUPS.GOV])];
/** Who may trigger Muqeem calls. */
const GOV_ROLES = ROLE_GROUPS.GOV;

const TX_SELECT = {
  id: true,
  operation: true,
  status: true,
  externalRef: true,
  errorMessage: true,
  requestSummary: true,
  responseSummary: true,
  createdAt: true,
  completedAt: true,
} as const;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadContext(id: string) {
  const settlement = await prisma.settlement.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      status: true,
      lastWorkingDate: true,
      employee: {
        select: {
          id: true,
          firstNameArabic: true,
          lastNameArabic: true,
          nationality: true,
          iqamaOrIdNumber: true,
          legalCompany: { select: { id: true, nameArabic: true, moiNumber: true, muqeemPlatformId: true } },
        },
      },
    },
  });
  if (!settlement) throw notFound('التصفية غير موجودة');
  const txs: FinalExitTx[] = await prisma.muqeemTransaction.findMany({
    where: { entityType: FINAL_EXIT_ENTITY_TYPE, entityId: id, operation: { in: [FINAL_EXIT_ISSUE_OP, FINAL_EXIT_CANCEL_OP] } },
    select: TX_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  const emp = settlement.employee;
  const lc = emp.legalCompany;
  const company = lc ? { id: lc.id, name: lc.nameArabic, linked: !!lc.moiNumber?.trim() && !!lc.muqeemPlatformId } : null;
  const state = deriveFinalExitState(txs);
  const muqeemUsable = muqeemConfig().usable;
  return { settlement, employee: emp, company, txs, state, muqeemUsable };
}

type LoadedContext = Awaited<ReturnType<typeof loadContext>>;

const EXIT_REENTRY_VISA_TYPE = 'خروج وعودة';
const OPEN_PAYMENT_STATUSES = ['PENDING_OWNER', 'PENDING_FINANCE'] as const;
const VISA_STATUS_AR: Record<string, string> = { PENDING_PAYMENT: 'بانتظار الدفع', PAID: 'مدفوعة', ISSUED: 'صادرة' };

/**
 * Same open obligations as the settlement preview (DOM-005), formatted by the shared
 * openObligationWarnings(), plus final-exit specific warnings (unpaid settlement, loans).
 */
async function loadWarnings(ctx: LoadedContext): Promise<string[]> {
  const employeeId = ctx.employee.id;
  const lastDate = ctx.settlement.lastWorkingDate ?? new Date();
  const [assets, sims, vehicles, futureLeaves, visas, loans] = await Promise.all([
    prisma.asset.findMany({ where: { employeeId, status: 'ACTIVE' }, select: { assetType: true, description: true } }),
    prisma.telecomSim.findMany({ where: { employeeId }, select: { simNumber: true, provider: true } }),
    prisma.vehicle.findMany({ where: { driverId: employeeId, isArchived: false }, select: { plateNumber: true, brand: true } }),
    prisma.leave.findMany({
      where: { employeeId, status: 'APPROVED', startDate: { gt: lastDate } },
      select: { leaveType: true, startDate: true, endDate: true },
      orderBy: { startDate: 'asc' },
    }),
    prisma.visa.findMany({
      where: { employeeId, visaType: EXIT_REENTRY_VISA_TYPE, status: { not: 'CANCELLED' }, OR: [{ returnDate: null }, { returnDate: { gte: lastDate } }] },
      select: { id: true, status: true, departureDate: true, externalVisaNumber: true },
    }),
    prisma.loan.findMany({
      where: { employeeId, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] }, isForgiven: false, remainingAmount: { gt: 0 } },
      select: { remainingAmount: true },
    }),
  ]);
  const visaIds = visas.map((v) => v.id);
  const payments = await prisma.paymentRequest.findMany({
    where: {
      status: { in: [...OPEN_PAYMENT_STATUSES] },
      OR: [{ entityType: 'EMPLOYEE', entityId: employeeId }, ...(visaIds.length ? [{ entityType: 'VISA', entityId: { in: visaIds } }] : [])],
    },
    select: { title: true, amount: true },
  });
  const obligations: OpenObligations = {
    assets: assets.map((a) => [a.assetType, a.description].filter(Boolean).join(' - ')),
    sims: sims.map((s) => [s.simNumber, s.provider].filter(Boolean).join(' - ')),
    vehicles: vehicles.map((v) => [v.plateNumber, v.brand].filter(Boolean).join(' - ')),
    futureLeaves: futureLeaves.map((l) => `${leaveTypeLabel(l.leaveType)} من ${dateKey(l.startDate)} إلى ${dateKey(l.endDate)}`),
    exitReentryVisas: visas.map(
      (v) =>
        `${VISA_STATUS_AR[v.status] ?? v.status}${v.externalVisaNumber ? ` رقم ${v.externalVisaNumber}` : ''}${v.departureDate ? ` (مغادرة ${dateKey(v.departureDate)})` : ''}`,
    ),
    pendingPayments: payments.map((p) => `${p.title} (${formatMoney(p.amount)} ر.س)`),
  };
  return [
    ...openObligationWarnings(obligations),
    ...finalExitExtraWarnings({ settlementStatus: ctx.settlement.status, loans }),
  ];
}

// ---------------------------------------------------------------------------
// Business Visa row (written only after Muqeem succeeded)
// ---------------------------------------------------------------------------

/**
 * Makes sure the employee has an ISSUED 'خروج نهائي' Visa row for this Muqeem visa number: reuses
 * the placeholder created with the settlement (requestFinalExitVisa: PENDING_PAYMENT / PAID, no
 * number yet), otherwise creates one. Idempotent (a second call finds the row by number).
 */
async function ensureIssuedVisaRow(
  employeeId: string,
  visaNumber: string,
  info: { issuedAt: Date; pdfUrl: string | null; settlementId: string; transactionId: string },
  user: AuthUser,
  ipAddress: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.visa.findFirst({
      where: { employeeId, visaType: FINAL_EXIT_VISA_TYPE, externalVisaNumber: visaNumber },
      select: { id: true, status: true },
    });
    if (existing) return { visaId: existing.id, created: false, changed: false };

    const placeholder = await tx.visa.findFirst({
      where: { employeeId, visaType: FINAL_EXIT_VISA_TYPE, externalVisaNumber: null, status: { in: ['PENDING_PAYMENT', 'PAID'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    const data: Prisma.VisaUpdateManyMutationInput = {
      status: 'ISSUED',
      externalVisaNumber: visaNumber,
      issuedViaMuqeemAt: info.issuedAt,
      ...(info.pdfUrl ? { visaPdfUrl: info.pdfUrl } : {}),
    };
    let visaId: string;
    let created: boolean;
    if (placeholder) {
      // Guarded update: only if it is still an unnumbered placeholder.
      const upd = await tx.visa.updateMany({ where: { id: placeholder.id, externalVisaNumber: null }, data });
      if (upd.count !== 1) throw conflict('تغيّر سجل التأشيرة أثناء الحفظ، أعد تحميل الصفحة');
      visaId = placeholder.id;
      created = false;
    } else {
      const row = await tx.visa.create({
        data: {
          employeeId,
          visaType: FINAL_EXIT_VISA_TYPE,
          status: 'ISSUED',
          externalVisaNumber: visaNumber,
          issuedViaMuqeemAt: info.issuedAt,
          visaPdfUrl: info.pdfUrl,
        },
        select: { id: true },
      });
      visaId = row.id;
      created = true;
    }
    await logAudit(
      {
        userId: user.id,
        action: created ? 'CREATE' : 'UPDATE',
        entityType: 'VISA',
        entityId: visaId,
        details: {
          source: 'MUQEEM_FINAL_EXIT',
          visaType: FINAL_EXIT_VISA_TYPE,
          status: 'ISSUED',
          externalVisaNumber: visaNumber,
          settlementId: info.settlementId,
          muqeemTransactionId: info.transactionId,
          ...(placeholder ? { previousStatus: placeholder.status } : {}),
        },
        ipAddress,
      },
      tx,
    );
    return { visaId, created, changed: true };
  });
}

/** Marks the employee's 'خروج نهائي' Visa row(s) with this number CANCELLED (idempotent). */
async function cancelVisaRows(employeeId: string, visaNumber: string, info: { settlementId: string; transactionId: string }, user: AuthUser, ipAddress: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.visa.findMany({
      where: { employeeId, visaType: FINAL_EXIT_VISA_TYPE, externalVisaNumber: visaNumber, status: { not: 'CANCELLED' } },
      select: { id: true, status: true },
    });
    for (const r of rows) {
      await tx.visa.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
      await logAudit(
        {
          userId: user.id,
          action: 'UPDATE',
          entityType: 'VISA',
          entityId: r.id,
          details: {
            source: 'MUQEEM_FINAL_EXIT_CANCEL',
            from: r.status,
            to: 'CANCELLED',
            externalVisaNumber: visaNumber,
            settlementId: info.settlementId,
            muqeemTransactionId: info.transactionId,
          },
          ipAddress,
        },
        tx,
      );
    }
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function blockerError(b: FinalExitBlock, state: FinalExitState): HttpError {
  switch (b.code) {
    case 'NOT_LINKED':
    case 'NO_LEGAL_COMPANY':
      return new HttpError(MUQEEM_ERROR_HTTP_STATUS.NOT_LINKED, b.message, { muqeemKind: 'NOT_LINKED', code: b.code });
    case 'NOT_CONFIGURED':
      return new HttpError(MUQEEM_ERROR_HTTP_STATUS.NOT_CONFIGURED, b.message, { muqeemKind: 'NOT_CONFIGURED', code: b.code });
    case 'UNDETERMINED':
      return conflict(b.message, {
        code: b.code,
        muqeemTransactionId: state.undetermined?.id ?? null,
        status: state.undetermined?.status ?? null,
      });
    case 'INVALID_IQAMA':
      return badRequest(b.message, { code: b.code });
    default:
      return conflict(b.message, { code: b.code });
  }
}

/**
 * MuqeemError -> HttpError; for an UNKNOWN outcome the transaction id is added so the page can
 * offer the reconciliation right away.
 */
async function muqeemFailure(err: unknown, idempotencyKey: string): Promise<unknown> {
  if (!(err instanceof MuqeemError)) return err;
  const http = err.toHttpError();
  const row = await prisma.muqeemTransaction.findUnique({ where: { idempotencyKey }, select: { id: true, status: true } }).catch(() => null);
  return new HttpError(http.status, http.message, {
    ...(http.details as Record<string, unknown>),
    ...(row ? { muqeemTransactionId: row.id, transactionStatus: row.status } : {}),
  });
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

function publicTx(t: FinalExitTx, now: Date) {
  return {
    id: t.id,
    operation: t.operation,
    status: t.status,
    externalRef: t.externalRef,
    errorMessage: t.errorMessage,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    reconcilable: isReconcilable(t, now),
    targetVisaNumber: t.operation === FINAL_EXIT_CANCEL_OP ? cancelledVisaNumber(t) : null,
  };
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(READ_ROLES);
    const { id } = await params;
    const ctx = await loadContext(id);
    const { settlement, employee, company, txs, state, muqeemUsable } = ctx;
    const now = new Date();

    const blockers = issueBlockers({ settlement, employee, company, muqeemUsable, state });
    const cancelBlock = cancelBlockers({ employee, company, muqeemUsable, state });
    const relevant = settlement.type === 'END_OF_SERVICE';
    const warnings = relevant ? await loadWarnings(ctx) : [];

    // Details of the active visa (exit-before date) from the stored response summary.
    const details = state.activeIssue ? extractFinalExitDetails(parseSummary(state.activeIssue.responseSummary)) : null;
    const visaRow = state.visaNumber
      ? await prisma.visa.findFirst({
          where: { employeeId: employee.id, visaType: FINAL_EXIT_VISA_TYPE, externalVisaNumber: state.visaNumber },
          select: { id: true, status: true, issuedViaMuqeemAt: true, visaPdfUrl: true },
        })
      : null;

    const canOperate = roleIn(user.role, GOV_ROLES);
    return NextResponse.json({
      settlement: { id: settlement.id, type: settlement.type, status: settlement.status },
      employee: {
        id: employee.id,
        name: `${employee.firstNameArabic ?? ''} ${employee.lastNameArabic ?? ''}`.trim(),
        nationality: employee.nationality,
        iqamaLast4: (employee.iqamaOrIdNumber ?? '').slice(-4),
      },
      company: company ? { id: company.id, name: company.name, linked: company.linked } : null,
      muqeem: { usable: muqeemUsable },
      canOperate,
      relevant,
      eligible: blockers.length === 0,
      reasons: blockers.map((b) => b.message),
      reasonCodes: blockers.map((b) => b.code),
      canCancel: canOperate && cancelBlock.length === 0,
      cancelReasons: cancelBlock.map((b) => b.message),
      warnings,
      state: {
        phase: state.phase,
        visaNumber: state.visaNumber,
        exitBefore: details?.exitBefore ? dateKey(details.exitBefore) : null,
        exitBeforeHijri: details?.exitBeforeHijri ?? null,
        issuedAt: state.activeIssue?.completedAt ?? null,
        visaRecord: visaRow,
        lastError: state.lastError,
        undetermined: state.undetermined ? publicTx(state.undetermined, now) : null,
      },
      transactions: txs.map((t) => publicTx(t, now)).reverse(),
    });
  } catch (err) {
    return handleApiError(toApiError(err), 'settlements/[id]/muqeem:GET');
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const zConfirm = z.literal(true, { errorMap: () => ({ message: 'يجب تأكيد العملية صراحةً قبل إرسالها إلى منصة مقيم' }) });

const PostSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ISSUE_FINAL_EXIT'), confirm: zConfirm }),
  /** Never calls Muqeem: (re)creates the Visa row of an already issued final exit. */
  z.object({ action: z.literal('SYNC_VISA_RECORD') }),
  z.object({ action: z.literal('CANCEL_FINAL_EXIT'), confirm: zConfirm, visaNumber: z.string().trim().min(1).max(250) }),
  z.object({
    action: z.literal('RECONCILE'),
    transactionId: zId,
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    visaNumber: z.string().trim().max(250).optional().nullable(),
    note: z.string().trim().max(1000).optional().nullable(),
  }),
]);

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(GOV_ROLES);
    const { id } = await params;
    const body = await parseBody(req, PostSchema);
    const ipAddress = getClientIp(req);
    const ctx = await loadContext(id);

    switch (body.action) {
      case 'ISSUE_FINAL_EXIT':
        return await issue(ctx, user, ipAddress);
      case 'SYNC_VISA_RECORD':
        return await syncVisaRecord(ctx, user, ipAddress);
      case 'CANCEL_FINAL_EXIT':
        return await cancel(ctx, body.visaNumber, user, ipAddress);
      case 'RECONCILE':
        return await reconcile(ctx, body, user, ipAddress);
    }
  } catch (err) {
    return handleApiError(toApiError(err), 'settlements/[id]/muqeem:POST');
  }
}

async function syncVisaRecord(ctx: LoadedContext, user: AuthUser, ipAddress: string) {
  const { settlement, employee, state } = ctx;
  if (state.phase !== 'ISSUED' || !state.activeIssue || !state.visaNumber) {
    throw conflict('لا توجد تأشيرة خروج نهائي صادرة معروفة الرقم لهذه التصفية لمزامنة سجلها.');
  }
  const r = await ensureIssuedVisaRow(
    employee.id,
    state.visaNumber,
    { issuedAt: state.activeIssue.completedAt ?? state.activeIssue.createdAt, pdfUrl: null, settlementId: settlement.id, transactionId: state.activeIssue.id },
    user,
    ipAddress,
  );
  return NextResponse.json({
    alreadyDone: !r.changed,
    message: r.changed ? 'حُدِّث سجل التأشيرات في النظام. لم يُرسل أي طلب إلى مقيم.' : 'سجل التأشيرة موجود مسبقاً. لم يُرسل أي طلب إلى مقيم.',
    visaNumber: state.visaNumber,
    visaId: r.visaId,
  });
}

async function issue(ctx: LoadedContext, user: AuthUser, ipAddress: string) {
  const { settlement, employee, company, state, muqeemUsable } = ctx;
  const blockers = issueBlockers({ settlement, employee, company, muqeemUsable, state });

  // Double submit after a success: nothing is sent to Muqeem; only the Visa row is repaired if needed.
  if (state.phase === 'ISSUED' && state.activeIssue) {
    const visaNumber = state.visaNumber;
    let visaId: string | null = null;
    if (visaNumber) {
      const r = await ensureIssuedVisaRow(
        employee.id,
        visaNumber,
        { issuedAt: state.activeIssue.completedAt ?? state.activeIssue.createdAt, pdfUrl: null, settlementId: settlement.id, transactionId: state.activeIssue.id },
        user,
        ipAddress,
      );
      visaId = r.visaId;
    }
    return NextResponse.json({
      alreadyDone: true,
      message: `تأشيرة الخروج النهائي صادرة مسبقاً لهذه التصفية${visaNumber ? ` (رقم ${visaNumber})` : ''}. لم يُرسل أي طلب جديد إلى مقيم.`,
      visaNumber,
      visaId,
      transactionId: state.activeIssue.id,
    });
  }
  if (blockers.length) throw blockerError(blockers[0], state);

  const iqamaNumber = (employee.iqamaOrIdNumber ?? '').trim();
  const companyId = company!.id; // guaranteed by issueBlockers (NO_LEGAL_COMPANY)
  const idempotencyKey = muqeemIdempotencyKey('FINAL_EXIT_ISSUE', ...issueKeyParts(settlement.id, state.successfulCancels));

  let run;
  try {
    run = await runMuqeemTransaction<FinalExitIssueResponse>({
      operation: 'FINAL_EXIT_ISSUE',
      idempotencyKey,
      companyId,
      employeeId: employee.id,
      entity: { type: FINAL_EXIT_ENTITY_TYPE, id: settlement.id },
      user,
      ipAddress,
      requestSummary: { settlementId: settlement.id, iqamaLast4: iqamaNumber.slice(-4), generation: state.successfulCancels },
      execute: (client) => client.issueFinalExit({ iqamaNumber }),
      extractRef: (r) => extractFinalExitDetails(r).visaNumber,
    });
  } catch (err) {
    throw await muqeemFailure(err, idempotencyKey);
  }

  const txRow = run.transaction;
  const details = run.result ? extractFinalExitDetails(run.result) : extractFinalExitDetails(parseSummary(txRow.responseSummary));
  const visaNumber = txRow.externalRef ?? details.visaNumber;

  let visaId: string | null = null;
  let recordWarning: string | null = null;
  if (visaNumber) {
    try {
      const r = await ensureIssuedVisaRow(
        employee.id,
        visaNumber,
        { issuedAt: txRow.completedAt ?? new Date(), pdfUrl: txRow.documentUrl, settlementId: settlement.id, transactionId: txRow.id },
        user,
        ipAddress,
      );
      visaId = r.visaId;
    } catch (err) {
      console.error('[settlements/muqeem] final exit issued but the Visa row could not be saved:', err instanceof Error ? err.message : err);
      recordWarning = 'صدرت التأشيرة في مقيم لكن تعذر تحديث سجل التأشيرات في النظام. أعد تحميل الصفحة واضغط «مزامنة سجل التأشيرة» (لن يُرسل طلب جديد إلى مقيم).';
    }
  } else {
    recordWarning = 'نفّذ مقيم العملية لكنه لم يُرجع رقم التأشيرة. راجع تقرير الخدمات التفاعلية في مقيم لمعرفة الرقم.';
  }

  return NextResponse.json({
    alreadyDone: run.alreadyDone,
    message: run.alreadyDone
      ? 'تأشيرة الخروج النهائي صادرة مسبقاً لهذه التصفية. لم يُرسل أي طلب جديد إلى مقيم.'
      : `صدرت تأشيرة الخروج النهائي في مقيم${visaNumber ? ` برقم ${visaNumber}` : ''}${details.exitBefore ? `، ويجب أن يغادر الموظف المملكة قبل ${dateKey(details.exitBefore)}` : ''}.`,
    visaNumber,
    exitBefore: details.exitBefore ? dateKey(details.exitBefore) : null,
    visaId,
    transactionId: txRow.id,
    ...(recordWarning ? { warning: recordWarning } : {}),
  });
}

async function cancel(ctx: LoadedContext, expectedVisaNumber: string, user: AuthUser, ipAddress: string) {
  const { settlement, employee, company, state, muqeemUsable } = ctx;
  const requested = normalizeVisaNumberInput(expectedVisaNumber);
  if (!requested) throw badRequest('رقم التأشيرة غير صالح');

  // Double submit after a successful cancellation: nothing is sent to Muqeem.
  const cancelledBefore = ctx.txs.find((t) => t.operation === FINAL_EXIT_CANCEL_OP && t.status === 'SUCCEEDED' && cancelledVisaNumber(t) === requested);
  if (cancelledBefore && state.visaNumber !== requested) {
    await cancelVisaRows(employee.id, requested, { settlementId: settlement.id, transactionId: cancelledBefore.id }, user, ipAddress);
    return NextResponse.json({
      alreadyDone: true,
      message: `تأشيرة الخروج النهائي رقم ${requested} ملغاة مسبقاً. لم يُرسل أي طلب جديد إلى مقيم.`,
      visaNumber: requested,
      transactionId: cancelledBefore.id,
    });
  }

  const blockers = cancelBlockers({ employee, company, muqeemUsable, state });
  if (blockers.length) throw blockerError(blockers[0], state);
  if (state.visaNumber !== requested) {
    throw conflict(`رقم التأشيرة المطلوب إلغاؤها (${requested}) لا يطابق التأشيرة الصادرة لهذه التصفية (${state.visaNumber}). أعد تحميل الصفحة.`);
  }

  const iqamaNumber = (employee.iqamaOrIdNumber ?? '').trim();
  const idempotencyKey = muqeemIdempotencyKey('FINAL_EXIT_CANCEL', ...cancelKeyParts(settlement.id, requested));
  let run;
  try {
    run = await runMuqeemTransaction({
      operation: 'FINAL_EXIT_CANCEL',
      idempotencyKey,
      companyId: company!.id,
      employeeId: employee.id,
      entity: { type: FINAL_EXIT_ENTITY_TYPE, id: settlement.id },
      user,
      ipAddress,
      requestSummary: { settlementId: settlement.id, iqamaLast4: iqamaNumber.slice(-4), feVisaNumber: requested },
      execute: (client) => client.cancelFinalExit({ iqamaNumber, feVisaNumber: requested }),
      extractRef: () => requested,
    });
  } catch (err) {
    throw await muqeemFailure(err, idempotencyKey);
  }

  let warning: string | null = null;
  try {
    await cancelVisaRows(employee.id, requested, { settlementId: settlement.id, transactionId: run.transaction.id }, user, ipAddress);
  } catch (err) {
    console.error('[settlements/muqeem] final exit cancelled but the Visa row could not be updated:', err instanceof Error ? err.message : err);
    warning = 'أُلغيت التأشيرة في مقيم لكن تعذر تحديث سجل التأشيرات في النظام. أعد المحاولة لإكمال الحفظ (لن يُرسل طلب جديد إلى مقيم).';
  }
  return NextResponse.json({
    alreadyDone: run.alreadyDone,
    message: run.alreadyDone
      ? `تأشيرة الخروج النهائي رقم ${requested} ملغاة مسبقاً. لم يُرسل أي طلب جديد إلى مقيم.`
      : `أُلغيت تأشيرة الخروج النهائي رقم ${requested} في مقيم.`,
    visaNumber: requested,
    transactionId: run.transaction.id,
    ...(warning ? { warning } : {}),
  });
}

async function reconcile(
  ctx: LoadedContext,
  body: { transactionId: string; outcome: 'SUCCEEDED' | 'FAILED'; visaNumber?: string | null; note?: string | null },
  user: AuthUser,
  ipAddress: string,
) {
  const { settlement, employee } = ctx;
  const tx = ctx.txs.find((t) => t.id === body.transactionId);
  if (!tx) throw notFound('عملية مقيم غير موجودة ضمن عمليات هذه التصفية');

  let externalRef: string | null = null;
  if (body.outcome === 'SUCCEEDED') {
    if (tx.operation === FINAL_EXIT_ISSUE_OP) {
      externalRef = normalizeVisaNumberInput(body.visaNumber ?? '');
      if (!externalRef) throw badRequest('أدخل رقم تأشيرة الخروج النهائي كما يظهر في تقرير الخدمات التفاعلية في مقيم (أرقام فقط)');
    } else {
      externalRef = cancelledVisaNumber(tx);
    }
  }

  const done = await reconcileTransaction(
    tx.id,
    body.outcome === 'SUCCEEDED' ? { status: 'SUCCEEDED', externalRef, note: body.note ?? null } : { status: 'FAILED', note: body.note ?? null },
    user,
    ipAddress,
  );

  let visaId: string | null = null;
  if (done.status === 'SUCCEEDED' && done.externalRef) {
    if (tx.operation === FINAL_EXIT_ISSUE_OP) {
      const r = await ensureIssuedVisaRow(
        employee.id,
        done.externalRef,
        // Issued when the request was sent (the exact time on Muqeem is not known).
        { issuedAt: tx.createdAt, pdfUrl: null, settlementId: settlement.id, transactionId: tx.id },
        user,
        ipAddress,
      );
      visaId = r.visaId;
    } else {
      await cancelVisaRows(employee.id, done.externalRef, { settlementId: settlement.id, transactionId: tx.id }, user, ipAddress);
    }
  }

  const what = tx.operation === FINAL_EXIT_ISSUE_OP ? 'إصدار الخروج النهائي' : 'إلغاء الخروج النهائي';
  return NextResponse.json({
    message:
      done.status === 'SUCCEEDED'
        ? `سُجّلت عملية ${what} على أنها نُفّذت في مقيم${done.externalRef ? ` (رقم التأشيرة ${done.externalRef})` : ''}.`
        : `سُجّلت عملية ${what} على أنها لم تُنفّذ في مقيم. يمكن إعادة الطلب الآن.`,
    transactionId: done.id,
    status: done.status,
    visaNumber: done.externalRef,
    visaId,
  });
}

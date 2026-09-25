// Exit/re-entry visas through Muqeem (مقيم): issue, extend, cancel, reprint, reconcile.
//
// GET  /api/visas/muqeem  (HR + GOV)  -> { enabled, configured, usable, canOperate, reason }
// POST /api/visas/muqeem  (ROLE_GROUPS.GOV only)
//   (ISSUE / EXTEND / CANCEL / REPRINT also require confirm: true)
//   { action: 'ISSUE',   visaId, visaType: 1|2, mode: 'days', days } | { ..., mode: 'date', returnBefore: 'YYYY-MM-DD' }
//   { action: 'EXTEND',  visaId, baseReturnBefore: 'YYYY-MM-DD', mode: 'days', days } | { ..., mode: 'date', returnBefore }
//   { action: 'CANCEL',  visaId }
//   { action: 'REPRINT', visaId }
//   { action: 'RECONCILE', visaId, muqeemTransactionId, outcome: 'SUCCEEDED'|'FAILED', externalRef?, note }
//   { action: 'SYNC',    visaId }  applies a SUCCEEDED operation not yet reflected on the visa (e.g.
//                                  reconciled from the integrations screen). Never calls Muqeem.
//
// Safety (docs/integrations/muqeem/README.md §5): every call goes through runMuqeemTransaction with
// a deterministic idempotency key (visaMuqeemKeyParts), so a double click / retry never issues twice;
// an UNKNOWN outcome blocks any retry until it is reconciled here; the UI asks for an explicit
// confirmation stating that the action is executed in the real government system.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { MuqeemTransaction, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireUser, type AuthUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { todayKey } from '@/lib/dates';
import {
  MuqeemError,
  muqeemConfig,
  muqeemIdempotencyKey,
  reconcileTransaction,
  runMuqeemTransaction,
  toApiError,
  MUQEEM_TX_STATUS,
  type ExitReentryIssueRequest,
} from '@/lib/muqeem';
import {
  EXIT_REENTRY_VISA_TYPE,
  STALE_PENDING_MS,
  VISA_MUQEEM_OPERATIONS,
  VISA_MUQEEM_OPERATION_LABEL,
  VISA_MUQEEM_TYPE_LABEL,
  extendedVisaFields,
  issuedVisaFields,
  parseSummary,
  pendingVisaSync,
  planExtension,
  planIssue,
  residentIneligibility,
  toDateKey,
  visaMuqeemKeyParts,
  type DurationInput,
  type VisaMuqeemOperation,
} from './shared';

export const dynamic = 'force-dynamic';

/** Visas are viewed by HR and government relations (GOV includes HR_MANAGER). */
const VISA_ROLES = [...new Set([...ROLE_GROUPS.GOV, ...ROLE_GROUPS.HR])];
/** Only government-relations operators trigger Muqeem calls. */
const OPERATOR_ROLES = ROLE_GROUPS.GOV;

const employeeSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  nationality: true,
  branch: { select: { nameArabic: true } },
} as const;

// ---------------------------------------------------------------------------
// GET: integration status for the page
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const user = await requireUser(VISA_ROLES);
    const cfg = muqeemConfig();
    const canOperate = hasRole(user, OPERATOR_ROLES);
    let reason: string | null = null;
    if (!cfg.enabled) reason = 'الربط مع منصة مقيم غير مفعّل على الخادم؛ استخدم الإصدار اليدوي (رفع مرفق التأشيرة).';
    else if (!cfg.usable) reason = 'الربط مع منصة مقيم غير مكتمل الإعداد على الخادم؛ تواصل مع مدير النظام.';
    else if (!canOperate) reason = 'إجراءات مقيم متاحة لمدير النظام وصاحب العمل والعلاقات الحكومية ومدير الموارد البشرية فقط.';
    return NextResponse.json({ enabled: cfg.enabled, configured: cfg.configured, usable: cfg.usable, canOperate, reason });
  } catch (err) {
    return handleApiError(err, 'visas/muqeem:GET');
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD');
const zDays = z.preprocess((v) => (typeof v === 'string' && v.trim() ? Number(v) : v), z.number({ invalid_type_error: 'أدخل عدد الأيام' }).int('عدد الأيام يجب أن يكون رقماً صحيحاً'));

const durationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('days'), days: zDays }),
  z.object({ mode: z.literal('date'), returnBefore: zDateKey }),
]);

const visaIdSchema = z.object({ visaId: z.string().trim().min(1).max(100) });

const issueSchema = visaIdSchema.and(z.object({ visaType: z.union([z.literal(1), z.literal(2)], { errorMap: () => ({ message: 'اختر نوع التأشيرة: مفردة أو متعددة' }) }) })).and(durationSchema);
const extendSchema = visaIdSchema.and(z.object({ baseReturnBefore: zDateKey })).and(durationSchema);
const reconcileSchema = visaIdSchema.and(
  z.object({
    muqeemTransactionId: z.string().trim().min(1).max(100),
    outcome: z.enum(['SUCCEEDED', 'FAILED'], { errorMap: () => ({ message: 'نتيجة التسوية غير صالحة' }) }),
    externalRef: z.string().trim().max(50).optional().nullable(),
    note: z.string({ required_error: 'اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم' }).trim().min(3, 'اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم').max(1000),
  }),
);

/** Actions that call Muqeem (RECONCILE / SYNC only record what was verified). */
const MUQEEM_CALL_ACTIONS = new Set(['ISSUE', 'EXTEND', 'CANCEL', 'REPRINT']);

const envelopeSchema = z
  .object({
    action: z.enum(['ISSUE', 'EXTEND', 'CANCEL', 'REPRINT', 'RECONCILE', 'SYNC'], { errorMap: () => ({ message: 'إجراء غير معروف' }) }),
    visaId: z.string().trim().min(1).max(100),
  })
  .passthrough();

type LoadedVisa = Prisma.VisaGetPayload<{
  include: {
    employee: {
      select: {
        id: true;
        firstNameArabic: true;
        lastNameArabic: true;
        nationality: true;
        iqamaOrIdNumber: true;
        legalCompany: { select: { id: true; nameArabic: true; moiNumber: true; muqeemPlatformId: true } };
      };
    };
  };
}>;

interface Ctx {
  user: AuthUser;
  ipAddress: string;
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(OPERATOR_ROLES);
    const raw = await parseBody(req, envelopeSchema);
    const env = raw;
    const ctx: Ctx = { user, ipAddress: getClientIp(req) };
    // Calls that reach Muqeem require the explicit confirmation the UI collects (confirmDialog).
    if (MUQEEM_CALL_ACTIONS.has(env.action) && (raw as { confirm?: unknown }).confirm !== true) {
      throw badRequest('يجب تأكيد العملية صراحةً قبل تنفيذها في منصة مقيم (confirm: true)');
    }

    switch (env.action) {
      case 'ISSUE':
        return await issue(issueSchema.parse(raw), ctx);
      case 'EXTEND':
        return await extend(extendSchema.parse(raw), ctx);
      case 'CANCEL':
        return await cancel(env.visaId, ctx);
      case 'REPRINT':
        return await reprint(env.visaId, ctx);
      case 'RECONCILE':
        return await reconcile(reconcileSchema.parse(raw), ctx);
      case 'SYNC':
        return await sync(env.visaId, ctx);
    }
    throw badRequest('إجراء غير معروف');
  } catch (err) {
    return handleApiError(toApiError(err), 'visas/muqeem:POST');
  }
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

async function loadVisa(visaId: string): Promise<LoadedVisa> {
  const visa = await prisma.visa.findUnique({
    where: { id: visaId },
    include: {
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
  if (!visa) throw notFound('التأشيرة غير موجودة');
  return visa;
}

/** Everything that must hold before any Muqeem call for this visa. Returns the company and iqama. */
function assertOperable(visa: LoadedVisa): { companyId: string; iqama: string } {
  if (visa.visaType !== EXIT_REENTRY_VISA_TYPE) throw badRequest('إجراءات مقيم في هذه الشاشة متاحة لتأشيرات الخروج والعودة فقط');
  const ineligible = residentIneligibility(visa.employee);
  if (ineligible) throw badRequest(ineligible);
  const cfg = muqeemConfig();
  if (!cfg.usable) throw new MuqeemError('NOT_CONFIGURED');
  const company = visa.employee.legalCompany;
  if (!company) {
    const base = new MuqeemError('NOT_LINKED').toHttpError();
    throw new HttpError(
      base.status,
      'لم تُحدَّد الشركة الكفيلة (الكيان القانوني) للموظف، وهي التي يُستخدم حسابها في مقيم. حدّدها في ملف الموظف أولاً.',
      base.details,
    );
  }
  if (!company.moiNumber?.trim() || !company.muqeemPlatformId) {
    const base = new MuqeemError('NOT_LINKED').toHttpError();
    throw new HttpError(base.status, `الشركة الكفيلة «${company.nameArabic}»: ${base.message}`, base.details);
  }
  return { companyId: company.id, iqama: (visa.employee.iqamaOrIdNumber ?? '').trim() };
}

function assertMuqeemIssued(visa: LoadedVisa): string {
  if (visa.status === 'CANCELLED') throw conflict('هذه التأشيرة ملغاة');
  const number = visa.externalVisaNumber?.trim();
  if (visa.status !== 'ISSUED' || !number) {
    throw conflict('هذه التأشيرة لم تُصدر عبر مقيم؛ التمديد والإلغاء وإعادة الطباعة من النظام متاحة للتأشيرات الصادرة عبر مقيم فقط');
  }
  return number;
}

/**
 * No new Muqeem call on a visa while (a) any previous call for it is undetermined (PENDING/UNKNOWN:
 * it may have been executed) or (b) a settled result is not applied to the record yet (the dates /
 * status we would act on are stale).
 */
async function assertSettled(visa: LoadedVisa): Promise<void> {
  const txs = await prisma.muqeemTransaction.findMany({
    where: { entityType: 'VISA', entityId: visa.id, operation: { in: [...VISA_MUQEEM_OPERATIONS] }, status: { in: [MUQEEM_TX_STATUS.PENDING, MUQEEM_TX_STATUS.UNKNOWN, MUQEEM_TX_STATUS.SUCCEEDED] } },
    select: { id: true, operation: true, status: true, requestSummary: true, createdAt: true },
  });
  const open = txs.find((t) => t.status !== MUQEEM_TX_STATUS.SUCCEEDED);
  if (open && open.status === MUQEEM_TX_STATUS.PENDING && Date.now() - open.createdAt.getTime() <= STALE_PENDING_MS) {
    throw conflict(
      `يوجد طلب «${VISA_MUQEEM_OPERATION_LABEL[open.operation as VisaMuqeemOperation] ?? open.operation}» لهذه التأشيرة قيد التنفيذ الآن في منصة مقيم (ربما نقرة مكررة). لا تُعِد الإرسال؛ انتظر قليلاً ثم حدّث الصفحة لمعرفة النتيجة.`,
      { muqeemTransactionId: open.id, status: open.status, operation: open.operation },
    );
  }
  if (open) {
    throw conflict(
      'يوجد طلب سابق على منصة مقيم لهذه التأشيرة لم تُحسم نتيجته بعد (قد يكون نُفِّذ). لا تُعِد المحاولة: تحقق من تقرير الخدمات التفاعلية في مقيم ثم قم بتسوية العملية من شاشة التأشيرات.',
      { muqeemTransactionId: open.id, status: open.status, operation: open.operation },
    );
  }
  if (pendingVisaSync(visa, txs)) {
    throw conflict('توجد نتيجة عملية مقيم مسجلة لم تُطبَّق على بيانات التأشيرة بعد. اضغط «تحديث بيانات التأشيرة» أولاً ثم راجعها.');
  }
}

function key(op: VisaMuqeemOperation, parts: string[]): string {
  return muqeemIdempotencyKey(op, ...parts);
}

/** A SUCCEEDED transaction for this key (the action was already done: never call Muqeem again). */
async function findSucceeded(idempotencyKey: string): Promise<MuqeemTransaction | null> {
  const row = await prisma.muqeemTransaction.findUnique({ where: { idempotencyKey } });
  return row && row.status === MUQEEM_TX_STATUS.SUCCEEDED ? row : null;
}

function employeeName(visa: LoadedVisa): string {
  return `${visa.employee.firstNameArabic ?? ''} ${visa.employee.lastNameArabic ?? ''}`.trim();
}

function toDate(key: unknown): Date | null {
  const k = typeof key === 'string' ? toDateKey(key) : null;
  return k ? new Date(`${k}T00:00:00.000Z`) : null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

async function reloadVisa(id: string) {
  return prisma.visa.findUniqueOrThrow({ where: { id }, include: { employee: { select: employeeSelect } } });
}

function txView(tx: MuqeemTransaction) {
  return { id: tx.id, operation: tx.operation, status: tx.status, externalRef: tx.externalRef, documentUrl: tx.documentUrl, completedAt: tx.completedAt };
}

// ---------------------------------------------------------------------------
// ISSUE
// ---------------------------------------------------------------------------

/** Writes an issued Muqeem visa onto the Visa record (fresh result, replay, or reconciliation). */
async function applyIssued(
  visa: LoadedVisa,
  tx: MuqeemTransaction,
  response: unknown,
  ctx: Ctx,
  source: 'MUQEEM' | 'MUQEEM_REPLAY' | 'MUQEEM_RECONCILED',
): Promise<void> {
  const req = parseSummary(tx.requestSummary);
  const f = issuedVisaFields(response);
  const externalVisaNumber = f.externalVisaNumber ?? tx.externalRef;
  if (!externalVisaNumber) throw new HttpError(500, 'نُفِّذت العملية في مقيم لكن لم يُعرف رقم التأشيرة؛ راجع مقيم وقم بتسوية العملية.');
  const returnBefore = f.returnBefore ?? toDate(req.expectedReturnBefore);
  const visaDurationDays = f.visaDurationDays ?? intOrNull(req.visaDuration) ?? intOrNull(req.expectedDays);
  await prisma.$transaction(async (db) => {
    await db.visa.update({
      where: { id: visa.id },
      data: {
        status: 'ISSUED',
        externalVisaNumber,
        visaDurationDays,
        returnBefore,
        ...(tx.documentUrl ? { visaPdfUrl: tx.documentUrl } : {}),
        issuedViaMuqeemAt: visa.issuedViaMuqeemAt ?? tx.completedAt ?? new Date(),
      },
    });
    await logAudit(
      {
        userId: ctx.user.id,
        action: 'APPROVE',
        entityType: 'Visa',
        entityId: visa.id,
        details: {
          status: 'ISSUED',
          via: source,
          externalVisaNumber,
          visaDurationDays,
          returnBefore: toDateKey(returnBefore),
          muqeemTransactionId: tx.id,
        },
        ipAddress: ctx.ipAddress,
      },
      db,
    );
  });
}

async function issue(input: z.infer<typeof issueSchema>, ctx: Ctx) {
  const visa = await loadVisa(input.visaId);
  const idempotencyKey = key('EXIT_REENTRY_ISSUE', visaMuqeemKeyParts('EXIT_REENTRY_ISSUE', visa));

  // Replay: already issued through Muqeem -> return the stored result, no call.
  const done = await findSucceeded(idempotencyKey);
  if (done) {
    // Only fills the record if a previous run stopped before saving it (never overwrites a later extension).
    if (!visa.externalVisaNumber && visa.status !== 'CANCELLED') await applyIssued(visa, done, parseSummary(done.responseSummary), ctx, 'MUQEEM_REPLAY');
    return NextResponse.json({
      alreadyDone: true,
      message: `هذه التأشيرة صدرت عبر مقيم مسبقاً برقم ${done.externalRef ?? '-'}؛ لم يُرسل أي طلب جديد إلى مقيم.`,
      visa: await reloadVisa(visa.id),
      transaction: txView(done),
    });
  }

  if (visa.status === 'ISSUED') throw conflict('تم تسجيل إصدار هذه التأشيرة يدوياً مسبقاً؛ لا يمكن إصدارها عبر مقيم مرة أخرى');
  if (visa.status === 'CANCELLED') throw conflict('هذه التأشيرة ملغاة ولا يمكن إصدارها');
  if (visa.status !== 'PAID') {
    throw conflict('لم تُسدَّد رسوم التأشيرة بعد: الإصدار عبر مقيم متاح بعد أن تؤكد الإدارة المالية سداد طلب الرسوم');
  }
  const { companyId, iqama } = assertOperable(visa);
  await assertSettled(visa);

  const today = todayKey();
  const duration: DurationInput = input.mode === 'days' ? { mode: 'days', days: input.days } : { mode: 'date', returnBefore: input.returnBefore };
  const plan = planIssue(duration, today);
  if (!plan.ok) throw badRequest(plan.error);
  const p = plan.value;

  const request: ExitReentryIssueRequest = {
    iqamaNumber: iqama,
    visaType: input.visaType,
    ...(p.visaDuration !== undefined ? { visaDuration: p.visaDuration } : {}),
    ...(p.returnBeforeHijri !== undefined ? { returnBefore: p.returnBeforeHijri } : {}),
  };

  const { alreadyDone, transaction, result } = await runMuqeemTransaction({
    operation: 'EXIT_REENTRY_ISSUE',
    idempotencyKey,
    companyId,
    employeeId: visa.employee.id,
    entity: { type: 'VISA', id: visa.id },
    user: ctx.user,
    ipAddress: ctx.ipAddress,
    requestSummary: {
      iqamaLast4: iqama.slice(-4),
      visaType: input.visaType,
      visaTypeLabel: VISA_MUQEEM_TYPE_LABEL[input.visaType],
      mode: input.mode,
      visaDuration: p.visaDuration ?? null,
      returnBeforeHijri: p.returnBeforeHijri ?? null,
      expectedReturnBefore: p.expectedReturnBefore,
      expectedDays: p.days,
      requestedOn: today,
    },
    execute: (client) => client.issueExitReentry(request),
    extractRef: (r) => r?.visaNumber,
    extractPdf: (r) => r?.ervisaPDF ?? null,
  });

  if (!alreadyDone) await applyIssued(visa, transaction, result, ctx, 'MUQEEM');
  else if (!visa.externalVisaNumber) await applyIssued(visa, transaction, parseSummary(transaction.responseSummary), ctx, 'MUQEEM_REPLAY');
  const pdfMissing = !transaction.documentUrl;
  return NextResponse.json({
    alreadyDone,
    message: alreadyDone
      ? `هذه التأشيرة صدرت عبر مقيم مسبقاً برقم ${transaction.externalRef ?? '-'}؛ لم يُرسل أي طلب جديد إلى مقيم.`
      : `تم إصدار تأشيرة الخروج والعودة في مقيم برقم ${transaction.externalRef ?? '-'} للموظف ${employeeName(visa)}.` +
        (pdfMissing ? ' تعذر حفظ نسخة PDF من التأشيرة؛ استخدم «إعادة طباعة» للحصول عليها.' : ''),
    visa: await reloadVisa(visa.id),
    transaction: txView(transaction),
  });
}

// ---------------------------------------------------------------------------
// EXTEND
// ---------------------------------------------------------------------------

async function applyExtended(visa: LoadedVisa, tx: MuqeemTransaction, response: unknown, ctx: Ctx, source: 'MUQEEM' | 'MUQEEM_REPLAY' | 'MUQEEM_RECONCILED'): Promise<void> {
  const req = parseSummary(tx.requestSummary);
  const f = extendedVisaFields(response);
  const returnBefore = f.returnBefore ?? toDate(req.newReturnBefore);
  const prevDuration = intOrNull(req.previousDuration) ?? visa.visaDurationDays;
  const extra = intOrNull(req.extraDays);
  const visaDurationDays = f.visaDurationDays ?? (prevDuration !== null && extra !== null ? prevDuration + extra : visa.visaDurationDays);
  await prisma.$transaction(async (db) => {
    // Only from the return-before this extension was based on: when two requests apply the same
    // executed extension at once (winner + a request answered from it), exactly one writes it.
    const updated = await db.visa.updateMany({ where: { id: visa.id, returnBefore: visa.returnBefore }, data: { returnBefore, visaDurationDays } });
    if (updated.count !== 1) return;
    await logAudit(
      {
        userId: ctx.user.id,
        action: 'UPDATE',
        entityType: 'Visa',
        entityId: visa.id,
        details: {
          muqeem: 'EXIT_REENTRY_EXTEND',
          via: source,
          externalVisaNumber: visa.externalVisaNumber,
          previousReturnBefore: toDateKey(visa.returnBefore),
          returnBefore: toDateKey(returnBefore),
          visaDurationDays,
          serviceCost: f.serviceCost,
          muqeemTransactionId: tx.id,
        },
        ipAddress: ctx.ipAddress,
      },
      db,
    );
  });
}

/**
 * Answer to an extension request whose key (visa + number + base return-before) already has a
 * SUCCEEDED transaction: no Muqeem call. When the stored extension asked for another date, the
 * message says so and never claims the new date. If the visa still shows the base date (the result
 * was settled elsewhere or not saved), the EXECUTED extension is applied to it.
 */
async function extensionAlreadyDone(visaId: string, base: string, done: MuqeemTransaction, requestedReturnBefore: string, ctx: Ctx) {
  const executed = toDateKey(parseSummary(done.requestSummary).newReturnBefore as string | null | undefined);
  const fresh = await loadVisa(visaId);
  let applied = false;
  if (toDateKey(fresh.returnBefore) === base && executed && executed !== base) {
    await applyExtended(fresh, done, parseSummary(done.responseSummary), ctx, 'MUQEEM_REPLAY');
    applied = true;
  }
  const differentRequest = !!executed && executed !== requestedReturnBefore;
  const message = differentRequest
    ? `سبق تنفيذ تمديد لهذه التأشيرة في مقيم من تاريخ العودة نفسه (${base}) حتى ${executed}، فلم يُطبَّق التاريخ المطلوب الآن (${requestedReturnBefore}) ولم يُرسل أي طلب جديد إلى مقيم.` +
      (applied ? ` وحُدّث تاريخ "العودة قبل" في النظام إلى ${executed} وفق ذلك التمديد.` : ' لتمديد إضافي حدّث الصفحة وابدأ من تاريخ العودة الحالي.')
    : `تم تمديد هذه التأشيرة حتى ${executed ?? requestedReturnBefore} مسبقاً؛ لم يُرسل أي طلب جديد إلى مقيم.` +
      (applied ? ' وحُدّث تاريخ "العودة قبل" في النظام وفقه.' : '');
  return NextResponse.json({
    alreadyDone: true,
    differentRequest,
    message,
    visa: await reloadVisa(visaId),
    transaction: txView(done),
  });
}

async function extend(input: z.infer<typeof extendSchema>, ctx: Ctx) {
  const visa = await loadVisa(input.visaId);
  const number = assertMuqeemIssued(visa);

  // The plan is computed from the return-before date the user saw, and the key is that BASE date
  // (not the requested new one): a repeated submit, or two different extensions sent at the same
  // moment, map to the same key -> one call; a stale page cannot extend twice.
  const duration: DurationInput = input.mode === 'days' ? { mode: 'days', days: input.days } : { mode: 'date', returnBefore: input.returnBefore };
  const plan = planExtension(input.baseReturnBefore, duration);
  if (!plan.ok) throw badRequest(plan.error);
  const p = plan.value;
  const idempotencyKey = key('EXIT_REENTRY_EXTEND', visaMuqeemKeyParts('EXIT_REENTRY_EXTEND', visa, input.baseReturnBefore));

  const done = await findSucceeded(idempotencyKey);
  if (done) return extensionAlreadyDone(visa.id, input.baseReturnBefore, done, p.newReturnBefore, ctx);
  if (toDateKey(visa.returnBefore) !== input.baseReturnBefore) {
    throw conflict('تغيّر تاريخ "العودة قبل" لهذه التأشيرة منذ فتح الصفحة (ربما مُدِّدت بالفعل). حدّث الصفحة وراجع التاريخ قبل أي تمديد جديد.');
  }
  const { companyId, iqama } = assertOperable(visa);
  await assertSettled(visa);

  const { alreadyDone, transaction, result } = await runMuqeemTransaction({
    operation: 'EXIT_REENTRY_EXTEND',
    idempotencyKey,
    companyId,
    employeeId: visa.employee.id,
    entity: { type: 'VISA', id: visa.id },
    user: ctx.user,
    ipAddress: ctx.ipAddress,
    requestSummary: {
      iqamaLast4: iqama.slice(-4),
      visaNumber: number,
      extraDays: p.extraDays,
      newReturnBefore: p.newReturnBefore,
      newReturnBeforeHijri: p.newReturnBeforeHijri,
      previousReturnBefore: input.baseReturnBefore,
      previousDuration: visa.visaDurationDays,
    },
    execute: (client) => client.extendExitReentry({ iqamaNumber: iqama, visaNumber: number, visaDuration: p.extraDays, returnBefore: p.newReturnBeforeHijri }),
    extractRef: (r) => r?.visaNumber ?? number,
  });

  // Lost the race to a request that finished first (possibly with another date): its result stands.
  if (alreadyDone) return extensionAlreadyDone(visa.id, input.baseReturnBefore, transaction, p.newReturnBefore, ctx);

  await applyExtended(visa, transaction, result, ctx, 'MUQEEM');
  const cost = extendedVisaFields(result).serviceCost;
  return NextResponse.json({
    alreadyDone: false,
    message:
      `تم تمديد التأشيرة ${number} في مقيم (${p.extraDays} يوماً إضافياً).` +
      (cost !== null ? ` الرسوم التي أعادتها مقيم: ${cost} ر.س.` : '') +
      ' استخدم «إعادة طباعة» للحصول على نسخة محدثة من التأشيرة.',
    visa: await reloadVisa(visa.id),
    transaction: txView(transaction),
  });
}

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

async function applyCancelled(visa: LoadedVisa, tx: MuqeemTransaction, ctx: Ctx, source: 'MUQEEM' | 'MUQEEM_RECONCILED'): Promise<void> {
  await prisma.$transaction(async (db) => {
    await db.visa.update({ where: { id: visa.id }, data: { status: 'CANCELLED' } });
    await logAudit(
      {
        userId: ctx.user.id,
        action: 'UPDATE',
        entityType: 'Visa',
        entityId: visa.id,
        details: { status: 'CANCELLED', via: source, externalVisaNumber: visa.externalVisaNumber, muqeemTransactionId: tx.id },
        ipAddress: ctx.ipAddress,
      },
      db,
    );
  });
}

async function cancel(visaId: string, ctx: Ctx) {
  const visa = await loadVisa(visaId);
  const number = visa.externalVisaNumber?.trim() ?? '';
  const idempotencyKey = number ? key('EXIT_REENTRY_CANCEL', visaMuqeemKeyParts('EXIT_REENTRY_CANCEL', visa)) : null;
  const done = idempotencyKey ? await findSucceeded(idempotencyKey) : null;
  if (done) {
    if (visa.status !== 'CANCELLED') await applyCancelled(visa, done, ctx, 'MUQEEM');
    return NextResponse.json({
      alreadyDone: true,
      message: `التأشيرة ${number} أُلغيت في مقيم مسبقاً؛ لم يُرسل أي طلب جديد إلى مقيم.`,
      visa: await reloadVisa(visa.id),
      transaction: txView(done),
    });
  }
  assertMuqeemIssued(visa);
  const { companyId, iqama } = assertOperable(visa);
  await assertSettled(visa);

  const { alreadyDone, transaction } = await runMuqeemTransaction({
    operation: 'EXIT_REENTRY_CANCEL',
    idempotencyKey: idempotencyKey as string,
    companyId,
    employeeId: visa.employee.id,
    entity: { type: 'VISA', id: visa.id },
    user: ctx.user,
    ipAddress: ctx.ipAddress,
    requestSummary: { iqamaLast4: iqama.slice(-4), visaNumber: number },
    execute: (client) => client.cancelExitReentry({ iqamaNumber: iqama, erVisaNumber: number }),
    extractRef: (r) => r?.visaNumber ?? number,
  });
  await applyCancelled(visa, transaction, ctx, 'MUQEEM');
  return NextResponse.json({
    alreadyDone,
    message: alreadyDone
      ? `التأشيرة ${number} أُلغيت في مقيم مسبقاً؛ لم يُرسل أي طلب جديد إلى مقيم.`
      : `تم إلغاء التأشيرة ${number} في مقيم، وأصبحت حالتها في النظام «ملغاة».`,
    visa: await reloadVisa(visa.id),
    transaction: txView(transaction),
  });
}

// ---------------------------------------------------------------------------
// REPRINT
// ---------------------------------------------------------------------------

async function reprint(visaId: string, ctx: Ctx) {
  const visa = await loadVisa(visaId);
  const number = assertMuqeemIssued(visa);
  // A completed reprint that brought back no stored PDF must not block a new attempt: count them.
  const baseParts = visaMuqeemKeyParts('EXIT_REENTRY_REPRINT', visa);
  const baseKey = key('EXIT_REENTRY_REPRINT', baseParts);
  const emptyReprints = await prisma.muqeemTransaction.count({
    where: {
      operation: 'EXIT_REENTRY_REPRINT',
      entityType: 'VISA',
      entityId: visa.id,
      status: MUQEEM_TX_STATUS.SUCCEEDED,
      documentUrl: null,
      idempotencyKey: { startsWith: baseKey },
    },
  });
  const idempotencyKey = emptyReprints ? key('EXIT_REENTRY_REPRINT', [...baseParts, `retry${emptyReprints}`]) : baseKey;

  let outcome = await findSucceeded(idempotencyKey).then((t) => (t ? { alreadyDone: true, transaction: t } : null));
  if (!outcome) {
    const { companyId, iqama } = assertOperable(visa);
    await assertSettled(visa);
    const r = await runMuqeemTransaction({
      operation: 'EXIT_REENTRY_REPRINT',
      idempotencyKey,
      companyId,
      employeeId: visa.employee.id,
      entity: { type: 'VISA', id: visa.id },
      user: ctx.user,
      ipAddress: ctx.ipAddress,
      requestSummary: { iqamaLast4: iqama.slice(-4), visaNumber: number },
      execute: (client) => client.reprintExitReentry({ iqamaNumber: iqama, visaNumber: number }),
      extractRef: (res) => res?.visaNumber ?? number,
      extractPdf: (res) => res?.ervisaPDF ?? null,
    });
    outcome = { alreadyDone: r.alreadyDone, transaction: r.transaction };
  }
  const { alreadyDone, transaction } = outcome;
  if (transaction.documentUrl && transaction.documentUrl !== visa.visaPdfUrl) {
    await prisma.$transaction(async (db) => {
      await db.visa.update({ where: { id: visa.id }, data: { visaPdfUrl: transaction.documentUrl } });
      await logAudit(
        {
          userId: ctx.user.id,
          action: 'UPDATE',
          entityType: 'Visa',
          entityId: visa.id,
          details: { muqeem: 'EXIT_REENTRY_REPRINT', externalVisaNumber: number, visaPdfUrl: transaction.documentUrl, muqeemTransactionId: transaction.id },
          ipAddress: ctx.ipAddress,
        },
        db,
      );
    });
  }
  return NextResponse.json({
    alreadyDone,
    message: !transaction.documentUrl
      ? 'نُفِّذ طلب إعادة الطباعة لكن مقيم لم يُرجع ملف PDF صالحاً أو تعذر حفظه.'
      : alreadyDone
        ? 'أُعيدت طباعة هذه النسخة من التأشيرة مسبقاً؛ هذا هو الملف المحفوظ (لم يُرسل طلب جديد إلى مقيم).'
        : `تم جلب نسخة جديدة من التأشيرة ${number} من مقيم وحفظها.`,
    visa: await reloadVisa(visa.id),
    transaction: txView(transaction),
  });
}

// ---------------------------------------------------------------------------
// RECONCILE (UNKNOWN / stale PENDING outcomes)
// ---------------------------------------------------------------------------

async function reconcile(input: z.infer<typeof reconcileSchema>, ctx: Ctx) {
  const visa = await loadVisa(input.visaId);
  const row = await prisma.muqeemTransaction.findUnique({ where: { id: input.muqeemTransactionId } });
  if (!row || row.entityType !== 'VISA' || row.entityId !== visa.id || !(VISA_MUQEEM_OPERATIONS as readonly string[]).includes(row.operation)) {
    throw notFound('عملية مقيم غير موجودة لهذه التأشيرة');
  }
  const op = row.operation as VisaMuqeemOperation;
  const externalRef = input.externalRef?.trim() || null;
  if (input.outcome === 'SUCCEEDED' && op === 'EXIT_REENTRY_ISSUE') {
    if (!externalRef || !/^\d{1,30}$/.test(externalRef)) throw badRequest('أدخل رقم التأشيرة كما يظهر في مقيم (أرقام فقط) لتسجيل الإصدار');
  }
  if (input.outcome === 'SUCCEEDED' && op === 'EXIT_REENTRY_REPRINT') {
    throw badRequest('إعادة الطباعة لا تغيّر شيئاً في مقيم ولا يُحفظ منها ملف عند التسوية: سجّلها كـ«لم تُنفَّذ» ثم أعد طلب إعادة الطباعة.');
  }
  if (input.outcome === 'SUCCEEDED' && op === 'EXIT_REENTRY_ISSUE' && visa.status === 'CANCELLED') {
    throw conflict('هذه التأشيرة ملغاة في النظام؛ لا يمكن تسجيلها كصادرة');
  }

  const fresh = await reconcileTransaction(
    row.id,
    input.outcome === 'SUCCEEDED' ? { status: 'SUCCEEDED', externalRef, note: input.note } : { status: 'FAILED', note: input.note },
    ctx.user,
    ctx.ipAddress,
  );

  let message: string;
  if (input.outcome === 'FAILED') {
    message = 'سُجّلت العملية كـ«لم تُنفَّذ في مقيم». يمكنك الآن إعادة المحاولة إذا لزم.';
  } else if (op === 'EXIT_REENTRY_ISSUE') {
    await applyIssued(visa, fresh, {}, ctx, 'MUQEEM_RECONCILED');
    message = `سُجّلت التأشيرة كصادرة برقم ${fresh.externalRef}. تاريخ "العودة قبل" المسجّل هو التاريخ المطلوب عند الإصدار؛ استخدم «إعادة طباعة» للحصول على نسخة التأشيرة الرسمية والتحقق من التاريخ.`;
  } else if (op === 'EXIT_REENTRY_EXTEND') {
    await applyExtended(visa, fresh, {}, ctx, 'MUQEEM_RECONCILED');
    message = 'سُجّل التمديد كمنفَّذ بالتاريخ المطلوب. استخدم «إعادة طباعة» للحصول على نسخة محدثة من التأشيرة.';
  } else if (op === 'EXIT_REENTRY_CANCEL') {
    await applyCancelled(visa, fresh, ctx, 'MUQEEM_RECONCILED');
    message = 'سُجّل الإلغاء كمنفَّذ وأصبحت حالة التأشيرة «ملغاة».';
  } else {
    message = 'تمت التسوية.';
  }
  return NextResponse.json({ message, visa: await reloadVisa(visa.id), transaction: txView(fresh) });
}

// ---------------------------------------------------------------------------
// SYNC: apply a settled operation to the visa record (no Muqeem call)
// ---------------------------------------------------------------------------

async function sync(visaId: string, ctx: Ctx) {
  const visa = await loadVisa(visaId);
  const txs = await prisma.muqeemTransaction.findMany({
    where: { entityType: 'VISA', entityId: visa.id, operation: { in: [...VISA_MUQEEM_OPERATIONS] }, status: MUQEEM_TX_STATUS.SUCCEEDED },
    orderBy: { createdAt: 'asc' },
  });
  const op = pendingVisaSync(visa, txs);
  let message = 'بيانات التأشيرة محدّثة؛ لا توجد نتيجة مقيم تحتاج إلى تطبيق.';
  if (op === 'EXIT_REENTRY_ISSUE') {
    const tx = txs.find((t) => t.operation === op) as MuqeemTransaction;
    await applyIssued(visa, tx, parseSummary(tx.responseSummary), ctx, 'MUQEEM_RECONCILED');
    message = `سُجّلت التأشيرة كصادرة برقم ${tx.externalRef ?? '-'} وفق نتيجة العملية المسجلة. استخدم «إعادة طباعة» للحصول على نسخة التأشيرة والتحقق من التواريخ.`;
  } else if (op === 'EXIT_REENTRY_CANCEL') {
    const tx = txs.find((t) => t.operation === op) as MuqeemTransaction;
    await applyCancelled(visa, tx, ctx, 'MUQEEM_RECONCILED');
    message = 'سُجّل إلغاء التأشيرة وفق نتيجة العملية المسجلة، وأصبحت حالتها «ملغاة».';
  } else if (op === 'EXIT_REENTRY_EXTEND') {
    const current = toDateKey(visa.returnBefore);
    const tx = txs.find((t) => t.operation === op && parseSummary(t.requestSummary).previousReturnBefore === current) as MuqeemTransaction;
    await applyExtended(visa, tx, parseSummary(tx.responseSummary), ctx, 'MUQEEM_RECONCILED');
    message = 'سُجّل تمديد التأشيرة وفق نتيجة العملية المسجلة. استخدم «إعادة طباعة» للحصول على نسخة محدثة.';
  }
  return NextResponse.json({ message, applied: op, visa: await reloadVisa(visa.id) });
}

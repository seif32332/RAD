import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import { DEDUCTION_STATUS, ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zDate, zId, zOptDate, zOptInt, zOptMoney, zOptText, zText } from '@/lib/validation';
import { dateKey, today, todayKey } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { logAudit, type AuditEntry } from '@/lib/audit';
import { dailyRate, releaseDeductionFromDraft } from '@/lib/payroll';

export const dynamic = 'force-dynamic';

type Tx = Prisma.TransactionClient;

/** Investigations link to deductions (penalties), so HR works on them together with legal. */
const INVESTIGATION_ROLES = [...new Set([...ROLE_GROUPS.LEGAL, ...ROLE_GROUPS.HR])];

const INV_STATUS = {
  OPENED: 'OPENED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUSPENDED: 'SUSPENDED',
  COMPLETED_GUILTY: 'COMPLETED_GUILTY',
  COMPLETED_INNOCENT: 'COMPLETED_INNOCENT',
  CLOSED: 'CLOSED',
} as const;

/** Investigations that have not reached a verdict yet. */
const OPEN_STATUSES: string[] = [INV_STATUS.OPENED, INV_STATUS.IN_PROGRESS, INV_STATUS.SUSPENDED];

const UPDATE_TARGETS = [INV_STATUS.IN_PROGRESS, INV_STATUS.COMPLETED_GUILTY, INV_STATUS.COMPLETED_INNOCENT, INV_STATUS.CLOSED] as const;
type UpdateTarget = (typeof UPDATE_TARGETS)[number];

const ALLOWED_FROM: Record<UpdateTarget, string[]> = {
  IN_PROGRESS: OPEN_STATUSES,
  COMPLETED_GUILTY: OPEN_STATUSES,
  COMPLETED_INNOCENT: OPEN_STATUSES,
  CLOSED: [...OPEN_STATUSES, INV_STATUS.COMPLETED_GUILTY, INV_STATUS.COMPLETED_INNOCENT],
};

/** Statuses carrying a verdict: findings / recommendation / final decision are frozen from here on. */
const VERDICT_STATUSES: string[] = [INV_STATUS.COMPLETED_GUILTY, INV_STATUS.COMPLETED_INNOCENT];

/** Article 70: a single violation's penalty may not exceed five days' wage. */
export const PENALTY_DAYS_MAX = 5;

/** How the employee was told of the hearing, recorded by the user (the system sends nothing itself). */
export const MANUAL_NOTICE_METHODS = {
  HAND_DELIVERY: 'خطاب مسلّم باليد',
  EMAIL: 'البريد الإلكتروني',
  SMS: 'رسالة نصية',
  PHONE: 'اتصال هاتفي',
  OTHER: 'طريقة أخرى',
} as const;
type ManualNoticeMethod = keyof typeof MANUAL_NOTICE_METHODS;
const MANUAL_NOTICE_KEYS = Object.keys(MANUAL_NOTICE_METHODS) as [ManualNoticeMethod, ...ManualNoticeMethod[]];

/** Prefix of the notes line recording a manual notice (the page looks for it). */
export const MANUAL_NOTICE_PREFIX = '[إبلاغ يدوي]';

/** Deduction statuses that are waiting for an investigation outcome. */
const AWAITING_INVESTIGATION: string[] = [DEDUCTION_STATUS.UNDER_INVESTIGATION, DEDUCTION_STATUS.PENDING_INVESTIGATION];

/** Deductions that may still be referred to an investigation. */
const NOT_REFERABLE: string[] = [DEDUCTION_STATUS.WAIVED, DEDUCTION_STATUS.REJECTED, DEDUCTION_STATUS.UNDER_INVESTIGATION];

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
/** Optional text where a blank value means "leave unchanged". */
const zKeepText = (max = 5000) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const envelopeSchema = z.object({
  action: z.enum(['CREATE', 'UPDATE_STATUS', 'SUSPEND', 'ATTACH'], {
    errorMap: () => ({ message: 'إجراء غير معروف' }),
  }),
  payload: z.unknown(),
});

const createSchema = z.object({
  employeeId: zId,
  subject: zText(500),
  description: zOptText(5000),
  category: z.preprocess(blankToUndefined, z.enum(['ATTENDANCE', 'BEHAVIORAL', 'SERIOUS', 'PERFORMANCE']).optional()),
  severity: z.preprocess(blankToUndefined, z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH')),
  investigatorName: zOptText(200),
  investigatorRole: zOptText(200),
  committeeMember3: zOptText(200),
  notes: zOptText(5000),
  investigationDate: zOptDate,
  investigationTime: z.preprocess(
    blankToUndefined,
    z.string().trim().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'وقت غير صالح').optional(),
  ),
  /**
   * Legacy flag from older clients. IGNORED: the system sends no notice to the employee, so it
   * must never be recorded as sent. A manual notice is recorded with the three fields below.
   */
  sendNotification: z.preprocess(blankToUndefined, zBool.optional()),
  /** The user states the employee was told of the hearing outside the system (method + date required). */
  employeeNotifiedManually: z.preprocess(blankToUndefined, zBool.optional()),
  notificationMethod: z.preprocess(
    blankToUndefined,
    z.enum(MANUAL_NOTICE_KEYS, { errorMap: () => ({ message: 'طريقة الإبلاغ غير صالحة' }) }).optional(),
  ),
  notificationDate: zOptDate,
  suspendEmployee: z.preprocess(blankToUndefined, zBool.optional()),
  deductionId: z.preprocess(blankToUndefined, zId.optional()),
});

const updateStatusSchema = z.object({
  id: zId,
  status: z.enum(UPDATE_TARGETS, { errorMap: () => ({ message: 'حالة التحقيق غير صالحة' }) }),
  findings: zKeepText(),
  recommendation: zKeepText(),
  finalDecision: zKeepText(),
  notes: zKeepText(),
  penaltyAmount: zOptMoney,
  penaltyDays: z.preprocess(
    blankToUndefined,
    zOptInt
      .refine((n) => n === undefined || n >= 0, 'عدد أيام الجزاء غير صالح')
      .refine((n) => n === undefined || n <= PENALTY_DAYS_MAX, `لا يجوز أن يتجاوز الجزاء أجر ${PENALTY_DAYS_MAX} أيام عن المخالفة الواحدة (المادة 70)`),
  ),
});

const suspendSchema = z.object({
  id: zId,
  suspensionStartDate: zDate,
  suspensionEndDate: zOptDate,
});

const attachSchema = z.object({
  id: zId,
  attachmentUrl: zText(2000),
});

export async function GET() {
  try {
    await requireUser(INVESTIGATION_ROLES);
    const investigations = await prisma.investigation.findMany({
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstNameArabic: true,
            lastNameArabic: true,
            jobTitle: true,
            branch: { select: { nameArabic: true } },
          },
        },
        deductions: {
          select: { id: true, reason: true, category: true, violationType: true, date: true, amount: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(investigations);
  } catch (err) {
    return handleApiError(err, 'legal/investigations:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(INVESTIGATION_ROLES);
    const { action, payload } = await parseBody(req, envelopeSchema);
    const ipAddress = getClientIp(req);

    if (action === 'CREATE') {
      const data = createSchema.parse(payload ?? {});
      const noticeProblem = manualNoticeProblem(data);
      if (noticeProblem) throw badRequest(noticeProblem);
      const { investigation, audits } = await prisma.$transaction((tx) => createInvestigation(tx, data, user, ipAddress));
      await Promise.all(audits.map((a) => logAudit(a)));
      return NextResponse.json({ message: 'تم فتح ملف التحقيق بنجاح', data: investigation });
    }

    if (action === 'UPDATE_STATUS') {
      const data = updateStatusSchema.parse(payload ?? {});
      const { investigation, audits } = await prisma.$transaction((tx) => updateInvestigationStatus(tx, data, user, ipAddress));
      await Promise.all(audits.map((a) => logAudit(a)));
      return NextResponse.json({ message: 'تم تحديث التحقيق', data: investigation });
    }

    if (action === 'SUSPEND') {
      const data = suspendSchema.parse(payload ?? {});
      if (data.suspensionEndDate && data.suspensionEndDate < data.suspensionStartDate) {
        throw badRequest('تاريخ نهاية الإيقاف يجب أن يكون بعد تاريخ بدايته');
      }
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.investigation.updateMany({
          where: { id: data.id, status: { in: OPEN_STATUSES } },
          data: {
            isSuspended: true,
            suspensionStartDate: data.suspensionStartDate,
            suspensionEndDate: data.suspensionEndDate ?? null,
            status: INV_STATUS.IN_PROGRESS,
          },
        });
        if (res.count === 0) await throwGuardFailure(tx, data.id, 'لا يمكن إيقاف الموظف لأن ملف التحقيق مغلق');
        return tx.investigation.findUniqueOrThrow({ where: { id: data.id } });
      });
      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Investigation',
        entityId: data.id,
        details: {
          suspended: true,
          suspensionStartDate: dateKey(data.suspensionStartDate),
          suspensionEndDate: dateKey(data.suspensionEndDate ?? null),
        },
        ipAddress,
      });
      // The suspension is recorded on the case file only; the employee record is not changed.
      return NextResponse.json({ message: 'تم تسجيل الإيقاف عن العمل في ملف التحقيق', data: updated });
    }

    // ATTACH
    const data = attachSchema.parse(payload ?? {});
    const updated = await prisma.investigation.update({
      where: { id: data.id },
      data: { attachmentUrl: data.attachmentUrl },
    });
    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Investigation',
      entityId: data.id,
      details: { attachmentUrl: data.attachmentUrl },
      ipAddress,
    });
    return NextResponse.json({ message: 'تم رفع المرفق', data: updated });
  } catch (err) {
    return handleApiError(err, 'legal/investigations:POST');
  }
}

// ---------------------------------------------------------------------------
// Workflow helpers (run inside a transaction)
// ---------------------------------------------------------------------------

async function throwGuardFailure(tx: Tx, id: string, message: string): Promise<never> {
  const exists = await tx.investigation.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw notFound('ملف التحقيق غير موجود');
  throw conflict(message);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in src/lib/__tests__/c2-discipline.test.ts)
// ---------------------------------------------------------------------------

export interface CreateNotesInput {
  notes?: string | null;
  committeeMember3?: string | null;
  investigationDate?: Date | null;
  investigationTime?: string | null;
  /** Ignored on purpose: nothing is sent by the system, so nothing is recorded as sent. */
  sendNotification?: boolean | null;
  employeeNotifiedManually?: boolean | null;
  notificationMethod?: ManualNoticeMethod | null;
  notificationDate?: Date | null;
}

/** Arabic error for an incomplete / impossible manual-notice record, or null when acceptable. */
export function manualNoticeProblem(data: CreateNotesInput, now: Date = new Date()): string | null {
  if (!data.employeeNotifiedManually) return null;
  if (!data.notificationMethod) return 'يرجى تحديد طريقة إبلاغ الموظف';
  if (!data.notificationDate) return 'يرجى تحديد تاريخ إبلاغ الموظف';
  if (data.notificationDate.getTime() > today(now).getTime()) return 'تاريخ إبلاغ الموظف لا يمكن أن يكون في المستقبل';
  return null;
}

/**
 * Notes written when the case is opened. It records only facts the user entered: the hearing
 * time, the third committee member and, when the user says so, a manual notice (method + date).
 * It never states that the system notified the employee (`sendNotification` is ignored).
 */
export function buildCreateNotes(data: CreateNotesInput, recordedBy?: string | null): string | null {
  let notes = data.notes ?? '';
  if (data.committeeMember3) {
    const member = `عضو لجنة 3: ${data.committeeMember3}`;
    notes = notes ? `${notes} | ${member}` : member;
  }
  if (data.investigationDate && data.investigationTime) {
    const when = `موعد التحقيق: ${dateKey(data.investigationDate)} الساعة ${data.investigationTime}`;
    notes = notes ? `${when} \n ${notes}` : when;
  }
  if (data.employeeNotifiedManually && data.notificationMethod && data.notificationDate) {
    const who = recordedBy?.trim() ? `سجّله ${recordedBy.trim()}` : 'مسجّل من المستخدم';
    const line = `${MANUAL_NOTICE_PREFIX} أُبلغ الموظف بموعد التحقيق خارج النظام بطريقة: ${MANUAL_NOTICE_METHODS[data.notificationMethod]}، بتاريخ ${dateKey(data.notificationDate)} (${who}).`;
    notes = notes ? `${notes} \n ${line}` : line;
  }
  return notes || null;
}

export interface VerdictText {
  findings?: string | null;
  recommendation?: string | null;
  finalDecision?: string | null;
}

/**
 * Verdict fields a request tries to change on a file that already has a verdict. Sending the
 * stored text again is not a change; a blank value means "leave unchanged" upstream.
 */
export function changedVerdictFields(stored: VerdictText, requested: VerdictText): (keyof VerdictText)[] {
  const keys: (keyof VerdictText)[] = ['findings', 'recommendation', 'finalDecision'];
  return keys.filter((k) => {
    const next = requested[k];
    if (next === undefined || next === null) return false;
    return next.trim() !== (stored[k] ?? '').trim();
  });
}

/** True when a guilty verdict has no written findings (neither in the request nor stored). */
export function guiltyWithoutFindings(stored: Pick<VerdictText, 'findings'>, requested: Pick<VerdictText, 'findings'>): boolean {
  const text = requested.findings ?? stored.findings ?? '';
  return text.trim() === '';
}

/**
 * Appends a dated entry to the case notes. Earlier text is never rewritten: after the verdict
 * the entry is an addendum (ملحق); before it, a dated note.
 */
export function appendDatedNote(
  existing: string | null | undefined,
  text: string,
  opts: { date: string; by?: string | null; afterVerdict: boolean },
): string {
  const label = opts.afterVerdict ? 'ملحق' : 'ملاحظة';
  const by = opts.by?.trim() ? ` - ${opts.by.trim()}` : '';
  const entry = `[${label} بتاريخ ${opts.date}${by}]: ${text.trim()}`;
  return existing && existing.trim() ? `${existing} \n ${entry}` : entry;
}

/**
 * Suspension fields once the case reaches a verdict or is closed: the suspension is lifted and
 * its end date is the stored one if already past, otherwise today. Null when nothing to lift.
 */
export function liftedSuspension(
  current: { isSuspended: boolean; suspensionEndDate: Date | null },
  now: Date = new Date(),
): { isSuspended: false; suspensionEndDate: Date } | null {
  if (!current.isSuspended) return null;
  const t = today(now);
  const end = current.suspensionEndDate && current.suspensionEndDate.getTime() <= t.getTime() ? current.suspensionEndDate : t;
  return { isSuspended: false, suspensionEndDate: end };
}

async function createInvestigation(tx: Tx, data: z.infer<typeof createSchema>, user: AuthUser, ipAddress: string) {
  const employee = await tx.employee.findUnique({ where: { id: data.employeeId }, select: { id: true } });
  if (!employee) throw notFound('الموظف غير موجود');

  const suspend = data.suspendEmployee === true;
  const investigation = await tx.investigation.create({
    data: {
      employeeId: data.employeeId,
      subject: data.subject,
      description: data.description ?? null,
      category: data.category ?? null,
      severity: data.severity,
      investigatorName: data.investigatorName ?? null,
      investigatorRole: data.investigatorRole ?? null,
      isSuspended: suspend,
      suspensionStartDate: suspend ? today() : null,
      status: suspend ? INV_STATUS.SUSPENDED : INV_STATUS.OPENED,
      notes: buildCreateNotes(data, user.name),
    },
  });

  const audits: AuditEntry[] = [
    {
      userId: user.id,
      action: 'CREATE',
      entityType: 'Investigation',
      entityId: investigation.id,
      details: {
        employeeId: data.employeeId,
        subject: data.subject,
        suspended: suspend,
        deductionId: data.deductionId ?? null,
        manualNotice: data.employeeNotifiedManually
          ? { method: data.notificationMethod ?? null, date: dateKey(data.notificationDate ?? null) }
          : null,
      },
      ipAddress,
    },
  ];

  // Refer the related violation (if any) to this investigation.
  if (data.deductionId) {
    const deduction = await tx.deduction.findUnique({
      where: { id: data.deductionId },
      select: { id: true, employeeId: true, amount: true, status: true, payrollMonth: true, isLinkedToPayroll: true, investigationId: true },
    });
    if (!deduction) throw notFound('المخالفة المرتبطة غير موجودة');
    if (deduction.employeeId !== data.employeeId) throw badRequest('المخالفة المرتبطة لا تخص الموظف المحال للتحقيق');

    const res = await tx.deduction.updateMany({
      where: {
        id: deduction.id,
        investigationId: null,
        isLinkedToPayroll: false,
        status: { notIn: NOT_REFERABLE },
      },
      data: {
        isReferredToInvestigation: true,
        investigationId: investigation.id,
        status: DEDUCTION_STATUS.UNDER_INVESTIGATION,
      },
    });
    if (res.count === 0) throw conflict('لا يمكن إحالة هذه المخالفة للتحقيق (محالة مسبقاً أو مُعالجة أو مخصومة في مسير معتمد)');
    // A referred violation is no longer payable: free it from any draft payroll that reserved it.
    await releaseDeductionFromDraft(tx, deduction);
    audits.push({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Deduction',
      entityId: deduction.id,
      details: { status: DEDUCTION_STATUS.UNDER_INVESTIGATION, investigationId: investigation.id },
      ipAddress,
    });
  }

  return { investigation, audits };
}

async function updateInvestigationStatus(tx: Tx, data: z.infer<typeof updateStatusSchema>, user: AuthUser, ipAddress: string) {
  const current = await tx.investigation.findUnique({
    where: { id: data.id },
    select: {
      id: true,
      status: true,
      subject: true,
      category: true,
      severity: true,
      employeeId: true,
      findings: true,
      recommendation: true,
      finalDecision: true,
      notes: true,
      isSuspended: true,
      suspensionEndDate: true,
      employee: { select: { basicSalary: true, allowances: { select: { amount: true, isMonthly: true } } } },
    },
  });
  if (!current) throw notFound('ملف التحقيق غير موجود');

  const target = data.status;
  if (!ALLOWED_FROM[target].includes(current.status)) {
    throw conflict(
      current.status === target
        ? 'تم اعتماد هذه الحالة لملف التحقيق مسبقاً'
        : 'تمت معالجة ملف التحقيق مسبقاً أو أن الانتقال للحالة المطلوبة غير مسموح',
    );
  }
  const afterVerdict = VERDICT_STATUSES.includes(current.status);
  if (afterVerdict && changedVerdictFields(current, data).length > 0) {
    throw conflict('نتائج التحقيق والتوصية والقرار النهائي مقفلة بعد صدور القرار ولا يمكن تعديلها. أضف أي توضيح كملحق في الملاحظات.');
  }
  if (target === INV_STATUS.COMPLETED_GUILTY && guiltyWithoutFindings(current, data)) {
    throw badRequest('لا يمكن اعتماد الإدانة دون كتابة نتائج التحقيق');
  }
  const concluding = OPEN_STATUSES.includes(current.status) && target !== INV_STATUS.IN_PROGRESS;

  // Financial penalty (only meaningful for a guilty verdict).
  const penaltyDays = target === INV_STATUS.COMPLETED_GUILTY ? (data.penaltyDays ?? 0) : 0;
  const perDay = penaltyDays > 0 ? dailyRate(current.employee) : 0;
  let penaltyAmount = 0;
  if (target === INV_STATUS.COMPLETED_GUILTY) {
    penaltyAmount = data.penaltyAmount !== undefined && data.penaltyAmount > 0
      ? roundMoney(data.penaltyAmount)
      : roundMoney(perDay * penaltyDays);
    // Article 70 also bounds an amount typed directly (guard only, no amount is recomputed).
    const rate = dailyRate(current.employee);
    const cap = roundMoney(rate * PENALTY_DAYS_MAX);
    if (rate > 0 && penaltyAmount > cap) {
      throw badRequest(`مبلغ الجزاء يتجاوز أجر ${PENALTY_DAYS_MAX} أيام للموظف (${cap} ر.س)، ولا يجوز ذلك عن المخالفة الواحدة (المادة 70)`);
    }
  }

  const update: Prisma.InvestigationUpdateManyMutationInput = { status: target };
  if (!afterVerdict) {
    // Before the verdict the text is still being written; from the verdict on it is frozen.
    if (data.findings !== undefined) update.findings = data.findings;
    if (data.recommendation !== undefined) update.recommendation = data.recommendation;
    if (data.finalDecision !== undefined) update.finalDecision = data.finalDecision;
  }
  // Notes are append-only: the text recorded at opening (hearing time, notice) is never overwritten.
  const addendum = data.notes;
  if (addendum !== undefined) {
    update.notes = appendDatedNote(current.notes, addendum, { date: todayKey(), by: user.name, afterVerdict });
  }
  if (target === INV_STATUS.COMPLETED_GUILTY) {
    if (data.penaltyAmount !== undefined || penaltyAmount > 0) update.penaltyAmount = penaltyAmount;
    if (data.penaltyDays !== undefined) update.penaltyDays = penaltyDays;
  }
  // A verdict or closure ends any suspension recorded on the file.
  const lifted = target !== INV_STATUS.IN_PROGRESS ? liftedSuspension(current) : null;
  if (lifted) Object.assign(update, lifted);

  // Atomic guard on the exact previous status (and notes, when appending): a double submit /
  // concurrent change can never apply the verdict side effects twice or lose an addendum.
  const res = await tx.investigation.updateMany({
    where: { id: data.id, status: current.status, ...(addendum !== undefined ? { notes: current.notes } : {}) },
    data: update,
  });
  if (res.count === 0) {
    await throwGuardFailure(tx, data.id, 'تم تعديل ملف التحقيق من مستخدم آخر، يرجى تحديث الصفحة');
  }

  const auditAction: AuditEntry['action'] =
    target === INV_STATUS.IN_PROGRESS ? 'UPDATE'
      : target === INV_STATUS.COMPLETED_INNOCENT ? 'REJECT'
        : target === INV_STATUS.CLOSED ? 'CLOSE'
          : 'APPROVE';
  const audits: AuditEntry[] = [
    {
      userId: user.id,
      action: auditAction,
      entityType: 'Investigation',
      entityId: data.id,
      details: {
        from: current.status,
        to: target,
        penaltyAmount: penaltyAmount || null,
        penaltyDays: penaltyDays || null,
        // The verdict text as recorded at the moment of the decision.
        ...(!afterVerdict && target !== INV_STATUS.IN_PROGRESS
          ? {
              findings: data.findings ?? current.findings ?? null,
              recommendation: data.recommendation ?? current.recommendation ?? null,
              finalDecision: data.finalDecision ?? current.finalDecision ?? null,
            }
          : {}),
        ...(addendum !== undefined ? { addendum, previousNotes: current.notes ?? null } : {}),
        ...(lifted ? { suspensionLifted: true, suspensionEndDate: dateKey(lifted.suspensionEndDate) } : {}),
      },
      ipAddress,
    },
  ];

  if (concluding) {
    const linked = await tx.deduction.findMany({
      where: { investigationId: data.id, status: { in: AWAITING_INVESTIGATION }, isLinkedToPayroll: false },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const linkedIds = linked.map((d) => d.id);

    if (target === INV_STATUS.COMPLETED_INNOCENT) {
      // Innocent: the referred violations are dropped.
      if (linkedIds.length) {
        await tx.deduction.updateMany({
          where: { id: { in: linkedIds }, status: { in: AWAITING_INVESTIGATION }, isLinkedToPayroll: false },
          data: { status: DEDUCTION_STATUS.WAIVED, approvedBy: user.name, approvedAt: new Date() },
        });
      }
      for (const id of linkedIds) {
        audits.push({ userId: user.id, action: 'UPDATE', entityType: 'Deduction', entityId: id, details: { status: DEDUCTION_STATUS.WAIVED, investigationId: data.id }, ipAddress });
      }
    } else {
      // Guilty (or closed without a verdict): the violations go back to HR for amount approval.
      let remaining = linkedIds;
      const hasPenalty = target === INV_STATUS.COMPLETED_GUILTY && (penaltyAmount > 0 || penaltyDays > 0);
      if (hasPenalty) {
        const penaltyData = {
          amount: penaltyAmount,
          deductionDays: penaltyDays,
          dailySalary: perDay > 0 ? perDay : null,
          hasFinancialImpact: penaltyAmount > 0,
          status: DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL,
        };
        if (linkedIds.length) {
          // The investigation's penalty replaces the amount of the violation that triggered it.
          const [first, ...rest] = linkedIds;
          await tx.deduction.update({ where: { id: first }, data: penaltyData });
          audits.push({ userId: user.id, action: 'UPDATE', entityType: 'Deduction', entityId: first, details: { ...penaltyData, investigationId: data.id }, ipAddress });
          remaining = rest;
        } else {
          const created = await tx.deduction.create({
            data: {
              ...penaltyData,
              employeeId: current.employeeId,
              date: today(),
              reason: `جزاء تحقيق إداري: ${current.subject}`.slice(0, 500),
              category: current.category ?? 'SERIOUS',
              severity: current.severity,
              isReferredToInvestigation: true,
              investigationId: data.id,
              issuedBy: user.name,
            },
            select: { id: true },
          });
          audits.push({ userId: user.id, action: 'CREATE', entityType: 'Deduction', entityId: created.id, details: { ...penaltyData, investigationId: data.id }, ipAddress });
        }
      }
      if (remaining.length) {
        await tx.deduction.updateMany({
          where: { id: { in: remaining }, status: { in: AWAITING_INVESTIGATION }, isLinkedToPayroll: false },
          data: { status: DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL },
        });
        for (const id of remaining) {
          audits.push({ userId: user.id, action: 'UPDATE', entityType: 'Deduction', entityId: id, details: { status: DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL, investigationId: data.id }, ipAddress });
        }
      }
    }
  }

  const investigation = await tx.investigation.findUniqueOrThrow({ where: { id: data.id } });
  return { investigation, audits };
}

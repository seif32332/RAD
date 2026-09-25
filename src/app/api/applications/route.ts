import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { sendMail, type MailResult } from '@/lib/mailer';
import {
  APPLICATION_STATUS,
  APPLICATION_STATUS_VALUES,
  APPLICATION_TRANSITIONS,
  JOB_REQUEST_OPEN_STATUS,
  type ApplicationStatus,
  buildOfferEmail,
  zOptDateTime,
  zOptEmail,
  zPhone,
  zStaffResumeUrl,
} from '@/app/api/recruitment/shared';

export const dynamic = 'force-dynamic';

const applicationInclude = {
  jobRequest: {
    select: {
      jobTitle: true,
      department: { select: { nameArabic: true } },
      status: true,
    },
  },
} satisfies Prisma.JobApplicationInclude;

const createSchema = z.object({
  jobRequestId: zId,
  candidateName: zText(150),
  candidatePhone: zPhone,
  candidateEmail: zOptEmail,
  resumeUrl: zStaffResumeUrl,
  notes: zOptText(4000),
  interviewDate: zOptDateTime,
});

const updateStatusSchema = z.object({
  actionType: z.literal('UPDATE_STATUS'),
  payload: z.object({
    id: zId,
    status: z.enum(APPLICATION_STATUS_VALUES),
    interviewDate: zOptDateTime,
    /** Internal HR note. Appended to the notes log (never replaces it) and never e-mailed. */
    notes: zOptText(4000),
    /** Offer wording e-mailed to the candidate. Required when moving to OFFERED. */
    offerText: zOptText(4000),
  }),
});

/** Stage names used in the notes log lines. */
const STAGE_LABELS: Record<ApplicationStatus, string> = {
  APPLIED: 'إعادة إلى الفرز',
  INTERVIEW: 'مقابلة',
  OFFERED: 'عرض وظيفي',
  HIRED: 'توظيف',
  REJECTED: 'استبعاد',
};

const NOTES_MAX = 20000;

/** "2026-09-25 14:05" in Riyadh time. */
function riyadhStamp(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * Appends dated, signed entries to the application notes. What the candidate wrote (e.g. the
 * expected salary on the first line) stays at the top; earlier HR entries are never overwritten.
 */
function appendNoteEntries(previous: string | null, entries: readonly string[], author: string, stage: ApplicationStatus, now: Date): string | null {
  const texts = entries.map((e) => e.trim()).filter((e) => e.length > 0);
  if (texts.length === 0) return previous;
  const safeAuthor = author.replace(/[\r\n[\]]+/g, ' ').trim() || 'مستخدم';
  const header = `[${riyadhStamp(now)} · ${safeAuthor} · ${STAGE_LABELS[stage]}]`;
  const block = texts.map((t) => `${header} ${t}`).join('\n');
  const base = previous?.trimEnd() ?? '';
  const next = base ? `${base}\n\n${block}` : block;
  if (next.length > NOTES_MAX) throw badRequest('سجل ملاحظات هذا المرشح بلغ الحد الأقصى للطول');
  return next;
}

const EMAIL_FAILURE_MESSAGES: Record<NonNullable<MailResult['reason']>, string> = {
  NOT_CONFIGURED: 'لم يتم إرسال البريد لأن خادم البريد (SMTP) غير مُعد في النظام',
  INVALID_RECIPIENT: 'لم يتم إرسال البريد لأن بريد المرشح غير صالح',
  TIMEOUT: 'تعذر الاتصال بخادم البريد، لم يتم إرسال العرض بريدياً',
  SEND_FAILED: 'فشل إرسال البريد للمرشح، يرجى التواصل معه مباشرة',
};

/** GET: all applications + open vacancies (for the manual "add CV" form). HR only. */
export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.HR);
    const [applications, activeJobs] = await Promise.all([
      prisma.jobApplication.findMany({ include: applicationInclude, orderBy: { createdAt: 'desc' } }),
      prisma.jobRequest.findMany({
        where: { status: JOB_REQUEST_OPEN_STATUS },
        select: { id: true, jobTitle: true, department: { select: { nameArabic: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return NextResponse.json({ applications, activeJobs });
  } catch (err) {
    return handleApiError(err, 'applications:GET');
  }
}

/**
 * POST { actionType: 'UPDATE_STATUS', payload: { id, status, interviewDate?, notes?, offerText? } }
 *   -> moves the candidate in the pipeline. `notes` is appended to the internal notes log as a dated,
 *      signed line (never replaces it). OFFERED requires `offerText`, which alone makes up the offer
 *      e-mail (sent when the candidate has an e-mail and SMTP is set).
 *   Response adds { emailSent, emailStatus } ('SENT' | 'NOT_REQUIRED' | failure reason).
 * POST { jobRequestId, candidateName, candidatePhone, candidateEmail?, resumeUrl?, notes? }
 *   -> HR adds a CV manually to an open vacancy.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const ip = getClientIp(req);
    const raw = await parseBody(req, z.object({ actionType: z.string().max(50).optional() }).passthrough());

    if (raw.actionType === 'UPDATE_STATUS') {
      const { id, status, interviewDate, notes, offerText } = updateStatusSchema.parse(raw).payload;
      if (status === APPLICATION_STATUS.INTERVIEW && !interviewDate) throw badRequest('يرجى تحديد موعد المقابلة');
      // HR-09: the offer e-mail is built only from this field, never from the internal notes.
      if (status === APPLICATION_STATUS.OFFERED && !offerText) {
        throw badRequest('يرجى كتابة نص العرض الوظيفي الذي سيصل إلى المرشح');
      }
      const internalNote = notes ?? '';
      const offerForCandidate = status === APPLICATION_STATUS.OFFERED ? (offerText ?? '') : '';

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.jobApplication.findUnique({ where: { id }, select: { notes: true } });
        if (!current) throw notFound('طلب التوظيف غير موجود');

        const data: Prisma.JobApplicationUpdateManyMutationInput = { status };
        if (interviewDate !== undefined) data.interviewDate = interviewDate;
        const entries = [offerForCandidate ? `نص العرض الوظيفي: ${offerForCandidate}` : '', internalNote];
        const nextNotes = appendNoteEntries(current.notes, entries, user.name, status, new Date());
        if (nextNotes !== current.notes) data.notes = nextNotes;

        // notes in the filter: a concurrent edit makes this a conflict instead of a lost entry.
        const res = await tx.jobApplication.updateMany({
          where: { id, status: { in: [...APPLICATION_TRANSITIONS[status]] }, notes: current.notes },
          data,
        });
        if (res.count === 0) {
          throw conflict('لا يمكن نقل المرشح إلى هذه المرحلة من مرحلته الحالية، أو عُدّل ملفه للتو. يرجى تحديث الصفحة');
        }
        await logAudit(
          {
            userId: user.id,
            action: status === APPLICATION_STATUS.REJECTED ? 'REJECT' : status === APPLICATION_STATUS.HIRED ? 'APPROVE' : 'UPDATE',
            entityType: 'JobApplication',
            entityId: id,
            details: {
              status,
              interviewDate: interviewDate ?? undefined,
              noteAdded: internalNote.trim().length > 0 || undefined,
              offerTextLength: offerForCandidate ? offerForCandidate.length : undefined,
            },
            ipAddress: ip,
          },
          tx,
        );
        return tx.jobApplication.findUniqueOrThrow({ where: { id }, include: applicationInclude });
      });

      // Offer e-mail: sent after the commit, bounded by the mailer timeout; never fails the request.
      let emailStatus: 'SENT' | 'NOT_REQUIRED' | NonNullable<MailResult['reason']> = 'NOT_REQUIRED';
      if (status === APPLICATION_STATUS.OFFERED && updated.candidateEmail) {
        const { subject, html } = buildOfferEmail({
          candidateName: updated.candidateName,
          jobTitle: updated.jobRequest?.jobTitle,
          departmentName: updated.jobRequest?.department?.nameArabic,
          offerDetails: offerForCandidate,
        });
        const result = await sendMail({ to: updated.candidateEmail, subject, html });
        emailStatus = result.sent ? 'SENT' : (result.reason ?? 'SEND_FAILED');
        await logAudit({
          userId: user.id,
          action: 'UPDATE',
          entityType: 'JobApplicationEmail',
          entityId: id,
          details: { type: 'OFFER', emailStatus },
          ipAddress: ip,
        });
      }

      const emailSent = emailStatus === 'SENT';
      const message =
        emailStatus === 'SENT'
          ? 'تم تحديث الحالة وإرسال العرض الوظيفي للمرشح بريدياً'
          : emailStatus === 'NOT_REQUIRED'
            ? 'تم تحديث حالة السيرة الذاتية بنجاح'
            : `تم تحديث الحالة. ${EMAIL_FAILURE_MESSAGES[emailStatus]}`;

      return NextResponse.json({ message, data: updated, emailSent, emailStatus });
    }

    if (raw.actionType !== undefined && raw.actionType !== 'CREATE') throw badRequest('إجراء غير معروف');
    const body = createSchema.parse(raw);

    const job = await prisma.jobRequest.findUnique({ where: { id: body.jobRequestId }, select: { status: true } });
    if (!job) throw badRequest('الشاغر الوظيفي غير موجود');
    if (job.status !== JOB_REQUEST_OPEN_STATUS) throw conflict('الشاغر الوظيفي غير مفتوح للتقديم');

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.jobApplication.create({
        data: {
          jobRequestId: body.jobRequestId,
          candidateName: body.candidateName,
          candidatePhone: body.candidatePhone,
          candidateEmail: body.candidateEmail ?? null,
          resumeUrl: body.resumeUrl ?? null,
          status: APPLICATION_STATUS.APPLIED,
          notes: body.notes ?? null,
          interviewDate: body.interviewDate ?? null,
        },
      });
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'JobApplication',
          entityId: row.id,
          details: { jobRequestId: row.jobRequestId, source: 'HR' },
          ipAddress: ip,
        },
        tx,
      );
      return row;
    });

    return NextResponse.json({ message: 'تم حفظ السيرة الذاتية وربطها بالشاغر بنجاح', data: created });
  } catch (err) {
    return handleApiError(err, 'applications:POST');
  }
}

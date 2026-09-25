// Recruitment domain constants and pure helpers shared by /api/recruitment, /api/applications
// and the public /api/apply/[jobRequestId] route. No prisma / no I/O here.
import { z } from 'zod';
import { escapeHtml } from '@/lib/mailer';

// ---------------------------------------------------------------------------
// Job requests (staffing needs)
// ---------------------------------------------------------------------------

export const JOB_REQUEST_STATUS = {
  PENDING: 'PENDING',
  /** Approved by HR: the vacancy is open and accepts applications. */
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** Someone was hired; the request is archived. */
  FULFILLED: 'FULFILLED',
} as const;
export type JobRequestStatus = (typeof JOB_REQUEST_STATUS)[keyof typeof JOB_REQUEST_STATUS];

/** A job request accepts applications only in this status. */
export const JOB_REQUEST_OPEN_STATUS = JOB_REQUEST_STATUS.APPROVED;

/** Allowed previous statuses for each target status (guards double-clicks and invalid jumps). */
export const JOB_REQUEST_TRANSITIONS: Record<Exclude<JobRequestStatus, 'PENDING'>, readonly JobRequestStatus[]> = {
  APPROVED: [JOB_REQUEST_STATUS.PENDING],
  REJECTED: [JOB_REQUEST_STATUS.PENDING],
  FULFILLED: [JOB_REQUEST_STATUS.APPROVED],
};

export const JOB_TYPES = ['FULL_TIME', 'PART_TIME', 'REMOTE'] as const;

// ---------------------------------------------------------------------------
// Job applications (candidates)
// ---------------------------------------------------------------------------

export const APPLICATION_STATUS = {
  APPLIED: 'APPLIED',
  INTERVIEW: 'INTERVIEW',
  OFFERED: 'OFFERED',
  HIRED: 'HIRED',
  REJECTED: 'REJECTED',
} as const;
export type ApplicationStatus = (typeof APPLICATION_STATUS)[keyof typeof APPLICATION_STATUS];
export const APPLICATION_STATUS_VALUES = Object.values(APPLICATION_STATUS) as [ApplicationStatus, ...ApplicationStatus[]];

/**
 * Allowed previous statuses for each target status. OFFERED only from INTERVIEW so a repeated
 * request can't send the offer e-mail twice; INTERVIEW may be re-set to reschedule.
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  APPLIED: [APPLICATION_STATUS.REJECTED, APPLICATION_STATUS.INTERVIEW],
  INTERVIEW: [APPLICATION_STATUS.APPLIED, APPLICATION_STATUS.REJECTED, APPLICATION_STATUS.INTERVIEW],
  OFFERED: [APPLICATION_STATUS.INTERVIEW],
  HIRED: [APPLICATION_STATUS.OFFERED],
  REJECTED: [APPLICATION_STATUS.APPLIED, APPLICATION_STATUS.INTERVIEW, APPLICATION_STATUS.OFFERED],
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
function latinDigits(s: string): string {
  return s.replace(ARABIC_DIGITS, (c) => {
    const code = c.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Normalizes a phone number: Latin digits, no spaces/dashes/parentheses. */
export function normalizePhone(v: string): string {
  return latinDigits(v).replace(/[\s\-().]/g, '');
}

export const zPhone = z.preprocess(
  (v) => (typeof v === 'string' ? normalizePhone(v) : v),
  z.string({ required_error: 'رقم الجوال مطلوب' }).regex(/^\+?\d{7,15}$/, 'رقم الجوال غير صالح'),
);

/** Optional e-mail: '' / null -> null. */
export const zOptEmail = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(200).nullable(),
).optional();

/** A file URL produced by our /api/upload route: /api/files/<uuid>.<ext>. */
export const UPLOADED_FILE_URL = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/i;

/** Public form: CV must be a file uploaded through /api/upload (or omitted). */
export const zUploadedFileUrl = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : typeof v === 'string' ? v.trim() : v),
  z.string().regex(UPLOADED_FILE_URL, 'رابط السيرة الذاتية غير صالح، يرجى رفع الملف من خلال النموذج').nullable(),
).optional();

/** Staff form: an uploaded file URL or an external http(s) link. */
export const zStaffResumeUrl = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : typeof v === 'string' ? v.trim() : v),
  z
    .string()
    .max(1000)
    .refine((s) => UPLOADED_FILE_URL.test(s) || /^https?:\/\/[^\s<>"']+$/i.test(s), 'رابط السيرة الذاتية غير صالح')
    .nullable(),
).optional();

/**
 * Interview date-time from an <input type="datetime-local"> ('YYYY-MM-DDTHH:mm', no zone):
 * interpreted as Riyadh time (UTC+3). Full ISO strings with a zone are accepted as-is.
 * Returns undefined for undefined, null for ''/null, and throws via zod for garbage.
 */
export const zOptDateTime = z
  .preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === '' || v === null) return null;
    if (typeof v !== 'string') return v;
    const s = v.trim();
    const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);
    const d = new Date(local ? `${s}${s.length === 16 ? ':00' : ''}+03:00` : s);
    return Number.isNaN(d.getTime()) ? v : d;
  }, z.date({ invalid_type_error: 'موعد المقابلة غير صالح' }).nullable())
  .optional();

// ---------------------------------------------------------------------------
// Offer e-mail
// ---------------------------------------------------------------------------

export interface OfferEmailInput {
  candidateName: string;
  jobTitle?: string | null;
  departmentName?: string | null;
  offerDetails?: string | null;
}

/** Builds the offer e-mail. Every interpolated value is HTML-escaped. */
export function buildOfferEmail(input: OfferEmailInput): { subject: string; html: string } {
  const jobTitle = input.jobTitle?.trim() || 'موظف';
  const deptName = input.departmentName?.trim() || 'العام';
  const details = input.offerDetails?.trim() || 'سيتم تزويدكم بتفاصيل العرض لاحقاً.';

  const html = `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h2 style="color: #4f46e5; margin: 0;">عرض وظيفي - منصة رديف</h2>
          <p style="color: #64748b; font-size: 14px; margin-top: 5px;">مرحباً بك في فريقنا</p>
        </div>
        <p style="font-size: 16px; color: #1e293b; font-weight: bold;">عزيزي/عزيزتي ${escapeHtml(input.candidateName)}،</p>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">
          يسعدنا تقديم هذا العرض الوظيفي لك للانضمام إلى فريق عملنا بمسمى <strong>${escapeHtml(jobTitle)}</strong> في قسم <strong>${escapeHtml(deptName)}</strong>.
        </p>
        <div style="background-color: #f8fafc; border: 1px solid #f1f5f9; border-radius: 8px; padding: 15px; margin: 20px 0;">
          <h4 style="color: #4f46e5; margin-top: 0; margin-bottom: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">تفاصيل العرض المالي والوظيفي:</h4>
          <p style="font-size: 14px; color: #334155; line-height: 1.6; white-space: pre-wrap; margin: 0;">${escapeHtml(details)}</p>
        </div>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">
          الرجاء مراجعة تفاصيل العرض أعلاه والرد علينا بالقبول أو الاستفسار في أقرب وقت ممكن.
        </p>
        <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8; text-align: center;">هذه الرسالة تم توليدها تلقائياً من نظام رديف لإدارة الموارد البشرية.</p>
      </div>
    `;

  return { subject: `عرض وظيفي: ${jobTitle}`, html };
}

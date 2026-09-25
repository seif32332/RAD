// PUBLIC endpoint (no session): the job application form reached by QR code / link.
// Middleware allows /api/apply/* without a session, so everything here is hardened:
// open vacancies only, strict validation, length caps, per-IP rate limits, minimal responses.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp } from '@/lib/auth';
import { HttpError, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText, zText } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import {
  APPLICATION_STATUS,
  JOB_REQUEST_OPEN_STATUS,
  zOptEmail,
  zPhone,
  zUploadedFileUrl,
} from '@/app/api/recruitment/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ jobRequestId: string }> };

const HOUR_MS = 60 * 60_000;
/** Successful submissions per IP per hour. */
const SUBMIT_LIMIT = 5;
/** Submission attempts (including invalid ones) per IP per hour. */
const ATTEMPT_LIMIT = 20;
/** Vacancy look-ups per IP per 10 minutes. */
const VIEW_LIMIT = 120;
const SUCCESS_MESSAGE = 'تم تقديم الطلب بنجاح';

const applySchema = z.object({
  candidateName: zText(150),
  candidatePhone: zPhone,
  candidateEmail: zOptEmail,
  resumeUrl: zUploadedFileUrl,
  notes: zOptText(2000),
});

function tooManyRequests(retryAfterSeconds: number) {
  const message = 'تم تجاوز عدد المحاولات المسموح بها، يرجى المحاولة لاحقاً';
  return NextResponse.json(
    { message, error: message },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

async function loadOpenJob(jobRequestId: string) {
  const id = zId.safeParse(jobRequestId);
  if (!id.success) throw notFound('الشاغر غير موجود');
  const job = await prisma.jobRequest.findFirst({
    where: { id: id.data, status: JOB_REQUEST_OPEN_STATUS },
    select: {
      id: true,
      jobTitle: true,
      jobType: true,
      nationality: true,
      description: true,
      status: true,
      department: { select: { nameArabic: true } },
    },
  });
  if (!job) throw notFound('الشاغر غير موجود أو تم إغلاق التقديم عليه');
  return job;
}

/** GET: public vacancy details (only for open vacancies). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const limit = rateLimit(`apply:view:${getClientIp(req)}`, VIEW_LIMIT, 10 * 60_000);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

    const { jobRequestId } = await params;
    const job = await loadOpenJob(jobRequestId);
    return NextResponse.json(job);
  } catch (err) {
    return handleApiError(err, 'apply:GET');
  }
}

/** POST: submit an application to an open vacancy. Response: { message }. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const ip = getClientIp(req);
    const attempts = rateLimit(`apply:attempt:${ip}`, ATTEMPT_LIMIT, HOUR_MS);
    if (!attempts.ok) return tooManyRequests(attempts.retryAfterSeconds);

    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > 32 * 1024) throw new HttpError(413, 'حجم البيانات المرسلة كبير جداً');

    const { jobRequestId } = await params;
    const body = await parseBody(req, applySchema);
    const job = await loadOpenJob(jobRequestId);

    const duplicate = await prisma.jobApplication.findFirst({
      where: { jobRequestId: job.id, candidatePhone: body.candidatePhone },
      select: { id: true },
    });
    // Same response as a new submission, so the form can't be used to probe who applied.
    if (duplicate) return NextResponse.json({ message: SUCCESS_MESSAGE }, { status: 201 });

    const submits = rateLimit(`apply:submit:${ip}`, SUBMIT_LIMIT, HOUR_MS);
    if (!submits.ok) return tooManyRequests(submits.retryAfterSeconds);

    const application = await prisma.jobApplication.create({
      data: {
        jobRequestId: job.id,
        candidateName: body.candidateName,
        candidatePhone: body.candidatePhone,
        candidateEmail: body.candidateEmail ?? null,
        resumeUrl: body.resumeUrl ?? null,
        notes: body.notes ?? null,
        status: APPLICATION_STATUS.APPLIED, // enters the screening list as a new applicant
      },
      select: { id: true },
    });

    await logAudit({
      userId: null,
      action: 'CREATE',
      entityType: 'JobApplication',
      entityId: application.id,
      details: { jobRequestId: job.id, source: 'PUBLIC_FORM' },
      ipAddress: ip,
    });

    return NextResponse.json({ message: SUCCESS_MESSAGE }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'apply:POST');
  }
}

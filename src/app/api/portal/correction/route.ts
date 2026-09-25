import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, parseBody } from '@/lib/http';
import { zDate, zId, zOptText, zText } from '@/lib/validation';
import { dateKey } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import { CORRECTION_STATUS, CORRECTION_TYPES, isHrDirectRequest } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  /** Legacy: the page still sends it; it must match the session employee. */
  employeeId: zId.optional(),
  date: zDate,
  reason: zText(4000),
  attachmentUrl: zOptText(2000),
  /** Fingerprint corrections: LATE | EARLY_LEAVE | ABSENT | GENERAL (default GENERAL). Ignored for general requests. */
  correctionType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(CORRECTION_TYPES).optional()),
  /** Rejected / flagged self punch the request is about (its server time is used on approval). */
  punchId: zId.optional(),
});

/**
 * POST /api/portal/correction — self-service fingerprint correction / general request
 * (general requests are encoded as "[طلب: ...]" in the reason and go straight to HR, so their
 * type is always GENERAL). Always filed for the logged-in employee.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const body = await parseBody(req, createSchema);
    if (body.employeeId && body.employeeId !== employeeId) throw forbidden('لا يمكنك تقديم طلب لموظف آخر');

    // Prevent duplicate pending requests with the same reason.
    const existing = await prisma.attendanceCorrection.findFirst({
      where: { employeeId, reason: body.reason, status: CORRECTION_STATUS.PENDING },
      select: { id: true },
    });
    if (existing) throw conflict('يوجد لديك طلب مطابق قيد الانتظار حالياً.');

    const hrDirect = isHrDirectRequest(body.reason);
    const correctionType = hrDirect ? 'GENERAL' : (body.correctionType ?? 'GENERAL');

    let punchId: string | null = null;
    if (body.punchId && !hrDirect) {
      const punch = await prisma.attendancePunch.findUnique({ where: { id: body.punchId }, select: { employeeId: true, result: true, workDate: true } });
      if (!punch || punch.employeeId !== employeeId) throw forbidden('الحركة المرتبطة بالطلب غير موجودة');
      if (punch.result === 'ACCEPTED') throw badRequest('هذه الحركة مقبولة ولا تحتاج إلى تصحيح');
      if (dateKey(punch.workDate) !== dateKey(body.date)) throw badRequest('تاريخ الطلب لا يطابق تاريخ الحركة');
      const pendingForPunch = await prisma.attendanceCorrection.findFirst({
        where: { punchId: body.punchId, status: CORRECTION_STATUS.PENDING },
        select: { id: true },
      });
      if (pendingForPunch) throw conflict('يوجد طلب تصحيح قيد الانتظار لهذه الحركة.');
      punchId = body.punchId;
    }

    const request = await prisma.attendanceCorrection.create({
      data: {
        employeeId,
        date: body.date,
        reason: body.reason,
        attachmentUrl: body.attachmentUrl ?? null,
        correctionType,
        status: CORRECTION_STATUS.PENDING,
        punchId,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'AttendanceCorrection',
      entityId: request.id,
      details: { employeeId, date: body.date, correctionType, selfService: true, punchId },
      ipAddress: getClientIp(req),
    });

    const message = hrDirect ? 'تم رفع الطلب إلى الموارد البشرية' : 'تم رفع طلب تصحيح البصمة';
    return NextResponse.json({ message, request }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'portal/correction:POST');
  }
}

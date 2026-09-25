import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ action: z.literal('MARK_REVIEWED') });

/**
 * PUT /api/attendance-punches/[id] — HR marks a FLAGGED punch as reviewed. When no other flagged
 * punch of the same Attendance row is still pending, the row's "flagged" warning is cleared.
 * (A punch that should not count is handled by editing the day in the attendance page.)
 */
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const { id } = await params;
    await parseBody(req, bodySchema);

    const updated = await prisma.$transaction(async (tx) => {
      const punch = await tx.attendancePunch.findUnique({ where: { id }, select: { id: true, result: true, attendanceId: true, reviewedAt: true } });
      if (!punch) throw notFound('الحركة غير موجودة');
      if (punch.result !== 'FLAGGED') throw conflict('المراجعة للحركات المعلَّمة فقط');
      const r = await tx.attendancePunch.updateMany({ where: { id, reviewedAt: null }, data: { reviewedAt: new Date(), reviewedById: user.id } });
      if (r.count === 0) throw conflict('تمت مراجعة هذه الحركة مسبقاً');
      if (punch.attendanceId) {
        const stillPending = await tx.attendancePunch.count({ where: { attendanceId: punch.attendanceId, result: 'FLAGGED', reviewedAt: null } });
        if (stillPending === 0) await tx.attendance.update({ where: { id: punch.attendanceId }, data: { flagged: false } });
      }
      return punch;
    });

    await logAudit({
      userId: user.id,
      action: 'APPROVE',
      entityType: 'AttendancePunch',
      entityId: id,
      details: { event: 'FLAGGED_PUNCH_REVIEWED', attendanceId: updated.attendanceId },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تمت مراجعة الحركة' });
  } catch (err) {
    return handleApiError(err, 'attendance-punches/[id]:PUT');
  }
}

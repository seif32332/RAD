import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { biometricImageResponse, readBiometricImage } from '@/lib/biometric-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/attendance-punches/[id]/photo — evidence selfie of a rejected / flagged punch (HR only, audited, never cached). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const { id } = await params;
    const punch = await prisma.attendancePunch.findUnique({ where: { id }, select: { employeeId: true, selfieStoredName: true } });
    if (!punch?.selfieStoredName) throw notFound('لا توجد صورة لهذه الحركة (ربما حُذفت بعد انتهاء مدة الاحتفاظ)');
    const data = await readBiometricImage(punch.selfieStoredName);
    if (!data) throw notFound('الصورة غير موجودة');
    await logAudit({
      userId: user.id,
      action: 'VIEW',
      entityType: 'AttendancePunch',
      entityId: id,
      details: { event: 'PUNCH_SELFIE_VIEWED', employeeId: punch.employeeId },
      ipAddress: getClientIp(req),
    });
    return biometricImageResponse(punch.selfieStoredName, data);
  } catch (err) {
    return handleApiError(err, 'attendance-punches/[id]/photo:GET');
  }
}

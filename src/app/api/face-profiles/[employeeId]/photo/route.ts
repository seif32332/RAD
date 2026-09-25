import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { biometricImageResponse, readBiometricImage } from '@/lib/biometric-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ employeeId: string }> };

/**
 * GET /api/face-profiles/[employeeId]/photo — reference selfie the employee enrolled (HR only,
 * audited, never cached). Enrollment needs no approval, so HR can check who enrolled which face.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const { employeeId } = await params;
    const profile = await prisma.faceProfile.findUnique({ where: { employeeId }, select: { id: true, photoStoredName: true } });
    if (!profile?.photoStoredName) throw notFound('لا توجد صورة وجه مسجلة لهذا الموظف');
    const data = await readBiometricImage(profile.photoStoredName);
    if (!data) throw notFound('الصورة غير موجودة');
    await logAudit({
      userId: user.id,
      action: 'VIEW',
      entityType: 'FaceProfile',
      entityId: profile.id,
      details: { event: 'REFERENCE_FACE_VIEWED', employeeId },
      ipAddress: getClientIp(req),
    });
    return biometricImageResponse(profile.photoStoredName, data);
  } catch (err) {
    return handleApiError(err, 'face-profiles/[employeeId]/photo:GET');
  }
}

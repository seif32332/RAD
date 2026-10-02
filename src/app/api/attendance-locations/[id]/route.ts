import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { badRequest, definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { authz, resolveActor, scopedContext } from '@/modules/iam';
import { locationScopeWhere } from '../route';
import { LOCATION_WRITERS, latitudeSchema, locationSelect, longitudeSchema, radiusSchema } from '@/lib/attendance-locations';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** P1-SCOPE: the location's branch must be in the user's companies; else "not found". */
async function inScope(user: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const ctx = scopedContext(await resolveActor(prisma, user));
  authz.assert(ctx, 'attendance.location.manage');
  return { id, ...locationScopeWhere(ctx) };
}

const updateSchema = z.object({
  name: zText(120).optional(),
  latitude: latitudeSchema.optional(),
  longitude: longitudeSchema.optional(),
  radiusM: radiusSchema.optional(),
  isActive: zBool.optional(),
});

/** PUT /api/attendance-locations/[id] — edits a location (moving the center, radius, on/off). */
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(LOCATION_WRITERS);
    const { id } = await params;
    const body = await parseBody(req, updateSchema);
    const where = await inScope(user, id);
    const before = await prisma.attendanceLocation.findFirst({ where, select: locationSelect });
    if (!before) throw notFound('موقع الحضور غير موجود');
    const next = { latitude: body.latitude ?? before.latitude, longitude: body.longitude ?? before.longitude };
    if (next.latitude === 0 && next.longitude === 0) throw badRequest('الإحداثيات غير صالحة');

    const location = await prisma.attendanceLocation.update({ where, data: definedOnly(body), select: locationSelect });
    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'AttendanceLocation',
      entityId: id,
      details: {
        branchId: location.branchId,
        before: { latitude: before.latitude, longitude: before.longitude, radiusM: before.radiusM, isActive: before.isActive, name: before.name },
        after: { latitude: location.latitude, longitude: location.longitude, radiusM: location.radiusM, isActive: location.isActive, name: location.name },
      },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تم تحديث موقع الحضور', location });
  } catch (err) {
    return handleApiError(err, 'attendance-locations/[id]:PUT');
  }
}

/** DELETE /api/attendance-locations/[id] — past punches keep their own snapshot of the location. */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(LOCATION_WRITERS);
    const { id } = await params;
    const where = await inScope(user, id);
    const location = await prisma.attendanceLocation.findFirst({ where, select: locationSelect });
    if (!location) throw notFound('موقع الحضور غير موجود');
    await prisma.attendanceLocation.delete({ where });
    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'AttendanceLocation',
      entityId: id,
      details: { branchId: location.branchId, name: location.name, latitude: location.latitude, longitude: location.longitude, radiusM: location.radiusM },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تم حذف موقع الحضور' });
  } catch (err) {
    return handleApiError(err, 'attendance-locations/[id]:DELETE');
  }
}

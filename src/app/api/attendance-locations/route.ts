import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zBool, zId, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { GEOFENCE_RADIUS_LIMITS } from '@/lib/geo';
import { LOCATION_WRITERS, latitudeSchema, locationSelect, longitudeSchema, radiusSchema } from '@/lib/attendance-locations';
import { loadSelfAttendanceSettings } from '@/lib/self-attendance-server';

export const dynamic = 'force-dynamic';

const createSchema = z
  .object({
    branchId: zId,
    name: zText(120),
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    radiusM: radiusSchema.optional(),
    isActive: zBool.optional(),
  })
  .refine((b) => !(b.latitude === 0 && b.longitude === 0), { message: 'الإحداثيات غير صالحة', path: ['latitude'] });

/** GET /api/attendance-locations?branchId=... — the branch's attendance locations (staff). */
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const { branchId } = parseQuery(req, z.object({ branchId: zId }));
    const [locations, settings] = await Promise.all([
      prisma.attendanceLocation.findMany({ where: { branchId }, select: locationSelect, orderBy: { createdAt: 'asc' } }),
      loadSelfAttendanceSettings(prisma),
    ]);
    return NextResponse.json({ locations, defaultRadiusM: settings.defaultRadiusM, radiusLimits: GEOFENCE_RADIUS_LIMITS });
  } catch (err) {
    return handleApiError(err, 'attendance-locations:GET');
  }
}

/** POST /api/attendance-locations — adds a location (center + radius) to a branch. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(LOCATION_WRITERS);
    const body = await parseBody(req, createSchema);
    const branch = await prisma.branch.findUnique({ where: { id: body.branchId }, select: { id: true } });
    if (!branch) throw notFound('الفرع غير موجود');
    const radiusM = body.radiusM ?? (await loadSelfAttendanceSettings(prisma)).defaultRadiusM;

    const location = await prisma.attendanceLocation.create({
      data: { branchId: body.branchId, name: body.name, latitude: body.latitude, longitude: body.longitude, radiusM, isActive: body.isActive ?? true },
      select: locationSelect,
    });
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'AttendanceLocation',
      entityId: location.id,
      details: { branchId: location.branchId, name: location.name, latitude: location.latitude, longitude: location.longitude, radiusM: location.radiusM },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ message: 'تمت إضافة موقع الحضور', location }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'attendance-locations:POST');
  }
}

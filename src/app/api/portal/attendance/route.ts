import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { faceServiceConfigured } from '@/lib/face';
import { FACE_CONSENT_VERSION, SELF_ATTENDANCE_BLOCKER_MESSAGES } from '@/lib/self-attendance';
import { loadSelfAttendanceContext } from '@/lib/self-attendance-server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/portal/attendance — state of the self clock-in card for the logged-in employee:
 * what the next punch would be (IN / OUT / DONE), what is required (location, face), and why a
 * punch is currently impossible (blockers). Never returns coordinates or biometric data.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const ctx = await loadSelfAttendanceContext(prisma, employeeId);

    return NextResponse.json(
      {
        enabled: ctx.settings.enabled,
        nextAction: ctx.plan.action,
        workDate: ctx.plan.dayKey,
        record: ctx.record ? { workDate: ctx.record.dayKey, checkIn: ctx.record.checkIn, checkOut: ctx.record.checkOut } : null,
        blockers: ctx.blockers.map((code) => ({ code, message: SELF_ATTENDANCE_BLOCKER_MESSAGES[code] })),
        geoRequired: !ctx.employee.attendanceGeoExempt,
        faceRequired: ctx.faceRequired,
        faceEnrolled: ctx.faceEnrolled,
        faceConsentCurrent: ctx.faceConsentCurrent,
        faceServiceConfigured: faceServiceConfigured(),
        locations: ctx.fences.map((f) => ({ name: f.name })),
        gpsMaxAccuracyM: ctx.settings.gpsMaxAccuracyM,
        consentVersion: FACE_CONSENT_VERSION,
        selfieRetentionDays: ctx.settings.selfieRetentionDays,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return handleApiError(err, 'portal/attendance:GET');
  }
}

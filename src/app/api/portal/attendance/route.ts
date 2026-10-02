import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { faceServiceConfigured } from '@/lib/face';
import { DAY_COMPLETE_WITHOUT_CHECK_IN_MESSAGE, FACE_CONSENT_VERSION, SELF_ATTENDANCE_BLOCKER_MESSAGES } from '@/lib/self-attendance';
import { loadSelfAttendanceContext } from '@/lib/self-attendance-server';
import { resolveSelfContext } from '@/lib/employee-scope';
import { authz, resolveActor } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/**
 * GET /api/portal/attendance — state of the self clock-in card for the logged-in employee:
 * what the next punch would be (IN / OUT / DONE), what is required (location, face), and why a
 * punch is currently impossible (blockers). Never returns coordinates or biometric data.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    // P1-SCOPE: SelfContext; the loader reads the session employee's own rows (and his branch's locations).
    const self = await resolveSelfContext(prisma, await resolveActor(prisma, user));
    authz.assert(self, 'portal.self.read');
    const ctx = await loadSelfAttendanceContext(prisma, self.employeeId);

    return NextResponse.json(
      {
        enabled: ctx.settings.enabled,
        nextAction: ctx.plan.action,
        // After a rejected check-in: the other button (retry the check-in / record the check-out).
        alternativeAction: ctx.plan.action === 'DONE' ? null : (ctx.plan.alternative ?? null),
        workDate: ctx.plan.dayKey,
        todayKey: ctx.todayKey,
        record: ctx.record ? { workDate: ctx.record.dayKey, checkIn: ctx.record.checkIn, checkOut: ctx.record.checkOut } : null,
        blockers: ctx.blockers.map((code) => ({
          code,
          message: code === 'DAY_COMPLETE' && ctx.record && !ctx.record.checkIn ? DAY_COMPLETE_WITHOUT_CHECK_IN_MESSAGE : SELF_ATTENDANCE_BLOCKER_MESSAGES[code],
        })),
        geoRequired: !ctx.employee.attendanceGeoExempt,
        faceRequired: ctx.faceRequired,
        faceEnrolled: ctx.faceEnrolled,
        faceDataStored: ctx.faceDataStored,
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

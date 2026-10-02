import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { PAYROLL_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { addDays, today } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { onLeaveWhere } from '@/lib/leave';
import { managedEmployeesWhere } from '@/lib/hr-workflows';
import { resolveTeamContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';
import { currentPayrollMonth, payrollMonthLabel } from '@/lib/payroll-core';
import {
  buildAdminAlerts,
  buildClaimAlerts,
  buildEmployeeDocumentAlerts,
  buildLegalAlerts,
  buildVehicleAlerts,
  countAlertLevels,
  employeeAlertSelect,
  getAlertThresholds,
  loadAdminAlertSources,
  loadClaimAlertSources,
  loadLegalAlertSources,
  loadVehicleAlertSources,
  type AlertsDb,
} from '@/lib/alerts';
import { buildOnboarding } from './onboarding';

export const dynamic = 'force-dynamic';

/**
 * Dashboard KPIs. Alert counts use the same builders as the alert screens (src/lib/alerts), so
 * the numbers here match /hr-alerts (employee documents), /admin-alerts, /logistics-alerts and
 * /legal-alerts.
 *
 * Scope (DEC-010 item 8): BRANCH_MANAGER / DEPT_MANAGER get team-level numbers only
 * (managedEmployeesWhere) and no tenant-wide legal, compliance, recruitment, structure or
 * company/vehicle alert totals — those keys are sent as null and the page hides them.
 * Admins (SUPER_ADMIN / COMPANY_ADMIN) also get an onboarding checklist computed from counts.
 *
 * P1-SCOPE: every count, sum and alert source goes through the scoped client of the user's context
 * (TeamContext for the two manager roles, ScopedContext otherwise), so a scoped user's numbers cover
 * his companies only (legal records follow their companyId, migration 9zb; a row without one is
 * visible to unrestricted users only).
 *
 * Council DOM-009:
 * - The payroll tile is the REFERENCE payroll: the latest APPROVED / PAID month that is not after
 *   the current Riyadh month (drafts and months stored in the future never take it over).
 * - totalAlerts counts each risk once: legal contracts are served by both the admin and the legal
 *   builders, so the admin copies (category LEGAL) are left out of the total and of byLevel.
 * - Attendance rate = employees with an attendance record today / employees expected today
 *   (active, already started, not on approved leave today).
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const teamScoped = user.role === 'BRANCH_MANAGER' || user.role === 'DEPT_MANAGER';
    const actor = await resolveActor(prisma, user);
    const ctx = teamScoped ? await resolveTeamContext(prisma, actor) : scopedContext(actor);
    authz.assert(ctx, 'dashboard.read');
    const db = scopedPrisma(ctx);
    // The alert loaders take a Prisma client; the scoped client runs the same calls.
    const adb = db as unknown as AlertsDb;
    const jobRequestScope = scopeWhere(ctx, 'JobRequest') as Prisma.JobRequestWhereInput | null;
    const byJobRequest = jobRequestScope ? { jobRequest: { is: jobRequestScope } } : {};
    const scope: Prisma.EmployeeWhereInput | null = teamScoped ? await managedEmployeesWhere(prisma, user) : null;
    const emp = (where: Prisma.EmployeeWhereInput): Prisma.EmployeeWhereInput => (scope ? { AND: [where, scope] } : where);
    const byEmployee = scope ? { employee: scope } : {};

    // Payroll totals are shown only to payroll/finance/owner roles (never to team-scoped managers).
    const canSeePayroll = !teamScoped && roleIn(user.role, ROLE_GROUPS.PAYROLL);
    const isAdmin = roleIn(user.role, ROLE_GROUPS.ADMIN);
    const now = new Date();
    const todayDate = today(now);
    const tomorrow = addDays(todayDate, 1);

    const cur = currentPayrollMonth(now);
    const [thresholds, latestPayroll] = await Promise.all([
      getAlertThresholds(prisma),
      canSeePayroll
        ? db.payroll.findFirst({
            where: {
              status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] },
              OR: [{ year: { lt: cur.year } }, { year: cur.year, month: { lte: cur.month } }],
            },
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
            select: { year: true, month: true },
          })
        : Promise.resolve(null),
    ]);
    // Employees expected at work today: active, already started, not on leave today. "On leave" is
    // the one rule onLeaveWhere (BR-LCY-008): a recorded return ends the leave the day before.
    const onLeaveToday: Prisma.EmployeeWhereInput = { leaves: { some: onLeaveWhere(todayDate) } };
    const expectedWhere = emp({ isTerminated: false, joinDate: { lt: tomorrow }, NOT: onLeaveToday });

    const [totalEmployees, terminatedEmployees, activeLeaves, todayAttendance, attendanceEver, employeeSources, leaves, expectedToday, presentExpected] = await Promise.all([
      db.employee.count({ where: emp({ isTerminated: false }) }),
      db.employee.count({ where: emp({ isTerminated: true }) }),
      // Terminated employees are never counted on leave (EX-LCY-001).
      db.leave.count({ where: { ...onLeaveWhere(todayDate), employee: emp({ isTerminated: false }) } }),
      db.attendance.count({ where: { date: { gte: todayDate, lt: tomorrow }, ...byEmployee } }),
      db.attendance.count({ where: byEmployee, take: 1 }),
      db.employee.findMany({ where: emp({ isTerminated: false }), select: employeeAlertSelect }),
      db.leave.findMany({
        take: 5,
        where: byEmployee,
        orderBy: { createdAt: 'desc' },
        select: {
          leaveType: true,
          status: true,
          totalDays: true,
          createdAt: true,
          employee: {
            select: {
              firstNameArabic: true,
              lastNameArabic: true,
              department: { select: { nameArabic: true } },
              branch: { select: { nameArabic: true } },
            },
          },
        },
      }),
      db.employee.count({ where: expectedWhere }),
      db.attendance.count({ where: { date: { gte: todayDate, lt: tomorrow }, employee: expectedWhere } }),
    ]);

    const hrAlerts = buildEmployeeDocumentAlerts(employeeSources, thresholds, now);
    const attendanceRate = expectedToday > 0 ? Math.round((Math.min(presentExpected, expectedToday) / expectedToday) * 1000) / 10 : 0;
    const recentLeaves = leaves.map((l) => ({
      employeeName: `${l.employee?.firstNameArabic || ''} ${l.employee?.lastNameArabic || ''}`.trim(),
      department: l.employee?.department?.nameArabic || '',
      branch: l.employee?.branch?.nameArabic || '',
      type: l.leaveType,
      status: l.status,
      days: l.totalDays,
      date: l.createdAt,
    }));
    const kpis = {
      totalEmployees,
      terminatedEmployees,
      activeLeaves,
      // null = not visible for this role (the page hides the tile).
      totalPayroll: null as number | null,
      /** Reference payroll month 'YYYY-M' (latest APPROVED / PAID, not after the current month). */
      latestPayrollMonth: latestPayroll ? `${latestPayroll.year}-${latestPayroll.month}` : '',
      /** Arabic label of that month, e.g. 'مارس 2026'. */
      latestPayrollLabel: latestPayroll ? payrollMonthLabel(latestPayroll.year, latestPayroll.month) : '',
      attendanceRate,
      todayAttendance,
      /** Denominator of attendanceRate: active, already started, not on approved leave today. */
      expectedToday,
      /** false = no attendance has ever been recorded (in scope): the rate is not meaningful. */
      hasAttendanceData: attendanceEver > 0,
    };

    if (teamScoped) {
      const byLevel = countAlertLevels(hrAlerts);
      return NextResponse.json({
        scope: 'TEAM',
        kpis,
        alerts: {
          hrAlertCount: hrAlerts.length,
          adminAlertCount: null,
          logisticsAlertCount: null,
          legalAlertCount: null,
          totalAlerts: hrAlerts.length,
          byLevel,
        },
        // Every active employee has an ID expiry date on file, so "tracked" = active employees.
        coverage: { employeeDocs: employeeSources.length, companyDocs: null, vehicles: null, legalRecords: null },
        compliance: null,
        recruitment: null,
        legal: null,
        structure: null,
        onboarding: null,
        recentLeaves,
      });
    }

    const [
      payrollSum,
      adminSources,
      vehicleSources,
      claimSources,
      legalSources,
      activeViolations,
      violationsSum,
      openVacancies,
      pendingVacancies,
      pendingApplications,
      scheduledInterviews,
      activeLawsuits,
      activeContracts,
      totalVehicles,
      totalBranches,
      totalCompanies,
      totalDepartments,
      legalRecordCounts,
      onboardingCounts,
    ] = await Promise.all([
      latestPayroll
        ? db.payroll.aggregate({
            where: { year: latestPayroll.year, month: latestPayroll.month, status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
            _sum: { netSalary: true },
          })
        : Promise.resolve(null),
      loadAdminAlertSources(adb, thresholds, now),
      loadVehicleAlertSources(adb, thresholds, now),
      loadClaimAlertSources(adb),
      loadLegalAlertSources(adb, thresholds, now),
      db.complianceViolation.count({ where: { status: 'PENDING_PAYMENT' } }),
      db.complianceViolation.aggregate({ where: { status: 'PENDING_PAYMENT' }, _sum: { amount: true } }),
      db.jobRequest.count({ where: { status: 'APPROVED' } }),
      db.jobRequest.count({ where: { status: 'PENDING' } }),
      db.jobApplication.count({ where: { status: 'APPLIED', ...byJobRequest } }),
      db.jobApplication.count({ where: { status: 'INTERVIEW', ...byJobRequest } }),
      db.lawsuit.count({ where: { status: 'REFERRED' } }),
      db.legalContract.count({ where: { status: 'ACTIVE' } }),
      db.vehicle.count(),
      db.branch.count(),
      db.company.count(),
      db.department.count(),
      Promise.all([db.promissoryNote.count(), db.legalContract.count(), db.lawsuit.count(), db.certifiedAgency.count()]),
      isAdmin
        ? Promise.all([
            db.employee.count({ where: { userId: { not: null } } }),
            db.workSchedule.count(),
            db.payroll.count(),
          ])
        : Promise.resolve(null),
    ]);

    const adminAlerts = buildAdminAlerts(adminSources, thresholds, now);
    // AccidentClaim has no company key: a claim counts for the user when its vehicle is in his scope.
    const vehicleScope = scopeWhere(ctx, 'Vehicle') as Prisma.VehicleWhereInput | null;
    const claimIdsInScope = vehicleScope
      ? new Set(
          (
            await prisma.accidentClaim.findMany({
              where: { id: { in: claimSources.map((c) => c.id) }, vehicle: { is: vehicleScope } },
              select: { id: true },
            })
          ).map((c) => c.id),
        )
      : null;
    const scopedClaims = claimIdsInScope ? claimSources.filter((c) => claimIdsInScope.has(c.id)) : claimSources;
    const logisticsAlerts = [...buildVehicleAlerts(vehicleSources, thresholds, now), ...buildClaimAlerts(scopedClaims, now)];
    const legalAlerts = buildLegalAlerts(legalSources, thresholds, now);
    const hrAlertCount = hrAlerts.length;
    const adminAlertCount = adminAlerts.length;
    // Legal contracts are also counted by the legal builder: count them once.
    const adminNonLegal = adminAlerts.filter((a) => a.category !== 'LEGAL');
    const adminAlertCountExcludingLegal = adminNonLegal.length;
    const logisticsAlertCount = logisticsAlerts.length;
    const legalAlertCount = legalAlerts.length;
    // expired (< 0 days) / critical (0..7 days, incl. "expires today") / warning (rest of the window)
    const byLevel = countAlertLevels([...hrAlerts, ...adminNonLegal, ...logisticsAlerts, ...legalAlerts]);
    kpis.totalPayroll = canSeePayroll ? roundMoney(payrollSum?._sum.netSalary ?? 0) : null;

    return NextResponse.json({
      scope: 'ALL',
      kpis,
      alerts: {
        hrAlertCount,
        /** Same count as /admin-alerts (includes legal contracts, category LEGAL). */
        adminAlertCount,
        /** Admin alerts without the legal contracts (those are in legalAlertCount). */
        adminAlertCountExcludingLegal,
        logisticsAlertCount,
        legalAlertCount,
        totalAlerts: hrAlertCount + adminAlertCountExcludingLegal + logisticsAlertCount + legalAlertCount,
        byLevel,
      },
      // How many records each alert screen watches: 0 means "nothing on file yet", not "all good".
      coverage: {
        employeeDocs: employeeSources.length,
        // Every company has a commercial-registration expiry date on file.
        companyDocs: totalCompanies,
        vehicles: totalVehicles,
        legalRecords: legalRecordCounts.reduce((a, b) => a + b, 0),
      },
      compliance: { activeViolations, totalPendingAmount: roundMoney(violationsSum._sum.amount ?? 0) },
      recruitment: { openVacancies, pendingVacancies, pendingApplications, scheduledInterviews },
      legal: { activeLawsuits, activeContracts },
      structure: { totalVehicles, totalBranches, totalCompanies, totalDepartments },
      onboarding: onboardingCounts
        ? buildOnboarding({
            companies: totalCompanies,
            branches: totalBranches,
            employees: totalEmployees + terminatedEmployees,
            linkedUsers: onboardingCounts[0],
            workSchedules: onboardingCounts[1],
            payrolls: onboardingCounts[2],
          })
        : null,
      recentLeaves,
    });
  } catch (err) {
    return handleApiError(err, 'dashboard:GET');
  }
}

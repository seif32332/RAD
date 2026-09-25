import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { LEAVE_STATUS, PAYROLL_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { addDays, today } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { managedEmployeesWhere } from '@/lib/hr-workflows';
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
        ? prisma.payroll.findFirst({
            where: {
              status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] },
              OR: [{ year: { lt: cur.year } }, { year: cur.year, month: { lte: cur.month } }],
            },
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
            select: { year: true, month: true },
          })
        : Promise.resolve(null),
    ]);
    // Employees expected at work today: active, already started, not on an approved leave today.
    const onLeaveToday: Prisma.EmployeeWhereInput = {
      leaves: { some: { status: LEAVE_STATUS.APPROVED, startDate: { lt: tomorrow }, endDate: { gte: todayDate } } },
    };
    const expectedWhere = emp({ isTerminated: false, joinDate: { lt: tomorrow }, NOT: onLeaveToday });

    const [totalEmployees, terminatedEmployees, activeLeaves, todayAttendance, attendanceEver, employeeSources, leaves, expectedToday, presentExpected] = await Promise.all([
      prisma.employee.count({ where: emp({ isTerminated: false }) }),
      prisma.employee.count({ where: emp({ isTerminated: true }) }),
      prisma.leave.count({ where: { status: LEAVE_STATUS.APPROVED, startDate: { lt: tomorrow }, endDate: { gte: todayDate }, ...byEmployee } }),
      prisma.attendance.count({ where: { date: { gte: todayDate, lt: tomorrow }, ...byEmployee } }),
      prisma.attendance.count({ where: byEmployee, take: 1 }),
      prisma.employee.findMany({ where: emp({ isTerminated: false }), select: employeeAlertSelect }),
      prisma.leave.findMany({
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
      prisma.employee.count({ where: expectedWhere }),
      prisma.attendance.count({ where: { date: { gte: todayDate, lt: tomorrow }, employee: expectedWhere } }),
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
        ? prisma.payroll.aggregate({
            where: { year: latestPayroll.year, month: latestPayroll.month, status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
            _sum: { netSalary: true },
          })
        : Promise.resolve(null),
      loadAdminAlertSources(prisma, thresholds, now),
      loadVehicleAlertSources(prisma, thresholds, now),
      loadClaimAlertSources(prisma),
      loadLegalAlertSources(prisma, thresholds, now),
      prisma.complianceViolation.count({ where: { status: 'PENDING_PAYMENT' } }),
      prisma.complianceViolation.aggregate({ where: { status: 'PENDING_PAYMENT' }, _sum: { amount: true } }),
      prisma.jobRequest.count({ where: { status: 'APPROVED' } }),
      prisma.jobRequest.count({ where: { status: 'PENDING' } }),
      prisma.jobApplication.count({ where: { status: 'APPLIED' } }),
      prisma.jobApplication.count({ where: { status: 'INTERVIEW' } }),
      prisma.lawsuit.count({ where: { status: 'REFERRED' } }),
      prisma.legalContract.count({ where: { status: 'ACTIVE' } }),
      prisma.vehicle.count(),
      prisma.branch.count(),
      prisma.company.count(),
      prisma.department.count(),
      Promise.all([prisma.promissoryNote.count(), prisma.legalContract.count(), prisma.lawsuit.count(), prisma.certifiedAgency.count()]),
      isAdmin
        ? Promise.all([
            prisma.employee.count({ where: { userId: { not: null } } }),
            prisma.workSchedule.count(),
            prisma.payroll.count(),
          ])
        : Promise.resolve(null),
    ]);

    const adminAlerts = buildAdminAlerts(adminSources, thresholds, now);
    const logisticsAlerts = [...buildVehicleAlerts(vehicleSources, thresholds, now), ...buildClaimAlerts(claimSources, now)];
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

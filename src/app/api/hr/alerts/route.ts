import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { LEAVE_STATUS, LOAN_STATUS, ROLE_GROUPS, SETTLEMENT_STATUS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { today } from '@/lib/dates';
import {
  alertCutoffDate,
  buildEmployeeDocumentAlerts,
  buildMedicalInsuranceAlerts,
  buildSettlementAlerts,
  getAlertThresholds,
  loadEmployeeAlertSources,
  type AlertsDb,
  type HrAlert,
} from '@/lib/alerts';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

// Read by /hr-alerts (HR) and /unified-alerts (operations section, also used by gov relations).
const HR_ALERT_ROLES = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV])];

// P1-SCOPE: every source (employees, insurances, settlements) and every count is read through the
// user's ScopedContext: a scoped user sees and counts only his companies.
export async function GET() {
  try {
    const user = await requireUser(HR_ALERT_ROLES);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'alerts.read');
    const db = scopedPrisma(ctx);
    const now = new Date();
    const t = await getAlertThresholds(prisma);

    const [
      employees,
      medicalInsurances,
      pendingSettlements,
      pendingLeaves,
      pendingLoans,
      pendingTerminations,
      pendingOvertimes,
      pendingWorks,
      returnLeaves,
      pendingManagerEvals,
      pendingApprovalEvals,
      pendingAckEvals,
    ] = await Promise.all([
      // The scoped client runs the same model calls (its type is Prisma's extended client).
      loadEmployeeAlertSources(db as unknown as AlertsDb),
      db.medicalInsurance.findMany({
        where: { expiryDate: { lt: alertCutoffDate(t.medicalInsurance, now) } },
        select: {
          id: true,
          insuranceIssuer: true,
          policyNumber: true,
          expiryDate: true,
          company: { select: { nameArabic: true } },
        },
      }),
      // Owner-approved settlements are waiting for the finance transfer.
      db.settlement.findMany({
        where: { status: SETTLEMENT_STATUS.OWNER_APPROVED },
        select: {
          id: true,
          createdAt: true,
          totalSettlement: true,
          employee: { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true, branchId: true, legalCompanyId: true } },
        },
      }),
      db.leave.count({ where: { status: LEAVE_STATUS.PENDING } }),
      db.loan.count({ where: { status: LOAN_STATUS.PENDING, isHrApproved: false } }),
      db.terminationRequest.count({ where: { status: 'PENDING' } }),
      db.overtimeRequest.count({ where: { status: 'PENDING' } }),
      db.workAssignment.count({ where: { status: 'PENDING_EMPLOYEE' } }),
      db.leave.count({ where: { status: LEAVE_STATUS.APPROVED, actualReturnDate: { not: null }, isReturned: false } }),
      db.employeeEvaluation.count({ where: { status: 'PENDING_MANAGER' } }),
      db.employeeEvaluation.count({ where: { status: 'PENDING_APPROVAL' } }),
      db.employeeEvaluation.count({ where: { status: 'PENDING_EMPLOYEE_ACK' } }),
    ]);

    const alerts: HrAlert[] = [
      ...buildEmployeeDocumentAlerts(employees, t, now),
      ...buildMedicalInsuranceAlerts(medicalInsurances, t, now),
      ...buildSettlementAlerts(pendingSettlements),
    ];

    const todayDate = today(now);
    const summary = (id: string, employee: string, type: string, message: string): HrAlert => ({
      id,
      employee,
      employeeId: '*',
      type,
      daysLeft: 0,
      dueDate: todayDate,
      message,
    });

    const totalIncoming = pendingLeaves + pendingLoans + pendingTerminations + pendingOvertimes + pendingWorks + returnLeaves;
    if (totalIncoming > 0) {
      alerts.push(summary('incoming-requests-summary', 'شاشة الطلبات الواردة', 'INCOMING_REQUEST',
        `يوجد (${totalIncoming}) طلبات واردة جديدة بانتظار المراجعة والاعتماد.`));
    }
    if (pendingManagerEvals > 0) {
      alerts.push(summary('eval-pending-manager', 'نظام التقييم', 'EVAL_PENDING_MANAGER',
        `يوجد (${pendingManagerEvals}) تقييم بانتظار تعبئة المدير المباشر.`));
    }
    if (pendingApprovalEvals > 0) {
      alerts.push(summary('eval-pending-approval', 'نظام التقييم', 'EVAL_PENDING_APPROVAL',
        `يوجد (${pendingApprovalEvals}) تقييم بانتظار اعتماد الموارد البشرية.`));
    }
    if (pendingAckEvals > 0) {
      alerts.push(summary('eval-pending-ack', 'نظام التقييم', 'EVAL_PENDING_ACK',
        `يوجد (${pendingAckEvals}) تقييم بانتظار اطلاع الموظف.`));
    }

    alerts.sort((a, b) => a.daysLeft - b.daysLeft);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'hr/alerts:GET');
  }
}

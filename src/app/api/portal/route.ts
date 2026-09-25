import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeId, requireUser } from '@/lib/auth';
import { LEAVE_STATUS, LOAN_DEDUCTIBLE_STATUSES, LOAN_STATUS, PAYROLL_STATUS, ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound } from '@/lib/http';
import { formatDateShort } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import {
  REQUEST_STAGE_LABELS,
  getEmployeeLeaveBalance,
  isHrDirectRequest,
  leaveRejectionReason,
  twoStepRequestStage,
  type RequestStage,
} from '@/lib/hr-workflows';
import { leaveTypeLabel } from '@/lib/leave';

export const dynamic = 'force-dynamic';

const medicalInsuranceSelect = {
  select: {
    id: true,
    insuranceIssuer: true,
    policyNumber: true,
    expiryDate: true,
    medicalNetwork: true,
    coverageType: true,
    insuranceClass: true,
    policyCost: true,
    coverageUrl: true,
    benefitsUrl: true,
  },
  orderBy: { expiryDate: 'desc' },
} as const;

const ASSET_TYPE_LABELS: Record<string, string> = { LAPTOP: 'جهاز حاسب', MOBILE: 'جوال', SIM: 'شريحة اتصال' };

/** Loans past the finance approval are shown as approved in the history (still repaid in payroll). */
const LOAN_DONE_STATUSES: readonly string[] = [...LOAN_DEDUCTIBLE_STATUSES, LOAN_STATUS.COMPLETED, LOAN_STATUS.FORGIVEN];

/** History status the portal renders: APPROVED / COMPLETED / REJECTED / CANCELLED, anything else = pending. */
function loanHistoryStatus(status: string): string {
  if (status === LOAN_STATUS.REJECTED) return 'REJECTED';
  return LOAN_DONE_STATUSES.includes(status) ? 'APPROVED' : 'PENDING';
}
function assetRequestHistoryStatus(status: string): string {
  if (status === 'COMPLETED' || status === 'REJECTED') return status;
  return 'PENDING';
}

const CORRECTION_TYPE_LABELS: Record<string, string> = {
  LATE: 'تأخير',
  EARLY_LEAVE: 'خروج مبكر',
  ABSENT: 'غياب أو نسيان بصمة',
  GENERAL: 'عام',
};

/** Stage code + its Arabic label, as rendered by the portal ("طلباتي"). */
function stageFields(stage: RequestStage) {
  return { stage, stageLabel: REQUEST_STAGE_LABELS[stage] };
}

/** Stage of a single-status request (loans, terminations, asset requests, tickets). */
function simpleStage(status: string): RequestStage {
  if (status === 'APPROVED' || status === 'COMPLETED') return 'APPROVED';
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'IN_REVIEW';
}

const companySelect = { select: { id: true, nameArabic: true, medicalInsurances: medicalInsuranceSelect } } as const;

/**
 * GET /api/portal — the logged-in employee's own self-service dashboard.
 * The employee is derived strictly from the session (never from the query string).
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    // Users without a linked employee file (e.g. pure admins) get 404: the page shows
    // "link your account to your employee file".
    if (!user.employeeId) throw notFound('حسابك غير مرتبط بملف موظف');
    const employeeId = await requireEmployeeId(user);

    const [employee, circulars, leaveBalance] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: employeeId },
        include: {
          department: { select: { id: true, nameArabic: true } },
          branch: { select: { id: true, nameArabic: true } },
          actualCompany: companySelect,
          legalCompany: companySelect,
          allowances: true,
          payrolls: {
            where: { status: { not: PAYROLL_STATUS.DRAFT } },
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
            take: 5,
          },
          leaves: { orderBy: { createdAt: 'desc' }, take: 10 },
          loans: { orderBy: { createdAt: 'desc' }, take: 10 },
          deductions: { orderBy: { date: 'desc' }, take: 5 },
          attendanceCorrections: { orderBy: { createdAt: 'desc' }, take: 10 },
          terminationRequests: { orderBy: { createdAt: 'desc' }, take: 3 },
          attendances: { orderBy: { date: 'desc' }, take: 30 },
          visas: { orderBy: { updatedAt: 'desc' }, take: 10 },
          assetRequestsFor: {
            select: { id: true, assetType: true, description: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      }),
      prisma.circular.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { datePublished: 'desc' },
        take: 5,
        select: { id: true, title: true, content: true, issuedBy: true, datePublished: true, attachmentUrl: true },
      }),
      // Informational: a balance failure must not break the whole dashboard.
      getEmployeeLeaveBalance(prisma, employeeId).catch((err: unknown) => {
        console.error('[portal:GET] leave balance failed:', err);
        return null;
      }),
    ]);

    if (!employee) throw notFound('لم يتم العثور على ملفك الوظيفي');

    // Request history (leaves, loans, general/correction requests, terminations, tickets).
    const history = [
      ...employee.leaves.map((r) => ({
        id: `leave-${r.id}`,
        type: `إجازة ${leaveTypeLabel(r.leaveType)}`,
        details: `من ${formatDateShort(r.startDate)} إلى ${formatDateShort(r.endDate)}`,
        status: r.status as string,
        date: r.createdAt,
        // Same rule as approveLeave(): without a direct manager the leave goes straight to HR.
        ...stageFields(twoStepRequestStage({ status: r.status, isManagerApproved: r.isManagerApproved, needsManager: !!employee.directManagerId })),
        managerComment: null,
        hrComment: null,
        rejectionReason: r.status === LEAVE_STATUS.REJECTED ? leaveRejectionReason(r.notes) : null,
        // The owner may cancel their own PENDING leave (POST /api/leaves/{id}/action {action:'CANCEL'}).
        leaveId: r.id,
        canCancel: r.status === LEAVE_STATUS.PENDING,
      })),
      ...employee.loans.map((r) => ({
        id: `loan-${r.id}`,
        type: 'سلفة',
        details: `طلب مبلغ ${formatMoney(r.amount)} ر.س`,
        status: loanHistoryStatus(r.status),
        date: r.createdAt,
        ...stageFields(simpleStage(loanHistoryStatus(r.status))),
      })),
      ...employee.attendanceCorrections.map((r) => {
        const reason = r.reason ?? '';
        const hrDirect = isHrDirectRequest(reason);
        const match = reason.match(/^\s*\[طلب:\s*(.+?)\]\s*/);
        const reqType = match ? match[1] : 'تصحيح بصمة';
        const body = match ? reason.slice(match[0].length) : reason;
        const typeLabel = !hrDirect && r.correctionType ? CORRECTION_TYPE_LABELS[r.correctionType] : undefined;
        return {
          id: `acc-${r.id}`,
          type: reqType,
          details: hrDirect
            ? body
            : `التاريخ: ${formatDateShort(r.date)}${typeLabel ? ` - النوع: ${typeLabel}` : ''} - المبرر: ${body}`,
          status: r.status,
          date: r.createdAt,
          // General requests (letters, data update) skip the direct manager and go straight to HR.
          ...stageFields(twoStepRequestStage({ status: r.status, isManagerApproved: r.isManagerApproved, needsManager: !hrDirect })),
          managerComment: r.managerComment,
          hrComment: r.hrComment,
          rejectionReason: r.status === 'REJECTED' ? r.hrComment || r.managerComment || null : null,
        };
      }),
      ...employee.terminationRequests.map((r) => ({
        id: `term-${r.id}`,
        type: 'إنهاء عقد',
        details: `النوع: ${r.terminationType}`,
        status: r.status,
        date: r.createdAt,
        ...stageFields(simpleStage(r.status)),
      })),
      ...employee.assetRequestsFor.map((r) => ({
        id: `asset-${r.id}`,
        type: 'طلب عهدة',
        details: `${ASSET_TYPE_LABELS[r.assetType] ?? 'عهدة أخرى'}${r.description ? ` - ${r.description}` : ''}`,
        status: assetRequestHistoryStatus(r.status),
        date: r.createdAt,
        ...stageFields(simpleStage(assetRequestHistoryStatus(r.status))),
      })),
      ...employee.visas
        .filter((v) => v.ticketStatus === 'BOOKED')
        .map((v) => ({
          id: `ticket-${v.id}`,
          type: 'تذكرة طيران',
          details: `من ${v.flightFrom ?? '-'} إلى ${v.flightTo ?? '-'} - ناقل: ${v.airline ?? '-'}`,
          status: 'COMPLETED',
          date: v.updatedAt,
          ...stageFields('APPROVED'),
          attachment: v.ticketAttachmentUrl,
        })),
    ];

    history.sort((a, b) => b.date.getTime() - a.date.getTime());

    // leaveBalance carries { available, pending }: the portal shows "متاح · قيد الاعتماد".
    return NextResponse.json({ ...employee, circulars, history, leaveBalance });
  } catch (err) {
    return handleApiError(err, 'portal:GET');
  }
}

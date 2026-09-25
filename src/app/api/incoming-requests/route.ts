// HR approval hub ("الطلبات الواردة"): lists every pending request raised by employees,
// direct managers, department managers and the owner, and approves/rejects them.
//
// Every approval/rejection goes through the shared workflow helpers (src/lib/hr-workflows.ts,
// src/lib/finance.ts) or an atomic status guard inside prisma.$transaction, so a double click
// can never apply side effects twice.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { LeaveType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireUser, type AuthUser } from '@/lib/auth';
import {
  DEDUCTION_PENDING_STATUSES,
  LEAVE_STATUS,
  LOAN_STATUS,
  ROLE_GROUPS,
  type AppRole,
} from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptDate, zOptMoney, zOptText, zText } from '@/lib/validation';
import { formatDateShort, today } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import {
  BALANCE_LEAVE_TYPES,
  BEREAVEMENT_RELATION_LABELS,
  LEAVE_NOTE_MARKERS,
  computeLeaveBalance,
  leaveTypeLabel,
  parseStatutoryNoteMarkers,
  stripStatutoryNoteMarkers,
} from '@/lib/leave';
import {
  SETTING_KEYS,
  approveAttendanceCorrection,
  approveLeave,
  approveTransfer,
  confirmLeaveReturn,
  getNumericSetting,
  rejectAttendanceCorrection,
  rejectLeave,
  rejectLeaveReturn,
  rejectTransfer,
} from '@/lib/hr-workflows';
import { approveDeduction, approveLoanStep, rejectDeduction, rejectLoan } from '@/lib/finance';
import { assertValidDirectManager, isUniqueViolationOn, nextEmployeeCode } from '@/lib/employee';
import { ASSET_STATUS } from '@/app/api/assets/_lib';
import { ensureRefsExist } from '@/app/api/services/_lib';
import {
  NATIONALITY_REVIEW_LABEL,
  onboardingDataReviewNote,
  onboardingNationality,
  onboardingPlaceholderFields,
  onboardingPlaceholderLabels,
  type OnboardingPlaceholderField,
} from './_lib';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Who may open the hub: HR, plus finance/payroll users for the finance items. */
const HUB_ROLES: readonly AppRole[] = [...new Set<AppRole>([...ROLE_GROUPS.HR, ...ROLE_GROUPS.PAYROLL])];

/**
 * The purchasing agent opens the hub only for the purchasing stage of asset requests
 * (ASSET_REQUEST in PENDING_PURCHASING). It never sees loans, deductions or any other item.
 */
const PURCHASING_ROLE: AppRole = 'PURCHASING_AGENT';
const ACCESS_ROLES: readonly AppRole[] = [...HUB_ROLES, PURCHASING_ROLE];

/** What the signed-in user sees in the hub. */
type HubScope = 'FULL' | 'FINANCE' | 'PURCHASING';
function hubScope(user: Pick<AuthUser, 'role'>): HubScope {
  if (hasRole(user, ROLE_GROUPS.HR)) return 'FULL';
  if (hasRole(user, HUB_ROLES)) return 'FINANCE';
  return 'PURCHASING';
}

/** Request types handled by payroll/finance roles (the rest are HR-only). */
const FINANCE_TYPES = ['LOAN', 'DEDUCTION', 'OVERTIME', 'WORK_ASSIGNMENT'] as const;

const REQUEST_TYPES = [
  'LEAVE',
  'LOAN',
  'TERMINATION',
  'OVERTIME',
  'WORK_ASSIGNMENT',
  'DEDUCTION',
  'HIRING',
  'ONBOARDING',
  'RETURN_NOTICE',
  'ATTENDANCE_CORRECTION',
  'TRANSFER',
  'OWNER_REQUEST',
  'ASSET_REQUEST',
] as const;
type RequestType = (typeof REQUEST_TYPES)[number];

/** 'إجازة <label>' from the single leave-type label map in src/lib/leave.ts (covers every LeaveType, incl. statutory types). */
function leaveTypeFullLabel(t: LeaveType, notes: string | null): string {
  const base = `إجازة ${leaveTypeLabel(t)}`;
  if (t !== 'BEREAVEMENT') return base;
  const { bereavementRelation } = parseStatutoryNoteMarkers(notes);
  return bereavementRelation ? `${base} (${BEREAVEMENT_RELATION_LABELS[bereavementRelation]})` : base;
}

const ASSET_TYPE_LABELS: Record<string, string> = { LAPTOP: 'لابتوب', MOBILE: 'جوال', SIM: 'شريحة' };
const assetTypeLabel = (t: string) => ASSET_TYPE_LABELS[t] ?? 'أخرى';

const ASSET_REQUEST_STATUS = {
  PENDING_HR: 'PENDING_HR',
  PENDING_OWNER: 'PENDING_OWNER',
  PENDING_PURCHASING: 'PENDING_PURCHASING',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
} as const;
const ASSET_REQUEST_PENDING = [
  ASSET_REQUEST_STATUS.PENDING_HR,
  ASSET_REQUEST_STATUS.PENDING_OWNER,
  ASSET_REQUEST_STATUS.PENDING_PURCHASING,
];
const ASSET_STATUS_LABELS: Record<string, string> = {
  PENDING_HR: 'بانتظار الموارد البشرية',
  PENDING_OWNER: 'بانتظار الإدارة العليا',
  PENDING_PURCHASING: 'بانتظار مسؤول المشتريات',
};

/** Max warehouse assets offered per purchasing-stage request. */
const VACANT_ASSET_OPTIONS_MAX = 200;

/** Warehouse assets for one request: those whose type mentions the requested type first. */
function vacantAssetOptions(
  requestedType: string,
  assets: ReadonlyArray<{ id: string; assetType: string; description: string | null }>,
) {
  const label = ASSET_TYPE_LABELS[requestedType];
  const matches = (a: { assetType: string }) => !!label && a.assetType.includes(label);
  return [...assets]
    .map((a) => ({ ...a, matchesType: matches(a) }))
    .sort((a, b) => Number(b.matchesType) - Number(a.matchesType));
}

/** Roles allowed to act on each asset-request stage. */
const ASSET_STAGE_ROLES: Record<string, readonly string[]> = {
  PENDING_HR: ROLE_GROUPS.HR,
  PENDING_OWNER: ROLE_GROUPS.OWNER,
  PENDING_PURCHASING: [...ROLE_GROUPS.HR, 'PURCHASING_AGENT'],
};

const SIMPLE_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' } as const;
const WORK_ASSIGNMENT_PENDING = ['PENDING_EMPLOYEE', 'PENDING_HR'];
const OWNER_REQUEST_OPEN = ['PENDING', 'IN_PROGRESS'];
const CONTRACT_TYPES = ['FULL_TIME', 'PART_TIME', 'FREELANCE'] as const;

const employeeSelect = {
  select: {
    id: true,
    firstNameArabic: true,
    lastNameArabic: true,
    employeeId: true,
    department: { select: { nameArabic: true } },
  },
} as const;

type EmployeeLite = {
  id: string;
  firstNameArabic: string;
  lastNameArabic: string;
  employeeId: string;
  department: { nameArabic: string } | null;
};

const fullName = (e: { firstNameArabic: string | null; lastNameArabic: string | null } | null | undefined) =>
  e ? `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() : '';

function employeeFields(e: EmployeeLite | null | undefined) {
  return {
    employeeName: fullName(e),
    employeeId: e?.employeeId ?? '-',
    department: e?.department?.nameArabic || 'غير محدد',
  };
}

function cleanLeaveNotes(notes: string | null): string {
  return stripStatutoryNoteMarkers(notes)
    .split(LEAVE_NOTE_MARKERS.OUTSIDE)
    .join('')
    .split(LEAVE_NOTE_MARKERS.ACCEPT_EXCESS)
    .join('')
    .trim();
}

const byNewest = (a: { createdAt: Date }, b: { createdAt: Date }) => b.createdAt.getTime() - a.createdAt.getTime();

// ---------------------------------------------------------------------------
// GET: pending requests grouped by origin
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const user = await requireUser(ACCESS_ROLES);
    const scope = hubScope(user);
    const isHr = scope === 'FULL';
    const isPurchasing = scope === 'PURCHASING';
    // Finance/payroll users (not HR) only see the finance items.
    const hrOnly = <T,>(q: () => Promise<T[]>): Promise<T[]> => (isHr ? q() : Promise.resolve([]));
    // Finance items: HR + finance/payroll, never the purchasing agent.
    const hubOnly = <T,>(q: () => Promise<T[]>): Promise<T[]> => (isPurchasing ? Promise.resolve([]) : q());
    // Asset requests: HR sees every pending stage, the purchasing agent only its own stage.
    const assetRequestStatuses: string[] = isHr
      ? [...ASSET_REQUEST_PENDING]
      : isPurchasing
        ? [ASSET_REQUEST_STATUS.PENDING_PURCHASING]
        : [];

    const [
      pendingLeaves,
      pendingLoans,
      pendingTerminations,
      pendingOvertimes,
      pendingWorkAssignments,
      pendingDeductions,
      pendingJobRequests,
      pendingOnboardingRequests,
      pendingAttendanceCorrections,
      pendingTransfers,
      branches,
      departments,
      pendingOwnerRequests,
      pendingAssetRequests,
      returnFromLeave,
      annualLeaveDaysSetting,
    ] = await Promise.all([
      hrOnly(() =>
        prisma.leave.findMany({
          where: { status: LEAVE_STATUS.PENDING },
          select: {
            id: true,
            leaveType: true,
            startDate: true,
            endDate: true,
            totalDays: true,
            notes: true,
            isOutsideKSA: true,
            unpaidDays: true,
            isManagerApproved: true,
            createdAt: true,
            employee: {
              select: {
                ...employeeSelect.select,
                directManagerId: true,
                joinDate: true,
                leaveAccrualStartDate: true,
                leaves: {
                  where: {
                    leaveType: { in: BALANCE_LEAVE_TYPES as LeaveType[] },
                    status: { in: [LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED, LEAVE_STATUS.COMPLETED] },
                  },
                  select: {
                    id: true,
                    leaveType: true,
                    status: true,
                    paidDays: true,
                    // Legacy rows without paidDays fall back to totalDays - unpaidDays.
                    totalDays: true,
                    unpaidDays: true,
                    startDate: true,
                    endDate: true,
                    createdAt: true,
                  },
                },
              },
            },
          },
        }),
      ),
      hubOnly(() =>
        prisma.loan.findMany({
          where: { status: { in: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED] } },
          select: { id: true, amount: true, reason: true, status: true, monthlyInstallment: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hrOnly(() =>
        prisma.terminationRequest.findMany({
          where: { status: SIMPLE_STATUS.PENDING },
          select: { id: true, terminationType: true, reasonDetails: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hubOnly(() =>
        prisma.overtimeRequest.findMany({
          where: { status: SIMPLE_STATUS.PENDING },
          select: { id: true, type: true, hours: true, amount: true, date: true, reason: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hubOnly(() =>
        prisma.workAssignment.findMany({
          where: { status: { in: WORK_ASSIGNMENT_PENDING } },
          select: { id: true, destination: true, startDate: true, endDate: true, status: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hubOnly(() =>
        prisma.deduction.findMany({
          where: { status: { in: DEDUCTION_PENDING_STATUSES } },
          select: { id: true, amount: true, reason: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hrOnly(() =>
        prisma.jobRequest.findMany({
          where: { status: SIMPLE_STATUS.PENDING },
          select: {
            id: true,
            jobTitle: true,
            jobType: true,
            createdAt: true,
            department: { select: { nameArabic: true } },
            requester: employeeSelect,
          },
        }),
      ),
      // Full record: the page opens it in the onboarding review/edit modal.
      hrOnly(() => prisma.onboardingRequest.findMany({ where: { status: SIMPLE_STATUS.PENDING } })),
      hrOnly(() =>
        prisma.attendanceCorrection.findMany({
          where: { status: SIMPLE_STATUS.PENDING },
          select: { id: true, date: true, reason: true, isManagerApproved: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hrOnly(() =>
        prisma.transferRequest.findMany({
          where: { status: SIMPLE_STATUS.PENDING },
          select: { id: true, toBranchId: true, reason: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      hrOnly(() => prisma.branch.findMany({ select: { id: true, nameArabic: true } })),
      hrOnly(() => prisma.department.findMany({ select: { id: true, nameArabic: true } })),
      hrOnly(() =>
        prisma.ownerRequest.findMany({
          where: { status: SIMPLE_STATUS.PENDING },
          select: { id: true, title: true, assignedTo: true, createdAt: true },
        }),
      ),
      assetRequestStatuses.length
        ? prisma.assetRequest.findMany({
            where: { status: { in: assetRequestStatuses } },
            select: {
              id: true,
              assetType: true,
              description: true,
              status: true,
              createdAt: true,
              requestedFor: { select: { ...employeeSelect.select, isTerminated: true } },
            },
          })
        : Promise.resolve([]),
      hrOnly(() =>
        prisma.leave.findMany({
          where: { status: LEAVE_STATUS.APPROVED, actualReturnDate: { not: null }, isReturned: false },
          select: { id: true, actualReturnDate: true, createdAt: true, employee: employeeSelect },
        }),
      ),
      isHr ? getNumericSetting(prisma, SETTING_KEYS.ANNUAL_LEAVE_DAYS) : Promise.resolve(null),
    ]);

    // Warehouse stock offered when closing a request at the purchasing stage ("صرف من المستودع").
    const vacantAssets = pendingAssetRequests.some((r) => r.status === ASSET_REQUEST_STATUS.PENDING_PURCHASING)
      ? await prisma.asset.findMany({
          where: { status: { in: [ASSET_STATUS.VACANT, ASSET_STATUS.RETURNED] } },
          select: { id: true, assetType: true, description: true },
          orderBy: { createdAt: 'desc' },
          take: VACANT_ASSET_OPTIONS_MAX,
        })
      : [];

    const branchName = new Map(branches.map((b) => [b.id, b.nameArabic]));
    const departmentName = new Map(departments.map((d) => [d.id, d.nameArabic]));

    // ----- Employee requests
    const employeeReqs = [
      ...pendingLeaves.map((r) => {
        const notes = r.notes || '';
        const acceptExcess = notes.includes(LEAVE_NOTE_MARKERS.ACCEPT_EXCESS);
        const isOutside = r.isOutsideKSA || notes.includes(LEAVE_NOTE_MARKERS.OUTSIDE);
        const cleanNotes = cleanLeaveNotes(r.notes);
        const balance = computeLeaveBalance({
          joinDate: r.employee.joinDate,
          leaveAccrualStartDate: r.employee.leaveAccrualStartDate,
          leaves: r.employee.leaves,
          asOf: r.startDate,
          annualLeaveDaysSetting,
          excludeLeaveId: r.id,
        });
        const availableBalance = balance.available;
        const totalDays = r.totalDays || 0;
        const usesBalance = BALANCE_LEAVE_TYPES.includes(r.leaveType);
        const unpaidDays =
          r.unpaidDays ?? (usesBalance && totalDays > availableBalance ? Math.ceil(totalDays - availableBalance) : 0);
        const typeLabel = leaveTypeFullLabel(r.leaveType, r.notes);
        const eventDate = parseStatutoryNoteMarkers(r.notes).eventDate;
        const awaitingManager = !r.isManagerApproved && !!r.employee.directManagerId;

        return {
          id: `leave-${r.id}`,
          dbId: r.id,
          empDbId: r.employee.id,
          category: 'EMPLOYEE',
          type: 'LEAVE',
          title: 'طلب إجازة',
          ...employeeFields(r.employee),
          createdAt: r.createdAt,
          // "Awaiting direct manager" is shown as a badge by the page (customData.awaitingManagerApproval).
          details: `نوع الإجازة: ${typeLabel} | من ${formatDateShort(r.startDate)} إلى ${formatDateShort(r.endDate)}${eventDate ? ` | تاريخ الواقعة: ${formatDateShort(eventDate)}` : ''}`,
          customData: {
            leaveType: r.leaveType,
            leaveTypeMap: typeLabel,
            totalDays,
            notes: cleanNotes || 'لا يوجد ملاحظات إضافية',
            startDate: r.startDate.toISOString(),
            endDate: r.endDate.toISOString(),
            isOutsideKSA: isOutside,
            availableBalance: availableBalance.toFixed(0),
            unpaidDays,
            acceptUnpaidExtraDays: acceptExcess,
            isManagerApproved: r.isManagerApproved,
            awaitingManagerApproval: awaitingManager,
            // Statutory / sick / unpaid leaves do not consume the annual balance: the card hides it.
            usesAnnualBalance: usesBalance,
          },
        };
      }),
      ...pendingLoans.map((r) => ({
        id: `loan-${r.id}`,
        dbId: r.id,
        empDbId: r.employee.id,
        category: 'EMPLOYEE',
        type: 'LOAN',
        title: 'طلب سلفة مبكرة',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `مبلغ السلفة المطلوبة: ${roundMoney(r.amount)} ر.س | القسط الشهري: ${roundMoney(r.monthlyInstallment)} ر.س | المبرر: ${r.reason || 'بدون مبرر'}`,
      })),
      ...pendingTerminations.map((r) => ({
        id: `term-${r.id}`,
        dbId: r.id,
        empDbId: r.employee.id,
        category: 'EMPLOYEE',
        type: 'TERMINATION',
        title: 'طلب إنهاء عقد / استقالة',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `النوع: ${r.terminationType} | المبرر: ${r.reasonDetails || 'غير محدد'}`,
      })),
      ...pendingAttendanceCorrections.map((r) => ({
        id: `acc-${r.id}`,
        dbId: r.id,
        category: 'EMPLOYEE',
        type: 'ATTENDANCE_CORRECTION',
        title: 'تصحيح بصمة / حضور',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `التاريخ المراد تصحيحه: ${formatDateShort(r.date)} | السبب: ${r.reason}`,
      })),
    ].sort(byNewest);

    // ----- Direct manager requests
    const managerReqs = [
      ...pendingOvertimes.map((r) => ({
        id: `overtime-${r.id}`,
        dbId: r.id,
        category: 'MANAGER',
        type: 'OVERTIME',
        title: 'تكليف عمل إضافي',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details:
          r.type === 'LUMP_SUM'
            ? `مبلغ مقطوع ${roundMoney(r.amount ?? 0)} ر.س بتاريخ ${formatDateShort(r.date)}`
            : `وقت إضافي لمدة ${r.hours ?? 0} ساعة بتاريخ ${formatDateShort(r.date)}`,
      })),
      ...pendingWorkAssignments.map((r) => ({
        id: `work-${r.id}`,
        dbId: r.id,
        category: 'MANAGER',
        type: 'WORK_ASSIGNMENT',
        title: 'تكليف مهمة خارجية (انتداب)',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `الوجهة: ${r.destination} | من ${formatDateShort(r.startDate)} إلى ${formatDateShort(r.endDate)}${r.status === 'PENDING_EMPLOYEE' ? ' | بانتظار موافقة الموظف' : ''}`,
      })),
      ...pendingDeductions.map((r) => ({
        id: `deduction-${r.id}`,
        dbId: r.id,
        category: 'MANAGER',
        type: 'DEDUCTION',
        title: 'اعتماد مخالفة وحسم',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `مبلغ الحسم: ${roundMoney(r.amount)} ر.س | السبب: ${r.reason}`,
      })),
      ...returnFromLeave.map((r) => ({
        id: `return-${r.id}`,
        dbId: r.id,
        category: 'MANAGER',
        type: 'RETURN_NOTICE',
        title: 'إشعار مباشرة عمل بعد إجازة',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `تاريخ المباشرة الفعلية: ${formatDateShort(r.actualReturnDate)}`,
      })),
      ...pendingOnboardingRequests.map((r) => ({
        id: `onboarding-${r.id}`,
        dbId: r.id,
        category: 'MANAGER',
        type: 'ONBOARDING',
        title: 'إشعار مباشرة عمل موظف جديد',
        employeeName: r.fullNameArabic,
        employeeId: r.iqamaOrIdNumber,
        department: (r.departmentId && departmentName.get(r.departmentId)) || 'غير محدد',
        createdAt: r.createdAt,
        details: `الراتب الأساسي: ${roundMoney(r.basicSalary ?? 0)} ر.س | الجوال: ${r.mobileNumber} | البنك: ${r.bankName || 'غير محدد'}`,
        customData: r, // full record for the review/edit modal
      })),
    ].sort(byNewest);

    // ----- Department manager requests
    const deptManagerReqs = [
      ...pendingJobRequests.map((r) => ({
        id: `job-${r.id}`,
        dbId: r.id,
        category: 'DEPT_MANAGER',
        type: 'HIRING',
        title: 'طلب احتياج وظيفي',
        employeeName: fullName(r.requester) || 'طلب مجهول / رفع عام',
        employeeId: r.requester?.employeeId ?? '-',
        department: r.department?.nameArabic || r.requester?.department?.nameArabic || 'حسب الطلب',
        createdAt: r.createdAt,
        details: `المسمى: ${r.jobTitle} | استقطاب كفاءات (${r.jobType})`,
      })),
      ...pendingTransfers.map((r) => ({
        id: `transfer-${r.id}`,
        dbId: r.id,
        category: 'DEPT_MANAGER',
        type: 'TRANSFER',
        title: 'طلب نقل داخلي',
        ...employeeFields(r.employee),
        createdAt: r.createdAt,
        details: `الفرع المطلوب: ${branchName.get(r.toBranchId) || 'غير محدد'} | السبب: ${r.reason || 'بدون سبب'}`,
      })),
      ...pendingAssetRequests.map((r) => ({
        id: `assetreq-${r.id}`,
        dbId: r.id,
        category: 'DEPT_MANAGER',
        type: 'ASSET_REQUEST',
        title: 'طلب احتياج عهدة/أجهزة',
        ...employeeFields(r.requestedFor),
        createdAt: r.createdAt,
        details: `النوع: ${assetTypeLabel(r.assetType)} | الحالة: ${ASSET_STATUS_LABELS[r.status] ?? r.status}`,
        customData: {
          assetType: r.assetType,
          description: r.description,
          status: r.status,
          requestedForTerminated: r.requestedFor.isTerminated,
          ...(r.status === ASSET_REQUEST_STATUS.PENDING_PURCHASING
            ? { vacantAssets: vacantAssetOptions(r.assetType, vacantAssets) }
            : {}),
        },
      })),
    ].sort(byNewest);

    // ----- Owner requests
    const ownerReqs = pendingOwnerRequests
      .map((r) => ({
        id: `ownerreq-${r.id}`,
        dbId: r.id,
        category: 'OWNER',
        type: 'OWNER_REQUEST',
        title: 'توجيه / طلب من صاحب العمل',
        employeeName: 'صاحب العمل / الإدارة العليا',
        employeeId: '-',
        department: 'الإدارة العليا',
        createdAt: r.createdAt,
        details: `الموضوع: ${r.title} | توجيه إلى: ${r.assignedTo || 'جهة غير محددة'}`,
      }))
      .sort(byNewest);

    return NextResponse.json({
      scope,
      employeeRequests: employeeReqs,
      managerRequests: managerReqs,
      deptManagerRequests: deptManagerReqs,
      ownerRequests: ownerReqs,
    });
  } catch (err) {
    return handleApiError(err, 'incoming-requests:GET');
  }
}

// ---------------------------------------------------------------------------
// POST: approve / reject one request
// ---------------------------------------------------------------------------

const actionSchema = z.object({
  actionType: z.enum(['APPROVE', 'REJECT']),
  type: z.enum(REQUEST_TYPES),
  dbId: zId,
  /** Optional rejection reason / HR note. */
  reason: zOptText(1000),
  /**
   * ASSET_REQUEST closed at the purchasing stage: a warehouse asset (VACANT / RETURNED) handed to the
   * employee instead of creating a new asset record.
   */
  existingAssetId: zOptText(100),
  /** Onboarding review edits (validated separately, only whitelisted fields are used). */
  updatedData: z.unknown().optional(),
});

/** Editable onboarding fields (whitelist). Unknown keys sent by the page are ignored. */
const onboardingEditsSchema = z.object({
  fullNameArabic: zText(200).optional(),
  /** Edited first name in the review modal (not a column of OnboardingRequest). */
  firstNameArabic: zOptText(100),
  lastNameArabic: zOptText(100),
  firstNameEnglish: zOptText(100),
  lastNameEnglish: zOptText(100),
  nationality: zOptText(50),
  dateOfBirth: zOptDate,
  gender: zOptText(20),
  maritalStatus: zOptText(30),
  iqamaOrIdNumber: zText(50).optional(),
  iqamaOrIdExp: zOptDate,
  passportNumber: zOptText(50),
  passportExp: zOptDate,
  mobileNumber: zText(30).optional(),
  email: z
    .preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(200).nullable())
    .optional(),
  branchId: zOptText(100),
  administrationId: zOptText(100),
  departmentId: zOptText(100),
  directManagerId: zOptText(100),
  jobTitle: zOptText(200),
  joinDate: zOptDate,
  contractType: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.enum(CONTRACT_TYPES).nullable()).optional(),
  bankName: zOptText(100),
  ibanNumber: zOptText(50),
  basicSalary: zOptMoney,
  iqamaCopyUrl: zOptText(1000),
  passportCopyUrl: zOptText(1000),
  ibanCertificateUrl: zOptText(1000),
  resumeUrl: zOptText(1000),
  workContractUrl: zOptText(1000),
  healthCertificateUrl: zOptText(1000),
});
type OnboardingEdits = z.infer<typeof onboardingEditsSchema>;

interface ActionCtx {
  user: AuthUser;
  ip: string;
  approve: boolean;
  id: string;
  reason: string | null;
  existingAssetId: string | null;
}

function requireGroup(user: AuthUser, group: readonly string[], message?: string) {
  if (!hasRole(user, group)) throw forbidden(message);
}

/** Throws 404 when the row doesn't exist, else 409 (already processed). */
async function guardFailed(exists: Promise<unknown>, message = 'تمت معالجة هذا الطلب مسبقاً'): Promise<never> {
  if (!(await exists)) throw notFound();
  throw conflict(message);
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ACCESS_ROLES);
    const body = await parseBody(req, actionSchema);
    const type: RequestType = body.type;
    if (hubScope(user) === 'PURCHASING') {
      // Only asset requests; the stage check in the handler limits it to PENDING_PURCHASING.
      if (type !== 'ASSET_REQUEST') throw forbidden('صلاحية مسؤول المشتريات تقتصر على طلبات العهد في مرحلة الشراء');
    } else if (!(FINANCE_TYPES as readonly string[]).includes(type)) {
      requireGroup(user, ROLE_GROUPS.HR, 'اعتماد هذا الطلب من صلاحية الموارد البشرية');
    }
    if (body.existingAssetId && type !== 'ASSET_REQUEST') throw badRequest('اختيار أصل من المستودع خاص بطلبات العهد');
    const ctx: ActionCtx = {
      user,
      ip: getClientIp(req),
      approve: body.actionType === 'APPROVE',
      id: body.dbId,
      reason: body.reason ?? null,
      existingAssetId: body.existingAssetId ?? null,
    };

    if (type === 'ONBOARDING') {
      if (ctx.approve) {
        const edits = onboardingEditsSchema.parse(body.updatedData ?? {});
        const created = await approveOnboarding(ctx, edits);
        const missing = onboardingPlaceholderLabels(created.placeholderFields);
        return NextResponse.json({
          message: `تم اعتماد مباشرة العمل وتسجيل الموظف برقم وظيفي ${created.employeeCode}`,
          employeeId: created.employeeId,
          employeeCode: created.employeeCode,
          placeholderFields: created.placeholderFields,
          dataReviewNote: created.dataReviewNote,
          warning:
            [
              missing.length ? `تم تعبئة الحقول التالية مؤقتاً بتاريخ اليوم، يرجى استكمالها في ملف الموظف: ${missing.join('، ')}` : '',
              created.nationalityNeedsReview ? 'لم تُحدد جنسية الموظف في الطلب (سُجلت "غير سعودي")، يرجى تحديثها في ملف الموظف.' : '',
            ]
              .filter(Boolean)
              .join(' ') || null,
        });
      }
      await rejectOnboarding(ctx);
      return NextResponse.json({ message: 'تم رفض طلب مباشرة العمل' });
    }

    const message = await prisma.$transaction((tx) => HANDLERS[type](tx, ctx));
    return NextResponse.json({ message: message || 'تم إنجاز الإجراء بنجاح' });
  } catch (err) {
    return handleApiError(err, 'incoming-requests:POST');
  }
}

type Tx = Prisma.TransactionClient;
type Handler = (tx: Tx, ctx: ActionCtx) => Promise<string | void>;

const HANDLERS: Record<Exclude<RequestType, 'ONBOARDING'>, Handler> = {
  async LEAVE(tx, { user, ip, approve, id, reason }) {
    if (approve) {
      await approveLeave(tx, id, 'HR', user, { ipAddress: ip });
      return 'تم اعتماد الإجازة';
    }
    await rejectLeave(tx, id, user, reason, { ipAddress: ip });
    return 'تم رفض طلب الإجازة';
  },

  async LOAN(tx, { user, ip, approve, id, reason }) {
    if (approve) {
      await approveLoanStep(tx, id, 'HR', user, { ipAddress: ip });
      return 'تم اعتماد السلفة من الموارد البشرية وإحالتها للمالية للتحويل';
    }
    await rejectLoan(tx, id, user, reason, { ipAddress: ip });
    return 'تم رفض طلب السلفة';
  },

  async DEDUCTION(tx, { user, ip, approve, id, reason }) {
    if (approve) {
      await approveDeduction(tx, id, user, { ipAddress: ip });
      return 'تم اعتماد المخالفة وستُخصم في مسير الرواتب القادم';
    }
    await rejectDeduction(tx, id, user, reason, { ipAddress: ip });
    return 'تم رفض المخالفة';
  },

  async TRANSFER(tx, { user, ip, approve, id, reason }) {
    if (approve) {
      await approveTransfer(tx, id, user, { ipAddress: ip, ...(reason ? { hrNote: reason } : {}) });
      return 'تم اعتماد النقل وتحديث بيانات الموظف';
    }
    await rejectTransfer(tx, id, user, reason, { ipAddress: ip });
    return 'تم رفض طلب النقل';
  },

  async ATTENDANCE_CORRECTION(tx, { user, ip, approve, id, reason }) {
    if (approve) {
      const res = await approveAttendanceCorrection(tx, id, user, { ipAddress: ip, stage: 'HR', comment: reason });
      return res.message;
    }
    const res = await rejectAttendanceCorrection(tx, id, user, reason, { ipAddress: ip });
    return res.message;
  },

  async RETURN_NOTICE(tx, { user, ip, approve, id }) {
    if (approve) {
      await confirmLeaveReturn(tx, id, user, { ipAddress: ip });
      return 'تم تأكيد مباشرة الموظف بعد الإجازة';
    }
    await rejectLeaveReturn(tx, id, user, { ipAddress: ip });
    return 'تم رفض إشعار المباشرة';
  },

  async TERMINATION(tx, { user, ip, approve, id, reason }) {
    const now = new Date();
    const res = await tx.terminationRequest.updateMany({
      where: { id, status: SIMPLE_STATUS.PENDING },
      data: approve
        ? { status: SIMPLE_STATUS.APPROVED, isHrApproved: true, hrApprovedAt: now }
        : { status: SIMPLE_STATUS.REJECTED },
    });
    if (res.count === 0) await guardFailed(tx.terminationRequest.findUnique({ where: { id }, select: { id: true } }));
    await logAudit(
      { userId: user.id, action: approve ? 'APPROVE' : 'REJECT', entityType: 'TerminationRequest', entityId: id, details: { reason }, ipAddress: ip },
      tx,
    );
    return approve ? 'تم اعتماد طلب إنهاء العقد' : 'تم رفض طلب إنهاء العقد';
  },

  async OVERTIME(tx, { user, ip, approve, id, reason }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const status = approve ? SIMPLE_STATUS.APPROVED : SIMPLE_STATUS.REJECTED;
    const res = await tx.overtimeRequest.updateMany({ where: { id, status: SIMPLE_STATUS.PENDING }, data: { status } });
    if (res.count === 0) await guardFailed(tx.overtimeRequest.findUnique({ where: { id }, select: { id: true } }));
    await logAudit(
      { userId: user.id, action: approve ? 'APPROVE' : 'REJECT', entityType: 'OVERTIME', entityId: id, details: { status, reason }, ipAddress: ip },
      tx,
    );
    return approve ? 'تم اعتماد العمل الإضافي' : 'تم رفض طلب العمل الإضافي';
  },

  async WORK_ASSIGNMENT(tx, { user, ip, approve, id, reason }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const status = approve ? SIMPLE_STATUS.APPROVED : SIMPLE_STATUS.REJECTED;
    const res = await tx.workAssignment.updateMany({
      where: { id, status: { in: WORK_ASSIGNMENT_PENDING } },
      data: { status, ...(approve ? { hrApprovedAt: new Date() } : {}) },
    });
    if (res.count === 0) await guardFailed(tx.workAssignment.findUnique({ where: { id }, select: { id: true } }));
    await logAudit(
      { userId: user.id, action: approve ? 'APPROVE' : 'REJECT', entityType: 'WORK_ASSIGNMENT', entityId: id, details: { status, reason }, ipAddress: ip },
      tx,
    );
    return approve ? 'تم اعتماد المهمة الخارجية' : 'تم رفض المهمة الخارجية';
  },

  async HIRING(tx, { user, ip, approve, id, reason }) {
    const status = approve ? SIMPLE_STATUS.APPROVED : SIMPLE_STATUS.REJECTED;
    const res = await tx.jobRequest.updateMany({ where: { id, status: SIMPLE_STATUS.PENDING }, data: { status } });
    if (res.count === 0) await guardFailed(tx.jobRequest.findUnique({ where: { id }, select: { id: true } }));
    await logAudit(
      { userId: user.id, action: approve ? 'APPROVE' : 'REJECT', entityType: 'JobRequest', entityId: id, details: { status, reason }, ipAddress: ip },
      tx,
    );
    return approve ? 'تم اعتماد طلب الاحتياج الوظيفي' : 'تم رفض طلب الاحتياج الوظيفي';
  },

  async OWNER_REQUEST(tx, { user, ip, approve, id, reason }) {
    const status = approve ? 'COMPLETED' : SIMPLE_STATUS.REJECTED;
    const res = await tx.ownerRequest.updateMany({ where: { id, status: { in: OWNER_REQUEST_OPEN } }, data: { status } });
    if (res.count === 0) await guardFailed(tx.ownerRequest.findUnique({ where: { id }, select: { id: true } }));
    await logAudit(
      { userId: user.id, action: approve ? 'APPROVE' : 'REJECT', entityType: 'OwnerRequest', entityId: id, details: { status, reason }, ipAddress: ip },
      tx,
    );
    return approve ? 'تم إنجاز توجيه صاحب العمل' : 'تم رفض الطلب';
  },

  async ASSET_REQUEST(tx, { user, ip, approve, id, reason, existingAssetId }) {
    const current = await tx.assetRequest.findUnique({
      where: { id },
      select: { id: true, status: true, assetType: true, description: true, requestedForId: true },
    });
    if (!current) throw notFound('طلب العهدة غير موجود');
    const stageRoles = ASSET_STAGE_ROLES[current.status];
    if (!stageRoles) throw conflict('تمت معالجة هذا الطلب مسبقاً');
    requireGroup(
      user,
      stageRoles,
      hubScope(user) === 'PURCHASING'
        ? 'هذا الطلب لم يصل بعد إلى مرحلة المشتريات'
        : current.status === ASSET_REQUEST_STATUS.PENDING_OWNER
          ? 'هذه المرحلة بانتظار اعتماد صاحب العمل'
          : undefined,
    );

    const now = new Date();
    let data: Prisma.AssetRequestUpdateManyMutationInput;
    if (!approve) {
      const noteField =
        current.status === ASSET_REQUEST_STATUS.PENDING_OWNER
          ? 'ownerNotes'
          : current.status === ASSET_REQUEST_STATUS.PENDING_PURCHASING
            ? 'purchasingNotes'
            : 'hrNotes';
      data = { status: ASSET_REQUEST_STATUS.REJECTED, ...(reason ? { [noteField]: reason } : {}) };
    } else if (current.status === ASSET_REQUEST_STATUS.PENDING_HR) {
      data = { status: ASSET_REQUEST_STATUS.PENDING_OWNER, hrApprovedAt: now, ...(reason ? { hrNotes: reason } : {}) };
    } else if (current.status === ASSET_REQUEST_STATUS.PENDING_OWNER) {
      data = { status: ASSET_REQUEST_STATUS.PENDING_PURCHASING, ownerApprovedAt: now, ...(reason ? { ownerNotes: reason } : {}) };
    } else {
      data = { status: ASSET_REQUEST_STATUS.COMPLETED, completedAt: now, ...(reason ? { purchasingNotes: reason } : {}) };
    }

    const completing = approve && data.status === ASSET_REQUEST_STATUS.COMPLETED;
    if (existingAssetId && !completing) throw badRequest('اختيار أصل من المستودع متاح عند إقفال الطلب في مرحلة المشتريات فقط');
    // Custody is never handed to an employee whose service has ended.
    if (completing) await ensureRefsExist(tx, { employeeIds: [current.requestedForId] }, { activeOnly: true });

    const res = await tx.assetRequest.updateMany({ where: { id, status: current.status }, data });
    if (res.count === 0) throw conflict('تمت معالجة هذا الطلب مسبقاً');

    let assetId: string | null = null;
    if (completing && existingAssetId) {
      // "صرف من المستودع": hand over an asset that is in the warehouse (atomic status guard).
      const handed = await tx.asset.updateMany({
        where: { id: existingAssetId, status: { in: [ASSET_STATUS.VACANT, ASSET_STATUS.RETURNED] } },
        data: { status: ASSET_STATUS.ACTIVE, employeeId: current.requestedForId, receiveDate: today(), returnDate: null },
      });
      if (handed.count === 0) {
        const exists = await tx.asset.findUnique({ where: { id: existingAssetId }, select: { id: true } });
        if (!exists) throw notFound('الأصل المختار غير موجود');
        throw conflict('الأصل المختار لم يعد متاحاً في المستودع، اختر أصلاً آخر');
      }
      assetId = existingAssetId;
    } else if (completing) {
      const created = await tx.asset.create({
        data: {
          employeeId: current.requestedForId,
          assetType: assetTypeLabel(current.assetType),
          description: current.description || 'مضاف تلقائيا من طلب العهدة',
          receiveDate: today(),
          status: ASSET_STATUS.ACTIVE,
        },
      });
      assetId = created.id;
    }
    await logAudit(
      {
        userId: user.id,
        action: approve ? 'APPROVE' : 'REJECT',
        entityType: 'AssetRequest',
        entityId: id,
        details: {
          from: current.status,
          to: data.status,
          ...(reason ? { reason } : {}),
          ...(completing ? { fulfilment: existingAssetId ? 'WAREHOUSE' : 'NEW_ASSET', assetId } : {}),
        },
        ipAddress: ip,
      },
      tx,
    );
    if (!approve) return 'تم رفض طلب العهدة';
    if (!completing) return 'تم اعتماد الطلب وإحالته للمرحلة التالية';
    return existingAssetId
      ? 'تم صرف الأصل من المستودع وإسناده للموظف، وأُقفل الطلب'
      : 'تم تسليم العهدة وإضافتها لسجل عهد الموظف';
  },
};

// ---------------------------------------------------------------------------
// Onboarding (new employee) approval
// ---------------------------------------------------------------------------

/** Columns of OnboardingRequest that HR may edit during review. */
function onboardingRequestUpdate(e: OnboardingEdits): Prisma.OnboardingRequestUpdateManyMutationInput {
  const out: Prisma.OnboardingRequestUpdateManyMutationInput = {};
  const assign = <K extends keyof Prisma.OnboardingRequestUpdateManyMutationInput>(
    key: K,
    value: Prisma.OnboardingRequestUpdateManyMutationInput[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value;
  };
  assign('fullNameArabic', e.fullNameArabic);
  assign('lastNameArabic', e.lastNameArabic);
  assign('firstNameEnglish', e.firstNameEnglish);
  assign('lastNameEnglish', e.lastNameEnglish);
  assign('nationality', e.nationality);
  assign('dateOfBirth', e.dateOfBirth);
  assign('gender', e.gender);
  assign('maritalStatus', e.maritalStatus);
  assign('iqamaOrIdNumber', e.iqamaOrIdNumber);
  assign('iqamaOrIdExp', e.iqamaOrIdExp);
  assign('passportNumber', e.passportNumber);
  assign('passportExp', e.passportExp);
  assign('mobileNumber', e.mobileNumber);
  assign('email', e.email);
  assign('branchId', e.branchId);
  assign('administrationId', e.administrationId);
  assign('departmentId', e.departmentId);
  assign('directManagerId', e.directManagerId);
  assign('jobTitle', e.jobTitle);
  assign('joinDate', e.joinDate);
  assign('contractType', e.contractType);
  assign('bankName', e.bankName);
  assign('ibanNumber', e.ibanNumber);
  assign('basicSalary', e.basicSalary !== undefined ? roundMoney(e.basicSalary) : undefined);
  assign('iqamaCopyUrl', e.iqamaCopyUrl);
  assign('passportCopyUrl', e.passportCopyUrl);
  assign('ibanCertificateUrl', e.ibanCertificateUrl);
  assign('resumeUrl', e.resumeUrl);
  assign('workContractUrl', e.workContractUrl);
  assign('healthCertificateUrl', e.healthCertificateUrl);
  return out;
}

const pick = <T,>(edited: T | undefined, stored: T): T => (edited !== undefined ? edited : stored);

async function assertOrgUnitsExist(
  tx: Tx,
  ids: { branchId: string | null; administrationId: string | null; departmentId: string | null },
): Promise<void> {
  const [branch, administration, department] = await Promise.all([
    ids.branchId ? tx.branch.findUnique({ where: { id: ids.branchId }, select: { id: true } }) : Promise.resolve(true),
    ids.administrationId
      ? tx.administration.findUnique({ where: { id: ids.administrationId }, select: { id: true } })
      : Promise.resolve(true),
    ids.departmentId ? tx.department.findUnique({ where: { id: ids.departmentId }, select: { id: true } }) : Promise.resolve(true),
  ]);
  if (!branch) throw badRequest('الفرع المحدد غير موجود');
  if (!administration) throw badRequest('الإدارة المحددة غير موجودة');
  if (!department) throw badRequest('القسم المحدد غير موجود');
}

const EMPLOYEE_CODE_ATTEMPTS = 5;

interface OnboardingResult {
  employeeId: string;
  employeeCode: string;
  /** Required dates that were missing and filled with today() (HR must complete them). */
  placeholderFields: OnboardingPlaceholderField[];
  /** Employee.dataReviewNote written on the new employee (null when the file is complete). */
  dataReviewNote: string | null;
  /** The request gave no specific nationality (legacy "NON_SAUDI"): HR must set it. */
  nationalityNeedsReview: boolean;
}

/**
 * Approves a PENDING onboarding request and creates the employee in the same transaction.
 * The whole transaction is retried when a concurrent request took the same employee code
 * (a failed INSERT aborts a PostgreSQL transaction, so the retry must start a new one).
 */
async function approveOnboarding(ctx: ActionCtx, edits: OnboardingEdits): Promise<OnboardingResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.onboardingRequest.findUnique({ where: { id: ctx.id } });
        if (!current) throw notFound('طلب مباشرة العمل غير موجود');
        if (current.status !== SIMPLE_STATUS.PENDING) throw conflict('تمت معالجة هذا الطلب مسبقاً');

        const m = {
          fullNameArabic: pick(edits.fullNameArabic, current.fullNameArabic),
          lastNameArabic: pick(edits.lastNameArabic, current.lastNameArabic),
          firstNameEnglish: pick(edits.firstNameEnglish, current.firstNameEnglish),
          lastNameEnglish: pick(edits.lastNameEnglish, current.lastNameEnglish),
          nationality: pick(edits.nationality, current.nationality),
          dateOfBirth: pick(edits.dateOfBirth, current.dateOfBirth),
          gender: pick(edits.gender, current.gender),
          maritalStatus: pick(edits.maritalStatus, current.maritalStatus),
          iqamaOrIdNumber: pick(edits.iqamaOrIdNumber, current.iqamaOrIdNumber).trim(),
          iqamaOrIdExp: pick(edits.iqamaOrIdExp, current.iqamaOrIdExp),
          passportNumber: pick(edits.passportNumber, current.passportNumber),
          passportExp: pick(edits.passportExp, current.passportExp),
          mobileNumber: pick(edits.mobileNumber, current.mobileNumber),
          email: pick(edits.email, current.email),
          branchId: pick(edits.branchId, current.branchId),
          administrationId: pick(edits.administrationId, current.administrationId),
          departmentId: pick(edits.departmentId, current.departmentId),
          directManagerId: pick(edits.directManagerId, current.directManagerId),
          jobTitle: pick(edits.jobTitle, current.jobTitle),
          joinDate: pick(edits.joinDate, current.joinDate),
          contractType: pick<string | null>(edits.contractType, current.contractType),
          bankName: pick(edits.bankName, current.bankName),
          ibanNumber: pick(edits.ibanNumber, current.ibanNumber),
          basicSalary: pick<number | null>(edits.basicSalary, current.basicSalary),
          iqamaCopyUrl: pick(edits.iqamaCopyUrl, current.iqamaCopyUrl),
          passportCopyUrl: pick(edits.passportCopyUrl, current.passportCopyUrl),
          ibanCertificateUrl: pick(edits.ibanCertificateUrl, current.ibanCertificateUrl),
          resumeUrl: pick(edits.resumeUrl, current.resumeUrl),
          workContractUrl: pick(edits.workContractUrl, current.workContractUrl),
          healthCertificateUrl: pick(edits.healthCertificateUrl, current.healthCertificateUrl),
        };
        if (!m.iqamaOrIdNumber) throw badRequest('رقم الهوية / الإقامة مطلوب');

        const [duplicate] = await Promise.all([
          tx.employee.findUnique({ where: { iqamaOrIdNumber: m.iqamaOrIdNumber }, select: { employeeId: true } }),
          assertOrgUnitsExist(tx, m),
          assertValidDirectManager(tx, null, m.directManagerId),
        ]);
        if (duplicate) throw conflict(`رقم الهوية / الإقامة مسجل مسبقاً للموظف ${duplicate.employeeId}`);

        const placeholderFields = onboardingPlaceholderFields(m);
        const nationality = onboardingNationality(m.nationality);
        const dataReviewNote = onboardingDataReviewNote(placeholderFields, nationality.needsReview ? [NATIONALITY_REVIEW_LABEL] : []);
        const placeholderNote = placeholderFields.length
          ? `[بيانات مؤقتة يجب استكمالها في ملف الموظف: ${onboardingPlaceholderLabels(placeholderFields).join('، ')}]`
          : null;
        const hrNote = [ctx.reason, placeholderNote].filter(Boolean).join('\n') || null;

        const res = await tx.onboardingRequest.updateMany({
          where: { id: ctx.id, status: SIMPLE_STATUS.PENDING },
          data: { ...onboardingRequestUpdate(edits), status: SIMPLE_STATUS.APPROVED, ...(hrNote ? { hrNote } : {}) },
        });
        if (res.count === 0) throw conflict('تمت معالجة هذا الطلب مسبقاً');

        const contractType = (CONTRACT_TYPES as readonly string[]).includes(m.contractType ?? '')
          ? (m.contractType as (typeof CONTRACT_TYPES)[number])
          : 'FULL_TIME';
        const employeeCode = await nextEmployeeCode(tx);
        const employee = await tx.employee.create({
          data: {
            employeeId: employeeCode,
            firstNameArabic: edits.firstNameArabic || m.fullNameArabic || 'بدون اسم',
            lastNameArabic: m.lastNameArabic || 'بدون عائلة',
            firstNameEnglish: m.firstNameEnglish,
            lastNameEnglish: m.lastNameEnglish,
            nationality: nationality.nationality,
            dateOfBirth: m.dateOfBirth ?? today(),
            gender: m.gender || 'MALE',
            maritalStatus: m.maritalStatus,
            iqamaOrIdNumber: m.iqamaOrIdNumber,
            iqamaOrIdExp: m.iqamaOrIdExp ?? today(),
            passportNumber: m.passportNumber,
            passportExp: m.passportExp,
            mobileNumber: m.mobileNumber,
            email: m.email,
            branchId: m.branchId,
            administrationId: m.administrationId,
            departmentId: m.departmentId,
            directManagerId: m.directManagerId,
            jobTitle: m.jobTitle,
            joinDate: m.joinDate ?? today(),
            contractType,
            bankName: m.bankName,
            ibanNumber: m.ibanNumber,
            basicSalary: roundMoney(m.basicSalary ?? 0),
            iqamaCopyUrl: m.iqamaCopyUrl,
            passportCopyUrl: m.passportCopyUrl,
            ibanCertificateUrl: m.ibanCertificateUrl,
            resumeUrl: m.resumeUrl,
            workContractUrl: m.workContractUrl,
            healthCertificateUrl: m.healthCertificateUrl,
            // Required dates filled with today() above: flagged on the employee file for HR.
            dataReviewNote,
          },
          select: { id: true, employeeId: true },
        });

        await Promise.all([
          logAudit(
            {
              userId: ctx.user.id,
              action: 'APPROVE',
              entityType: 'OnboardingRequest',
              entityId: ctx.id,
              details: {
                employeeId: employee.id,
                employeeCode: employee.employeeId,
                editedFields: Object.keys(onboardingRequestUpdate(edits)),
                placeholderFields,
              },
              ipAddress: ctx.ip,
            },
            tx,
          ),
          logAudit(
            {
              userId: ctx.user.id,
              action: 'CREATE',
              entityType: 'Employee',
              entityId: employee.id,
              details: {
                source: 'OnboardingRequest',
                onboardingRequestId: ctx.id,
                employeeCode: employee.employeeId,
                // Dates filled with today() because the request left them empty: HR must complete them.
                needsCompletion: placeholderFields,
              },
              ipAddress: ctx.ip,
            },
            tx,
          ),
        ]);
        return { employeeId: employee.id, employeeCode: employee.employeeId, placeholderFields, dataReviewNote, nationalityNeedsReview: nationality.needsReview };
      });
    } catch (err) {
      if (attempt < EMPLOYEE_CODE_ATTEMPTS && isUniqueViolationOn(err, 'employeeId')) continue;
      throw err;
    }
  }
}

async function rejectOnboarding(ctx: ActionCtx): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const res = await tx.onboardingRequest.updateMany({
      where: { id: ctx.id, status: SIMPLE_STATUS.PENDING },
      data: { status: SIMPLE_STATUS.REJECTED, ...(ctx.reason ? { hrNote: ctx.reason } : {}) },
    });
    if (res.count === 0) await guardFailed(tx.onboardingRequest.findUnique({ where: { id: ctx.id }, select: { id: true } }));
    await logAudit(
      { userId: ctx.user.id, action: 'REJECT', entityType: 'OnboardingRequest', entityId: ctx.id, details: { reason: ctx.reason }, ipAddress: ctx.ip },
      tx,
    );
  });
}


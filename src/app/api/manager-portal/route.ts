// Supervisor / department-manager portal (used by /manager-portal, /dept-manager, /dept-actions
// and /asset-request). Managers raise requests for the employees they manage; HR approves them
// in /incoming-requests.
//
// Scope: HR/ADMIN act on every employee. A BRANCH_MANAGER acts on their branch (and direct
// reports), a DEPT_MANAGER on their department (and direct reports) — see managedEmployeesWhere /
// assertCanManageEmployee in src/lib/hr-workflows.ts.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireUser, type AuthUser } from '@/lib/auth';
import { DEDUCTION_PAYABLE_STATUSES, DEDUCTION_STATUS, LEAVE_STATUS, ROLE_GROUPS, type AppRole } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zDate, zId, zMoney, zNumber, zOptDate, zOptMoney, zOptText, zText } from '@/lib/validation';
import { daysBetween, formatDateShort, today } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { assertCanManageEmployee, managedEmployeesWhere, recordLeaveReturn } from '@/lib/hr-workflows';
import { normalizeNationality } from '@/lib/employee';

export const dynamic = 'force-dynamic';

/** Managers use the whole portal; logistics staff use it only to raise asset requests (/asset-request). */
const ASSET_REQUEST_ROLES: readonly AppRole[] = [...new Set<AppRole>([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.LOGISTICS])];

const HISTORY_TAKE = 10;
const CONTRACT_TYPES = ['FULL_TIME', 'PART_TIME', 'FREELANCE'] as const;
const ASSET_TYPES = ['LAPTOP', 'MOBILE', 'SIM', 'OTHER'] as const;
const ASSET_LABELS: Record<string, string> = { LAPTOP: 'جهاز حاسب', MOBILE: 'جوال', SIM: 'شريحة اتصال' };
const DEDUCTION_REJECTED = [DEDUCTION_STATUS.REJECTED, DEDUCTION_STATUS.WAIVED];

const nameSelect = { select: { firstNameArabic: true, lastNameArabic: true } } as const;
const fullName = (e: { firstNameArabic: string | null; lastNameArabic: string | null } | null | undefined) =>
  e ? `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() : '';

const scopeSelect = { id: true, directManagerId: true, branchId: true, departmentId: true, isTerminated: true } as const;

/** Loads the employee and throws 403 unless the user may act on them. */
async function loadManagedEmployee(user: AuthUser, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: scopeSelect });
  if (!employee) throw notFound('الموظف غير موجود');
  await assertCanManageEmployee(prisma, user, employee);
  if (employee.isTerminated) throw badRequest('لا يمكن رفع طلب لموظف منتهية خدماته');
  return employee;
}

/**
 * The Employee recorded as the requester. Normally the logged-in manager's own employee file;
 * an account without an employee file (e.g. the system admin) may pass an existing employee id.
 */
async function resolveRequesterId(user: AuthUser, requested: string | null | undefined): Promise<string> {
  if (user.employeeId) return user.employeeId;
  if (requested) {
    const exists = await prisma.employee.findUnique({ where: { id: requested }, select: { id: true } });
    if (exists) return exists.id;
  }
  throw forbidden('حسابك غير مرتبط بملف موظف، لا يمكن رفع الطلب باسمك');
}

// ---------------------------------------------------------------------------
// GET ?action=get_leaves | get_employees | get_history
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const action = new URL(req.url).searchParams.get('action');

    if (action === 'get_employees') {
      const user = await requireUser(ASSET_REQUEST_ROLES);
      // Logistics staff (not managers) raise asset requests for any employee: names only.
      const scope = hasRole(user, ROLE_GROUPS.MANAGERS) ? await managedEmployeesWhere(prisma, user) : null;
      const emps = await prisma.employee.findMany({
        where: { isTerminated: false, ...(scope ?? {}) },
        select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, jobTitle: true },
        orderBy: [{ firstNameArabic: 'asc' }, { lastNameArabic: 'asc' }],
      });
      return NextResponse.json(emps);
    }

    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const scope = await managedEmployeesWhere(prisma, user);
    const employeeWhere = scope ? { employee: scope } : {};

    if (action === 'get_leaves') {
      // Approved leaves still awaiting a return notice.
      const leaves = await prisma.leave.findMany({
        where: { status: LEAVE_STATUS.APPROVED, isReturned: false, actualReturnDate: null, ...employeeWhere },
        select: {
          id: true,
          employeeId: true,
          leaveType: true,
          startDate: true,
          endDate: true,
          totalDays: true,
          status: true,
          isOutsideKSA: true,
          employee: nameSelect,
        },
        orderBy: { endDate: 'asc' },
      });
      return NextResponse.json(leaves);
    }

    if (action === 'get_history') {
      const requesterWhere = scope ? { requester: scope } : {};
      const [overtimes, deducts, tasks, jobReqs, onboardingReqs, returnNotices, assetReqs] = await Promise.all([
        prisma.overtimeRequest.findMany({
          where: employeeWhere,
          select: { id: true, type: true, hours: true, amount: true, status: true, createdAt: true, employee: nameSelect },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
        prisma.deduction.findMany({
          where: employeeWhere,
          select: { id: true, amount: true, reason: true, status: true, createdAt: true, employee: nameSelect },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
        prisma.workAssignment.findMany({
          where: employeeWhere,
          select: { id: true, destination: true, status: true, createdAt: true, employee: nameSelect },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
        prisma.jobRequest.findMany({
          where: requesterWhere,
          select: { id: true, jobTitle: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
        prisma.onboardingRequest.findMany({
          where: requesterWhere,
          select: { id: true, fullNameArabic: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
        prisma.leave.findMany({
          where: { actualReturnDate: { not: null }, ...employeeWhere },
          select: { id: true, actualReturnDate: true, isReturned: true, createdAt: true, employee: nameSelect },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
        prisma.assetRequest.findMany({
          where: scope ? { requestedFor: scope } : {},
          select: { id: true, assetType: true, description: true, status: true, createdAt: true, requestedFor: nameSelect },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_TAKE,
        }),
      ]);

      const history = [
        ...overtimes.map((r) => ({
          id: `overtime-${r.id}`,
          type: 'عمل إضافي',
          employee: fullName(r.employee),
          details: r.type === 'LUMP_SUM' ? `تكليف بمبلغ مقطوع ${roundMoney(r.amount ?? 0)} ر.س` : `تكليف ${r.hours ?? 0} ساعة للموظف`,
          status: r.status,
          date: r.createdAt,
        })),
        ...deducts.map((r) => ({
          id: `deduct-${r.id}`,
          type: 'مخالفة',
          employee: fullName(r.employee),
          details: `توقيع خصم بقيمة ${roundMoney(r.amount)} - السبب: ${r.reason}`,
          status: DEDUCTION_PAYABLE_STATUSES.includes(r.status)
            ? 'APPROVED'
            : (DEDUCTION_REJECTED as readonly string[]).includes(r.status)
              ? 'REJECTED'
              : 'PENDING',
          date: r.createdAt,
        })),
        ...tasks.map((r) => ({
          id: `task-${r.id}`,
          type: 'مهمة خارجية',
          employee: fullName(r.employee),
          details: `انتداب إلى ${r.destination}`,
          status: r.status,
          date: r.createdAt,
        })),
        ...jobReqs.map((r) => ({
          id: `job-${r.id}`,
          type: 'طلب توظيف',
          employee: '-',
          details: `طلب توظيف: ${r.jobTitle}`,
          status: r.status,
          date: r.createdAt,
        })),
        ...onboardingReqs.map((r) => ({
          id: `onboard-${r.id}`,
          type: 'مباشرة عمل جديدة',
          employee: r.fullNameArabic,
          details: 'طلب توظيف جديد / إشعار مباشرة',
          status: r.status,
          date: r.createdAt,
        })),
        ...returnNotices.map((r) => ({
          id: `leave-${r.id}`,
          type: 'إثبات مباشرة',
          employee: fullName(r.employee),
          details: `إثبات عودة الموظف للعمل بتاريخ ${formatDateShort(r.actualReturnDate)}`,
          status: r.isReturned ? 'APPROVED' : 'PENDING',
          date: r.createdAt,
        })),
        ...assetReqs.map((r) => ({
          id: `asset-${r.id}`,
          type: 'طلب عهدة',
          employee: fullName(r.requestedFor),
          details: `طلب توفير ${ASSET_LABELS[r.assetType] ?? 'عهدة أخرى'} - ${r.description || ''}`,
          status: r.status === 'COMPLETED' ? 'APPROVED' : r.status === 'REJECTED' ? 'REJECTED' : 'PENDING',
          date: r.createdAt,
        })),
      ];

      history.sort((a, b) => b.date.getTime() - a.date.getTime());
      return NextResponse.json(history.slice(0, 50));
    }

    throw badRequest('إجراء غير معروف');
  } catch (err) {
    return handleApiError(err, 'manager-portal:GET');
  }
}

// ---------------------------------------------------------------------------
// POST { actionType, ...payload }
// ---------------------------------------------------------------------------

const optEmail = z
  .preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(200).nullable())
  .optional();

const optEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), z.enum(values).nullable()).optional();

const overtimeSchema = z.object({
  actionType: z.literal('ASSIGN_OVERTIME'),
  employeeId: zId,
  date: zDate,
  type: z.preprocess((v) => (v === '' || v == null ? 'HOURS' : v), z.enum(['HOURS', 'LUMP_SUM'])),
  hours: z.preprocess((v) => (v === '' || v == null ? undefined : v), zNumber.optional()),
  amount: zOptMoney,
  reason: zOptText(1000),
});

const workTaskSchema = z.object({
  actionType: z.literal('ASSIGN_WORK_TASK'),
  employeeId: zId,
  destination: zText(300),
  details: zText(2000),
  startDate: zDate,
  endDate: zDate,
});

const penaltySchema = z.object({
  actionType: z.literal('ASSIGN_PENALTY'),
  employeeId: zId,
  amount: zMoney,
  reason: zText(1000),
});

const hiringSchema = z.object({
  actionType: z.literal('REQUEST_HIRING'),
  requesterId: zOptText(100),
  jobTitle: zText(200),
  jobType: zText(50),
  nationality: zText(100),
  description: zText(5000),
});

const returnSchema = z.object({
  actionType: z.literal('RETURN_FROM_LEAVE'),
  leaveId: zId,
  actualReturnDate: zDate,
});

const onboardingSchema = z.object({
  actionType: z.literal('SUBMIT_ONBOARDING'),
  requesterId: zOptText(100),
  fullNameArabic: zText(200),
  lastNameArabic: zOptText(100),
  firstNameEnglish: zOptText(100),
  lastNameEnglish: zOptText(100),
  nationality: zOptText(50),
  dateOfBirth: zOptDate,
  gender: zOptText(20),
  maritalStatus: zOptText(30),
  iqamaOrIdNumber: zText(50),
  iqamaOrIdExp: zOptDate,
  passportNumber: zOptText(50),
  passportExp: zOptDate,
  mobileNumber: zText(30),
  email: optEmail,
  branchId: zOptText(100),
  administrationId: zOptText(100),
  departmentId: zOptText(100),
  directManagerId: zOptText(100),
  jobTitle: zOptText(200),
  joinDate: zOptDate,
  contractType: optEnum(CONTRACT_TYPES),
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

const assetSchema = z.object({
  actionType: z.literal('REQUEST_ASSET'),
  /** Legacy: ignored, the requester is taken from the session. */
  requesterId: zOptText(100),
  employeeId: zId,
  assetType: z.preprocess((v) => (v === '' || v == null ? 'OTHER' : v), z.enum(ASSET_TYPES)),
  description: zOptText(2000),
});

const actionSchema = z.discriminatedUnion('actionType', [
  overtimeSchema,
  workTaskSchema,
  penaltySchema,
  hiringSchema,
  returnSchema,
  onboardingSchema,
  assetSchema,
]);

export async function POST(req: Request) {
  try {
    // Any signed-in user: plain employees may only raise an asset request for themselves
    // (checked below); every other action is for managers.
    const user = await requireUser(ROLE_GROUPS.ALL);
    const raw = await parseBody(req, z.object({ actionType: z.string().max(50) }).passthrough());
    if (!actionSchema.options.some((o) => o.shape.actionType.value === raw.actionType)) throw badRequest('إجراء غير معروف');
    const data = actionSchema.parse(raw);
    // Only the asset request is open to logistics staff / employees; everything else is for managers.
    if (data.actionType !== 'REQUEST_ASSET' && !hasRole(user, ROLE_GROUPS.MANAGERS)) throw forbidden();
    const ip = getClientIp(req);
    const supervisorId = user.employeeId ?? user.id;

    switch (data.actionType) {
      case 'ASSIGN_OVERTIME': {
        await loadManagedEmployee(user, data.employeeId);
        const isHours = data.type === 'HOURS';
        const hours = isHours ? data.hours ?? 0 : 0;
        const amount = isHours ? 0 : roundMoney(data.amount ?? 0);
        if (isHours && !(hours > 0 && hours <= 24)) throw badRequest('عدد الساعات يجب أن يكون بين 0 و 24 ساعة');
        if (!isHours && !(amount > 0)) throw badRequest('يرجى إدخال المبلغ المقطوع');
        const created = await prisma.overtimeRequest.create({
          data: {
            employeeId: data.employeeId,
            supervisorId,
            date: data.date,
            type: data.type,
            hours,
            amount,
            reason: data.reason ?? null,
            status: 'PENDING',
          },
        });
        await logAudit({ userId: user.id, action: 'CREATE', entityType: 'OVERTIME', entityId: created.id, details: { employeeId: data.employeeId, type: data.type, hours, amount }, ipAddress: ip });
        return NextResponse.json({ message: 'تم رفع طلب العمل الإضافي للموارد البشرية للموافقة', data: created });
      }

      case 'ASSIGN_WORK_TASK': {
        await loadManagedEmployee(user, data.employeeId);
        if (daysBetween(data.startDate, data.endDate) < 0) throw badRequest('تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو مساوياً له');
        const created = await prisma.workAssignment.create({
          data: {
            employeeId: data.employeeId,
            supervisorId,
            destination: data.destination,
            details: data.details,
            startDate: data.startDate,
            endDate: data.endDate,
            status: 'PENDING_EMPLOYEE',
          },
        });
        await logAudit({ userId: user.id, action: 'CREATE', entityType: 'WORK_ASSIGNMENT', entityId: created.id, details: { employeeId: data.employeeId, destination: data.destination }, ipAddress: ip });
        return NextResponse.json({ message: 'تم إرسال تكليف المهمة الخارجية للموظف والموارد البشرية بنجاح!', data: created });
      }

      case 'ASSIGN_PENALTY': {
        await loadManagedEmployee(user, data.employeeId);
        const amount = roundMoney(data.amount);
        if (!(amount > 0)) throw badRequest('مبلغ الخصم يجب أن يكون أكبر من صفر');
        const created = await prisma.deduction.create({
          data: {
            employeeId: data.employeeId,
            date: today(),
            amount,
            reason: data.reason,
            status: DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL,
            hasFinancialImpact: true,
            issuedBy: user.name,
          },
        });
        await logAudit({ userId: user.id, action: 'CREATE', entityType: 'DEDUCTION', entityId: created.id, details: { employeeId: data.employeeId, amount, status: created.status }, ipAddress: ip });
        return NextResponse.json({ message: 'تم إرسال المخالفة للموارد البشرية لاعتمادها', data: created });
      }

      case 'REQUEST_HIRING': {
        const requesterId = await resolveRequesterId(user, data.requesterId);
        const requester = await prisma.employee.findUnique({ where: { id: requesterId }, select: { departmentId: true } });
        const created = await prisma.jobRequest.create({
          data: {
            requesterId,
            departmentId: requester?.departmentId ?? null,
            jobTitle: data.jobTitle,
            jobType: data.jobType,
            nationality: data.nationality,
            description: data.description,
            status: 'PENDING',
          },
        });
        await logAudit({ userId: user.id, action: 'CREATE', entityType: 'JobRequest', entityId: created.id, details: { jobTitle: data.jobTitle, requesterId }, ipAddress: ip });
        return NextResponse.json({ message: 'تم رفع احتياج التوظيف للموارد البشرية', data: created });
      }

      case 'RETURN_FROM_LEAVE': {
        const updated = await prisma.$transaction(async (tx) => {
          // Lock the leave row so a double submit cannot record (and audit) the return twice, then
          // refuse a second notice while the first one awaits HR confirmation.
          await tx.$queryRaw`SELECT "id" FROM "Leave" WHERE "id" = ${data.leaveId} FOR UPDATE`;
          const current = await tx.leave.findUnique({ where: { id: data.leaveId }, select: { actualReturnDate: true } });
          if (current?.actualReturnDate) throw conflict('تم رفع إشعار المباشرة لهذه الإجازة مسبقاً وهو بانتظار تأكيد الموارد البشرية');
          return recordLeaveReturn(tx, data.leaveId, data.actualReturnDate, user, { ipAddress: ip });
        });
        return NextResponse.json({ message: 'تم رفع إشعار المباشرة للموارد البشرية بانتظار التأكيد', data: updated });
      }

      case 'SUBMIT_ONBOARDING': {
        const requesterId = await resolveRequesterId(user, data.requesterId);
        const iqama = data.iqamaOrIdNumber.trim();
        const [existingEmployee, openRequest] = await Promise.all([
          prisma.employee.findUnique({ where: { iqamaOrIdNumber: iqama }, select: { id: true } }),
          prisma.onboardingRequest.findFirst({ where: { iqamaOrIdNumber: iqama, status: 'PENDING' }, select: { id: true } }),
        ]);
        if (existingEmployee) throw conflict('رقم الهوية / الإقامة مسجل مسبقاً لموظف في النظام');
        if (openRequest) throw conflict('يوجد طلب مباشرة قائم بنفس رقم الهوية / الإقامة');

        const onboarding: Prisma.OnboardingRequestUncheckedCreateInput = {
          requesterId,
          fullNameArabic: data.fullNameArabic,
          lastNameArabic: data.lastNameArabic ?? null,
          firstNameEnglish: data.firstNameEnglish ?? null,
          lastNameEnglish: data.lastNameEnglish ?? null,
          nationality: normalizeNationality(data.nationality),
          dateOfBirth: data.dateOfBirth ?? null,
          gender: data.gender ?? null,
          maritalStatus: data.maritalStatus ?? null,
          iqamaOrIdNumber: iqama,
          iqamaOrIdExp: data.iqamaOrIdExp ?? null,
          passportNumber: data.passportNumber ?? null,
          passportExp: data.passportExp ?? null,
          mobileNumber: data.mobileNumber,
          email: data.email ?? null,
          branchId: data.branchId ?? null,
          administrationId: data.administrationId ?? null,
          departmentId: data.departmentId ?? null,
          directManagerId: data.directManagerId ?? null,
          jobTitle: data.jobTitle ?? null,
          joinDate: data.joinDate ?? null,
          contractType: data.contractType ?? null,
          bankName: data.bankName ?? null,
          ibanNumber: data.ibanNumber ?? null,
          basicSalary: roundMoney(data.basicSalary ?? 0),
          iqamaCopyUrl: data.iqamaCopyUrl ?? null,
          passportCopyUrl: data.passportCopyUrl ?? null,
          ibanCertificateUrl: data.ibanCertificateUrl ?? null,
          resumeUrl: data.resumeUrl ?? null,
          workContractUrl: data.workContractUrl ?? null,
          healthCertificateUrl: data.healthCertificateUrl ?? null,
          status: 'PENDING',
        };
        const created = await prisma.onboardingRequest.create({ data: onboarding });
        await logAudit({ userId: user.id, action: 'CREATE', entityType: 'OnboardingRequest', entityId: created.id, details: { fullNameArabic: data.fullNameArabic, requesterId }, ipAddress: ip });
        return NextResponse.json({ message: 'تم رفع طلب مباشرة العمل الجديدة بنجاح، وهو الآن في الطلبات الواردة للموارد البشرية', data: created });
      }

      case 'REQUEST_ASSET': {
        const isSelf = !!user.employeeId && user.employeeId === data.employeeId;
        // Self-service (employee portal): an employee may only request an asset for themselves.
        if (!hasRole(user, ASSET_REQUEST_ROLES) && !isSelf) throw forbidden('يمكنك طلب عهدة لنفسك فقط');
        if (hasRole(user, ROLE_GROUPS.MANAGERS) && !isSelf) {
          await loadManagedEmployee(user, data.employeeId);
        } else {
          const target = await prisma.employee.findUnique({ where: { id: data.employeeId }, select: { id: true, isTerminated: true } });
          if (!target) throw notFound('الموظف غير موجود');
          if (target.isTerminated) throw badRequest('لا يمكن رفع طلب لموظف منتهية خدماته');
        }
        // The requester always comes from the session: the signed-in user's own employee file.
        // Accounts without one (e.g. the system admin) raise it on the target employee's behalf;
        // a requesterId sent by the client is ignored (the audit log records the real user).
        const requesterId = user.employeeId ?? data.employeeId;
        const created = await prisma.assetRequest.create({
          data: {
            requesterId,
            requestedForId: data.employeeId,
            assetType: data.assetType,
            description: data.description ?? null,
            status: 'PENDING_HR',
          },
        });
        await logAudit({ userId: user.id, action: 'CREATE', entityType: 'AssetRequest', entityId: created.id, details: { employeeId: data.employeeId, requesterId, assetType: data.assetType }, ipAddress: ip });
        return NextResponse.json({ message: 'تم رفع طلب احتياج العهدة للموارد البشرية', data: created });
      }
    }
    throw badRequest('إجراء غير معروف');
  } catch (err) {
    return handleApiError(err, 'manager-portal:POST');
  }
}

import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import {
  ASSET_ACTIONS,
  TRANSFER_STATUS,
  approveTransfer,
  assertCanManageEmployee,
  managedEmployeesWhere,
  rejectTransfer,
} from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

/**
 * HR sees every transfer and every active employee. Branch / department managers (who may file
 * transfers for their team) see only the transfers of the employees they manage or that they
 * requested themselves, and only their team in the form (never themselves: nobody transfers
 * their own file). Approve / reject stays HR-only (POST).
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const isHr = roleIn(user.role, ROLE_GROUPS.HR);
    // null for HR (everyone); a team filter for the other managers.
    const team = await managedEmployeesWhere(prisma, user);
    const transferWhere: Prisma.TransferRequestWhereInput = team
      ? { OR: [{ employee: team }, ...(user.employeeId ? [{ requesterId: user.employeeId }] : [])] }
      : {};
    const employeeWhere: Prisma.EmployeeWhereInput = team
      ? { AND: [{ isTerminated: false }, team, { id: { not: user.employeeId ?? '__none__' } }] }
      : { isTerminated: false };

    const [transfers, employees, branches, me] = await Promise.all([
      prisma.transferRequest.findMany({
        where: transferWhere,
        include: {
          employee: {
            select: {
              id: true,
              employeeId: true,
              firstNameArabic: true,
              lastNameArabic: true,
              nationality: true,
              jobTitle: true,
              branch: { select: { id: true, nameArabic: true } },
              assets: { where: { returnDate: null } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      // Form metadata
      prisma.employee.findMany({
        where: employeeWhere,
        select: {
          id: true,
          employeeId: true,
          firstNameArabic: true,
          lastNameArabic: true,
          jobTitle: true,
          branchId: true,
          branch: { select: { id: true, nameArabic: true } },
          assets: { where: { returnDate: null }, select: { id: true, assetType: true, description: true } },
        },
        orderBy: { firstNameArabic: 'asc' },
      }),
      prisma.branch.findMany({
        select: {
          id: true,
          nameArabic: true,
          workSchedules: { select: { id: true, name: true, shiftType: true, startTime: true, endTime: true } },
        },
        orderBy: { nameArabic: 'asc' },
      }),
      !isHr && user.employeeId
        ? prisma.employee.findUnique({
            where: { id: user.employeeId },
            select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, jobTitle: true },
          })
        : Promise.resolve(null),
    ]);

    // Requester options: HR may file on behalf of anyone; a manager files as themselves.
    const managers = isHr
      ? employees.map((e) => ({
          id: e.id,
          employeeId: e.employeeId,
          firstNameArabic: e.firstNameArabic,
          lastNameArabic: e.lastNameArabic,
          jobTitle: e.jobTitle,
        }))
      : me
        ? [me]
        : [];

    return NextResponse.json({ transfers, metadata: { employees, branches, managers }, canDecide: isHr });
  } catch (err) {
    return handleApiError(err, 'transfers:GET');
  }
}

const updateStatusSchema = z.object({
  actionType: z.literal('UPDATE_STATUS'),
  payload: z.object({
    id: zId,
    status: z.enum([TRANSFER_STATUS.APPROVED, TRANSFER_STATUS.REJECTED]),
    hrNote: zOptText(1000),
  }),
});

const createSchema = z.object({
  actionType: z.undefined().optional(),
  employeeId: zId,
  requesterId: z.preprocess((v) => (v === '' || v === null ? undefined : v), zId.optional()),
  toBranchId: zId,
  toWorkSchedule: zOptText(200),
  reason: zOptText(2000),
  assetAction: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(ASSET_ACTIONS).default('RETAIN')),
});

const bodySchema = z.union([updateStatusSchema, createSchema]);

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const body = await parseBody(req, bodySchema);
    const ipAddress = getClientIp(req);

    // Approve / reject (HR only, guarded + atomic in src/lib/hr-workflows).
    if ('payload' in body) {
      if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
      const { id, status, hrNote } = body.payload;
      if (status === TRANSFER_STATUS.APPROVED) {
        await prisma.$transaction((tx) => approveTransfer(tx, id, user, { hrNote, ipAddress }));
        return NextResponse.json({ message: 'تمت الموافقة على النقل وتحديث بيانات الموظف بنجاح' });
      }
      await prisma.$transaction((tx) => rejectTransfer(tx, id, user, hrNote, { ipAddress }));
      return NextResponse.json({ message: 'تم رفض طلب النقل' });
    }

    // Create a new transfer request. Only HR may file on behalf of another requester.
    if (!roleIn(user.role, ROLE_GROUPS.HR) && body.requesterId && body.requesterId !== user.employeeId) {
      throw forbidden('لا يمكنك رفع طلب النقل باسم مسؤول آخر');
    }
    const [employee, toBranch, requester, pending] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: body.employeeId },
        select: { id: true, branchId: true, directManagerId: true, departmentId: true, isTerminated: true },
      }),
      prisma.branch.findUnique({
        where: { id: body.toBranchId },
        select: { id: true, workSchedules: { select: { name: true } } },
      }),
      body.requesterId ? prisma.employee.findUnique({ where: { id: body.requesterId }, select: { id: true } }) : Promise.resolve(null),
      prisma.transferRequest.findFirst({ where: { employeeId: body.employeeId, status: TRANSFER_STATUS.PENDING }, select: { id: true } }),
    ]);
    if (!employee) throw notFound('الموظف غير موجود');
    if (employee.isTerminated) throw conflict('لا يمكن نقل موظف منتهية خدماته');
    if (!toBranch) throw badRequest('الفرع المنقول إليه غير موجود');
    if (employee.branchId === body.toBranchId) throw badRequest('الموظف يعمل بالفعل في الفرع المختار');
    if (body.requesterId && !requester) throw badRequest('رافع الطلب غير موجود');
    if (body.toWorkSchedule && !toBranch.workSchedules.some((s) => s.name === body.toWorkSchedule)) {
      throw badRequest('جدول العمل المختار لا يتبع الفرع المنقول إليه');
    }
    if (pending) throw conflict('يوجد طلب نقل قائم لهذا الموظف بانتظار الموارد البشرية');
    if (!roleIn(user.role, ROLE_GROUPS.HR)) await assertCanManageEmployee(prisma, user, employee);

    const transfer = await prisma.transferRequest.create({
      data: {
        employeeId: body.employeeId,
        requesterId: body.requesterId ?? user.employeeId ?? null,
        fromBranchId: employee.branchId ?? null,
        toBranchId: body.toBranchId,
        toWorkSchedule: body.toWorkSchedule ?? null,
        reason: body.reason ?? null,
        assetAction: body.assetAction,
        status: TRANSFER_STATUS.PENDING,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'TransferRequest',
      entityId: transfer.id,
      details: { employeeId: transfer.employeeId, fromBranchId: transfer.fromBranchId, toBranchId: transfer.toBranchId },
      ipAddress,
    });

    return NextResponse.json(
      { message: 'تم رفع طلب النقل الداخلي بنجاح وسيصل للموارد البشرية للمراجعة', transfer },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err, 'transfers:POST');
  }
}

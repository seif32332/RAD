import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, definedOnly, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { roundMoney } from '@/lib/money';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { findPlateDuplicate, normalizePlate, vehicleArchiveSchema, vehicleUpdateSchema } from '../_lib';
import { authz, companiesAllowed, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

// P1-SCOPE: a vehicle is scoped by its legal (owning) company (Vehicle.legalCompanyId). Every handler
// reads it through the scoped client first: a vehicle of a company outside the user's scope is "not
// found" (404). A new owning / user company or driver must be inside the scope too.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.read');
    const { id } = await params;
    const vehicle = await scopedPrisma(ctx).vehicle.findUnique({ where: { id } });
    if (!vehicle) throw notFound('المركبة غير موجودة');
    return NextResponse.json({ message: 'تم جلب بيانات السيارة بنجاح', data: vehicle });
  } catch (err) {
    return handleApiError(err, 'vehicles/[id]:GET');
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.manage');
    const db = scopedPrisma(ctx);
    const body = await parseBody(req, vehicleUpdateSchema);
    if (!(await db.vehicle.findUnique({ where: { id }, select: { id: true } }))) throw notFound('المركبة غير موجودة');
    // Moving the vehicle to a company outside the scope (or to no owner, for a scoped user) is refused.
    if (body.legalCompanyId !== undefined && !companiesAllowed(ctx.companies, [body.legalCompanyId])) throw forbidden('هذه الشركة خارج نطاق صلاحياتك');
    if (body.actualCompanyId && !companiesAllowed(ctx.companies, [body.actualCompanyId])) throw forbidden('هذه الشركة خارج نطاق صلاحياتك');
    if (body.driverId && !(await db.employee.findUnique({ where: { id: body.driverId }, select: { id: true } }))) throw notFound('الموظف المحدد غير موجود');

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.vehicle.findUnique({
        where: { id },
        select: { id: true, plateNumber: true, driverId: true },
      });
      if (!existing) throw notFound('المركبة غير موجودة');

      // Only a NEW driver must be in service: editing other fields of a vehicle whose current driver
      // has left is still allowed (the driver is then changed or cleared separately).
      const driverChanged = body.driverId !== undefined && body.driverId !== null && body.driverId !== existing.driverId;
      // Duplicate check only when the plate really changes (compared on the normalised key).
      const plateChanged = !!body.plateNumber && normalizePlate(body.plateNumber) !== normalizePlate(existing.plateNumber);

      const [, activePlates] = await Promise.all([
        ensureRefsExist(
          tx,
          { companyIds: [body.legalCompanyId, body.actualCompanyId], employeeIds: driverChanged ? [body.driverId] : [] },
          { activeOnly: true },
        ),
        plateChanged
          ? tx.vehicle.findMany({ where: { isArchived: false }, select: { id: true, plateNumber: true, vehicleCode: true, legalCompanyId: true } })
          : Promise.resolve([]),
      ]);
      const duplicate = plateChanged && body.plateNumber ? findPlateDuplicate(body.plateNumber, activePlates, id) : undefined;
      if (duplicate) {
        // The plate is unique in the tenant; another company's vehicle is not described (INV-SCOPE-01).
        if (!companiesAllowed(ctx.companies, [duplicate.legalCompanyId])) throw conflict('توجد مركبة أخرى مسجلة بنفس رقم اللوحة');
        throw conflict(`توجد مركبة أخرى مسجلة بنفس رقم اللوحة (${duplicate.vehicleCode ?? '-'}: ${duplicate.plateNumber})`);
      }

      const data = definedOnly({
        ...body,
        insuranceCost: body.insuranceCost !== undefined ? roundMoney(body.insuranceCost) : undefined,
      });

      const vehicle = await tx.vehicle.update({ where: { id }, data });
      await logAudit(
        {
          userId: user.id,
          action: 'UPDATE',
          entityType: 'Vehicle',
          entityId: id,
          details: { fields: Object.keys(data) },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return vehicle;
    });

    return NextResponse.json({ message: 'تم التحديث', data: updated });
  } catch (err) {
    return handleApiError(err, 'vehicles/[id]:PUT');
  }
}

/** Archive / unarchive: body { isArchived: boolean }. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.manage');
    const db = scopedPrisma(ctx);
    const { isArchived } = await parseBody(req, vehicleArchiveSchema);

    if (!(await db.vehicle.findUnique({ where: { id }, select: { id: true } }))) throw notFound('المركبة غير موجودة');
    const updated = await db.vehicle.update({ where: { id }, data: { isArchived } });
    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Vehicle',
      entityId: id,
      details: { isArchived },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({
      message: isArchived ? 'تمت الأرشفة بنجاح' : 'تم إلغاء الأرشفة بنجاح',
      data: updated,
    });
  } catch (err) {
    return handleApiError(err, 'vehicles/[id]:PATCH');
  }
}

/**
 * Deletes a vehicle. A vehicle that has accident claims is never hard-deleted (that would
 * destroy financial records): it is archived instead and the response says so (`archived: true`).
 */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.manage');
    const db = scopedPrisma(ctx);
    if (!(await db.vehicle.findUnique({ where: { id }, select: { id: true } }))) throw notFound('المركبة غير موجودة');

    const result = await prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findUnique({
        where: { id },
        select: { id: true, vehicleCode: true, plateNumber: true, brand: true, _count: { select: { claims: true } } },
      });
      if (!vehicle) throw notFound('المركبة غير موجودة');

      const snapshot = { vehicleCode: vehicle.vehicleCode, plateNumber: vehicle.plateNumber, brand: vehicle.brand };

      if (vehicle._count.claims > 0) {
        await tx.vehicle.update({ where: { id }, data: { isArchived: true } });
        await logAudit(
          {
            userId: user.id,
            action: 'UPDATE',
            entityType: 'Vehicle',
            entityId: id,
            details: { ...snapshot, isArchived: true, reason: 'delete requested; vehicle has accident claims' },
            ipAddress: getClientIp(req),
          },
          tx,
        );
        return { archived: true };
      }

      await tx.vehicle.delete({ where: { id } });
      await logAudit(
        { userId: user.id, action: 'DELETE', entityType: 'Vehicle', entityId: id, details: snapshot, ipAddress: getClientIp(req) },
        tx,
      );
      return { archived: false };
    });

    if (result.archived) {
      return NextResponse.json({
        message: 'المركبة مرتبطة بمطالبات حوادث، لذلك تمت أرشفتها بدلاً من حذفها',
        archived: true,
      });
    }
    return NextResponse.json({ message: 'تم الحذف بنجاح', archived: false });
  } catch (err) {
    return handleApiError(err, 'vehicles/[id]:DELETE');
  }
}

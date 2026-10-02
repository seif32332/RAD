import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { roundMoney } from '@/lib/money';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { findPlateDuplicate, nextVehicleCode, vehicleCreateSchema } from './_lib';
import { recordCompanyId } from '@/lib/record-company';
import { authz, companiesAllowed, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/** Vehicles owned (legal company) by the user's companies (P1-SCOPE: Vehicle.legalCompanyId, scoped client). */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.read');
    const vehicles = await scopedPrisma(ctx).vehicle.findMany({
      include: {
        legalCompany: { select: { nameArabic: true } },
        actualCompany: { select: { nameArabic: true } },
        driver: {
          select: {
            firstNameArabic: true,
            lastNameArabic: true,
            employeeId: true,
            branchId: true,
            legalCompanyId: true,
            legalCompany: { select: { nameArabic: true } },
            branch: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(vehicles);
  } catch (err) {
    return handleApiError(err, 'vehicles:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.manage');
    const body = await parseBody(req, vehicleCreateSchema);
    // P1-SCOPE: the owning company (scope key) defaults to the user's only company; the user company
    // and the driver must be inside the user's companies too (403 / 404).
    const legalCompanyId = await recordCompanyId(prisma, ctx, body.legalCompanyId);
    if (body.actualCompanyId && !companiesAllowed(ctx.companies, [body.actualCompanyId])) throw forbidden('هذه الشركة خارج نطاق صلاحياتك');
    if (body.driverId && !(await scopedPrisma(ctx).employee.findUnique({ where: { id: body.driverId }, select: { id: true } }))) {
      throw notFound('الموظف المحدد غير موجود');
    }

    const vehicle = await prisma.$transaction(async (tx) => {
      const [, activePlates, lastCoded, total] = await Promise.all([
        // The driver must still be in service (409 otherwise).
        ensureRefsExist(
          tx,
          { companyIds: [legalCompanyId, body.actualCompanyId], employeeIds: [body.driverId] },
          { activeOnly: true },
        ),
        // Duplicate check on the normalised plate (spaces, alef forms, Latin/Arabic letters, digits).
        tx.vehicle.findMany({ where: { isArchived: false }, select: { id: true, plateNumber: true, vehicleCode: true, legalCompanyId: true } }),
        tx.vehicle.findFirst({
          where: { vehicleCode: { startsWith: 'VH-' } },
          orderBy: { vehicleCode: 'desc' },
          select: { vehicleCode: true },
        }),
        tx.vehicle.count(),
      ]);
      const duplicate = findPlateDuplicate(body.plateNumber, activePlates);
      if (duplicate) {
        // The plate is unique in the tenant; another company's vehicle is not described (INV-SCOPE-01).
        if (!companiesAllowed(ctx.companies, [duplicate.legalCompanyId])) throw conflict('توجد مركبة مسجلة بنفس رقم اللوحة');
        throw conflict(`توجد مركبة مسجلة بنفس رقم اللوحة (${duplicate.vehicleCode ?? '-'}: ${duplicate.plateNumber})`);
      }

      const created = await tx.vehicle.create({
        data: {
          vehicleCode: nextVehicleCode([lastCoded?.vehicleCode ?? null], total),
          category: body.category ?? '',
          brand: body.brand,
          modelYear: body.modelYear ?? '',
          color: body.color ?? '',
          sequenceNumber: body.sequenceNumber ?? '',
          plateNumber: body.plateNumber,
          legalCompanyId,
          actualCompanyId: body.actualCompanyId ?? null,
          licenseExpDate: body.licenseExpDate ?? null,
          insuranceExpDate: body.insuranceExpDate ?? null,
          ...(body.insuranceCost !== undefined ? { insuranceCost: roundMoney(body.insuranceCost) } : {}),
          inspectionExpDate: body.inspectionExpDate ?? null,
          operatingCardExpDate: body.operatingCardExpDate ?? null,
          operatingCardUrl: body.operatingCardUrl ?? null,
          driverId: body.driverId ?? null,
          driverCardNumber: body.driverCardNumber ?? null,
          driverCardExpDate: body.driverCardExpDate ?? null,
          drivingAuthorizationUrl: body.drivingAuthorizationUrl ?? null,
          drivingAuthExpDate: body.drivingAuthExpDate ?? null,
          vehiclePhotosUrl: body.vehiclePhotosUrl ?? null,
          registrationFormUrl: body.registrationFormUrl ?? null,
          otherAttachmentsUrl: body.otherAttachmentsUrl ?? null,
        },
      });

      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'Vehicle',
          entityId: created.id,
          details: { vehicleCode: created.vehicleCode, plateNumber: created.plateNumber, brand: created.brand },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    return NextResponse.json({ message: 'تم إضافة المركبة بنجاح', vehicle }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'vehicles:POST');
  }
}

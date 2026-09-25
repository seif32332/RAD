import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { roundMoney } from '@/lib/money';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { findPlateDuplicate, nextVehicleCode, vehicleCreateSchema } from './_lib';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const vehicles = await prisma.vehicle.findMany({
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
    const body = await parseBody(req, vehicleCreateSchema);

    const vehicle = await prisma.$transaction(async (tx) => {
      const [, activePlates, lastCoded, total] = await Promise.all([
        // The driver must still be in service (409 otherwise).
        ensureRefsExist(
          tx,
          { companyIds: [body.legalCompanyId, body.actualCompanyId], employeeIds: [body.driverId] },
          { activeOnly: true },
        ),
        // Duplicate check on the normalised plate (spaces, alef forms, Latin/Arabic letters, digits).
        tx.vehicle.findMany({ where: { isArchived: false }, select: { id: true, plateNumber: true, vehicleCode: true } }),
        tx.vehicle.findFirst({
          where: { vehicleCode: { startsWith: 'VH-' } },
          orderBy: { vehicleCode: 'desc' },
          select: { vehicleCode: true },
        }),
        tx.vehicle.count(),
      ]);
      const duplicate = findPlateDuplicate(body.plateNumber, activePlates);
      if (duplicate) {
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
          legalCompanyId: body.legalCompanyId ?? null,
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

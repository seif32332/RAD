import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { today } from '@/lib/dates';
import { ensureRefsExist } from '@/app/api/services/_lib';
import type { Prisma } from '@prisma/client';
import { ASSET_STATUS, SIM_DAMAGE_MESSAGE, assetActionGuard, assetActionSchema } from '../_lib';

type Ctx = { params: Promise<{ id: string }> };

const STATE_CHANGED = 'تغيرت حالة العهدة، يرجى تحديث الصفحة والمحاولة مجدداً';

/** Holder snapshot written to the audit log of a damage / loss (who had it when it was lost). */
async function holderSnapshot(db: Prisma.TransactionClient, employeeId: string | null) {
  if (!employeeId) return null;
  const e = await db.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, isTerminated: true },
  });
  if (!e) return { id: employeeId };
  return {
    id: e.id,
    code: e.employeeId,
    name: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim(),
    isTerminated: e.isTerminated,
  };
}

/**
 * Custody actions: body { action: 'edit'|'clear'|'assign'|'transfer'|'damage', employeeId?, assetType?, description?, reason? }.
 * 'damage' requires a reason (min 5 characters), audited with the holder at the time.
 * 'assign' / 'transfer' refuse (409) an employee whose service has ended.
 * The id may also be a TelecomSim (the GET list merges SIMs held by employees into custody items).
 */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const { id } = await params;
    const body = await parseBody(req, assetActionSchema);
    const { action } = body;
    const ip = getClientIp(req);
    /** Target employee for assign/transfer (the schema already requires it for those actions). */
    const targetEmployeeId = (): string => {
      if (!body.employeeId) throw badRequest('يجب تحديد الموظف');
      return body.employeeId;
    };

    const [asset, sim] = await Promise.all([
      prisma.asset.findUnique({ where: { id } }),
      prisma.telecomSim.findUnique({ where: { id }, select: { id: true, employeeId: true, simNumber: true } }),
    ]);

    // ------------------------------------------------------------ Telecom SIM
    if (!asset) {
      if (!sim) throw notFound('العهدة غير موجودة');

      if (action === 'clear' || action === 'damage') {
        const damaged = action === 'damage';
        await prisma.$transaction(async (tx) => {
          const holder = damaged ? await holderSnapshot(tx, sim.employeeId) : undefined;
          await tx.telecomSim.update({ where: { id }, data: { employeeId: null } });
          await logAudit(
            {
              userId: user.id,
              action: 'UPDATE',
              entityType: 'TelecomSim',
              entityId: id,
              details: {
                custodyAction: action,
                simNumber: sim.simNumber,
                employeeFrom: sim.employeeId,
                employeeTo: null,
                ...(damaged ? { holder, reason: body.reason } : {}),
              },
              ipAddress: ip,
            },
            tx,
          );
        });
        // The SIM model has no status column: a damaged / lost SIM is only detached from the employee,
        // the line itself stays active at the operator until it is cancelled there.
        return NextResponse.json({ message: damaged ? SIM_DAMAGE_MESSAGE : 'تم إخلاء الشريحة واستعادتها كمخزون' });
      }

      if (action === 'assign' || action === 'transfer') {
        const employeeId = targetEmployeeId();
        await prisma.$transaction(async (tx) => {
          await ensureRefsExist(tx, { employeeIds: [employeeId] }, { activeOnly: true });
          await tx.telecomSim.update({ where: { id }, data: { employeeId } });
          await logAudit(
            {
              userId: user.id,
              action: 'UPDATE',
              entityType: 'TelecomSim',
              entityId: id,
              details: { custodyAction: action, simNumber: sim.simNumber, employeeFrom: sim.employeeId, employeeTo: employeeId },
              ipAddress: ip,
            },
            tx,
          );
        });
        return NextResponse.json({ message: 'تم تسليم الشريحة للموظف بنجاح' });
      }

      throw badRequest('إجراء غير متاح لشرائح الاتصال');
    }

    // ------------------------------------------------------------ Regular asset
    const guard = { id, ...assetActionGuard(action) };
    const audit = (details: Record<string, unknown>) => ({
      userId: user.id,
      action: 'UPDATE' as const,
      entityType: 'Asset',
      entityId: id,
      details: { custodyAction: action, assetType: asset.assetType, previousStatus: asset.status, employeeFrom: asset.employeeId, ...details },
      ipAddress: ip,
    });

    switch (action) {
      case 'edit': {
        await prisma.$transaction(async (tx) => {
          await tx.asset.update({
            where: { id },
            data: {
              ...(body.assetType ? { assetType: body.assetType } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
            },
          });
          await logAudit(audit({ assetTypeTo: body.assetType, description: body.description }), tx);
        });
        return NextResponse.json({ message: 'تم تعديل بيانات العهدة بنجاح' });
      }

      case 'clear': {
        await prisma.$transaction(async (tx) => {
          const r = await tx.asset.updateMany({
            where: guard,
            data: { status: ASSET_STATUS.VACANT, returnDate: today(), employeeId: null },
          });
          if (r.count === 0) throw conflict(STATE_CHANGED);
          await logAudit(audit({ status: ASSET_STATUS.VACANT }), tx);
        });
        return NextResponse.json({ message: 'تم إخلاء العهدة وتحويلها إلى المستودع' });
      }

      case 'assign': {
        const employeeId = targetEmployeeId();
        await prisma.$transaction(async (tx) => {
          await ensureRefsExist(tx, { employeeIds: [employeeId] }, { activeOnly: true });
          const r = await tx.asset.updateMany({
            where: guard,
            data: { status: ASSET_STATUS.ACTIVE, employeeId, receiveDate: today(), returnDate: null },
          });
          if (r.count === 0) throw conflict(STATE_CHANGED);
          await logAudit(audit({ status: ASSET_STATUS.ACTIVE, employeeTo: employeeId }), tx);
        });
        return NextResponse.json({ message: 'تم إسناد العهدة بنجاح' });
      }

      case 'transfer': {
        const employeeId = targetEmployeeId();
        if (employeeId === asset.employeeId) throw badRequest('العهدة مسندة لهذا الموظف بالفعل');
        await prisma.$transaction(async (tx) => {
          await ensureRefsExist(tx, { employeeIds: [employeeId] }, { activeOnly: true });
          // 1. Close the current holder's record (kept as history).
          const r = await tx.asset.updateMany({
            where: guard,
            data: { status: ASSET_STATUS.TRANSFERRED, returnDate: today() },
          });
          if (r.count === 0) throw conflict(STATE_CHANGED);
          // 2. New custody record for the new holder.
          const created = await tx.asset.create({
            data: {
              employeeId,
              assetType: asset.assetType,
              description: asset.description,
              receiveDate: today(),
              status: ASSET_STATUS.ACTIVE,
            },
          });
          await logAudit(audit({ status: ASSET_STATUS.TRANSFERRED, employeeTo: employeeId, newAssetId: created.id }), tx);
        });
        return NextResponse.json({ message: 'تم تحويل العهدة بنجاح' });
      }

      case 'damage': {
        await prisma.$transaction(async (tx) => {
          const holder = await holderSnapshot(tx, asset.employeeId);
          const r = await tx.asset.updateMany({
            where: guard,
            data: { status: ASSET_STATUS.DAMAGED, returnDate: today(), employeeId: null },
          });
          if (r.count === 0) throw conflict(STATE_CHANGED);
          await logAudit(audit({ status: ASSET_STATUS.DAMAGED, holder, reason: body.reason }), tx);
        });
        return NextResponse.json({ message: 'تم إتلاف العهدة وأرشفتها' });
      }

      default:
        throw badRequest('إجراء غير معروف');
    }
  } catch (err) {
    return handleApiError(err, 'assets/[id]:PATCH');
  }
}

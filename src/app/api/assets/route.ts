import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { today } from '@/lib/dates';
import { ensureRefsExist } from '@/app/api/services/_lib';
import {
  ASSET_STATUS,
  assetCreateSchema,
  assetListQuerySchema,
  simAsCustodyItem,
  sortCustodyNewestFirst,
} from './_lib';

export const dynamic = 'force-dynamic';

/** Holder projection shown on custody cards (no salary / identity data). */
const holderSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  isTerminated: true,
  branch: { select: { nameArabic: true } },
} as const;

/**
 * Lists assets (custody items). Query: ?employeeId=<Employee.id>&active=true&heldByTerminated=1
 * Back-office users may list anyone's assets; a plain employee only ever sees their own.
 * When filtering by employee (or active only, or held by terminated employees), telecom SIMs held
 * by employees are included as custody items (isTelecomSim: true).
 * heldByTerminated=1 (back-office only): items still in the custody of employees whose service has
 * ended, i.e. what must be recovered before the final settlement.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const query = parseQuery(req, assetListQuerySchema);
    const isStaff = hasRole(user, ROLE_GROUPS.STAFF);
    const employeeId = isStaff ? query.employeeId || undefined : await requireEmployeeId(user);
    const activeOnly = query.active === 'true';
    const heldByTerminated = isStaff && (query.heldByTerminated === '1' || query.heldByTerminated === 'true');

    const where: Prisma.AssetWhereInput = {};
    if (employeeId) where.employeeId = employeeId;
    if (activeOnly || heldByTerminated) {
      where.returnDate = null;
      where.status = ASSET_STATUS.ACTIVE;
    }
    if (heldByTerminated) where.employee = { isTerminated: true };

    const simWhere: Prisma.TelecomSimWhereInput = employeeId ? { employeeId } : { employeeId: { not: null } };
    if (heldByTerminated) simWhere.employee = { isTerminated: true };

    const includeSims = !!employeeId || activeOnly || heldByTerminated;
    const [assets, sims] = await Promise.all([
      prisma.asset.findMany({
        where,
        include: { employee: { select: holderSelect } },
        orderBy: { createdAt: 'desc' },
      }),
      includeSims
        ? prisma.telecomSim.findMany({
            where: simWhere,
            select: {
              id: true,
              employeeId: true,
              simNumber: true,
              plan: true,
              provider: true,
              createdAt: true,
              employee: { select: holderSelect },
            },
          })
        : Promise.resolve([]),
    ]);

    const combined = sortCustodyNewestFirst([...assets, ...sims.map(simAsCustodyItem)]);
    return NextResponse.json(combined);
  } catch (err) {
    return handleApiError(err, 'assets:GET');
  }
}

/** Creates one asset, or several with { assets: [...] }. With employeeId it is assigned as custody. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const items = await parseBody(req, assetCreateSchema);

    const createdAssets = await prisma.$transaction(async (tx) => {
      await ensureRefsExist(tx, { employeeIds: items.map((i) => i.employeeId) }, { activeOnly: true });
      const created = [];
      for (const item of items) {
        const assigned = !!item.employeeId;
        created.push(
          await tx.asset.create({
            data: {
              employeeId: item.employeeId ?? null,
              assetType: item.assetType,
              description: item.description ?? null,
              receiveDate: assigned ? (item.receiveDate ?? today()) : (item.receiveDate ?? null),
              status: assigned ? ASSET_STATUS.ACTIVE : ASSET_STATUS.VACANT,
              returnDate: item.returnDate ?? null,
            },
          }),
        );
      }
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'Asset',
          entityId: created.length === 1 ? created[0].id : null,
          details: created.map((a) => ({ id: a.id, assetType: a.assetType, employeeId: a.employeeId, status: a.status })),
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    return NextResponse.json({ message: 'تم حفظ الأصول/العهد بنجاح', createdAssets }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'assets:POST');
  }
}

import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { today } from '@/lib/dates';
import { ensureRefsExist } from '@/app/api/services/_lib';
import { recordCompanyId } from '@/lib/record-company';
import { resolveSelfContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';
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
 * P1-SCOPE: back-office users read through their ScopedContext (Asset.companyId, TelecomSim.companyId),
 * a plain employee through his SelfContext.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const query = parseQuery(req, assetListQuerySchema);
    const isStaff = hasRole(user, ROLE_GROUPS.STAFF);
    const actor = await resolveActor(prisma, user);
    const ctx = isStaff ? scopedContext(actor) : await resolveSelfContext(prisma, actor);
    authz.assert(ctx, 'assets.read');
    const db = scopedPrisma(ctx);
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
      db.asset.findMany({
        where,
        include: { employee: { select: holderSelect } },
        orderBy: { createdAt: 'desc' },
      }),
      includeSims
        ? db.telecomSim.findMany({
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
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'assets.manage');
    const db = scopedPrisma(ctx);
    const items = await parseBody(req, assetCreateSchema);

    // P1-SCOPE: the holder must be an employee of the user's companies (404 otherwise); an assigned
    // asset belongs to its holder's legal company, a vacant one to the chosen (or only) company.
    const holderIds = [...new Set(items.map((i) => i.employeeId).filter((v): v is string => !!v))];
    const holders = holderIds.length ? await db.employee.findMany({ where: { id: { in: holderIds } }, select: { id: true, legalCompanyId: true } }) : [];
    if (holders.length !== holderIds.length) throw notFound('الموظف المحدد غير موجود');
    const holderCompany = new Map(holders.map((h) => [h.id, h.legalCompanyId]));
    const companyIds: (string | null)[] = [];
    for (const item of items) {
      if (item.employeeId) {
        const company = holderCompany.get(item.employeeId) ?? null;
        if (item.companyId && item.companyId !== company) throw badRequest('العهدة المسندة تتبع شركة الموظف المستلم');
        companyIds.push(company);
      } else {
        companyIds.push(await recordCompanyId(prisma, ctx, item.companyId));
      }
    }

    const createdAssets = await prisma.$transaction(async (tx) => {
      await ensureRefsExist(tx, { employeeIds: items.map((i) => i.employeeId) }, { activeOnly: true });
      const created = [];
      for (const [i, item] of items.entries()) {
        const assigned = !!item.employeeId;
        created.push(
          await tx.asset.create({
            data: {
              employeeId: item.employeeId ?? null,
              companyId: companyIds[i],
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
          details: created.map((a) => ({ id: a.id, assetType: a.assetType, employeeId: a.employeeId, companyId: a.companyId, status: a.status })),
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

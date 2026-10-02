import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseQuery } from '@/lib/http';
import { zPagination } from '@/lib/validation';
import { AUDIT_ORDER_BY, auditCursorWhere, paginateAuditRows, parseAuditCursor } from './cursor';
import { ALL_COMPANIES, authz, resolveActor, scopedContext } from '@/modules/iam';

export const dynamic = 'force-dynamic';

// P1-SCOPE: tenant-wide (SystemSetting / User / RolePermission / AuditLog have no company): an admin
// who sees EVERY company only. scopedContext(actor, ALL_COMPANIES) refuses (403) an actor restricted
// to some companies by UserCompanyScope, whatever his role.

const DEFAULT_TAKE = 200;

const QuerySchema = zPagination.extend({ cursor: z.string().max(100).optional() });

/**
 * GET ?take=200[&cursor=<X-Next-Cursor>] — newest audit entries first, ordered by (createdAt, id).
 * Returns an array; headers: X-Total-Count (all rows) and X-Next-Cursor (absent on the last page).
 * Pass the cursor to fetch the next page: rows added meanwhile do not shift the pages.
 * `skip` is still accepted (offset paging) when no cursor is given.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ADMIN);
    const ctx = scopedContext(await resolveActor(prisma, user), ALL_COMPANIES);
    authz.assert(ctx, 'platform.settings.manage');
    const { take: rawTake, skip, cursor: rawCursor } = parseQuery(req, QuerySchema);
    const take = rawTake ?? DEFAULT_TAKE;

    const cursor = rawCursor ? parseAuditCursor(rawCursor) : null;
    if (rawCursor && !cursor) throw badRequest('مؤشر الصفحة غير صالح');

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: cursor ? auditCursorWhere(cursor) : undefined,
        orderBy: AUDIT_ORDER_BY,
        take: take + 1,
        skip: cursor ? 0 : (skip ?? 0),
        select: {
          id: true,
          userId: true,
          action: true,
          entityType: true,
          entityId: true,
          details: true,
          ipAddress: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              employeeProfile: { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } },
            },
          },
        },
      }),
      prisma.auditLog.count(),
    ]);

    const { page, nextCursor } = paginateAuditRows(rows, take);
    const headers: Record<string, string> = { 'X-Total-Count': String(total) };
    if (nextCursor) headers['X-Next-Cursor'] = nextCursor;
    return NextResponse.json(page, { headers });
  } catch (err) {
    return handleApiError(err, 'audit-logs:GET');
  }
}

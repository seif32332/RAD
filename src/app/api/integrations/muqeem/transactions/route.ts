import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { zPagination } from '@/lib/validation';
import { MUQEEM_OPERATIONS, MUQEEM_TX_STATUS, STALE_PENDING_MS, featureSettlePath } from '@/lib/muqeem';

export const dynamic = 'force-dynamic';

/** Roles that may reconcile (mirrors transactions/[id]/reconcile and reconcileTransaction). */
const RECONCILE_ROLES: readonly string[] = ROLE_GROUPS.GOV;

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

const QuerySchema = zPagination.extend({
  status: z.preprocess(emptyToUndefined, z.enum(Object.values(MUQEEM_TX_STATUS) as [string, ...string[]]).optional()),
  operation: z.preprocess(emptyToUndefined, z.enum(MUQEEM_OPERATIONS).optional()),
  companyId: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  employeeId: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
});

/**
 * GET /api/integrations/muqeem/transactions?status=&operation=&companyId=&employeeId=&take=&skip=  (ROLE_GROUPS.GOV)
 * Muqeem transaction log, newest first, with employee / company / requester names.
 * 200 { items, total, statusCounts: { PENDING, SUCCEEDED, FAILED, UNKNOWN }, needsReconciliationCount, canReconcile, stalePendingMinutes }
 * Summaries are stored already redacted (no credentials, no PDFs).
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const q = parseQuery(req, QuerySchema);
    const take = q.take ?? 50;
    const skip = q.skip ?? 0;

    const scope: Prisma.MuqeemTransactionWhereInput = {
      ...(q.operation ? { operation: q.operation } : {}),
      ...(q.companyId ? { companyId: q.companyId } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
    };
    const where: Prisma.MuqeemTransactionWhereInput = { ...scope, ...(q.status ? { status: q.status } : {}) };

    const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
    const [rows, total, grouped, needsReconciliationCount] = await Promise.all([
      prisma.muqeemTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      prisma.muqeemTransaction.count({ where }),
      prisma.muqeemTransaction.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      prisma.muqeemTransaction.count({
        where: {
          ...scope,
          OR: [{ status: MUQEEM_TX_STATUS.UNKNOWN }, { status: MUQEEM_TX_STATUS.PENDING, createdAt: { lt: staleBefore } }],
        },
      }),
    ]);

    const employeeIds = [...new Set(rows.map((r) => r.employeeId).filter((v): v is string => !!v))];
    const companyIds = [...new Set(rows.map((r) => r.companyId).filter((v): v is string => !!v))];
    const userIds = [...new Set(rows.map((r) => r.requestedById).filter((v): v is string => !!v))];
    const [employees, companies, users] = await Promise.all([
      employeeIds.length
        ? prisma.employee.findMany({
            where: { id: { in: employeeIds } },
            select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, iqamaOrIdNumber: true },
          })
        : [],
      companyIds.length ? prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, nameArabic: true } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    ]);
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const compMap = new Map(companies.map((c) => [c.id, c.nameArabic]));
    const userMap = new Map(users.map((u) => [u.id, u.name?.trim() || u.email.split('@')[0]]));

    const now = Date.now();
    const statusCounts: Record<string, number> = { PENDING: 0, SUCCEEDED: 0, FAILED: 0, UNKNOWN: 0 };
    for (const g of grouped) statusCounts[g.status] = g._count._all;

    return NextResponse.json({
      items: rows.map((r) => {
        const e = r.employeeId ? empMap.get(r.employeeId) : undefined;
        const stalePending = r.status === MUQEEM_TX_STATUS.PENDING && now - r.createdAt.getTime() > STALE_PENDING_MS;
        return {
          id: r.id,
          operation: r.operation,
          status: r.status,
          companyId: r.companyId,
          companyName: r.companyId ? (compMap.get(r.companyId) ?? null) : null,
          employeeId: r.employeeId,
          employeeName: e ? `${e.firstNameArabic} ${e.lastNameArabic}`.trim() : null,
          employeeCode: e?.employeeId ?? null,
          iqamaLast4: e ? e.iqamaOrIdNumber.slice(-4) : null,
          entityType: r.entityType,
          entityId: r.entityId,
          externalRef: r.externalRef,
          httpStatus: r.httpStatus,
          errorMessage: r.errorMessage,
          requestSummary: r.requestSummary,
          responseSummary: r.responseSummary,
          documentUrl: r.documentUrl,
          requestedBy: r.requestedById ? (userMap.get(r.requestedById) ?? null) : null,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
          /** UNKNOWN, or PENDING for longer than STALE_PENDING_MS. */
          needsReconciliation: r.status === MUQEEM_TX_STATUS.UNKNOWN || stalePending,
          /** Screen that settles this operation (and applies it to the visa / employee / settlement); null = settle here. */
          settleAt: featureSettlePath(r.operation, r.employeeId)?.path ?? null,
        };
      }),
      total,
      take,
      skip,
      statusCounts,
      needsReconciliationCount,
      canReconcile: RECONCILE_ROLES.includes(user.role),
      stalePendingMinutes: Math.round(STALE_PENDING_MS / 60_000),
    });
  } catch (err) {
    return handleApiError(err, 'integrations/muqeem/transactions:GET');
  }
}

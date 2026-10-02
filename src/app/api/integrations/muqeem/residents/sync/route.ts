import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { toApiError } from '@/lib/muqeem';
import { computeResidentDiff, normalizeIqamaNumber, MAX_SYNC_RESIDENTS } from '@/lib/muqeem-sync';
import { fetchAllResidents, loadCompany, loadEmployeesForDiff } from '../_shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ companyId: zId });

/**
 * POST /api/integrations/muqeem/residents/sync { companyId }  (ROLE_GROUPS.GOV)
 * READ-ONLY: reads the company's active residents report on Muqeem (all pages, capped at 5000) and
 * compares it with the Radeef employees whose legal company is `companyId`, by iqama number.
 * Changes nothing (neither in Muqeem nor in Radeef); audited as VIEW with the counts.
 * P1-SCOPE: only a company of the user's scope (404 otherwise), and the employees compared (including
 * those of "another company" matched by iqama) are those of the user's companies only.
 * 200 { company, fetchedAt, truncated, total, pages, diff: ResidentDiff }
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'gov.muqeem.operate');
    const limit = rateLimit(`muqeem-sync:${user.id}`, 30, 10 * 60_000);
    if (!limit.ok) throw new HttpError(429, 'تم تجاوز عدد مرات المطابقة المسموح بها، حاول بعد بضع دقائق');
    const { companyId } = await parseBody(req, BodySchema);
    if (!(await scopedPrisma(ctx).company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw notFound('الشركة غير موجودة');
    const company = await loadCompany(companyId);

    const report = await fetchAllResidents(companyId);
    const iqamas = report.rows.map((r) => normalizeIqamaNumber(r.iqamaNumber)).filter((v): v is string => !!v);
    const employees = await loadEmployeesForDiff(companyId, iqamas, scopeWhere(ctx, 'Employee') as Prisma.EmployeeWhereInput | null);
    const diff = computeResidentDiff(companyId, report.rows, employees);

    await logAudit({
      userId: user.id,
      action: 'VIEW',
      entityType: 'Company',
      entityId: companyId,
      details: { muqeemOperation: 'ACTIVE_RESIDENTS_SYNC', pages: report.pages, truncated: report.truncated, ...diff.counts },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({
      company: { id: company.id, name: company.nameArabic, moiNumber: company.moiNumber },
      fetchedAt: new Date().toISOString(),
      truncated: report.truncated,
      cap: MAX_SYNC_RESIDENTS,
      total: report.total,
      pages: report.pages,
      diff,
    });
  } catch (err) {
    return handleApiError(toApiError(err), 'integrations/muqeem/residents/sync:POST');
  }
}

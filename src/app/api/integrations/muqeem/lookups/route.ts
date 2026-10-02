import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseQuery } from '@/lib/http';
import { getCachedMuqeemLookup, MUQEEM_LOOKUP_TYPES, MuqeemError, toApiError } from '@/lib/muqeem';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  type: z.enum(MUQEEM_LOOKUP_TYPES, { errorMap: () => ({ message: 'نوع القائمة يجب أن يكون countries أو cities أو marital-statuses' }) }),
  companyId: z.string().trim().min(1).max(100).optional(),
});

/**
 * GET /api/integrations/muqeem/lookups?type=countries|cities|marital-statuses[&companyId=]
 * (ROLE_GROUPS.GOV). Lookups are global reference data cached in memory for 12 h; the company (or,
 * when omitted, the first linked company) only provides the credentials for the first fetch.
 * P1-SCOPE: only a company of the user's scope lends its credentials (404 for another company).
 * 200 { type, items: [{ code, nameAr, nameEn }], cachedAt, fromCache }.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'gov.muqeem.operate');
    const db = scopedPrisma(ctx);
    const { type, companyId: requested } = parseQuery(req, QuerySchema);

    let companyId = requested;
    if (companyId) {
      if (!(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw notFound('الشركة غير موجودة');
    } else {
      const linked = await db.company.findFirst({
        where: { moiNumber: { not: null }, muqeemPlatformId: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!linked) throw new MuqeemError('NOT_LINKED', { detail: 'no linked company for lookups' });
      companyId = linked.id;
    }

    const { items, cachedAt, fromCache } = await getCachedMuqeemLookup(type, companyId);
    return NextResponse.json({
      type,
      items: items.map((i) => ({ code: i.code ?? null, nameAr: i.nameAr ?? null, nameEn: i.nameEn ?? null })),
      cachedAt,
      fromCache,
    });
  } catch (err) {
    return handleApiError(toApiError(err), 'integrations/muqeem/lookups:GET');
  }
}

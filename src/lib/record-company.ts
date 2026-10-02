// The company a NEW company-keyed record is written to (P1-SCOPE, DOMAIN_BOUNDARIES §5.4.3), for the
// tables whose company is chosen by the user rather than derived from an employee (gov platforms,
// legal records, vacant assets).
import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, forbidden } from '@/lib/http';
import { ALL_COMPANIES, companiesAllowed, type ScopeContext } from '@/modules/iam';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * - a requested company must exist and be inside the context (403 outside it, 400 unknown);
 * - none requested: the context's only company; the tenant's only company for an unrestricted
 *   context; otherwise 400 for a restricted context with several companies (it must choose), and
 *   null (unknown, visible to unrestricted users only) for an unrestricted one.
 */
export async function recordCompanyId(db: Db, ctx: ScopeContext, requested?: string | null): Promise<string | null> {
  if (requested) {
    if (!companiesAllowed(ctx.companies, [requested])) throw forbidden('هذه الشركة خارج نطاق صلاحياتك');
    const exists = await db.company.findUnique({ where: { id: requested }, select: { id: true } });
    if (!exists) throw badRequest('الشركة المحددة غير موجودة');
    return exists.id;
  }
  if (ctx.companies !== ALL_COMPANIES) {
    if (ctx.companies.length === 1) return ctx.companies[0];
    throw badRequest('اختر الشركة التي يتبع لها السجل');
  }
  const only = await db.company.findMany({ select: { id: true }, take: 2 });
  return only.length === 1 ? only[0].id : null;
}

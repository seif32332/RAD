// iam reads of the login accounts (User is an iam table, DOMAIN_BOUNDARIES §5.2): for the modules
// above that apply person rules (the eligible second person of lifecycle, BR-LCY-012) without
// reading User themselves (ARCH-001).
import type { Prisma, PrismaClient } from '@prisma/client';
import { ROLE_GROUPS, type AppRole } from '@/lib/constants';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ActiveUser {
  id: string;
  role: AppRole;
}

/**
 * Active accounts with one of `roles`, excluding documents-only accounts (a leaver's window,
 * src/lib/auth.ts) whatever their role. Tenant-wide: User has no company (§5.4.2).
 */
export async function activeUsersWithRoles(db: Db, roles: readonly string[]): Promise<ActiveUser[]> {
  if (!roles.length) return [];
  const rows = await db.user.findMany({
    where: { isActive: true, documentsOnlyUntil: null, role: { in: [...roles] as AppRole[] } },
    select: { id: true, role: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, role: r.role as AppRole }));
}

/**
 * WFE-002 (approval engine, wfe-to-be.md §12.4 / G9 general eligibility; DEC-PO-145 guardrail 1): the
 * accounts that may be an approver in `companyId` with one of `roles`. Active, not documents-only (a leaver's
 * window), not a Radeef vendor account (G9, BL-PAY-005), holding one of `roles`, and whose company scope
 * covers the company: an explicit owner role, no UserCompanyScope rows (the transitional "every company" rule
 * of actorCompanies, context.ts), or a row for `companyId`. Read live on every call: the engine never trusts a
 * role or a scope it saw earlier (act time re-check).
 */
export async function activeUsersWithRolesInCompany(db: Db, roles: readonly string[], companyId: string, onlyUserIds?: readonly string[]): Promise<ActiveUser[]> {
  if (!roles.length || !companyId) return [];
  if (onlyUserIds && !onlyUserIds.length) return [];
  const rows = await db.user.findMany({
    where: {
      ...(onlyUserIds ? { id: { in: [...onlyUserIds] } } : {}),
      isActive: true,
      documentsOnlyUntil: null,
      isVendorStaff: false,
      role: { in: [...roles] as AppRole[] },
      OR: [{ role: { in: [...ROLE_GROUPS.OWNER] } }, { companyScopes: { none: {} } }, { companyScopes: { some: { companyId } } }],
    },
    select: { id: true, role: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, role: r.role as AppRole }));
}

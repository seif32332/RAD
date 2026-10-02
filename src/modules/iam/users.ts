// iam reads of the login accounts (User is an iam table, DOMAIN_BOUNDARIES §5.2): for the modules
// above that apply person rules (the eligible second person of lifecycle, BR-LCY-012) without
// reading User themselves (ARCH-001).
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppRole } from '@/lib/constants';

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

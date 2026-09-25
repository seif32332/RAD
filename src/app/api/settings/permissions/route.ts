import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ALL_ROLES, ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const PermissionSchema = z.object({
  role: z.enum(ALL_ROLES),
  allowedPages: z
    .array(z.string().trim().min(1).max(200))
    .max(100, 'عدد الصفحات كبير جداً')
    .transform((pages) => Array.from(new Set(pages))),
});

/**
 * Admins only: the permissions screen. The sidebar reads the current role's own row from
 * GET /api/auth/me, so other roles never need the full matrix.
 */
export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.ADMIN);
    const permissions = await prisma.rolePermission.findMany({
      select: { id: true, role: true, allowedPages: true, createdAt: true, updatedAt: true },
      orderBy: { role: 'asc' },
    });
    return NextResponse.json(permissions);
  } catch (err) {
    return handleApiError(err, 'permissions:GET');
  }
}

/** POST { role, allowedPages: string[] } — admins only. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ADMIN);
    const { role, allowedPages } = await parseBody(req, PermissionSchema);

    const before = await prisma.rolePermission.findUnique({ where: { role }, select: { allowedPages: true } });
    const updated = await prisma.rolePermission.upsert({
      where: { role },
      update: { allowedPages },
      create: { role, allowedPages },
      select: { id: true, role: true, allowedPages: true, createdAt: true, updatedAt: true },
    });

    await logAudit({
      userId: user.id,
      action: before ? 'UPDATE' : 'CREATE',
      entityType: 'RolePermission',
      entityId: updated.id,
      details: { role, from: before?.allowedPages ?? null, to: allowedPages },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم تحديث الصلاحيات بنجاح', data: updated });
  } catch (err) {
    return handleApiError(err, 'permissions:POST');
  }
}

import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zBool, zEmail, zOptText, zPassword } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { ALL_COMPANIES, authz, resolveActor, scopedContext } from '@/modules/iam';
import { assertPasswordLength, friendlyValidationError } from '../security';
import { BCRYPT_COST, assertEmailAvailable, checkCreateRole, linkEmployee, safeUserSelect, zEmployeeLink, zRole } from './shared';

export const dynamic = 'force-dynamic';

// P1-SCOPE: tenant-wide (SystemSetting / User / RolePermission / AuditLog have no company): an admin
// who sees EVERY company only. scopedContext(actor, ALL_COMPANIES) refuses (403) an actor restricted
// to some companies by UserCompanyScope, whatever his role.

const CreateUserSchema = z.object({
  email: zEmail,
  password: zPassword,
  role: zRole,
  employeeId: zEmployeeLink,
  isActive: zBool.optional(),
  name: zOptText(120),
});

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ADMIN);
    const ctx = scopedContext(await resolveActor(prisma, user), ALL_COMPANIES);
    authz.assert(ctx, 'platform.settings.manage');
    const users = await prisma.user.findMany({ select: safeUserSelect, orderBy: { createdAt: 'desc' } });
    return NextResponse.json(users);
  } catch (err) {
    return handleApiError(err, 'users:GET');
  }
}

export async function POST(req: Request) {
  try {
    const actor = await requireUser(ROLE_GROUPS.ADMIN);
    const ctx = scopedContext(await resolveActor(prisma, actor), ALL_COMPANIES);
    authz.assert(ctx, 'platform.settings.manage');
    const body = await parseBody(req, CreateUserSchema);

    const roleError = checkCreateRole(actor, body.role);
    if (roleError) throw roleError;

    await assertPasswordLength(body.password);
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);

    const user = await prisma.$transaction(async (tx) => {
      await assertEmailAvailable(tx, body.email);
      const created = await tx.user.create({
        data: {
          email: body.email,
          passwordHash,
          role: body.role,
          isActive: body.isActive ?? true,
          ...(body.name ? { name: body.name } : {}),
        },
        select: { id: true },
      });
      if (body.employeeId) await linkEmployee(tx, created.id, body.employeeId);
      await logAudit(
        {
          userId: actor.id,
          action: 'CREATE',
          entityType: 'User',
          entityId: created.id,
          details: { email: body.email, role: body.role, employeeId: body.employeeId || null, isActive: body.isActive ?? true },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id: created.id }, select: safeUserSelect });
    });

    return NextResponse.json({ message: 'تم إنشاء المستخدم ومنحه الصلاحية بنجاح ✅', user }, { status: 201 });
  } catch (err) {
    return handleApiError(friendlyValidationError(err), 'users:POST');
  }
}

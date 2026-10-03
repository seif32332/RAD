import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zBool, zEmail, zOptText, zPassword } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { ALL_COMPANIES, authz, createUser, proposeLink, resolveActor, runIdentityTransaction, scopedContext } from '@/modules/iam';
import { moneyActorOf } from '@/modules/platform';
import { assertPasswordLength, friendlyValidationError } from '../security';
import { BCRYPT_COST, assertEmployeeExists, checkCreateRole, safeUserSelect, withIdentity, zEmployeeLink, zRole } from './shared';

export const dynamic = 'force-dynamic';

// P1-SCOPE: tenant-wide (SystemSetting / User / RolePermission / AuditLog have no company): an admin
// who sees EVERY company only. scopedContext(actor, ALL_COMPANIES) refuses (403) an actor restricted
// to some companies by UserCompanyScope, whatever his role.
//
// BL-PAY-005: an account is created by iam.createUser (createdById = the session user, UNATTESTED); a link to
// an employee file is only PROPOSED here and needs a second person to confirm it (two-step link, BR-PAY-005).

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
    return NextResponse.json(await withIdentity(users));
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
    if (body.employeeId) await assertEmployeeExists(body.employeeId);

    const idem = req.headers.get('idempotency-key')?.slice(0, 100) || randomUUID();
    const ip = getClientIp(req);
    const user = await runIdentityTransaction(prisma, async (tx) => {
      const created = await createUser(tx, {
        actor: moneyActorOf(actor),
        email: body.email,
        passwordHash,
        role: body.role,
        isActive: body.isActive ?? true,
        name: body.name ?? null,
        operationKey: `users.create:${actor.id}:${idem}`,
        ipAddress: ip,
      });
      if (body.employeeId) {
        await proposeLink(tx, { actor: moneyActorOf(actor), userId: created.userId, employeeId: body.employeeId, operationKey: `users.create.link:${actor.id}:${idem}`, ipAddress: ip });
      }
      await logAudit(
        {
          userId: actor.id,
          action: 'CREATE',
          entityType: 'User',
          entityId: created.userId,
          details: { email: body.email, role: body.role, employeeLinkProposed: body.employeeId || null, isActive: body.isActive ?? true },
          ipAddress: ip,
        },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id: created.userId }, select: safeUserSelect });
    });

    const [view] = await withIdentity([user]);
    return NextResponse.json(
      {
        message: body.employeeId
          ? 'تم إنشاء المستخدم. ربطه بملف الموظف بانتظار تأكيد مسؤول ثانٍ ✅'
          : 'تم إنشاء المستخدم ومنحه الصلاحية بنجاح ✅',
        user: view,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(friendlyValidationError(err), 'users:POST');
  }
}

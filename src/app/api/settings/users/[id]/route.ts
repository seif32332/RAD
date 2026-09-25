import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zEmail, zId, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import {
  BCRYPT_COST,
  assertEmailAvailable,
  checkUserChange,
  linkEmployee,
  mapTxConflict,
  safeUserSelect,
  zEmployeeLink,
  zOptPassword,
  zRole,
} from '../shared';
import { assertPasswordLength, friendlyValidationError } from '../../security';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const UpdateUserSchema = z.object({
  email: zEmail.optional(),
  role: zRole.optional(),
  password: zOptPassword,
  isActive: zBool.optional(),
  name: zOptText(120),
  employeeId: zEmployeeLink,
});

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

function countActiveSuperAdmins(tx: Prisma.TransactionClient) {
  return tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireUser(ROLE_GROUPS.ADMIN);
    const id = zId.parse((await params).id);
    const user = await prisma.user.findUnique({ where: { id }, select: safeUserSelect });
    if (!user) throw notFound('المستخدم غير موجود');
    return NextResponse.json(user);
  } catch (err) {
    return handleApiError(err, 'users:[id]:GET');
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const actor = await requireUser(ROLE_GROUPS.ADMIN);
    const id = zId.parse((await params).id);
    const body = await parseBody(req, UpdateUserSchema);

    await assertPasswordLength(body.password);
    const passwordHash = body.password ? await bcrypt.hash(body.password, BCRYPT_COST) : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, isActive: true } });
      if (!target) throw notFound('المستخدم غير موجود');

      const error = checkUserChange(actor, target, { nextRole: body.role, nextActive: body.isActive }, await countActiveSuperAdmins(tx));
      if (error) throw error;

      if (body.email && body.email !== target.email.toLowerCase()) await assertEmailAvailable(tx, body.email, id);

      if (body.employeeId === null) {
        await tx.employee.updateMany({ where: { userId: id }, data: { userId: null } });
      } else if (body.employeeId) {
        await linkEmployee(tx, id, body.employeeId);
      }

      const data = definedOnly({
        email: body.email,
        role: body.role,
        isActive: body.isActive,
        name: body.name,
        passwordHash,
      });
      // Deactivation also revokes existing sessions, so reactivating never revives an old token.
      const revoke = body.isActive === false && target.isActive;
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id }, data: revoke ? { ...data, sessionVersion: { increment: 1 } } : data });
      }

      await logAudit(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'User',
          entityId: id,
          details: {
            email: body.email !== undefined && body.email !== target.email ? { from: target.email, to: body.email } : undefined,
            role: body.role !== undefined && body.role !== target.role ? { from: target.role, to: body.role } : undefined,
            isActive: body.isActive !== undefined && body.isActive !== target.isActive ? { from: target.isActive, to: body.isActive } : undefined,
            credentialsReset: !!passwordHash,
            sessionsRevoked: revoke || undefined,
            employeeId: body.employeeId === '' ? undefined : body.employeeId,
          },
          ipAddress: getClientIp(req),
        },
        tx,
      );

      return tx.user.findUniqueOrThrow({ where: { id }, select: safeUserSelect });
    }, SERIALIZABLE);

    return NextResponse.json({ message: 'تم تحديث بيانات المستخدم بنجاح', data: updated });
  } catch (err) {
    return handleApiError(friendlyValidationError(mapTxConflict(err)), 'users:[id]:PATCH');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const actor = await requireUser(ROLE_GROUPS.ADMIN);
    const id = zId.parse((await params).id);

    // An account is never removed: deleting it would orphan its audit trail (AuditLog.userId is
    // SET NULL on delete). DELETE therefore deactivates the account and revokes its sessions.
    const data = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, isActive: true } });
      if (!target) throw notFound('المستخدم غير موجود');
      if (!target.isActive) throw conflict('الحساب معطّل مسبقاً');

      const error = checkUserChange(actor, target, { nextActive: false }, await countActiveSuperAdmins(tx));
      if (error) throw error;

      await tx.user.update({
        where: { id },
        data: { isActive: false, sessionVersion: { increment: 1 } },
      });
      await logAudit(
        {
          userId: actor.id,
          action: 'UPDATE',
          entityType: 'User',
          entityId: id,
          details: {
            email: target.email,
            role: target.role,
            isActive: { from: true, to: false },
            sessionsRevoked: true,
            via: 'DELETE',
          },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id }, select: safeUserSelect });
    }, SERIALIZABLE);

    return NextResponse.json({ message: 'تم تعطيل الحساب وإنهاء جلساته. يبقى سجل التدقيق منسوباً إليه، ويمكن إعادة تفعيله لاحقاً.', data });
  } catch (err) {
    return handleApiError(mapTxConflict(err), 'users:[id]:DELETE');
  }
}

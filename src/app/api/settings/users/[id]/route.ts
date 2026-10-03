import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zEmail, zId, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { assertEmployeeExists, checkUserChange, mapTxConflict, safeUserSelect, withIdentity, zEmployeeLink, zRole } from '../shared';
import { friendlyValidationError } from '../../security';
import { ALL_COMPANIES, authz, changeUserByAdmin, endLink, proposeLink, resolveActor, runIdentityTransaction, scopedContext } from '@/modules/iam';
import { moneyActorOf } from '@/modules/platform';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

// P1-SCOPE: tenant-wide (SystemSetting / User / RolePermission / AuditLog have no company): an admin
// who sees EVERY company only. scopedContext(actor, ALL_COMPANIES) refuses (403) an actor restricted
// to some companies by UserCompanyScope, whatever his role.
//
// BL-PAY-005 (identity controls): every change goes through iam.
//   - An admin never sets another user's password (DEC-PO-027): `password` is refused; use
//     POST /api/settings/users/:id/identity { action: 'resetCredentials' } (a one-time link to the holder).
//   - Email: only of an account that is not attested (RT-PAY-1001).
//   - Role / deactivation of an account that counts toward ENFORCED: a pending two-person request (202,
//     DEC-PO-021); otherwise applied now. A role into a financial approver role drops the attestation
//     (identity.promoteApprover).
//   - employeeId: a string PROPOSES a link (a second person confirms it); null ends the open link.

type Ctx = { params: Promise<{ id: string }> };

const UpdateUserSchema = z.object({
  email: zEmail.optional(),
  role: zRole.optional(),
  /** Refused (DEC-PO-027); kept in the schema to answer with a clear message. */
  password: z.unknown().optional(),
  isActive: zBool.optional(),
  name: zOptText(120),
  employeeId: zEmployeeLink,
  reason: zOptText(500),
});

function countActiveSuperAdmins(tx: Prisma.TransactionClient) {
  return tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const actor = await requireUser(ROLE_GROUPS.ADMIN);
    const ctx = scopedContext(await resolveActor(prisma, actor), ALL_COMPANIES);
    authz.assert(ctx, 'platform.settings.manage');
    const id = zId.parse((await params).id);
    const user = await prisma.user.findUnique({ where: { id }, select: safeUserSelect });
    if (!user) throw notFound('المستخدم غير موجود');
    const [view] = await withIdentity([user]);
    return NextResponse.json(view);
  } catch (err) {
    return handleApiError(err, 'users:[id]:GET');
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const actor = await requireUser(ROLE_GROUPS.ADMIN);
    const ctx = scopedContext(await resolveActor(prisma, actor), ALL_COMPANIES);
    authz.assert(ctx, 'platform.settings.manage');
    const id = zId.parse((await params).id);
    const body = await parseBody(req, UpdateUserSchema);
    if (body.password !== undefined && body.password !== '' && body.password !== null) {
      throw badRequest('لا يضبط المسؤول كلمة مرور مستخدم آخر: استخدم "إعادة ضبط بيانات الدخول" لإرسال رابط لمرة واحدة لصاحب الحساب (DEC-PO-027)');
    }
    if (typeof body.employeeId === 'string' && body.employeeId) await assertEmployeeExists(body.employeeId);

    const idem = req.headers.get('idempotency-key')?.slice(0, 100) || randomUUID();
    const ip = getClientIp(req);
    const me = moneyActorOf(actor);
    const r = await runIdentityTransaction(prisma, async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, isActive: true } });
      if (!target) throw notFound('المستخدم غير موجود');
      const error = checkUserChange(actor, target, { nextRole: body.role, nextActive: body.isActive }, await countActiveSuperAdmins(tx));
      if (error) throw error;

      if (body.employeeId === null) {
        await endLink(tx, { actor: me, userId: id, reason: body.reason ?? null, operationKey: `users.unlink:${actor.id}:${id}:${idem}`, ipAddress: ip });
      } else if (body.employeeId) {
        const open = await tx.userEmployeeLink.findFirst({ where: { userId: id, employeeId: body.employeeId, status: { in: ['PROPOSED', 'CONFIRMED', 'LEGACY_LINKED'] } }, select: { id: true } });
        if (!open) await proposeLink(tx, { actor: me, userId: id, employeeId: body.employeeId, operationKey: `users.link:${actor.id}:${id}:${idem}`, ipAddress: ip });
      }

      const change = await changeUserByAdmin(tx, {
        actor: me,
        userId: id,
        email: body.email,
        role: body.role,
        isActive: body.isActive,
        name: body.name,
        reason: body.reason ?? null,
        operationKey: `users.change:${actor.id}:${id}:${idem}`,
        ipAddress: ip,
      });

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
            twoPersonRequest: change.request ? { id: change.request.id, kind: change.request.kind } : undefined,
            employeeId: body.employeeId === '' ? undefined : body.employeeId,
          },
          ipAddress: ip,
        },
        tx,
      );
      return { change, user: await tx.user.findUniqueOrThrow({ where: { id }, select: safeUserSelect }) };
    });

    const [view] = await withIdentity([r.user]);
    if (r.change.request) {
      return NextResponse.json(
        {
          message: 'هذا الحساب يُحسب ضمن المعتمدين الماليين المُقرّين: التغيير يحتاج موافقة صاحبه أو مسؤول آخر مُقرّ به، وأُرسل طلباً بانتظار الموافقة',
          data: view,
          pendingRequest: r.change.request,
        },
        { status: 202 },
      );
    }
    return NextResponse.json({ message: 'تم تحديث بيانات المستخدم بنجاح', data: view });
  } catch (err) {
    return handleApiError(friendlyValidationError(mapTxConflict(err)), 'users:[id]:PATCH');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const actor = await requireUser(ROLE_GROUPS.ADMIN);
    const ctx = scopedContext(await resolveActor(prisma, actor), ALL_COMPANIES);
    authz.assert(ctx, 'platform.settings.manage');
    const id = zId.parse((await params).id);
    const idem = req.headers.get('idempotency-key')?.slice(0, 100) || randomUUID();
    const ip = getClientIp(req);

    // An account is never removed: deleting it would orphan its audit trail (AuditLog.userId is
    // SET NULL on delete). DELETE therefore deactivates the account and revokes its sessions; an account
    // that counts toward ENFORCED needs a second person (DEC-PO-021, identity.deactivateApprover).
    const r = await runIdentityTransaction(prisma, async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, isActive: true } });
      if (!target) throw notFound('المستخدم غير موجود');
      if (!target.isActive) throw conflict('الحساب معطّل مسبقاً');
      const error = checkUserChange(actor, target, { nextActive: false }, await countActiveSuperAdmins(tx));
      if (error) throw error;
      const change = await changeUserByAdmin(tx, {
        actor: moneyActorOf(actor),
        userId: id,
        isActive: false,
        operationKey: `users.deactivate:${actor.id}:${id}:${idem}`,
        ipAddress: ip,
      });
      if (!change.request) {
        await logAudit(
          {
            userId: actor.id,
            action: 'UPDATE',
            entityType: 'User',
            entityId: id,
            details: { email: target.email, role: target.role, isActive: { from: true, to: false }, sessionsRevoked: true, via: 'DELETE' },
            ipAddress: ip,
          },
          tx,
        );
      }
      return { change, user: await tx.user.findUniqueOrThrow({ where: { id }, select: safeUserSelect }) };
    });

    const [view] = await withIdentity([r.user]);
    if (r.change.request) {
      return NextResponse.json(
        { message: 'تعطيل معتمد مالي مُقرّ به يحتاج موافقة صاحب الحساب أو مسؤول آخر مُقرّ به (DEC-PO-021): أُرسل طلب التعطيل بانتظار الموافقة', data: view, pendingRequest: r.change.request },
        { status: 202 },
      );
    }
    return NextResponse.json({ message: 'تم تعطيل الحساب وإنهاء جلساته. يبقى سجل التدقيق منسوباً إليه، ويمكن إعادة تفعيله لاحقاً.', data: view });
  } catch (err) {
    return handleApiError(mapTxConflict(err), 'users:[id]:DELETE');
  }
}

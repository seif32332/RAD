import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { handleApiError, parseBody } from '@/lib/http';
import { zMoney, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { PAYMENTS_ACCESS } from './access';
import { filterPaymentsInScope } from './scope';
import { authz, resolveActor, scopedContext } from '@/modules/iam';
import { createPaymentRequest } from '@/modules/finance';
import { runPayrollTransaction } from '@/modules/payroll';
import { moneyActorOf } from '@/modules/platform';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser(PAYMENTS_ACCESS);
    // P1-SCOPE: the requests of the user's companies (company of the linked record, ./scope.ts).
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'payment.read');
    const payments = await filterPaymentsInScope(
      prisma,
      ctx,
      await prisma.paymentRequest.findMany({
        orderBy: { createdAt: 'desc' },
      }),
    );
    // Maker-checker display: who filed / approved / paid each request (the requester cannot pay it).
    const userIds = [
      ...new Set(payments.flatMap((p) => [p.requestedById, p.approvedById, p.paidById]).filter((v): v is string => !!v)),
    ];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name || u.email]));
    const name = (id: string | null) => (id ? (nameOf.get(id) ?? null) : null);
    return NextResponse.json(
      payments.map((p) => ({
        ...p,
        requestedByName: name(p.requestedById),
        approvedByName: name(p.approvedById),
        paidByName: name(p.paidById),
        isOwnRequest: !!p.requestedById && p.requestedById === user.id,
      })),
    );
  } catch (err) {
    return handleApiError(err, 'payments:GET');
  }
}

const createSchema = z.object({
  title: zText(300),
  reason: zOptText(4000),
  amount: zMoney,
  accountNumber: zOptText(1000),
  // Sent by the page but already embedded in `reason`; accepted and ignored.
  attachmentUrl: zOptText(2000),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(PAYMENTS_ACCESS);
    const body = await parseBody(req, createSchema);
    // A free-form request has no company: visible to unrestricted users and to its requester (./scope.ts).
    authz.assert(scopedContext(await resolveActor(prisma, user)), 'payment.manage');

    // finance.createPaymentRequest behind money.gateway. Maker-checker: the requester may not approve
    // (owner portal) nor pay (payments) it.
    const idem = req.headers.get('idempotency-key')?.trim();
    const payment = await runPayrollTransaction(prisma, (tx) =>
      createPaymentRequest(tx, {
        actor: moneyActorOf(user),
        title: body.title,
        reason: body.reason ?? null,
        amount: roundMoney(body.amount),
        accountNumber: body.accountNumber ?? null,
        status: 'PENDING_OWNER',
        operationKey: idem ? `payment.create:k:${user.id}:${idem.slice(0, 100)}` : `payment.create:${randomUUID()}`,
        ipAddress: getClientIp(req),
      }),
    );

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'PaymentRequest',
      entityId: payment.id,
      details: { title: payment.title, amount: payment.amount },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(payment, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'payments:POST');
  }
}

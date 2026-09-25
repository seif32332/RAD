import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { handleApiError, parseBody } from '@/lib/http';
import { zMoney, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { PAYMENTS_ACCESS } from './access';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser(PAYMENTS_ACCESS);
    const payments = await prisma.paymentRequest.findMany({
      orderBy: { createdAt: 'desc' },
    });
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

    const payment = await prisma.paymentRequest.create({
      data: {
        title: body.title,
        reason: body.reason ?? null,
        amount: roundMoney(body.amount),
        accountNumber: body.accountNumber ?? null,
        status: 'PENDING_OWNER',
        // Maker-checker: the requester may not approve (owner portal) nor pay (payments) it.
        requestedById: user.id,
      },
    });

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

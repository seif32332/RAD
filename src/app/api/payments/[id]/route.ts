import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { zOptMoney, zOptText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { markLoanTransferred, markSettlementPaid } from '@/lib/finance';
import {
  LINKED_PAYMENT_ENTITY_TYPES,
  PAYMENTS_ACCESS,
  PAYMENT_OPEN_STATUSES,
  PAYMENT_STATUS,
  paymentDeleteBlockReason,
} from '../access';
import { enforceMakerChecker } from '../maker-checker';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  status: z.enum([PAYMENT_STATUS.PAID, PAYMENT_STATUS.RETURNED]).optional(),
  receiptUrl: zOptText(2000),
  returnReason: zOptText(2000),
  title: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().min(1).max(300).optional()),
  reason: zOptText(4000),
  amount: zOptMoney,
  accountNumber: zOptText(1000),
});

/** Fields that may only change before the request is approved/paid. */
const EDITABLE_STATUSES = [PAYMENT_STATUS.PENDING_OWNER, PAYMENT_STATUS.RETURNED];

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.FINANCE);
    const { id } = await params;
    const body = await parseBody(req, updateSchema);
    const ipAddress = getClientIp(req);

    const payment = await prisma.$transaction(
      async (tx) => {
        const current = await tx.paymentRequest.findUnique({ where: { id } });
        if (!current) throw notFound('طلب السداد غير موجود');

        if (body.status === PAYMENT_STATUS.PAID) {
          const receiptUrl = body.receiptUrl ?? current.receiptUrl ?? null;
          if (!receiptUrl) throw badRequest('الرجاء إرفاق صورة السداد أو التحويل');

          // Maker-checker: the requester may not record their own request as paid (403),
          // except SUPER_ADMIN / allow_self_approval (audited as SELF_APPROVAL_OVERRIDE).
          const makerChecker = await enforceMakerChecker(tx, 'PAY', user, current, ipAddress);

          // Guard the transition first so a double submit cannot pay twice.
          const res = await tx.paymentRequest.updateMany({
            where: { id, status: PAYMENT_STATUS.PENDING_FINANCE },
            data: { status: PAYMENT_STATUS.PAID, receiptUrl, paidById: user.id },
          });
          if (res.count === 0) throw conflict('لا يمكن تأكيد السداد: الطلب غير معتمد للصرف أو تم سداده مسبقاً');

          // Linked entities: apply the same side effects as their own finance screens.
          if (current.entityId && current.entityType === 'SETTLEMENT') {
            await markSettlementPaid(tx, current.entityId, receiptUrl, user, { ipAddress });
          } else if (current.entityId && current.entityType === 'LOAN') {
            await markLoanTransferred(tx, current.entityId, receiptUrl, user, { ipAddress });
          } else if (current.entityId && current.entityType === 'VISA') {
            // Visa fee paid: PENDING_PAYMENT -> PAID (an already ISSUED visa is left as is).
            const visaRes = await tx.visa.updateMany({
              where: { id: current.entityId, status: 'PENDING_PAYMENT' },
              data: { status: 'PAID' },
            });
            if (visaRes.count === 0) {
              // A cancelled visa (e.g. its leave was cancelled) must not be paid; throwing rolls back
              // the PAID transition above.
              const visa = await tx.visa.findUnique({ where: { id: current.entityId }, select: { status: true } });
              if (visa?.status === 'CANCELLED') {
                throw conflict('لا يمكن سداد رسوم تأشيرة ملغاة؛ استخدم "رد السداد" بدلاً من ذلك');
              }
            } else {
              await logAudit(
                {
                  userId: user.id,
                  action: 'UPDATE',
                  entityType: 'Visa',
                  entityId: current.entityId,
                  details: { status: 'PAID', paymentRequestId: id, receiptUrl },
                  ipAddress,
                },
                tx,
              );
            }
          }

          await logAudit(
            {
              userId: user.id,
              action: 'UPDATE',
              entityType: 'PaymentRequest',
              entityId: id,
              details: {
                status: PAYMENT_STATUS.PAID,
                receiptUrl,
                entityType: current.entityType,
                entityId: current.entityId,
                requestedById: current.requestedById,
                makerChecker,
              },
              ipAddress,
            },
            tx,
          );
        } else if (body.status === PAYMENT_STATUS.RETURNED) {
          const returnReason = body.returnReason ?? null;
          if (!returnReason) throw badRequest('يرجى كتابة سبب رد السداد');
          const res = await tx.paymentRequest.updateMany({
            where: { id, status: { in: [...PAYMENT_OPEN_STATUSES] } },
            data: { status: PAYMENT_STATUS.RETURNED, returnReason },
          });
          if (res.count === 0) throw conflict('لا يمكن رد السداد: تم سداده أو رده مسبقاً');
          await logAudit(
            {
              userId: user.id,
              action: 'REJECT',
              entityType: 'PaymentRequest',
              entityId: id,
              details: { status: PAYMENT_STATUS.RETURNED, returnReason },
              ipAddress,
            },
            tx,
          );
        } else {
          // Plain field edits (no status change).
          const financial = definedOnly({
            title: body.title,
            reason: body.reason,
            amount: body.amount !== undefined ? roundMoney(body.amount) : undefined,
            accountNumber: body.accountNumber,
          });
          const data: Prisma.PaymentRequestUpdateManyMutationInput = {
            ...financial,
            ...definedOnly({ receiptUrl: body.receiptUrl, returnReason: body.returnReason }),
          };
          if (Object.keys(data).length === 0) throw badRequest('لا توجد بيانات للتحديث');

          const where: Prisma.PaymentRequestWhereInput = { id };
          if (Object.keys(financial).length > 0) {
            // Amount / payee changes after approval would bypass the owner's approval.
            where.status = { in: [...EDITABLE_STATUSES] };
          }
          const res = await tx.paymentRequest.updateMany({ where, data });
          if (res.count === 0) throw conflict('لا يمكن تعديل بيانات السداد بعد اعتماده أو سداده');
          await logAudit(
            { userId: user.id, action: 'UPDATE', entityType: 'PaymentRequest', entityId: id, details: data, ipAddress },
            tx,
          );
        }

        return tx.paymentRequest.findUniqueOrThrow({ where: { id } });
      },
      { timeout: 20_000 },
    );

    return NextResponse.json(payment);
  } catch (err) {
    return handleApiError(err, 'payments/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(PAYMENTS_ACCESS);
    const { id } = await params;

    const current = await prisma.paymentRequest.findUnique({
      where: { id },
      select: { id: true, title: true, amount: true, status: true, entityType: true, entityId: true },
    });
    if (!current) throw notFound('طلب السداد غير موجود');
    // Paid requests and requests linked to a visa / settlement / loan are never deleted.
    const blocked = paymentDeleteBlockReason(current);
    if (blocked) throw conflict(blocked);

    // Guarded delete: fails if the request was paid in the meantime (or got linked).
    const res = await prisma.paymentRequest.deleteMany({
      where: {
        id,
        status: { in: [...PAYMENT_OPEN_STATUSES, PAYMENT_STATUS.RETURNED] },
        OR: [{ entityType: null }, { entityType: { notIn: [...LINKED_PAYMENT_ENTITY_TYPES] } }],
      },
    });
    if (res.count === 0) throw conflict('لا يمكن حذف طلب سداد تم صرفه');

    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'PaymentRequest',
      entityId: id,
      details: current,
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حذف طلب السداد' });
  } catch (err) {
    return handleApiError(err, 'payments/[id]:DELETE');
  }
}

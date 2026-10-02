import { randomUUID } from 'crypto';
import { after, NextResponse } from 'next/server';
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
import { suggestExitDocumentsQuietly } from '@/lib/documents/service';
import { settlementPaymentProofSchema } from '@/lib/settlement-payment';
import {
  LINKED_PAYMENT_ENTITY_TYPES,
  PAYMENTS_ACCESS,
  PAYMENT_OPEN_STATUSES,
  PAYMENT_STATUS,
  paymentDeleteBlockReason,
} from '../access';
import { paymentCompanies, paymentInScope } from '../scope';
import { authz, resolveActor, scopedContext } from '@/modules/iam';
import { deletePaymentRequest, editPaymentRequest, payPaymentRequest, returnPaymentRequest } from '@/modules/finance';
import { runPayrollTransaction } from '@/modules/payroll';
import { moneyActorOf } from '@/modules/platform';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * P1-SCOPE: the request must belong to the user's companies (company of the linked record, ../scope.ts);
 * otherwise it is "not found" and nothing (payment, linked settlement / loan / visa) is touched.
 */
async function assertPaymentInScope(user: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const ctx = scopedContext(await resolveActor(prisma, user));
  authz.assert(ctx, 'payment.manage');
  const row = await prisma.paymentRequest.findUnique({ where: { id }, select: { id: true, entityType: true, entityId: true, requestedById: true } });
  if (!row || !paymentInScope(ctx, row, (await paymentCompanies(prisma, [row])).get(id) ?? null)) throw notFound('طلب السداد غير موجود');
}

const updateSchema = z.object({
  status: z.enum([PAYMENT_STATUS.PAID, PAYMENT_STATUS.RETURNED]).optional(),
  receiptUrl: zOptText(2000),
  returnReason: zOptText(2000),
  title: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().min(1).max(300).optional()),
  reason: zOptText(4000),
  amount: zOptMoney,
  accountNumber: zOptText(1000),
  // Paying a SETTLEMENT: payment proof (method, reference, actual day), required.
  paymentMethod: z.string().optional(),
  paymentReference: z.string().optional(),
  paidAt: z.string().optional(),
});

/** Amount / payee / title change only while PENDING_OWNER or RETURNED (finance.editPaymentRequest). */

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.FINANCE);
    const { id } = await params;
    const body = await parseBody(req, updateSchema);
    const ipAddress = getClientIp(req);
    await assertPaymentInScope(user, id);

    const idem = req.headers.get('idempotency-key')?.trim();
    const key = (act: string) => (idem ? `payment.${act}:k:${user.id}:${idem.slice(0, 100)}` : `payment.${act}:${id}:${user.id}`);
    const actor = moneyActorOf(user);
    const payment = await runPayrollTransaction(
      prisma,
      async (tx) => {
        const current = await tx.paymentRequest.findUnique({ where: { id } });
        if (!current) throw notFound('طلب السداد غير موجود');

        if (body.status === PAYMENT_STATUS.PAID) {
          const receiptUrl = body.receiptUrl ?? current.receiptUrl ?? null;
          if (!receiptUrl) throw badRequest('الرجاء إرفاق صورة السداد أو التحويل');

          // finance.payPaymentRequest behind money.gateway, guarded (a double submit cannot pay twice):
          // the payer is none of the beneficiary, the requester and the approver, for every role
          // (BL-PAY-008: no SUPER_ADMIN / allow_self_approval exception; SINGLE_OPERATOR is recorded).
          await payPaymentRequest(tx, { actor, paymentRequestId: id, receiptUrl, operationKey: key('pay'), ipAddress });

          // Linked entities: apply the same side effects as their own finance screens.
          if (current.entityId && current.entityType === 'SETTLEMENT') {
            const proof = settlementPaymentProofSchema.safeParse(body);
            if (!proof.success) throw badRequest(proof.error.issues[0]?.message ?? 'بيانات إثبات الصرف غير مكتملة');
            await markSettlementPaid(tx, current.entityId, receiptUrl, user, { ipAddress, operationKey: `${key('pay')}:settlement` }, proof.data);
          } else if (current.entityId && current.entityType === 'LOAN') {
            await markLoanTransferred(tx, current.entityId, receiptUrl, user, { ipAddress, operationKey: `${key('pay')}:loan` });
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
              },
              ipAddress,
            },
            tx,
          );
        } else if (body.status === PAYMENT_STATUS.RETURNED) {
          const returnReason = body.returnReason ?? null;
          if (!returnReason) throw badRequest('يرجى كتابة سبب رد السداد');
          await returnPaymentRequest(tx, { actor, paymentRequestId: id, reason: returnReason, from: [...PAYMENT_OPEN_STATUSES], operationKey: key('return'), ipAddress });
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

          // finance.editPaymentRequest: amount / payee changes only before the owner's approval
          // (PENDING_OWNER / RETURNED), which would otherwise be bypassed.
          await editPaymentRequest(tx, {
            actor,
            paymentRequestId: id,
            fields: {
              title: body.title,
              reason: body.reason,
              amount: body.amount,
              accountNumber: body.accountNumber,
              receiptUrl: body.receiptUrl,
              returnReason: body.returnReason,
            },
            operationKey: idem ? key('edit') : `payment.edit:${id}:${user.id}:${randomUUID()}`,
            ipAddress,
          });
          await logAudit(
            { userId: user.id, action: 'UPDATE', entityType: 'PaymentRequest', entityId: id, details: data, ipAddress },
            tx,
          );
        }

        return tx.paymentRequest.findUniqueOrThrow({ where: { id } });
      },
      { timeoutMs: 20_000 },
    );

    // A paid end-of-service settlement suggests its clearance / experience letters (after commit, best effort).
    if (body.status === PAYMENT_STATUS.PAID && payment.entityType === 'SETTLEMENT' && payment.entityId) {
      const settlementId = payment.entityId;
      after(() => suggestExitDocumentsQuietly(settlementId));
    }

    return NextResponse.json(payment);
  } catch (err) {
    return handleApiError(err, 'payments/[id]:PUT');
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(PAYMENTS_ACCESS);
    const { id } = await params;
    await assertPaymentInScope(user, id);

    const current = await prisma.paymentRequest.findUnique({
      where: { id },
      select: { id: true, title: true, amount: true, status: true, entityType: true, entityId: true },
    });
    if (!current) throw notFound('طلب السداد غير موجود');
    // Paid requests and requests linked to a visa / settlement / loan are never deleted.
    const blocked = paymentDeleteBlockReason(current);
    if (blocked) throw conflict(blocked);

    // finance.deletePaymentRequest, guarded: fails if the request was paid in the meantime (or got linked).
    await runPayrollTransaction(prisma, (tx) =>
      deletePaymentRequest(tx, { actor: moneyActorOf(user), paymentRequestId: id, linkedEntityTypes: LINKED_PAYMENT_ENTITY_TYPES, operationKey: `payment.delete:${id}:${user.id}` }),
    );

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

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma, VisaStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptDate, zOptText, zText } from '@/lib/validation';
import { dateKey } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import { logAudit, type AuditEntry } from '@/lib/audit';
import { getExitReentryVisaFee } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

/** Visas are handled by HR and government relations (GOV includes HR_MANAGER). */
const VISA_ROLES = [...new Set([...ROLE_GROUPS.GOV, ...ROLE_GROUPS.HR])];

const EXIT_REENTRY_VISA_TYPE = 'خروج وعودة';

/** Allowed previous statuses for each target status. */
const ALLOWED_FROM: Record<'PAID' | 'ISSUED', VisaStatus[]> = {
  PAID: ['PENDING_PAYMENT'],
  ISSUED: ['PENDING_PAYMENT', 'PAID'],
};

/** Payment requests that are still open or were settled (i.e. not returned / cancelled). */
const LIVE_PAYMENT_STATUSES = ['PENDING_OWNER', 'PENDING_FINANCE', 'PAID', 'COMPLETED'] as const;

const employeeSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  nationality: true,
  branch: { select: { nameArabic: true } },
} as const;

const envelopeSchema = z
  .object({
    visaId: zId,
    action: z.string().optional(),
  })
  .passthrough();

const bookTicketSchema = z.object({
  airline: zText(200),
  bookingRef: zText(100),
  flightFrom: zOptText(200),
  flightTo: zOptText(200),
  departureDate: zOptDate,
  returnDate: zOptDate,
  ticketAttachmentUrl: zOptText(2000),
});

const statusSchema = z.object({
  newStatus: z.enum(['PAID', 'ISSUED'], { errorMap: () => ({ message: 'البيانات غير مكتملة' }) }),
  attachmentUrl: zOptText(2000),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(VISA_ROLES);
    const body = await parseBody(req, envelopeSchema);
    const { visaId } = body;
    const ipAddress = getClientIp(req);

    // Flight ticket booking
    if (body.action === 'BOOK_TICKET') {
      const t = bookTicketSchema.parse(body);
      if (t.departureDate && t.returnDate && t.returnDate < t.departureDate) {
        throw badRequest('تاريخ العودة يجب أن يكون بعد تاريخ المغادرة');
      }
      // A cancelled visa (its leave was cancelled) gets no ticket.
      const res = await prisma.visa.updateMany({
        where: { id: visaId, status: { not: 'CANCELLED' } },
        data: {
          ticketStatus: 'BOOKED',
          airline: t.airline,
          bookingRef: t.bookingRef,
          flightFrom: t.flightFrom ?? null,
          flightTo: t.flightTo ?? null,
          departureDate: t.departureDate ?? null,
          returnDate: t.returnDate ?? null,
          ticketAttachmentUrl: t.ticketAttachmentUrl ?? null,
        },
      });
      if (res.count === 0) {
        const exists = await prisma.visa.findUnique({ where: { id: visaId }, select: { id: true } });
        if (!exists) throw notFound('التأشيرة غير موجودة');
        throw conflict('لا يمكن حجز تذكرة لتأشيرة ملغاة');
      }
      const updated = await prisma.visa.findUniqueOrThrow({
        where: { id: visaId },
        include: { employee: { select: employeeSelect } },
      });
      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Visa',
        entityId: visaId,
        details: {
          ticketStatus: 'BOOKED',
          airline: t.airline,
          bookingRef: t.bookingRef,
          departureDate: dateKey(t.departureDate ?? null),
          returnDate: dateKey(t.returnDate ?? null),
        },
        ipAddress,
      });
      return NextResponse.json({ message: 'تم حفظ بيانات الحجز بنجاح', visa: updated });
    }

    if (body.action !== undefined && body.action !== '' && body.action !== 'UPDATE_STATUS') {
      throw badRequest('إجراء غير معروف');
    }

    // Visa status update (payment / issuance)
    const { newStatus, attachmentUrl } = statusSchema.parse(body);
    if (newStatus === 'ISSUED' && !attachmentUrl) {
      throw badRequest('لا يمكن الإصدار إلا بارفاق التأشيرة');
    }
    if (newStatus === 'ISSUED') {
      // A Muqeem issuance whose outcome is not settled yet may have issued a real visa: recording a
      // manual issue now would hide it. It must be reconciled first (visas page).
      const open = await prisma.muqeemTransaction.findFirst({
        where: { entityType: 'VISA', entityId: visaId, operation: 'EXIT_REENTRY_ISSUE', status: { in: ['PENDING', 'UNKNOWN'] } },
        select: { id: true, status: true },
      });
      if (open) {
        throw conflict(
          'يوجد طلب إصدار لهذه التأشيرة عبر مقيم لم تُحسم نتيجته بعد. تحقق من مقيم وقم بتسوية العملية من شاشة التأشيرات قبل تسجيل إصدار يدوي.',
          { muqeemTransactionId: open.id, status: open.status },
        );
      }
    }

    const { visa, audits } = await prisma.$transaction(async (tx) => {
      const res = await tx.visa.updateMany({
        where: { id: visaId, status: { in: ALLOWED_FROM[newStatus] } },
        data: { status: newStatus, ...(attachmentUrl ? { attachmentUrl } : {}) },
      });
      if (res.count === 0) {
        const exists = await tx.visa.findUnique({ where: { id: visaId }, select: { status: true } });
        if (!exists) throw notFound('التأشيرة غير موجودة');
        if (exists.status === 'CANCELLED') throw conflict('هذه التأشيرة ملغاة ولا يمكن سدادها أو إصدارها');
        throw conflict(exists.status === 'ISSUED' ? 'تم إصدار هذه التأشيرة مسبقاً' : 'لا يمكن تغيير حالة التأشيرة من حالتها الحالية');
      }

      const updatedVisa = await tx.visa.findUniqueOrThrow({
        where: { id: visaId },
        include: { employee: { select: employeeSelect } },
      });

      const entries: AuditEntry[] = [
        {
          userId: user.id,
          action: newStatus === 'ISSUED' ? 'APPROVE' : 'UPDATE',
          entityType: 'Visa',
          entityId: visaId,
          details: { status: newStatus, attachmentUrl: attachmentUrl ?? null },
          ipAddress,
        },
      ];

      // Visa fees go to finance as a PENDING payment request (unless one is already open/settled,
      // e.g. the request opened automatically when the related leave was approved).
      if (newStatus === 'ISSUED') {
        const payment = await openVisaPaymentRequest(tx, updatedVisa, user.id);
        if (payment) {
          entries.push({
            userId: user.id,
            action: 'CREATE',
            entityType: 'PaymentRequest',
            entityId: payment.id,
            details: { entityType: 'VISA', entityId: visaId, amount: payment.amount },
            ipAddress,
          });
        }
      }

      return { visa: updatedVisa, audits: entries };
    });

    await Promise.all(audits.map((a) => logAudit(a)));

    return NextResponse.json({ message: 'تم تحديث حالة التأشيرة بنجاح', visa });
  } catch (err) {
    return handleApiError(err, 'visas/action:POST');
  }
}

async function openVisaPaymentRequest(
  tx: Prisma.TransactionClient,
  visa: { id: string; visaType: string; employee: { firstNameArabic: string | null; lastNameArabic: string | null } },
  /** The user whose action created the fee request (maker-checker). */
  requestedById: string,
): Promise<{ id: string; amount: number } | null> {
  const existing = await tx.paymentRequest.findFirst({
    where: { entityType: 'VISA', entityId: visa.id, status: { in: [...LIVE_PAYMENT_STATUSES] } },
    select: { id: true },
  });
  if (existing) return null;

  const fee = visa.visaType === EXIT_REENTRY_VISA_TYPE ? roundMoney(await getExitReentryVisaFee(tx)) : 0;
  if (!(fee > 0)) return null;

  const employeeName = `${visa.employee.firstNameArabic ?? ''} ${visa.employee.lastNameArabic ?? ''}`.trim();
  return tx.paymentRequest.create({
    data: {
      title: `رسوم تأشيرة (${visa.visaType}) - الموظف ${employeeName}`,
      reason: 'رسوم تأشيرة صادرة من النظام بانتظار السداد من الإدارة المالية',
      amount: fee,
      accountNumber: 'سداد - مدفوعات حكومية (تأشيرات)',
      status: 'PENDING_FINANCE',
      requestedById,
      entityType: 'VISA',
      entityId: visa.id,
    },
    select: { id: true, amount: true },
  });
}

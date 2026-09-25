import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zOptDate, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const NOTE_STATUS = { ACTIVE: 'ACTIVE', PAID: 'PAID', CANCELLED: 'CANCELLED' } as const;
type NoteStatus = (typeof NOTE_STATUS)[keyof typeof NOTE_STATUS];

/** Allowed previous statuses for each target status. */
const ALLOWED_FROM: Record<NoteStatus, NoteStatus[]> = {
  PAID: [NOTE_STATUS.ACTIVE],
  CANCELLED: [NOTE_STATUS.ACTIVE],
  ACTIVE: [NOTE_STATUS.CANCELLED],
};

const patchSchema = z.object({
  status: z.enum([NOTE_STATUS.ACTIVE, NOTE_STATUS.PAID, NOTE_STATUS.CANCELLED], {
    errorMap: () => ({ message: 'حالة السند غير صالحة' }),
  }),
  paymentAttachment: zOptText(2000),
  paymentDate: zOptDate,
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const { id } = await params;
    const { status, paymentAttachment, paymentDate } = await parseBody(req, patchSchema);

    const data: Prisma.PromissoryNoteUpdateManyMutationInput = { status };
    if (status === NOTE_STATUS.PAID) {
      if (!paymentAttachment || !paymentDate) {
        throw badRequest('يجب إرفاق إيصال التحويل وتاريخ استلام المبلغ');
      }
      data.paymentAttachment = paymentAttachment;
      data.paymentDate = paymentDate;
    }

    await prisma.$transaction(async (tx) => {
      const res = await tx.promissoryNote.updateMany({
        where: { id, status: { in: ALLOWED_FROM[status] } },
        data,
      });
      if (res.count === 0) {
        const exists = await tx.promissoryNote.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw notFound('السند غير موجود');
        throw conflict('لا يمكن تغيير حالة السند من حالته الحالية');
      }
    });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'PromissoryNote',
      entityId: id,
      details: { status, paymentDate: data.paymentDate ?? null },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم تحديث حالة السند بنجاح.' });
  } catch (err) {
    return handleApiError(err, 'legal/promissory-notes/[id]:PATCH');
  }
}

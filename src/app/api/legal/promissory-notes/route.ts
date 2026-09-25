import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zBool, zMoney, zOptDate, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  amount: zMoney.refine((n) => n > 0, 'مبلغ السند يجب أن يكون أكبر من صفر'),
  creditorName: zText(300),
  debtorName: zText(300),
  companyRole: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(['CREDITOR', 'DEBTOR']).default('CREDITOR')),
  isOnDemand: z.preprocess((v) => (v === '' || v === null ? undefined : v), zBool.optional()),
  dueDate: zOptDate,
  notes: zOptText(5000),
  idAttachment: zOptText(2000),
  noteAttachment: zOptText(2000),
  otherAttachment: zOptText(2000),
});

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.LEGAL);
    const notes = await prisma.promissoryNote.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(notes);
  } catch (err) {
    return handleApiError(err, 'legal/promissory-notes:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const data = await parseBody(req, createSchema);
    const isOnDemand = data.isOnDemand ?? false;

    const createdNote = await prisma.promissoryNote.create({
      data: {
        amount: roundMoney(data.amount),
        creditorName: data.creditorName,
        debtorName: data.debtorName,
        companyRole: data.companyRole,
        isOnDemand,
        dueDate: isOnDemand ? null : (data.dueDate ?? null),
        notes: data.notes ?? null,
        idAttachment: data.idAttachment ?? null,
        noteAttachment: data.noteAttachment ?? null,
        otherAttachment: data.otherAttachment ?? null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'PromissoryNote',
      entityId: createdNote.id,
      details: { amount: createdNote.amount, companyRole: createdNote.companyRole, debtorName: createdNote.debtorName },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حفظ السند لأمر وإدراجه بالمحفظة القانونية للمؤسسة', data: createdNote });
  } catch (err) {
    return handleApiError(err, 'legal/promissory-notes:POST');
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zBool, zMoney, zOptDate, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { recordCompanyId } from '@/lib/record-company';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

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
  /** The company party to the note (P1-SCOPE); defaults to the user's only company. */
  companyId: zOptText(100),
});

/** Notes of the user's companies (P1-SCOPE: PromissoryNote.companyId, scoped client). */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.read');
    const notes = await scopedPrisma(ctx).promissoryNote.findMany({
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
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.manage');
    const data = await parseBody(req, createSchema);
    const isOnDemand = data.isOnDemand ?? false;
    const companyId = await recordCompanyId(prisma, ctx, data.companyId);

    const createdNote = await scopedPrisma(ctx).promissoryNote.create({
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
        companyId,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'PromissoryNote',
      entityId: createdNote.id,
      details: { amount: createdNote.amount, companyRole: createdNote.companyRole, debtorName: createdNote.debtorName, companyId },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حفظ السند لأمر وإدراجه بالمحفظة القانونية للمؤسسة', data: createdNote });
  } catch (err) {
    return handleApiError(err, 'legal/promissory-notes:POST');
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { recordCompanyId } from '@/lib/record-company';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const LAWSUIT_STATUS = { REFERRED: 'REFERRED', CLOSED: 'CLOSED' } as const;
const CASE_TYPES = ['LABOR', 'COMMERCIAL', 'REAL_ESTATE', 'OTHER'] as const;

const envelopeSchema = z
  .object({
    actionType: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

const closeSchema = z.object({
  id: zId,
  judgmentAttachment: zOptText(2000),
});

const createSchema = z.object({
  caseType: z.enum(CASE_TYPES, { errorMap: () => ({ message: 'نوع الدعوى غير صالح' }) }),
  plaintiff: zText(300),
  defendant: zText(300),
  subject: zText(5000),
  lawFirmName: zOptText(300),
  lawFirmContact: zOptText(100),
  /** The company party to the case (P1-SCOPE); defaults to the user's only company. */
  companyId: zOptText(100),
});

/** Cases of the user's companies (P1-SCOPE: Lawsuit.companyId, scoped client). */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.read');
    const lawsuits = await scopedPrisma(ctx).lawsuit.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(lawsuits);
  } catch (err) {
    return handleApiError(err, 'legal/lawsuits:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.manage');
    // Scoped client: a case of a company outside the user's scope is "not found" (404).
    const db = scopedPrisma(ctx);
    const body = await parseBody(req, envelopeSchema);
    const ipAddress = getClientIp(req);

    if (body.actionType === 'CLOSE_CASE') {
      const payload = closeSchema.parse(body.payload ?? {});
      if (!payload.judgmentAttachment) throw badRequest('صك الحكم مطلوب لإنهاء الدعوى');

      // One conditional update (atomic): the status guard makes a second close a 409.
      const res = await db.lawsuit.updateMany({
        where: { id: payload.id, status: { not: LAWSUIT_STATUS.CLOSED } },
        data: { status: LAWSUIT_STATUS.CLOSED, judgmentAttachment: payload.judgmentAttachment },
      });
      if (res.count === 0) {
        const exists = await db.lawsuit.findUnique({ where: { id: payload.id }, select: { id: true } });
        if (!exists) throw notFound('الدعوى غير موجودة');
        throw conflict('تم إغلاق هذه الدعوى مسبقاً');
      }
      const updatedCase = await db.lawsuit.findUniqueOrThrow({ where: { id: payload.id } });

      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'Lawsuit',
        entityId: payload.id,
        details: { status: LAWSUIT_STATUS.CLOSED },
        ipAddress,
      });

      return NextResponse.json({ message: 'تم إغلاق القضية والانتهاء منها بنجاح', data: updatedCase });
    }

    if (body.actionType !== undefined && body.actionType !== 'CREATE') {
      throw badRequest('إجراء غير معروف');
    }

    // Default action: create a new lawsuit (always starts as REFERRED).
    const data = createSchema.parse(body);
    const companyId = await recordCompanyId(prisma, ctx, data.companyId);
    const createdLawsuit = await db.lawsuit.create({
      data: {
        caseType: data.caseType,
        plaintiff: data.plaintiff,
        defendant: data.defendant,
        subject: data.subject,
        status: LAWSUIT_STATUS.REFERRED,
        lawFirmName: data.lawFirmName ?? null,
        lawFirmContact: data.lawFirmContact ?? null,
        companyId,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Lawsuit',
      entityId: createdLawsuit.id,
      details: { caseType: createdLawsuit.caseType, plaintiff: createdLawsuit.plaintiff, defendant: createdLawsuit.defendant, companyId },
      ipAddress,
    });

    return NextResponse.json({ message: 'تم تقييد المنازعة وإحالتها للمكتب المفوض', data: createdLawsuit });
  } catch (err) {
    return handleApiError(err, 'legal/lawsuits:POST');
  }
}

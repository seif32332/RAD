import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireDocumentsUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { acknowledgeDocument, createDocumentRequest, revokeIssuedDocument, staffCan } from '@/lib/documents/service';
import { candidateLinkOf } from '@/lib/documents/candidate';
import { getDocumentType, paramsSchema } from '@/lib/documents/types';
import { actorFrom } from '../_shared';

export const dynamic = 'force-dynamic';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('revoke'), reason: z.string().trim().min(3, 'اذكر سبب الإلغاء').max(500) }),
  // Corrections are a new document with a new number; the old one becomes SUPERSEDED (DOC-09).
  z.object({ action: z.literal('reissue') }),
  // HR: the candidate's private link of a job offer (to send it by another channel).
  z.object({ action: z.literal('candidateLink') }),
  // The employee confirms receipt of a warning letter, optionally with his comment.
  z.object({
    action: z.literal('acknowledge'),
    decision: z.enum(['RECEIVED', 'ACCEPTED', 'DISPUTED', 'DECLINED']).optional(),
    comment: z.string().trim().max(2000).optional(),
  }),
]);

/** POST /api/documents/<id> { action: revoke | reissue (staff of the type) | acknowledge (the employee) }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireDocumentsUser();
    const { id } = await params;
    const body = await parseBody(req, actionSchema);
    const actor = actorFrom(user, req);
    if (body.action === 'acknowledge') return NextResponse.json(await acknowledgeDocument(id, { decision: body.decision, comment: body.comment || null }, actor));
    if (user.documentsOnly || !roleIn(user.role, ROLE_GROUPS.STAFF)) throw forbidden();
    if (body.action === 'candidateLink') {
      const doc = await prisma.issuedDocument.findUnique({ where: { id }, select: { typeKey: true, legalCompanyId: true, jobApplicationId: true } });
      const def = doc ? getDocumentType(doc.typeKey) : null;
      if (!doc?.jobApplicationId || !def || !(await staffCan(prisma, def, actor, doc.legalCompanyId))) throw notFound('المستند غير موجود');
      const link = await candidateLinkOf(id);
      if (!link) throw notFound('لا يوجد رابط لهذا المستند');
      return NextResponse.json(link);
    }
    if (body.action === 'revoke') return NextResponse.json(await revokeIssuedDocument(id, body.reason, actor));

    const doc = await prisma.issuedDocument.findUnique({ where: { id }, select: { employeeId: true, jobApplicationId: true, typeKey: true, request: { select: { paramsJson: true } } } });
    if (!doc) throw notFound('المستند غير موجود');
    // Same parameters as the replaced document (including a warning's text); it goes through approval again.
    const { supersedesDocumentId: _old, ...params0 } = JSON.parse(doc.request.paramsJson) as Record<string, unknown>;
    const result = await createDocumentRequest(
      {
        typeKey: doc.typeKey,
        employeeId: doc.employeeId,
        jobApplicationId: doc.jobApplicationId,
        params: paramsSchema.parse(params0),
        source: 'HR',
        supersedesDocumentId: id,
      },
      actor,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'documents/[id]:POST');
  }
}

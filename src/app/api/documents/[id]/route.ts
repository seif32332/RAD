import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { createDocumentRequest, revokeIssuedDocument } from '@/lib/documents/service';
import { actorFrom } from '../_shared';

export const dynamic = 'force-dynamic';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('revoke'), reason: z.string().trim().min(3, 'اذكر سبب الإلغاء').max(500) }),
  // Corrections are a new document with a new number; the old one becomes SUPERSEDED (DOC-09).
  z.object({ action: z.literal('reissue') }),
]);

/** POST /api/documents/<id> { action: revoke | reissue } (staff of the type). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const body = await parseBody(req, actionSchema);
    const actor = actorFrom(user, req);
    if (body.action === 'revoke') return NextResponse.json(await revokeIssuedDocument(id, body.reason, actor));

    const doc = await prisma.issuedDocument.findUnique({ where: { id }, select: { employeeId: true, typeKey: true, request: { select: { paramsJson: true } } } });
    if (!doc) throw notFound('المستند غير موجود');
    const params0 = JSON.parse(doc.request.paramsJson) as Record<string, unknown>;
    const result = await createDocumentRequest(
      {
        typeKey: doc.typeKey,
        employeeId: doc.employeeId,
        params: { language: params0.language, addresseeAr: params0.addresseeAr ?? undefined, addresseeEn: params0.addresseeEn ?? undefined },
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

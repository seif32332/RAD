import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody } from '@/lib/http';
import { documentRequestDetail } from '@/lib/documents/queries';
import {
  approveDocumentRequest, cancelDocumentRequest, rejectDocumentRequest, retryDocumentRequest,
} from '@/lib/documents/service';
import { actorFrom } from '../../_shared';

export const dynamic = 'force-dynamic';

/** GET /api/documents/requests/<id>: detail; approvers see the snapshot they approve (DOC-05). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const { id } = await params;
    const detail = await documentRequestDetail(id, actorFrom(user, req));
    if (!detail) throw notFound('الطلب غير موجود');
    return NextResponse.json(detail);
  } catch (err) {
    return handleApiError(err, 'documents/requests/[id]:GET');
  }
}

const actionSchema = z.discriminatedUnion('action', [
  // The hash of the snapshot the approver was shown: approving anything else is refused.
  z.object({ action: z.literal('approve'), snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal('reject'), reason: z.string().trim().min(3, 'اذكر سبب الرفض').max(500) }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('retry') }),
]);

/** POST /api/documents/requests/<id> { action: approve | reject | cancel | retry } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const { id } = await params;
    const body = await parseBody(req, actionSchema);
    const actor = actorFrom(user, req);
    switch (body.action) {
      case 'approve':
        return NextResponse.json(await approveDocumentRequest(id, body.snapshotSha256, body.note ?? null, actor));
      case 'reject':
        return NextResponse.json(await rejectDocumentRequest(id, body.reason, actor));
      case 'cancel':
        return NextResponse.json(await cancelDocumentRequest(id, actor));
      case 'retry':
        return NextResponse.json(await retryDocumentRequest(id, actor));
    }
  } catch (err) {
    return handleApiError(err, 'documents/requests/[id]:POST');
  }
}

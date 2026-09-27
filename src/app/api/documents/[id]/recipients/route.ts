import { NextResponse } from 'next/server';
import { requireDocumentsUser } from '@/lib/auth';
import { forbidden, handleApiError, notFound } from '@/lib/http';
import { circularRecipientsFor } from '@/lib/documents/queries';
import { actorFrom } from '../../_shared';

export const dynamic = 'force-dynamic';

/** GET /api/documents/<id>/recipients: a circular's recipients and who acknowledged (staff of the type). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireDocumentsUser();
    if (user.documentsOnly) throw forbidden();
    const { id } = await params;
    const rows = await circularRecipientsFor(id, actorFrom(user, req));
    if (!rows) throw notFound('المستند غير موجود');
    return NextResponse.json({ recipients: rows });
  } catch (err) {
    return handleApiError(err, 'documents/[id]/recipients');
  }
}

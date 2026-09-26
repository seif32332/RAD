import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { readIssuedDocument } from '@/lib/documents/service';
import { actorFrom } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/documents/<id>/pdf: the issued PDF (DOC-10). Owner employee or staff of the type; the
 * same 404 otherwise. The bytes are checked against the recorded hash before they are sent, and
 * every download is an event. Never served by /api/files.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const { id } = await params;
    const inline = new URL(req.url).searchParams.get('inline') === '1';
    const { pdf, fileName, sha256 } = await readIssuedDocument(id, actorFrom(user, req));
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fileName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Document-Sha256': sha256,
      },
    });
  } catch (err) {
    return handleApiError(err, 'documents/[id]/pdf');
  }
}

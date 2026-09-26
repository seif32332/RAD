import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { forbidden, handleApiError, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { portalTypesFor, myDocumentRequests, staffDocumentOverview } from '@/lib/documents/queries';
import { createDocumentRequest, processDueRenderJobs } from '@/lib/documents/service';
import { rateLimit } from '@/lib/rate-limit';
import { actorFrom } from '../_shared';

export const dynamic = 'force-dynamic';

/** Picks up render jobs whose retry time has come (the render service was down). Never blocks the response. */
function retryDueJobsLater() {
  after(() => processDueRenderJobs(3).catch((e) => console.error('[documents] due jobs:', e instanceof Error ? e.message : e)));
}

/**
 * GET /api/documents/requests?scope=mine   the logged-in employee's requests + requestable types
 * GET /api/documents/requests?scope=staff  HR queue (types the role may issue), optional &q=
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const url = new URL(req.url);
    const scope = url.searchParams.get('scope') ?? 'mine';
    retryDueJobsLater();
    if (scope === 'staff') {
      const overview = await staffDocumentOverview(actorFrom(user, req), {
        q: url.searchParams.get('q')?.slice(0, 100),
        employeeId: url.searchParams.get('employeeId')?.slice(0, 100) || undefined,
      });
      if (!overview.types.length) throw forbidden();
      return NextResponse.json(overview);
    }
    if (!user.employeeId) return NextResponse.json({ requests: [], types: { available: [], reason: 'لا يوجد ملف موظف مرتبط بحسابك' } });
    const [requests, types] = await Promise.all([myDocumentRequests(user.employeeId), portalTypesFor(user.employeeId)]);
    return NextResponse.json({ requests, types });
  } catch (err) {
    return handleApiError(err, 'documents/requests:GET');
  }
}

const createSchema = z.object({
  typeKey: z.string().trim().min(1).max(64),
  /** HR only: the employee the document is for. Absent = the logged-in employee (portal). */
  employeeId: zId.optional(),
  language: z.enum(['ar', 'ar-en']).default('ar'),
  addresseeAr: z.string().trim().max(120).optional(),
  addresseeEn: z.string().trim().max(120).optional(),
});

/** POST /api/documents/requests: portal self-service or HR issuance. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    // A request can render a PDF: bound the rate per user (10 per 10 minutes).
    if (!rateLimit(`documents:create:${user.id}`, 10, 10 * 60_000).ok) {
      return NextResponse.json({ message: 'عدد كبير من الطلبات؛ حاول بعد قليل', error: 'RATE_LIMITED' }, { status: 429 });
    }
    const body = await parseBody(req, createSchema);
    const forSelf = !body.employeeId || body.employeeId === user.employeeId;
    const employeeId = forSelf ? user.employeeId : body.employeeId!;
    if (!employeeId) throw forbidden('لا يوجد ملف موظف مرتبط بحسابك');
    const result = await createDocumentRequest(
      {
        typeKey: body.typeKey,
        employeeId,
        params: { language: body.language, addresseeAr: body.addresseeAr || undefined, addresseeEn: body.addresseeEn || undefined },
        source: forSelf ? 'PORTAL' : 'HR',
      },
      actorFrom(user, req),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'documents/requests:POST');
  }
}

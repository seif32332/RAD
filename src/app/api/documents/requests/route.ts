import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireDocumentsUser } from '@/lib/auth';
import { forbidden, handleApiError, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { concludedInvestigationsFor, offerCandidatesFor, paidSettlementsFor, portalTypesFor, myDocumentRequests, staffDocumentOverview } from '@/lib/documents/queries';
import { createDocumentRequest, issueDueCommencementNotices, issueDueEvaluationReports, issueDuePayslips, processDueRenderJobs, suggestDueExitDocuments, syncDueLeaveLetters } from '@/lib/documents/service';
import { applyDueChangeOrders } from '@/lib/documents/change-orders';
import { addendumParamsSchema, circularParamsSchema, nocParamsSchema, offerParamsSchema, promotionParamsSchema, terminationNoticeParamsSchema, warningParamsSchema } from '@/lib/documents/types';
import { rateLimit } from '@/lib/rate-limit';
import { actorFrom } from '../_shared';

export const dynamic = 'force-dynamic';

/** Picks up render jobs whose retry time has come (the render service was down). Never blocks the response. */
function retryDueJobsLater() {
  after(() => processDueRenderJobs(3).catch((e) => console.error('[documents] due jobs:', e instanceof Error ? e.message : e)));
}

/** Staff list: also catches up exit-document suggestions of paid settlements (SPEC §13) and missing payslips. */
function suggestExitDocumentsLater() {
  after(async () => {
    await suggestDueExitDocuments().catch((e) => console.error('[documents] exit suggestions:', e instanceof Error ? e.message : e));
    await issueDuePayslips().catch((e) => console.error('[documents] payslips:', e instanceof Error ? e.message : e));
    await applyDueChangeOrders().catch((e) => console.error('[documents] change orders:', e instanceof Error ? e.message : e));
    await syncDueLeaveLetters().catch((e) => console.error('[documents] leave letters:', e instanceof Error ? e.message : e));
    await issueDueEvaluationReports().catch((e) => console.error('[documents] evaluation reports:', e instanceof Error ? e.message : e));
    await issueDueCommencementNotices().catch((e) => console.error('[documents] commencement notices:', e instanceof Error ? e.message : e));
  });
}

/**
 * GET /api/documents/requests?scope=mine   the logged-in employee's requests + requestable types
 * GET /api/documents/requests?scope=staff  HR queue (types the role may issue), optional &q=
 */
export async function GET(req: Request) {
  try {
    const user = await requireDocumentsUser();
    const url = new URL(req.url);
    const scope = url.searchParams.get('scope') ?? 'mine';
    // A leaver's documents-only session sees his own documents, nothing else.
    if (user.documentsOnly && scope !== 'mine') throw forbidden();
    retryDueJobsLater();
    if (scope === 'settlements') {
      // Issue form of a settlement statement: the employee's paid settlements.
      const list = await paidSettlementsFor(actorFrom(user, req), url.searchParams.get('employeeId')?.slice(0, 100) ?? '');
      if (!list) throw forbidden();
      return NextResponse.json({ settlements: list });
    }
    if (scope === 'candidates') {
      // Issue form of a job offer: open applications and the legal companies within the actor's scope.
      const list = await offerCandidatesFor(actorFrom(user, req));
      if (!list) throw forbidden();
      return NextResponse.json(list);
    }
    if (scope === 'investigations') {
      // Issue form of an Article 80 termination notice: the employee's concluded investigations.
      const list = await concludedInvestigationsFor(actorFrom(user, req), url.searchParams.get('employeeId')?.slice(0, 100) ?? '');
      if (!list) throw forbidden();
      return NextResponse.json({ investigations: list });
    }
    if (scope === 'staff') {
      suggestExitDocumentsLater();
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
  /** WARNING_LETTER: the text HR wrote. */
  warning: warningParamsSchema.optional(),
  /** SETTLEMENT_STATEMENT: the settlement it states. */
  settlementId: z.string().trim().min(1).max(64).optional(),
  /** TERMINATION_NOTICE: the company's decision. */
  terminationNotice: terminationNoticeParamsSchema.optional(),
  /** NO_OBJECTION: purpose and destination. */
  noc: nocParamsSchema.optional(),
  /** PROMOTION_DECISION: the change it orders. */
  promotion: promotionParamsSchema.optional(),
  addendum: addendumParamsSchema.optional(),
  commencement: z.object({ kind: z.enum(['JOIN', 'RETURN']), leaveId: z.string().trim().min(1).max(64).optional() }).optional(),
  /** ADMIN_CIRCULAR: a company document to a group of employees (no employeeId). */
  circular: circularParamsSchema.optional(),
  /** JOB_OFFER: the application (instead of employeeId) and the offer's terms. */
  jobApplicationId: zId.optional(),
  offer: offerParamsSchema.optional(),
});

/** POST /api/documents/requests: portal self-service or HR issuance. */
export async function POST(req: Request) {
  try {
    const user = await requireDocumentsUser();
    // A request can render a PDF: bound the rate per user (10 per 10 minutes).
    if (!rateLimit(`documents:create:${user.id}`, 10, 10 * 60_000).ok) {
      return NextResponse.json({ message: 'عدد كبير من الطلبات؛ حاول بعد قليل', error: 'RATE_LIMITED' }, { status: 429 });
    }
    const body = await parseBody(req, createSchema);
    // A circular / administrative decision is the company's (HR only), to a group of employees.
    if (body.circular) {
      if (user.documentsOnly) throw forbidden();
      const result = await createDocumentRequest(
        { typeKey: body.typeKey, params: { language: body.language, circular: body.circular }, source: 'HR' },
        actorFrom(user, req),
      );
      return NextResponse.json(result, { status: 201 });
    }
    // A job offer goes to a candidate (HR only), not to an employee.
    if (body.jobApplicationId) {
      if (user.documentsOnly) throw forbidden();
      const result = await createDocumentRequest(
        { typeKey: body.typeKey, jobApplicationId: body.jobApplicationId, params: { language: body.language, offer: body.offer }, source: 'HR' },
        actorFrom(user, req),
      );
      return NextResponse.json(result, { status: 201 });
    }
    const forSelf = !body.employeeId || body.employeeId === user.employeeId;
    if (user.documentsOnly && !forSelf) throw forbidden();
    const employeeId = forSelf ? user.employeeId : body.employeeId!;
    if (!employeeId) throw forbidden('لا يوجد ملف موظف مرتبط بحسابك');
    const result = await createDocumentRequest(
      {
        typeKey: body.typeKey,
        employeeId,
        params: { language: body.language, addresseeAr: body.addresseeAr || undefined, addresseeEn: body.addresseeEn || undefined, warning: body.warning, settlementId: body.settlementId, terminationNotice: body.terminationNotice, noc: body.noc, promotion: body.promotion, addendum: body.addendum, commencement: body.commencement },
        source: forSelf ? 'PORTAL' : 'HR',
      },
      actorFrom(user, req),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'documents/requests:POST');
  }
}

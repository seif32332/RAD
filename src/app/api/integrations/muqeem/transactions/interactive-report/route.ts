import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { prisma } from '@/lib/prisma';
import { HttpError, badRequest, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { daysBetween } from '@/lib/dates';
import { createMuqeemClient, toApiError } from '@/lib/muqeem';

export const dynamic = 'force-dynamic';

const MAX_RANGE_DAYS = 31;
const zYmd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD');

const BodySchema = z.object({
  companyId: zId,
  fromDate: zYmd,
  toDate: zYmd,
  /** Muqeem's `operatorId` (^[1-2][0-9]{9}$): the ID number of the Muqeem user who made the requests. */
  operatorId: z.string().trim().regex(/^[12]\d{9}$/, 'رقم هوية المشغل يجب أن يتكون من 10 أرقام ويبدأ بـ 1 أو 2'),
});

/**
 * POST /api/integrations/muqeem/transactions/interactive-report { companyId, fromDate, toDate, operatorId }
 * (ROLE_GROUPS.GOV). READ-ONLY: Muqeem's interactive services report (every request made on Muqeem
 * for the establishment) for up to 31 days, to decide how to reconcile UNKNOWN transactions.
 * Audited as VIEW. 200 { rows: InteractiveServicesReportRow[], count }
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const limit = rateLimit(`muqeem-interactive-report:${user.id}`, 20, 10 * 60_000);
    if (!limit.ok) throw new HttpError(429, 'تم تجاوز عدد مرات عرض التقرير المسموح بها، حاول بعد بضع دقائق');
    const body = await parseBody(req, BodySchema);
    const span = daysBetween(body.fromDate, body.toDate);
    if (Number.isNaN(span) || span < 0) throw badRequest('تاريخ البداية يجب أن يسبق تاريخ النهاية');
    if (span > MAX_RANGE_DAYS - 1) throw badRequest(`الحد الأقصى للفترة ${MAX_RANGE_DAYS} يوماً`);
    const company = await prisma.company.findUnique({ where: { id: body.companyId }, select: { id: true } });
    if (!company) throw notFound('الشركة غير موجودة');

    const client = await createMuqeemClient({ companyId: body.companyId });
    const rows = await client.getInteractiveServicesReport({ fromDate: body.fromDate, toDate: body.toDate, operatorId: body.operatorId });

    await logAudit({
      userId: user.id,
      action: 'VIEW',
      entityType: 'Company',
      entityId: body.companyId,
      details: { muqeemOperation: 'INTERACTIVE_SERVICES_REPORT', fromDate: body.fromDate, toDate: body.toDate, count: rows.length },
      ipAddress: getClientIp(req),
    });

    const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    return NextResponse.json({
      rows: rows.map((r) => ({
        date: text(r.date),
        type: text(r.type),
        description: text(r.description),
        iqamaNumber: text(r.iqamaNumber),
        requestNumber: text(r.requestNumber),
        errorMessage: text(r.errorMessage),
        user: text(r.user),
        company: text(r.company),
      })),
      count: rows.length,
    });
  } catch (err) {
    return handleApiError(toApiError(err), 'integrations/muqeem/transactions/interactive-report:POST');
  }
}

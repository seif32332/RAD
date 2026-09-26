// GET /api/portal/total-rewards/pdf?year=YYYY — the logged-in employee's OWN «بيان المكافآت الشاملة» as a PDF
// (SPEC §9.2 / §11). Same rules as GET /api/portal/total-rewards, whose handler produces the view: the employee
// comes from the session only (any other parameter -> 400), hidden unless the owner enabled the statement
// (TOTAL_REWARDS_ENABLED: 403 here, since there is nothing to print). Internal document (footer says so); 503
// when the report service is not configured; 6 PDFs per minute; one EXPORT audit row per PDF.
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { forbidden, handleApiError, jsonError } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { buildTotalRewardsReport, reportServiceConfigured, type TotalRewardsReportView } from '@/lib/workforce/report-pdf';
import { GET as portalTotalRewardsGET } from '../route';
import { calculationTime, companyName, innerRequest, limitPdf, pdfResponse, renderErrorResponse, viewJson } from '@/app/api/workforce/report/_lib';

export const dynamic = 'force-dynamic';

const PORTAL_NOT_CONFIGURED = 'تنزيل PDF غير متاح حالياً: خدمة التقارير غير مهيأة. يمكنك طباعة البيان من زر «طباعة».';

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    // Employees have no Excel export: their own wording (the statement can still be printed from the page).
    if (!reportServiceConfigured()) return jsonError(503, PORTAL_NOT_CONFIGURED, { code: 'REPORT_SERVICE_NOT_CONFIGURED' });
    limitPdf(user, 'portal-total-rewards');
    const search = new URL(req.url).search;
    const r = await viewJson<({ enabled: false; message: string }) | ({ enabled: true } & TotalRewardsReportView)>(await portalTotalRewardsGET(innerRequest(req, `/api/portal/total-rewards${search}`)));
    if (!r.ok) return r.res;
    if (!r.body.enabled) throw forbidden('بيان المكافآت الشاملة غير مفعّل في منشأتك');
    const statement = r.body.statement;
    if (statement.employee.id !== employeeId) throw forbidden();
    const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { legalCompanyId: true, actualCompanyId: true } });
    const brandId = emp?.legalCompanyId || emp?.actualCompanyId || null;
    const model = buildTotalRewardsReport({ statement }, 'EMPLOYEE');
    return await pdfResponse({
      req,
      user,
      model,
      brandCompanyId: brandId,
      brandCompanyName: statement.employee.companyName ?? (await companyName(brandId)),
      multiCompany: false,
      generatedAt: calculationTime(),
      entityType: 'PortalTotalRewardsPdf',
      entityId: employeeId,
      ip: getClientIp(req),
    });
  } catch (err) {
    return renderErrorResponse(err) ?? handleApiError(err, 'portal:total-rewards:pdf:GET');
  }
}

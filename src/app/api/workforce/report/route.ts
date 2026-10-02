// Internal PDF reports of «محرك القرارات» (SPEC §11 «تقارير PDF»), rendered by radeef-render. INTERNAL planning
// reports: no number, no QR, no IssuedDocument; every page says so. Same roles as the views (WORKFORCE).
//
// GET  ?kind=true-cost&months=12|24|36&scenario&companyId?(letterhead)&employeeId?(adds that employee's months)
// GET  ?kind=saudization&companyId?&date?&targetBand?&byDate?   (targetBand needs companyId: adds the solver)
// GET  ?kind=plan&planId&live?&asOf?                            (projection, items, plan vs actual, approvals)
// GET  ?kind=total-rewards&employeeId&year?                     (HR view of one employee's statement)
// POST ?kind=exit-cost      body = POST /api/workforce/exit-cost body
// POST ?kind=saudization&date?  body = POST /api/workforce/saudization/solve body (the company's report + solver)
// POST ?kind=hire-scenario  body = POST /api/workforce/hire-scenario body
// POST ?kind=sensitivity    body = POST /api/workforce/sensitivity body ({decision: hire|exit|plan, …})
// GET  ?kind=sensitivity&decision=plan&planId                 («حساسية القرار» of a plan)
// -> application/pdf (filename ASCII + filename* Arabic). 503 «خدمة التقارير غير مهيأة» when RENDER_SERVICE_URL /
// RENDER_SERVICE_TOKEN are missing (checked before any computation), 503 when the service is down (retry), 422
// with the renderer's code for input it refuses. 6 PDFs per user per minute; one EXPORT audit row per PDF.
import { z } from 'zod';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseQuery } from '@/lib/http';
import { zId } from '@/lib/validation';
import {
  buildExitCostReport,
  buildHireScenarioReport,
  buildPlanReport,
  buildSensitivityReport,
  buildSaudizationReport,
  buildTotalRewardsReport,
  buildTrueCostReport,
  type EvidenceLike,
  type ExitCostReportView,
  type HireScenarioReportView,
  type PlanReportView,
  type SaudizationReportView,
  type SensitivityReportView,
  type TotalRewardsReportView,
  type TrueCostReportView,
  UNSPECIFIED_COMPANY_LABEL,
} from '@/lib/workforce/report-pdf';
import { prisma } from '@/lib/prisma';
import { NO_COMPANY_ID } from '@/lib/workforce/true-cost';
import { zHorizon, zScenario } from '../_lib/schemas';
import { employeeDetail, limitOrThrow, runOverview, runTrueCost } from '../_lib/server';
import { assertCompanyVisible, workforceScope } from '../_lib/scope';
import { GET as saudizationGET } from '../saudization/route';
import { POST as solvePOST } from '../saudization/solve/route';
import { POST as exitCostPOST } from '../exit-cost/route';
import { POST as hireScenarioPOST } from '../hire-scenario/route';
import { GET as planGET } from '../plans/[id]/route';
import { GET as planActualGET } from '../plans/[id]/actual/route';
import { GET as totalRewardsGET } from '../total-rewards/route';
import { GET as sensitivityGET, POST as sensitivityPOST } from '../sensitivity/route';
import {
  assertConfigured,
  calculationTime,
  companyName,
  innerRequest,
  limitPdf,
  pdfResponse,
  qs,
  renderErrorResponse,
  viewForRole,
  viewJson,
} from './_lib';

export const dynamic = 'force-dynamic';

const GET_KINDS = ['true-cost', 'saudization', 'plan', 'total-rewards', 'sensitivity'] as const;
const POST_KINDS = ['exit-cost', 'hire-scenario', 'sensitivity', 'saudization'] as const;
const opt = (v: unknown) => (v === '' || v === null ? undefined : v);

const kindSchema = (kinds: readonly [string, ...string[]]) =>
  z.object({ kind: z.enum(kinds as [string, ...string[]], { errorMap: () => ({ message: `نوع التقرير غير صالح (المتاح: ${kinds.join('، ')})` }) }) }).passthrough();

const trueCostSchema = z.object({
  kind: z.literal('true-cost'),
  months: zHorizon,
  scenario: zScenario,
  companyId: z.preprocess(opt, zId.optional()),
  employeeId: z.preprocess(opt, zId.optional()),
}).strict();

const saudizationSchema = z.object({
  kind: z.literal('saudization'),
  companyId: z.preprocess(opt, zId.optional()),
  date: z.preprocess(opt, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD').optional()),
  targetBand: z.preprocess(opt, z.string().max(20).optional()),
  byDate: z.preprocess(opt, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ الوصول بصيغة YYYY-MM-DD').optional()),
}).strict();

const planSchema = z.object({
  kind: z.literal('plan'),
  planId: zId,
  live: z.preprocess((v) => v === '1' || v === 'true', z.boolean()),
  asOf: z.preprocess(opt, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD').optional()),
}).strict();

const totalRewardsSchema = z.object({
  kind: z.literal('total-rewards'),
  employeeId: zId,
  year: z.preprocess(opt, z.string().regex(/^\d{4}$/, 'السنة غير صالحة').optional()),
}).strict();

const postQuerySchema = z.object({
  kind: z.enum(POST_KINDS, { errorMap: () => ({ message: `نوع التقرير غير صالح (المتاح: ${POST_KINDS.join('، ')})` }) }),
  date: z.preprocess(opt, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD').optional()),
}).strict();

/** «تقرير السعودة»: the saudization view (one company or all) and, with a solve body, the solver's view. */
async function saudizationPdf(
  req: Request,
  user: Pick<AuthUser, 'id' | 'role'>,
  q: { companyId?: string; date?: string },
  solveBody: unknown,
  generatedAt: Date,
  ip: string | null,
): Promise<Response> {
  const s = await viewJson<SaudizationReportView>(await saudizationGET(innerRequest(req, `/api/workforce/saudization${qs({ companyId: q.companyId, date: q.date })}`)));
  if (!s.ok) return s.res;
  let solve: SaudizationReportView['solve'] = null;
  if (solveBody) {
    const r = await viewJson<NonNullable<SaudizationReportView['solve']>>(await solvePOST(innerRequest(req, '/api/workforce/saudization/solve', solveBody)));
    if (!r.ok) return r.res;
    solve = r.body;
  }
  const view = viewForRole({ ...s.body, solve }, user.role);
  const brandId = q.companyId ?? view.companies[0]?.companyId ?? null;
  const model = buildSaudizationReport(view);
  model.scope = { ...model.scope, companyId: q.companyId ?? null };
  return pdfResponse({ req, user, model, brandCompanyId: brandId, brandCompanyName: view.companies.find((c) => c.companyId === brandId)?.companyName ?? null, multiCompany: !q.companyId && view.companies.length > 1, generatedAt, entityType: 'WorkforceReportPdf', entityId: q.companyId ?? null, ip });
}

/**
 * Letterhead company of a multi-company view: the selected one, else the first REAL legal company (the
 * placeholder group of employees without a legal company, NO_COMPANY_ID, is never a letterhead). When the view
 * only has that placeholder: no company (default branding) and the name «عدة شركات/غير محدد».
 */
function letterhead(companies: ReadonlyArray<{ companyId: string; name: string }>, selectedId: string | null | undefined): { id: string | null; name: string | null } {
  if (selectedId) return { id: selectedId, name: companies.find((c) => c.companyId === selectedId)?.name ?? null };
  const real = companies.find((c) => c.companyId && c.companyId !== NO_COMPANY_ID);
  if (real) return { id: real.companyId, name: real.name };
  return { id: null, name: companies.length ? UNSPECIFIED_COMPANY_LABEL : null };
}

const sensitivityQuerySchema = z.object({
  kind: z.literal('sensitivity'),
  decision: z.literal('plan', { errorMap: () => ({ message: 'حساسية التوظيف والإنهاء تُطلب بـ POST مع بيانات القرار' }) }),
  planId: zId,
}).strict();

/** Letterhead of a sensitivity report: the hire's company, the leaver's legal company, or the plan's company. */
async function sensitivityPdf(
  req: Request,
  user: Pick<AuthUser, 'id' | 'role'>,
  view: SensitivityReportView,
  subject: { decision?: string; planId?: string; companyId?: string; employeeId?: string },
  generatedAt: Date,
  ip: string | null,
): Promise<Response> {
  let brandId: string | null = null;
  let multi = false;
  if (subject.decision === 'hire') brandId = subject.companyId ?? null;
  else if (subject.decision === 'exit' && subject.employeeId) {
    const e = await prisma.employee.findUnique({ where: { id: subject.employeeId }, select: { legalCompanyId: true } });
    brandId = e?.legalCompanyId ?? null;
  } else if (subject.decision === 'plan' && subject.planId) {
    const p = await prisma.headcountPlan.findUnique({ where: { id: subject.planId }, select: { companyId: true } });
    brandId = p?.companyId ?? null;
    multi = !brandId;
  }
  const model = buildSensitivityReport(view);
  model.scope = { ...model.scope, planId: subject.planId ?? null, companyId: subject.companyId ?? null, employeeId: subject.employeeId ?? null };
  return pdfResponse({ req, user, model, brandCompanyId: brandId, brandCompanyName: await companyName(brandId), multiCompany: multi, generatedAt, entityType: 'WorkforceReportPdf', entityId: subject.planId ?? subject.employeeId ?? subject.companyId ?? null, ip });
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const { kind } = parseQuery(req, kindSchema(GET_KINDS as unknown as [string, ...string[]]));
    assertConfigured();
    // P1-SCOPE: the caller's company scope (after the 503: nothing is loaded when the renderer is missing).
    // The other kinds call the view handlers, which apply it themselves.
    const wf = await workforceScope(user);
    limitPdf(user, 'report');
    const ip = getClientIp(req);
    const generatedAt = calculationTime();

    if (kind === 'true-cost') {
      const q = parseQuery(req, trueCostSchema);
      limitOrThrow(user, 'heavy', 30, 60_000);
      assertCompanyVisible(wf, q.companyId);
      const { run, response } = await runOverview({ months: q.months, scenario: q.scenario }, wf);
      let employee: TrueCostReportView['employee'] = null;
      if (q.employeeId) {
        const one = await runTrueCost({ employeeId: q.employeeId, scenario: q.scenario }, wf);
        const d = employeeDetail(one, q.employeeId, user.role);
        employee = { summary: d.summary, months: d.months };
      }
      const view: TrueCostReportView = {
        overview: response,
        evidence: Object.values(run.tc.explanations).flatMap((x) => (x?.rules ?? []) as EvidenceLike[]),
        rulesUsed: run.tc.rulesUsed,
        employee,
      };
      const companies = response.legalCompanies;
      // Letterhead: the selected company, else the first real legal company of the view (the data cover all of them).
      const lh = letterhead(companies, q.companyId);
      const brandId = lh.id;
      let brandName = lh.name;
      if (q.companyId && !brandName) {
        brandName = await companyName(q.companyId);
        if (!brandName) throw notFound('الشركة غير موجودة');
      }
      const model = buildTrueCostReport(viewForRole(view, user.role));
      model.scope = { ...model.scope, employeeId: q.employeeId ?? null, letterheadCompanyId: brandId };
      return await pdfResponse({ req, user, model, brandCompanyId: brandId, brandCompanyName: brandName, multiCompany: companies.length > 1, generatedAt, entityType: 'WorkforceReportPdf', entityId: q.employeeId ?? null, ip });
    }

    if (kind === 'saudization') {
      const q = parseQuery(req, saudizationSchema);
      if (q.targetBand && !q.companyId) throw badRequest('اختر الشركة لحساب الوصول إلى النطاق المستهدف');
      const solveBody = q.targetBand && q.companyId ? { companyId: q.companyId, targetBand: q.targetBand, ...(q.byDate ? { byDate: q.byDate } : {}) } : null;
      return await saudizationPdf(req, user, { companyId: q.companyId, date: q.date }, solveBody, generatedAt, ip);
    }

    if (kind === 'plan') {
      const q = parseQuery(req, planSchema);
      const ctx = { params: Promise.resolve({ id: q.planId }) };
      const p = await viewJson<Omit<PlanReportView, 'actual'>>(await planGET(innerRequest(req, `/api/workforce/plans/${encodeURIComponent(q.planId)}${qs({ live: q.live ? 1 : undefined })}`), ctx));
      if (!p.ok) return p.res;
      const a = await viewJson<NonNullable<PlanReportView['actual']>>(await planActualGET(innerRequest(req, `/api/workforce/plans/${encodeURIComponent(q.planId)}/actual${qs({ live: q.live ? 1 : undefined, asOf: q.asOf })}`), { params: Promise.resolve({ id: q.planId }) }));
      if (!a.ok) return a.res;
      const view = viewForRole({ ...p.body, actual: a.body }, user.role);
      const companies = view.projection.companies;
      const lh = letterhead(companies, view.plan.companyId);
      const brandId = lh.id;
      const brandName = view.plan.companyName ?? lh.name;
      const model = buildPlanReport(view);
      return await pdfResponse({ req, user, model, brandCompanyId: brandId, brandCompanyName: brandName, multiCompany: !view.plan.companyId && companies.length > 1, generatedAt, entityType: 'WorkforceReportPdf', entityId: q.planId, ip });
    }

    if (kind === 'sensitivity') {
      const q = parseQuery(req, sensitivityQuerySchema);
      const r = await viewJson<SensitivityReportView>(await sensitivityGET(innerRequest(req, `/api/workforce/sensitivity${qs({ decision: q.decision, planId: q.planId })}`)));
      if (!r.ok) return r.res;
      return await sensitivityPdf(req, user, viewForRole(r.body, user.role), { decision: 'plan', planId: q.planId }, generatedAt, ip);
    }

    // total-rewards (HR view)
    const q = parseQuery(req, totalRewardsSchema);
    const t = await viewJson<TotalRewardsReportView>(await totalRewardsGET(innerRequest(req, `/api/workforce/total-rewards${qs({ employeeId: q.employeeId, year: q.year })}`)));
    if (!t.ok) return t.res;
    const emp = await prisma.employee.findUnique({ where: { id: q.employeeId }, select: { legalCompanyId: true, actualCompanyId: true } });
    const brandId = emp?.legalCompanyId || emp?.actualCompanyId || null;
    const model = buildTotalRewardsReport(viewForRole(t.body, user.role), 'HR');
    return await pdfResponse({ req, user, model, brandCompanyId: brandId, brandCompanyName: t.body.statement.employee.companyName ?? (await companyName(brandId)), multiCompany: false, generatedAt, entityType: 'WorkforceReportPdf', entityId: q.employeeId, ip });
  } catch (err) {
    return renderErrorResponse(err) ?? handleApiError(err, 'workforce:report:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const { kind, date } = parseQuery(req, postQuerySchema);
    assertConfigured();
    // P1-SCOPE: authorization through the scope layer; the view handlers called below apply the company scope.
    await workforceScope(user);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw badRequest('صيغة البيانات المرسلة غير صحيحة');
    }
    limitPdf(user, 'report');
    const ip = getClientIp(req);
    const generatedAt = calculationTime();

    if (kind === 'saudization') {
      // Body = the page's POST /api/workforce/saudization/solve body (with its options); the company is its own.
      const companyId = typeof (body as { companyId?: unknown } | null)?.companyId === 'string' ? (body as { companyId: string }).companyId : undefined;
      return await saudizationPdf(req, user, { companyId, date }, body, generatedAt, ip);
    }

    if (kind === 'exit-cost') {
      const r = await viewJson<ExitCostReportView>(await exitCostPOST(innerRequest(req, '/api/workforce/exit-cost', body)));
      if (!r.ok) return r.res;
      const view = viewForRole(r.body, user.role);
      const brandId = view.employee.legalCompanyId ?? null;
      const model = buildExitCostReport(view);
      return await pdfResponse({ req, user, model, brandCompanyId: brandId, brandCompanyName: await companyName(brandId), multiCompany: false, generatedAt, entityType: 'WorkforceReportPdf', entityId: view.employee.id, ip });
    }

    if (kind === 'sensitivity') {
      const r = await viewJson<SensitivityReportView>(await sensitivityPOST(innerRequest(req, '/api/workforce/sensitivity', body)));
      if (!r.ok) return r.res;
      const b = (body ?? {}) as { decision?: string; planId?: string; params?: { companyId?: string; employeeId?: string } };
      return await sensitivityPdf(req, user, viewForRole(r.body, user.role), { decision: b.decision, planId: b.planId, companyId: b.params?.companyId, employeeId: b.params?.employeeId }, generatedAt, ip);
    }

    const r = await viewJson<HireScenarioReportView>(await hireScenarioPOST(innerRequest(req, '/api/workforce/hire-scenario', body)));
    if (!r.ok) return r.res;
    const view = viewForRole(r.body, user.role);
    const model = buildHireScenarioReport(view);
    return await pdfResponse({ req, user, model, brandCompanyId: view.result.company.id, brandCompanyName: view.result.company.name, multiCompany: false, generatedAt, entityType: 'WorkforceReportPdf', entityId: view.result.company.id, ip });
  } catch (err) {
    return renderErrorResponse(err) ?? handleApiError(err, 'workforce:report:POST');
  }
}

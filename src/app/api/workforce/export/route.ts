// /api/workforce/export?kind=… — Excel exports of «محرك القرارات» (SPEC §11). WORKFORCE roles (as every
// underlying view), rate limited (10 files per minute per user), one EXPORT audit row per file (who, kind,
// scope / filters, rows per sheet; never throttled).
//
// GET  kind=overview        &months&scenario                                    (لوحة القرار)
//      kind=true-cost       &companyId&branchId&departmentId&q&sort&flagged&months&scenario | &employeeId
//      kind=saudization     &companyId&date                                     (estimate + localization)
//      kind=plan            &planId&live&asOf                                   (plan + plan vs actual)
//      kind=benchmarks      &months&companyId&branchId&departmentId             (same suppression)
//      kind=rules                                                               (full register)
//      kind=calculation     &id                                                 (saved snapshot, redacted)
//      kind=sensitivity     &decision=plan&planId
// POST kind=exit-cost       body = POST /api/workforce/exit-cost body
//      kind=hire-scenario   body = POST /api/workforce/hire-scenario body
//      kind=saudization     body = POST /api/workforce/saudization/solve body (&date): estimate + solver
//      kind=sensitivity     body = POST /api/workforce/sensitivity body
// The workbook is built from the same view objects as the JSON endpoints, after the privacy redaction of the
// viewer (a finance viewer never gets disability-identifying data) and the benchmarks suppression.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { logAudit } from '@/lib/audit';
import { HttpError, badRequest, handleApiError } from '@/lib/http';
import { zDate, zId } from '@/lib/validation';
import { canSeeDisability } from '@/lib/workforce/privacy';
import {
  XLSX_MIME,
  buildBenchmarksWorkbook,
  buildCalculationWorkbook,
  buildExitCostWorkbook,
  buildHireScenarioWorkbook,
  buildOverviewWorkbook,
  buildPlanWorkbook,
  buildRulesWorkbook,
  buildSaudizationWorkbook,
  buildSensitivityWorkbook,
  buildTrueCostWorkbook,
  auditSearchText,
  contentDisposition,
  exportFileNames,
  type BuiltWorkbook,
  type ExportContext,
} from '@/lib/workforce/export-xlsx';
import { exitCostSchema, overviewQuerySchema, trueCostQuerySchema } from '../_lib/schemas';
import { hireScenarioSchema, saudizationQuerySchema, solveSchema } from '../_lib/saudization-schemas';
import { limitOrThrow } from '../_lib/server';
import { actualQuerySchema } from '../plans/_lib/schemas';
import { bodyFromQuery, runSensitivity, sensitivityBodySchema } from '../sensitivity/_run';
import { benchmarksQuerySchema, benchmarksView, calculationView, exitView, hireView, overviewView, planView, rulesView, saudizationView, trueCostView } from './_views';

export const dynamic = 'force-dynamic';

const EXPORT_KINDS = ['overview', 'true-cost', 'exit-cost', 'saudization', 'hire-scenario', 'plan', 'benchmarks', 'rules', 'calculation', 'sensitivity'] as const;
type ExportKind = (typeof EXPORT_KINDS)[number];
const GET_KINDS: ReadonlyArray<ExportKind> = ['overview', 'true-cost', 'saudization', 'plan', 'benchmarks', 'rules', 'calculation', 'sensitivity'];
const POST_KINDS: ReadonlyArray<ExportKind> = ['exit-cost', 'hire-scenario', 'saudization', 'sensitivity'];

interface Built {
  built: BuiltWorkbook;
  /** Scope / filters for the audit row (ids and options, never names, amounts or the free-text search). */
  filters: Record<string, unknown>;
}

const planQuerySchema = z.object({ planId: zId }).merge(actualQuerySchema);
const calcQuerySchema = z.object({ id: zId });
const solveDateSchema = z.object({ date: z.preprocess((v) => (v === '' || v === null ? undefined : v), zDate.optional()) });

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest('صيغة البيانات المرسلة غير صحيحة');
  }
}

async function build(kind: ExportKind, method: 'GET' | 'POST', query: Record<string, string>, body: unknown, user: AuthUser, ctx: ExportContext): Promise<Built> {
  switch (kind) {
    case 'overview': {
      const q = overviewQuerySchema.parse(query);
      const { view, evidence } = await overviewView(q as { months: 12 | 24 | 36; scenario: 'low' | 'base' | 'high' });
      return { built: buildOverviewWorkbook(view, evidence, ctx), filters: { months: q.months, scenario: q.scenario } };
    }
    case 'true-cost': {
      const q = trueCostQuerySchema.parse(query);
      const { view, evidence } = await trueCostView(q, user.role);
      return {
        built: buildTrueCostWorkbook(view, evidence, ctx),
        filters: { companyId: q.companyId ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, employeeId: q.employeeId ?? null, ...auditSearchText(q.q), flagged: q.flagged, sort: q.sort, months: q.months, scenario: q.scenario },
      };
    }
    case 'exit-cost': {
      const p = exitCostSchema.parse(body);
      const view = await exitView(p);
      return { built: buildExitCostWorkbook(view, [], ctx), filters: { employeeId: p.employeeId, exitReason: p.exitReason, settlementReason: p.settlementReason ?? null, lastWorkingDate: p.lastWorkingDate.toISOString().slice(0, 10), scenario: p.scenario } };
    }
    case 'hire-scenario': {
      const p = hireScenarioSchema.parse(body);
      const view = await hireView(p);
      return { built: buildHireScenarioWorkbook(view, ctx), filters: { companyId: p.companyId, startMonth: view.result.startMonth, months: p.months, candidates: p.candidates.map((c) => c.kind) } };
    }
    case 'saudization': {
      if (method === 'POST') {
        const s = solveSchema.parse(body);
        const { date } = solveDateSchema.parse({ date: query.date });
        const { view, solve } = await saudizationView({ companyId: s.companyId, date }, s, user.role);
        return { built: buildSaudizationWorkbook(view, solve ? { companyName: solve.companyName, result: solve.result } : null, ctx), filters: { companyId: s.companyId, date: view.date, targetBand: s.targetBand, byDate: solve?.result.byDate ?? null } };
      }
      const q = saudizationQuerySchema.parse({ ...query, summary: '' });
      const { view } = await saudizationView({ companyId: q.companyId, date: q.date }, null, user.role);
      return { built: buildSaudizationWorkbook(view, null, ctx), filters: { companyId: q.companyId ?? null, date: view.date } };
    }
    case 'plan': {
      const q = planQuerySchema.parse(query);
      const view = await planView(q.planId, q.live, q.asOf ?? null);
      return { built: buildPlanWorkbook(view, ctx), filters: { planId: q.planId, live: q.live, asOf: view.actual?.result.asOf ?? null } };
    }
    case 'benchmarks': {
      const q = benchmarksQuerySchema.parse(query);
      const view = await benchmarksView(q);
      return { built: buildBenchmarksWorkbook(view, ctx), filters: { months: q.months, companyId: q.companyId ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, scopeSuppressed: view.scopeSuppressed } };
    }
    case 'rules': {
      const view = await rulesView();
      return { built: buildRulesWorkbook(view, ctx), filters: {} };
    }
    case 'calculation': {
      const q = calcQuerySchema.parse(query);
      const { view, evidence } = await calculationView(q.id, user.role);
      return { built: buildCalculationWorkbook(view, evidence, ctx), filters: { id: q.id, calculationKind: view.kind } };
    }
    case 'sensitivity': {
      const b = method === 'GET' ? bodyFromQuery(query) : sensitivityBodySchema.parse(body);
      const out = await runSensitivity(b);
      return { built: buildSensitivityWorkbook(out.result, out.evidence, ctx), filters: out.subject };
    }
  }
}

async function handle(req: Request, method: 'GET' | 'POST') {
  const user = await requireUser(ROLE_GROUPS.WORKFORCE);
  const url = new URL(req.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const kind = query.kind as ExportKind;
  delete query.kind;
  if (!(EXPORT_KINDS as ReadonlyArray<string>).includes(kind)) throw badRequest(`نوع التصدير غير صالح (${EXPORT_KINDS.join('، ')})`);
  if (!(method === 'GET' ? GET_KINDS : POST_KINDS).includes(kind)) throw new HttpError(405, method === 'GET' ? 'هذا التصدير يُطلب بـ POST ومعه بيانات الحساب نفسها' : 'هذا التصدير يُطلب بـ GET');
  limitOrThrow(user, 'export', 10, 60_000);
  const body = method === 'POST' ? await readJson(req) : null;
  const generatedAt = new Date();
  const ctx: ExportContext = { generatedAt, canSeeDisability: canSeeDisability(user.role) };
  const { built, filters } = await build(kind, method, query, body, user, ctx);
  const buffer = await built.workbook.xlsx.writeBuffer();
  const rows = built.sheets.reduce((s, x) => s + x.rows, 0);
  await logAudit({
    userId: user.id,
    action: 'EXPORT',
    entityType: 'WorkforceExport',
    entityId: kind,
    details: { kind, method, filters, restricted: !ctx.canSeeDisability, rows, sheets: built.sheets, bytes: buffer.byteLength },
    ipAddress: getClientIp(req),
  });
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': contentDisposition(exportFileNames(kind, built.title, generatedAt)),
      'Cache-Control': 'no-store',
      'X-Row-Count': String(rows),
    },
  });
}

export async function GET(req: Request) {
  try {
    return await handle(req, 'GET');
  } catch (err) {
    return handleApiError(err, 'workforce:export:GET');
  }
}

export async function POST(req: Request) {
  try {
    return await handle(req, 'POST');
  } catch (err) {
    return handleApiError(err, 'workforce:export:POST');
  }
}

// View loaders of the Excel export (SPEC §11). Each function returns the SAME view object as the JSON
// endpoint of that page (same runners, same privacy redaction, same benchmarks suppression), shaped for the
// pure builders of src/lib/workforce/export-xlsx.ts. Never a query with more detail than the page shows.
import 'server-only';
import { z } from 'zod';
import type { PayrollStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { badRequest, notFound } from '@/lib/http';
import { today, todayKey } from '@/lib/dates';
import { PAYROLL_STATUS } from '@/lib/constants';
import { zId } from '@/lib/validation';
import { BENCHMARK_PERIODS, BENCHMARK_SOURCE, MIN_GROUP_SIZE, computeBenchmarks, scopeDisclosure } from '@/lib/workforce/benchmarks';
import { canSeeDisability, redactSnapshotJson } from '@/lib/workforce/privacy';
import { planVsActual } from '@/lib/workforce/planning';
import { parseDecision } from '@/lib/workforce/saudization';
import { loadLocalizationDecisions, loadNitaqatRegister } from '@/lib/workforce/load';
import { settingsInScope } from '@/lib/workforce/export-xlsx';
import type { BenchmarksExportView, CalculationExportView, ExitCostExportView, HireExportView, PlanExportView, RulesExportView, SaudizationExportView, TrueCostExportView } from '@/lib/workforce/export-xlsx';
import type { OverviewResponse } from '../_lib/views';
import type { CompanySaudization } from '../_lib/saudization';
import type { RuleEvidence, RuleVersionRef, TrueCostResult } from '@/lib/workforce/types';
import { assumptionEvidence, buildRulesView, companySettingsEvidence, compositionForWindow, groupRows, pageSummaries, summarizeEmployee } from '../_lib/views';
import { employeeDetail, runExitCost, runOverview, runTrueCost, type TrueCostRun } from '../_lib/server';
import { runHireScenario, runSaudization, runSolve, currentDecisions } from '../_lib/saudization';
import type { ExitCostParams, TrueCostParams } from '../_lib/schemas';
import type { HireScenarioParams, SolveParams } from '../_lib/saudization-schemas';
import { loadBenchmarkPopulation, loadBenchmarksInput } from '../benchmarks/_load';
import { companyNameMap, loadPlanOr404, planHeader, planHistories, projectionFor, publicProjection, todayDate, toDefinition, userNames } from '../plans/_lib/server';
import { displayNames, serializePositions, serializeRaises } from '../plans/_lib/views';
import { assertUnitsVisible, calculationScopeWhere, type WfScope } from '../_lib/scope';

// ---------------------------------------------------------------------------
// Evidence of a true-cost run («لماذا؟» of every line, assumptions, company settings)
// ---------------------------------------------------------------------------

export function trueCostEvidence(tc: TrueCostResult, assumptions: TrueCostRun['assumptions'], companyId: string | null): RuleEvidence[] {
  return [
    ...Object.values(tc.explanations).flatMap((e) => e?.rules ?? []),
    ...Object.values(assumptionEvidence(assumptions, companyId, tc.scenario)),
    ...settingsInScope(tc, companyId).flatMap((c) => Object.values(companySettingsEvidence(c))),
  ];
}

// ---------------------------------------------------------------------------
// Overview / true cost
// ---------------------------------------------------------------------------

// Every view takes the caller's company scope (P1-SCOPE, §5.4.4: an export goes through the same canonical
// query with the same context as the screen).
export async function overviewView(q: { months: 12 | 24 | 36; scenario: 'low' | 'base' | 'high' }, s: WfScope): Promise<{ view: OverviewResponse; evidence: RuleEvidence[] }> {
  const { run, response } = await runOverview(q, s);
  return { view: response, evidence: trueCostEvidence(run.tc, run.assumptions, null) };
}

async function scopeText(p: { companyId?: string | null; branchId?: string | null; departmentId?: string | null }): Promise<string> {
  const [c, b, d] = await Promise.all([
    p.companyId ? prisma.company.findUnique({ where: { id: p.companyId }, select: { nameArabic: true } }) : null,
    p.branchId ? prisma.branch.findUnique({ where: { id: p.branchId }, select: { nameArabic: true } }) : null,
    p.departmentId ? prisma.department.findUnique({ where: { id: p.departmentId }, select: { nameArabic: true } }) : null,
  ]);
  const parts = [c ? `الشركة: ${c.nameArabic}` : null, b ? `الفرع: ${b.nameArabic}` : null, d ? `الإدارة: ${d.nameArabic}` : null].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'كل الموظفين (كل الشركات)';
}

/**
 * GET /api/workforce/true-cost with the same scope, search, flagged filter and sort, every page at once
 * (the page's CSV export already loaded every page); `employeeId` = the detail of one employee (months
 * redacted per viewer by employeeDetail, as the JSON endpoint).
 */
export async function trueCostView(
  q: TrueCostParams & { q?: string; sort: 'cost' | 'name' | 'flags'; flagged: boolean },
  role: string,
  s: WfScope,
): Promise<{ view: TrueCostExportView; evidence: RuleEvidence[]; rows: number }> {
  const run = await runTrueCost(q, s);
  const h = q.months as 12 | 24 | 36;
  const all = run.tc.employees.map(summarizeEmployee);
  const page = pageSummaries(all, { q: q.q, sort: q.sort, flagged: q.flagged, take: all.length || 1, skip: 0 });
  const detail = q.employeeId ? employeeDetail(run, q.employeeId, role) : null;
  const view: TrueCostExportView = {
    engineVersion: run.tc.engineVersion,
    startMonth: run.startMonth,
    horizon: h,
    scenario: run.tc.scenario,
    scopeText: detail ? `${detail.summary.name}${detail.summary.employeeNo ? ` (${detail.summary.employeeNo})` : ''}` : await scopeText(q),
    totals: run.tc.totals,
    headcount: run.tc.series[0]?.headcount ?? 0,
    series: run.tc.series.map((s) => ({ month: s.month, cost: s.cost, subsidy: s.subsidy, net: s.net, headcount: s.headcount })),
    composition: compositionForWindow(run.tc, h),
    byCompany: groupRows(run.tc.byCompany, h),
    byBranch: groupRows(run.tc.byBranch, h),
    byDepartment: groupRows(run.tc.byDepartment, h),
    employees: page.items,
    detail: detail ? { summary: detail.summary, months: detail.months, liabilities: detail.liabilities, flags: detail.flags } : null,
  };
  const evidence = detail
    ? [...Object.values(detail.explanations).flatMap((e) => e?.rules ?? []), ...Object.values(detail.assumptionEvidence)]
    : trueCostEvidence(run.tc, run.assumptions, q.companyId ?? null);
  return { view, evidence, rows: detail ? 1 : page.items.length };
}

// ---------------------------------------------------------------------------
// Exit cost / hire scenario / Saudization (POST bodies = the page's bodies)
// ---------------------------------------------------------------------------

export async function exitView(p: ExitCostParams, s: WfScope): Promise<ExitCostExportView> {
  const out = await runExitCost(p, s);
  return { ...out.result, employee: out.employee, reasonMapping: out.reasonMapping, warnings: out.warnings, assumptionEvidence: out.assumptionEvidence };
}

export async function hireView(p: HireScenarioParams, s: WfScope): Promise<HireExportView> {
  const out = await runHireScenario(p, s);
  return { result: out.result, assumptionEvidence: out.assumptionEvidence, horizon: out.horizon };
}

export async function saudizationView(q: { companyId?: string; date?: Date }, solve: SolveParams | null, role: string, wf: WfScope): Promise<{ view: SaudizationExportView; solve: Awaited<ReturnType<typeof runSolve>> | null }> {
  const body = await runSaudization({ companyId: solve?.companyId ?? q.companyId, date: q.date, summary: false }, role, wf);
  if (!('activitiesCount' in body)) throw badRequest('تعذر إعداد التصدير');
  const s = solve ? await runSolve(solve, role, wf) : null;
  return { view: { date: body.date, canSeeNames: body.canSeeNames, companies: body.companies as CompanySaudization[] }, solve: s };
}

// ---------------------------------------------------------------------------
// Workforce plan (+ plan vs actual, same queries as /plans/[id]/actual)
// ---------------------------------------------------------------------------

export async function planView(planId: string, live: boolean, asOfKey: string | null, s: WfScope): Promise<PlanExportView> {
  const row = await loadPlanOr404(planId, s);
  const [{ projection, frozen }, histories, names, companies] = await Promise.all([projectionFor(row, live), planHistories([row.id]), displayNames(row, s), companyNameMap(s)]);
  const history = histories.get(row.id) ?? null;
  const users = await userNames([row.createdById, row.decidedById, history?.archivedById]);
  const header = planHeader(row, users, companies, history);

  const asOf = asOfKey ? new Date(`${asOfKey}T00:00:00.000Z`) : todayDate();
  const asOfMonth = asOf.toISOString().slice(0, 7);
  const byYear = new Map<number, number[]>();
  for (const k of projection.monthKeys) {
    if (k > asOfMonth) continue;
    const [y, m] = k.split('-').map(Number);
    byYear.set(y, [...(byYear.get(y) ?? []), m]);
  }
  const scope = row.companyId ? { legalCompanyId: row.companyId } : s.companyIds ? { legalCompanyId: { in: [...s.companyIds] } } : {};
  const [rows, employees] = byYear.size
    ? await Promise.all([
        prisma.payroll.findMany({
          where: {
            status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] as PayrollStatus[] },
            OR: [...byYear.entries()].map(([year, months]) => ({ year, month: { in: months } })),
            ...(row.companyId || s.companyIds ? { employee: scope } : {}),
          },
          select: { employeeId: true, year: true, month: true, status: true, basicSalary: true, totalAllowances: true, overtimeCost: true, gosiEmployer: true, bonusAmount: true },
          orderBy: [{ year: 'asc' }, { month: 'asc' }, { employeeId: 'asc' }],
        }),
        prisma.employee.findMany({
          where: scope,
          select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, joinDate: true, terminationDate: true, isTerminated: true, legalCompanyId: true, departmentId: true, nationality: true },
          orderBy: { id: 'asc' },
        }),
      ])
    : [[], []];
  const actual = planVsActual(
    toDefinition(row),
    projection,
    rows.map((r) => ({ ...r, status: String(r.status) })),
    asOf,
    {
      employees: employees.map((e) => ({
        id: e.id,
        name: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() || e.employeeId || e.id,
        employeeNo: e.employeeId,
        joinDate: e.joinDate,
        terminationDate: e.terminationDate,
        isTerminated: e.isTerminated,
        legalCompanyId: e.legalCompanyId,
        departmentId: e.departmentId,
        nationality: e.nationality,
      })),
    },
  );
  const warning = frozen
    ? null
    : live
      ? 'المخطط معاد حسابه بالبيانات الحالية لا باللقطة المعتمدة: قد يظهر فيه من عُيّن فعلاً بعد بداية الخطة'
      : row.status === 'APPROVED' || row.status === 'ARCHIVED'
        ? 'لم يُعثر على لقطة الاعتماد: المقارنة بالتوقع المعاد حسابه بالبيانات الحالية'
        : 'الخطة غير معتمدة: المخطط يُعاد حسابه من البيانات الحالية، فقد يظهر فيه من عُيّن فعلاً بعد بداية الخطة';
  return {
    plan: {
      name: header.name,
      statusLabel: header.statusLabel,
      companyName: header.companyName,
      fromMonth: header.fromMonth,
      months: header.months,
      attritionPct: header.attritionPct,
      createdByName: header.createdByName,
      decisionLabel: header.decisionLabel,
      decidedByName: header.decidedByName,
      decidedAt: header.decidedAt,
      notes: header.notes,
    },
    positions: serializePositions(row),
    raises: serializeRaises(row),
    names,
    projection: publicProjection(projection),
    frozen,
    actual: { result: actual, warning },
  };
}

// ---------------------------------------------------------------------------
// Benchmarks (same schema, disclosure control and suppression as GET /api/workforce/benchmarks)
// ---------------------------------------------------------------------------

const blank = (v: unknown) => (v === '' || v === null ? undefined : v);

export const benchmarksQuerySchema = z
  .object({
    months: z.preprocess(
      (v) => (v === '' || v === undefined || v === null ? 12 : Number(v)),
      z.number().refine((n) => (BENCHMARK_PERIODS as ReadonlyArray<number>).includes(n), 'الفترة يجب أن تكون 3 أو 6 أو 12 أو 24 شهراً'),
    ),
    companyId: z.preprocess(blank, zId.optional()),
    branchId: z.preprocess(blank, zId.optional()),
    departmentId: z.preprocess(blank, zId.optional()),
  })
  .strict();

export async function benchmarksView(q: z.infer<typeof benchmarksQuerySchema>, s: WfScope): Promise<BenchmarksExportView> {
  await assertUnitsVisible(s, q);
  const [company, branch, department] = await Promise.all([
    q.companyId ? prisma.company.findUnique({ where: { id: q.companyId }, select: { id: true, nameArabic: true } }) : null,
    q.branchId ? prisma.branch.findUnique({ where: { id: q.branchId }, select: { id: true, nameArabic: true } }) : null,
    q.departmentId ? prisma.department.findUnique({ where: { id: q.departmentId }, select: { id: true, nameArabic: true } }) : null,
  ]);
  if (q.companyId && !company) throw badRequest('الشركة غير موجودة');
  if (q.branchId && !branch) throw badRequest('الفرع غير موجود');
  if (q.departmentId && !department) throw badRequest('الإدارة غير موجودة');
  const asOf = today();
  const scope = { companyId: q.companyId ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null };
  const scoped = !!(scope.companyId || scope.branchId || scope.departmentId);
  const [{ input, notes }, population] = await Promise.all([
    loadBenchmarksInput({ asOf, months: q.months, scope: { ...scope, companyIds: s.companyIds } }),
    scoped ? loadBenchmarkPopulation({ asOf, months: q.months, companyIds: s.companyIds }) : Promise.resolve(null),
  ]);
  const disclosure = population ? scopeDisclosure(population, scope, asOf, q.months, MIN_GROUP_SIZE) : null;
  const result = computeBenchmarks(input, { asOf, months: q.months, minGroupSize: MIN_GROUP_SIZE, disclosure });
  return {
    ...result,
    source: BENCHMARK_SOURCE,
    scope: { ...scope, companyName: company?.nameArabic ?? null, branchName: branch?.nameArabic ?? null, departmentName: department?.nameArabic ?? null },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Rules register (+ Nitaqat register + localization decisions)
// ---------------------------------------------------------------------------

export async function rulesView(): Promise<RulesExportView> {
  const [rules, gosiRates, register, decisionRows] = await Promise.all([
    prisma.ruleParameter.findMany({
      select: { key: true, domain: true, label: true, value: true, valueJson: true, unit: true, effectiveFrom: true, effectiveTo: true, status: true, sourceUrl: true, sourceQuote: true, notes: true, createdAt: true },
      orderBy: [{ domain: 'asc' }, { key: 'asc' }, { effectiveFrom: 'asc' }],
    }),
    prisma.gosiRate.findMany({
      select: { regime: true, isSaudi: true, effectiveFrom: true, employeeRate: true, employerRate: true, minWage: true, maxWage: true, isProvisional: true, source: true, createdAt: true },
      orderBy: [{ regime: 'asc' }, { isSaudi: 'asc' }, { effectiveFrom: 'asc' }],
    }),
    loadNitaqatRegister(),
    loadLocalizationDecisions(),
  ]);
  const t = todayKey();
  const current = new Set(currentDecisions(decisionRows).map((r) => r.id));
  return {
    today: t,
    domains: buildRulesView(rules, gosiRates, t),
    activities: register.activities.map((a) => ({
      ...a,
      curves: register.curves
        .filter((c) => c.activityKey === a.key)
        .map((c) => ({ band: c.band, year: c.year, m: c.m, c: c.c, status: c.status, page: c.page ?? null, sourceUrl: c.sourceUrl ?? null, note: c.note ?? null })),
    })),
    decisions: decisionRows.map((r) => ({ ...parseDecision(r), current: current.has(r.id), createdAt: r.createdAt.toISOString() })),
  };
}

// ---------------------------------------------------------------------------
// Saved calculation (redacted at read time for viewers outside the HR group, as GET /calculations/[id])
// ---------------------------------------------------------------------------

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function calculationView(id: string, role: string, s: WfScope): Promise<{ view: CalculationExportView; evidence: RuleEvidence[] }> {
  const view = canSeeDisability(role) ? (v: unknown) => v : redactSnapshotJson;
  const inScope = await calculationScopeWhere(s);
  const row = await prisma.workforceCalculation.findFirst({ where: { id, ...(inScope ? { AND: [inScope] } : {}) } });
  if (!row) throw notFound('الحساب المحفوظ غير موجود');
  const creator = row.createdById ? await prisma.user.findUnique({ where: { id: row.createdById }, select: { name: true, email: true } }) : null;
  const ruleVersions = (parse(row.ruleVersions) as RuleVersionRef[] | null) ?? [];
  // Label, unit and source of each exact version (immutable register rows, matched by key and date).
  const keys = [...new Set(ruleVersions.map((r) => r.key).filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k)))];
  const params = keys.length ? await prisma.ruleParameter.findMany({ where: { key: { in: keys } }, select: { key: true, label: true, unit: true, effectiveFrom: true, sourceUrl: true, sourceQuote: true } }) : [];
  const byVersion = new Map(params.map((p) => [`${p.key}@${p.effectiveFrom.toISOString().slice(0, 10)}`, p]));
  const evidence: RuleEvidence[] = ruleVersions.map((r) => {
    const p = byVersion.get(`${r.key}@${(r.effectiveFrom ?? '').slice(0, 10)}`);
    return { key: r.key, label: p?.label ?? r.key, value: r.value, unit: p?.unit ?? null, status: r.status, sourceUrl: p?.sourceUrl ?? null, sourceQuote: p?.sourceQuote ?? null, effectiveFrom: r.effectiveFrom ? r.effectiveFrom.slice(0, 10) : null };
  });
  return {
    view: {
      id: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      title: row.title,
      engineVersion: row.engineVersion,
      createdAt: row.createdAt.toISOString(),
      createdByName: creator ? creator.name || creator.email : null,
      ruleVersions,
      inputs: view(parse(row.inputs)),
      outputs: view(parse(row.outputs)),
    },
    evidence,
  };
}

// Server-side runners of the workforce API: load (src/lib/workforce/load.ts) -> compute (pure engine) ->
// shape (views.ts). Shared by the GET endpoints and by POST /api/workforce/calculations, which recomputes
// from the stored params and never trusts outputs sent by the client.
import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { HttpError, notFound } from '@/lib/http';
import { today, todayKey } from '@/lib/dates';
import type { AuthUser } from '@/lib/auth';
import { activeProtectedLeave } from '@/app/api/employees/[id]/route';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import { computeOverview } from '@/lib/workforce/overview';
import { computeExitCost } from '@/lib/workforce/exit-cost';
import { EXIT_REASON_TO_TERMINATION, type EmployeeExitReason } from '@/lib/workforce/reasons';
import { loadExitCostInput, loadTrueCostInput } from '@/lib/workforce/load';
import { canSeeDisability, redactMonths } from '@/lib/workforce/privacy';
import type { AssumptionRow, ExitCostInput, TrueCostResult, WfCompanyInput } from '@/lib/workforce/types';
import { COMPUTE_MONTHS, type Horizon } from './shared';
import { assumptionEvidence, buildOverviewResponse, companySettingsEvidence, settingsOf, summarizeEmployee, withAssumptionOverrides, type CompanySettingsView } from './views';
import type { ExitCostParams, OverviewParams, TrueCostParams } from './schemas';
import { assertEmployeeVisible, assertUnitsVisible, scopeCompanies, type WfScope } from './scope';

/** Current month in Riyadh ('YYYY-MM'): the first projected month. */
export function currentMonth(): string {
  return todayKey().slice(0, 7);
}

/** Throws 429 (Arabic) once `limit` hits happen in `windowMs` for this user and bucket. */
export function limitOrThrow(user: Pick<AuthUser, 'id'>, bucket: string, limit: number, windowMs: number): void {
  const r = rateLimit(`wf:${bucket}:${user.id}`, limit, windowMs);
  if (!r.ok) throw new HttpError(429, `طلبات كثيرة خلال وقت قصير. أعد المحاولة بعد ${r.retryAfterSeconds} ثانية.`);
}

const VIEW_AUDIT_WINDOW_MS = 5 * 60_000;

/** Stable text of a filter set: keys sorted at every level, null / undefined / '' dropped. */
export function normalizeViewFilters(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x instanceof Date) return x.toISOString();
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val === null || val === undefined || val === '') continue;
        o[k] = norm(val);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v) ?? null);
}

/**
 * VIEW audit at most once per user, screen and filter set every 5 minutes: the same view refetched is logged
 * once, while every different scope / filter (e.g. probing departments of the benchmarks) is logged.
 */
export async function auditViewOnce(user: Pick<AuthUser, 'id'>, entityType: string, details: unknown, ip: string | null): Promise<void> {
  const filters = createHash('sha256').update(normalizeViewFilters(details)).digest('base64url').slice(0, 22);
  if (!rateLimit(`wf-view:${entityType}:${user.id}:${filters}`, 1, VIEW_AUDIT_WINDOW_MS).ok) return;
  await logAudit({ userId: user.id, action: 'VIEW', entityType, details, ipAddress: ip });
}

// ---------------------------------------------------------------------------
// True cost / overview
// ---------------------------------------------------------------------------

export interface TrueCostRun {
  tc: TrueCostResult;
  startMonth: string;
  scope: { companyId: string | null; branchId: string | null; departmentId: string | null; employeeIds: string[] | null };
  assumptions: AssumptionRow[];
  reportedCount: number;
  input: Awaited<ReturnType<typeof loadTrueCostInput>>['input'];
}

/**
 * Computes the full 36-month horizon for the scope (the horizon parameter only selects the window shown).
 * `s` = the caller's company scope: only employees of those legal companies are loaded, and a filter
 * (company / branch / department / employee) outside it is a 404. A named company narrows the load to it
 * (the levy tiers are per legal company, so the reported employees' numbers are the same).
 */
export async function runTrueCost(p: Pick<TrueCostParams, 'companyId' | 'branchId' | 'departmentId' | 'employeeId' | 'scenario' | 'startMonth'>, s: WfScope): Promise<TrueCostRun> {
  await assertUnitsVisible(s, p);
  const startMonth = p.startMonth ?? currentMonth();
  const scope = {
    companyId: p.companyId ?? null,
    branchId: p.branchId ?? null,
    departmentId: p.departmentId ?? null,
    employeeIds: p.employeeId ? [p.employeeId] : null,
  };
  const loaded = await loadTrueCostInput({ startMonth, months: COMPUTE_MONTHS, scope: { ...scope, companyIds: scopeCompanies(s, p.companyId) } });
  const tc = computeTrueCost(loaded.input, { startMonth, months: COMPUTE_MONTHS, scenario: p.scenario, employeeIds: loaded.reportEmployeeIds });
  return {
    tc,
    startMonth,
    scope,
    assumptions: loaded.input.assumptions as AssumptionRow[],
    reportedCount: tc.employees.length,
    input: loaded.input,
  };
}

export async function runOverview(p: OverviewParams & { startMonth?: string }, s: WfScope) {
  const run = await runTrueCost({ scenario: p.scenario, startMonth: p.startMonth }, s);
  const ov = computeOverview(run.tc, { rules: run.input.rules, gosiRates: run.input.gosiRates });
  return { run, response: buildOverviewResponse(run.tc, ov, p.months as Horizon, p.scenario) };
}

/** Group totals of a true-cost run (no per-employee months). */
export function trueCostTotals(tc: TrueCostResult) {
  return {
    totals: tc.totals,
    headcount: tc.series[0]?.headcount ?? 0,
    series: tc.series.map((s) => ({ month: s.month, cost: s.cost, subsidy: s.subsidy, net: s.net, headcount: s.headcount })),
  };
}

/**
 * Detail of one employee: months (lines), explanations and assumption evidence for "لماذا؟".
 * `viewerRole`: a viewer who may not see disability (privacy.ts canSeeDisability) gets the HRDF category
 * list replaced by a neutral text (amount unchanged).
 */
export function employeeDetail(run: TrueCostRun, employeeId: string, viewerRole: string | null | undefined) {
  const e = run.tc.employees.find((x) => x.employeeId === employeeId);
  if (!e) throw notFound('الموظف غير موجود أو لا يعمل خلال فترة التوقع');
  return {
    summary: summarizeEmployee(e),
    months: canSeeDisability(viewerRole) ? e.months : redactMonths(e.months),
    byLine: e.byLine,
    liabilities: e.liabilities,
    flags: e.flags,
    explanations: run.tc.explanations,
    // «لماذا؟» for ASSUMPTION:* keys and for the company settings («إعدادات الكلفة», COMPANY:* keys).
    assumptionEvidence: { ...assumptionEvidence(run.assumptions, e.legalCompanyId, run.tc.scenario), ...companySettingsEvidence(settingsOf(run.tc, e.settingsCompanyId)) },
    rulesUsed: run.tc.rulesUsed,
  };
}

// ---------------------------------------------------------------------------
// Exit cost
// ---------------------------------------------------------------------------

/** Reasons where the worker ended the contract: the protected-leave rule does not apply (settlements). */
const WORKER_ENDED = ['RESIGNATION', 'ARTICLE_81'];

export async function runExitCost(p: ExitCostParams, s: WfScope) {
  await assertEmployeeVisible(s, p.employeeId);
  const mapping = EXIT_REASON_TO_TERMINATION[p.exitReason as EmployeeExitReason];
  const reason = p.settlementReason ?? p.exitReason;
  const input = await loadExitCostInput({
    employeeId: p.employeeId,
    reason,
    lastWorkingDate: p.lastWorkingDate,
    noticeServed: p.noticeServed,
    replacementIsSaudi: p.replacementIsSaudi ?? null,
    scenario: p.scenario,
    companyIds: s.companyIds,
  });
  if (!input) throw notFound('الموظف غير موجود');
  const companyId = input.employee.legalCompanyId || null;
  const engineInput: ExitCostInput = { ...input, assumptions: withAssumptionOverrides(input.assumptions, companyId, p.assumptionsOverride) };
  const result = computeExitCost(engineInput);

  const warnings: string[] = [];
  if (mapping.note && (p.settlementReason || !mapping.certain)) warnings.push(mapping.note);
  const emp = await prisma.employee.findUnique({ where: { id: p.employeeId }, select: { isTerminated: true } });
  if (emp?.isTerminated) warnings.push('الموظف مسجَّل منتهي الخدمة: الحساب لأغراض المراجعة فقط.');
  if (!WORKER_ENDED.includes(result.reason)) {
    const leaves = await prisma.leave.findMany({
      where: { employeeId: p.employeeId, status: 'APPROVED', leaveType: { in: ['MATERNITY', 'SICK'] } },
      select: { id: true, leaveType: true, status: true, startDate: true, endDate: true, isReturned: true, actualReturnDate: true },
    });
    const active = activeProtectedLeave(leaves, [p.lastWorkingDate, today()]);
    if (active) {
      const kind = active.leaveType === 'MATERNITY' ? 'إجازة وضع' : 'إجازة مرضية';
      warnings.push(
        `لا يجوز لصاحب العمل إنهاء العقد أثناء ${kind} سارية (من ${active.startDate.toISOString().slice(0, 10)} إلى ${active.endDate.toISOString().slice(0, 10)}). شاشة التصفية تمنع هذا الإنهاء حتى تنتهي الإجازة (إلا بتجاوز موثّق من المدير العام).`,
      );
    }
  }
  return {
    result,
    input: engineInput,
    warnings,
    reasonMapping: { exitReason: p.exitReason, terminationReason: result.reason, certain: mapping.certain && !p.settlementReason, note: mapping.note },
    assumptionEvidence: { ...assumptionEvidence(engineInput.assumptions, companyId, p.scenario), ...companySettingsEvidence(settingsView(engineInput.settingsCompany ?? engineInput.company)) },
    employee: { id: input.employee.id, name: input.employee.name, employeeNo: input.employee.employeeNo ?? null, legalCompanyId: companyId },
  };
}

/** WfCompanyInput -> the company-settings view used by «لماذا؟» (null when no company). */
function settingsView(c: WfCompanyInput | null | undefined): CompanySettingsView | null {
  if (!c) return null;
  return { companyId: c.id, name: c.name, ...(c.costSettings ?? { overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null }) };
}

// Server runners of the phase-2 workforce API: «مخطط السعودة» (estimate + localization + alerts), the
// band solver, «سيناريوهات التوظيف», and the registers. load (src/lib/workforce/load.ts) -> compute (pure
// engine) -> restrict per viewer. Shared by the GET/POST endpoints and by POST /api/workforce/calculations,
// which recomputes from stored params.
import 'server-only';
import { notFound } from '@/lib/http';
import { todayKey } from '@/lib/dates';
import { companySettingsHref } from '@/lib/workforce/company-settings';
import { loadCostContextRows, loadLegalCompanyWorkforce, loadLocalizationDecisions, loadNitaqatRegister, type LegalCompanyWorkforce } from '@/lib/workforce/load';
import {
  AMBIGUOUS_LABEL,
  BAND_LABELS,
  bandRank,
  nitaqatEstimate,
  restrictEstimate,
  restrictFlags,
  type NitaqatActivityRow,
  type NitaqatCurveRow,
  type NitaqatEstimate,
  type RestrictedEstimate,
} from '@/lib/workforce/nitaqat';
import { localizationCompliance, parseDecision, restrictSolve, solveToBand, type ComplianceResult, type LocalizationDecisionRow, type ParsedDecision, type SolveResult } from '@/lib/workforce/saudization';
import { hireScenario, type HireScenarioResult } from '@/lib/workforce/hiring';
import { canSeeDisability } from '@/lib/workforce/privacy';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import type { RuleEvidence } from '@/lib/workforce/types';
import { assumptionEvidence, companySettingsEvidence } from './views';
import type { HireScenarioParams, SaudizationQuery, SolveParams } from './saudization-schemas';

/** Company form anchor of the Nitaqat activity select. */
export function nitaqatSettingsHref(companyId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/edit#company-nitaqat`;
}

export function todayDate(): Date {
  return new Date(`${todayKey()}T00:00:00.000Z`);
}

/**
 * Decisions in force for the engine: the NEWEST row per group name (a correction is a new row; the
 * history stays in the register). Rows sorted by group then createdAt then id.
 */
export function currentDecisions<T extends LocalizationDecisionRow>(rows: ReadonlyArray<T>): T[] {
  const byGroup = new Map<string, T>();
  for (const r of rows) {
    const cur = byGroup.get(r.groupNameAr);
    const t = r.createdAt ? r.createdAt.getTime() : 0;
    const ct = cur?.createdAt ? cur.createdAt.getTime() : 0;
    if (!cur || t > ct || (t === ct && r.id > cur.id)) byGroup.set(r.groupNameAr, r);
  }
  return [...byGroup.values()].sort((a, b) => a.groupNameAr.localeCompare(b.groupNameAr));
}

export interface SaudizationAlert {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  href?: string;
}

export interface CompanySaudization {
  companyId: string;
  companyName: string;
  activityKey: string | null;
  /** Free-text activity of phase 1 (read-only reference). */
  activityText: string | null;
  settingsHref: string;
  estimate: NitaqatEstimate | RestrictedEstimate;
  compliance: ComplianceResult;
  alerts: SaudizationAlert[];
}

/** `canSee` false (viewer may not see disability): no documentation weight in the text (one undocumented disabled Saudi would show "+4"). */
function alertsOf(est: NitaqatEstimate, compliance: ComplianceResult, companyId: string, canSee: boolean): SaudizationAlert[] {
  const out: SaudizationAlert[] = [];
  if (est.status === 'NO_ACTIVITY') out.push({ severity: 'WARNING', code: 'NO_ACTIVITY', message: est.message ?? 'لم يُحدَّد نشاط نطاقات', href: nitaqatSettingsHref(companyId) });
  if (est.undocumented.length) {
    const w = est.undocumented.reduce((s, u) => s + u.potentialWeight, 0);
    out.push({ severity: 'ERROR', code: 'UNDOCUMENTED_QIWA', message: `${est.undocumented.length} عقد سعودي أو خليجي غير موثّق في قوى لا يُحتسب في نطاقات (توثيقه ${canSee ? `يضيف ${Math.round(w * 100) / 100} ` : ''}دون كلفة)` });
  }
  if (est.status === 'OK' && est.band) {
    if (est.band === 'RED') out.push({ severity: 'ERROR', code: 'BAND_RED', message: `النطاق التقديري أحمر (${est.pct}%): ${est.consequences?.items.slice(0, 2).join('، ')}` });
    const down = est.margin.down;
    if (down && (down.expatsBeforeDrop === 0 || down.saudiExitsBeforeDrop === 0)) {
      out.push({ severity: 'WARNING', code: 'BAND_EDGE', message: `على حافة الهبوط إلى ${BAND_LABELS[down.band]}: ${down.saudiExitsBeforeDrop === 0 ? 'خروج سعودي واحد' : 'إضافة وافد واحد'} يُنزل النطاق` });
    }
    const next = est.thresholdsByYear.find((y) => y.year === est.year + 1);
    if (next && bandRank(next.band) < bandRank(est.band)) out.push({ severity: 'WARNING', code: 'NEXT_YEAR_DROP', message: `بثوابت ${next.year} وبالعمالة الحالية يصبح النطاق ${BAND_LABELS[next.band]}` });
    if (est.flags.some((f) => f.code === 'CURVE_AMBIGUOUS')) out.push({ severity: 'WARNING', code: 'CURVE_AMBIGUOUS', message: `ثوابت النشاط ${AMBIGUOUS_LABEL}` });
  }
  for (const it of compliance.items) {
    if (it.applies && it.compliant === false) out.push({ severity: 'WARNING', code: 'LOCALIZATION_SHORTFALL', message: `${it.groupNameAr}: ${it.actualPct ?? 0}% والمطلوب ${it.requiredPct}% — ينقص ${it.shortfallReplacements} سعودي (إحلالاً)` });
    for (const u of it.upcoming) if (u.monthsAway <= 6 && it.total > 0) out.push({ severity: 'INFO', code: 'LOCALIZATION_UPCOMING', message: `${it.groupNameAr}: ${u.pct}% من ${u.effectiveFrom}` });
  }
  return out;
}

interface RegisterData {
  activities: NitaqatActivityRow[];
  curves: NitaqatCurveRow[];
  decisions: ParsedDecision[];
}

async function loadRegisterData(): Promise<RegisterData> {
  const [register, decisionRows] = await Promise.all([loadNitaqatRegister(), loadLocalizationDecisions()]);
  return { activities: register.activities, curves: register.curves, decisions: currentDecisions(decisionRows).map(parseDecision) };
}

function computeCompany(cw: LegalCompanyWorkforce, reg: RegisterData, date: Date, canSee: boolean, average = true): CompanySaudization {
  const key = cw.company.nitaqatActivityKey ?? null;
  const activity = key ? (reg.activities.find((a) => a.key === key) ?? null) : null;
  const est = nitaqatEstimate({ companyId: cw.company.id, companyName: cw.company.name, activity, curves: reg.curves.filter((c) => c.activityKey === key), employees: cw.employees }, date, { average });
  if (key && !activity) {
    est.message = `النشاط المختار (${key}) غير موجود في سجل نطاقات: اختر نشاطاً من إعدادات الشركة`;
  }
  const compliance = localizationCompliance({ companyId: cw.company.id, employees: cw.employees, decisions: reg.decisions }, date);
  const alerts = alertsOf(est, compliance, cw.company.id, canSee);
  return {
    companyId: cw.company.id,
    companyName: cw.company.name,
    activityKey: key,
    activityText: cw.company.nitaqatActivity ?? null,
    settingsHref: nitaqatSettingsHref(cw.company.id),
    estimate: canSee ? est : restrictEstimate(est),
    // Outside HR: no per-employee lists (the undocumented / occupation lists are counts only).
    compliance: canSee
      ? compliance
      : {
          ...compliance,
          items: compliance.items.map((i) => ({ ...i, employees: [] })),
          unknownOccupation: { count: compliance.unknownOccupation.count, employees: [] },
          flags: restrictFlags(compliance.flags),
        },
    alerts,
  };
}

export async function runSaudization(q: SaudizationQuery, viewerRole: string | null | undefined) {
  const date = q.date ?? todayDate();
  const canSee = canSeeDisability(viewerRole);
  const [workforces, reg] = await Promise.all([loadLegalCompanyWorkforce({ companyId: q.companyId ?? null, date }), loadRegisterData()]);
  if (q.companyId && !workforces.length) throw notFound('الشركة غير موجودة');
  const companies = workforces.map((cw) => computeCompany(cw, reg, date, canSee, !q.summary));
  const date10 = date.toISOString().slice(0, 10);
  if (q.summary) {
    return {
      date: date10,
      disclaimer: ESTIMATE_DISCLAIMER,
      canSeeNames: canSee,
      companies: companies.map((c) => ({
        companyId: c.companyId,
        companyName: c.companyName,
        status: c.estimate.status,
        message: c.estimate.message,
        band: c.estimate.band,
        pct: c.estimate.pct,
        x: c.estimate.counts.x,
        activityName: c.estimate.activity?.nameAr ?? null,
        activityStatus: c.estimate.activity?.status ?? null,
        undocumentedCount: c.estimate.counts.undocumented,
        alerts: c.alerts.filter((a) => a.severity !== 'INFO').length,
        settingsHref: c.settingsHref,
      })),
    };
  }
  return { date: date10, disclaimer: ESTIMATE_DISCLAIMER, canSeeNames: canSee, activitiesCount: reg.activities.length, decisionsCount: reg.decisions.length, companies };
}

export type SaudizationResponse = Awaited<ReturnType<typeof runSaudization>>;

async function companyWorkforce(companyId: string, date: Date): Promise<LegalCompanyWorkforce> {
  const [cw] = await loadLegalCompanyWorkforce({ companyId, date });
  if (!cw) throw notFound('الشركة غير موجودة');
  return cw;
}

export async function runSolve(p: SolveParams, viewerRole: string | null | undefined): Promise<{ result: SolveResult; companyName: string; disclaimer: string; settingsHref: string }> {
  const byDate = p.byDate ?? todayDate();
  const [cw, reg, ctx] = await Promise.all([companyWorkforce(p.companyId, byDate), loadRegisterData(), loadCostContextRows()]);
  const key = cw.company.nitaqatActivityKey ?? null;
  const activity = key ? (reg.activities.find((a) => a.key === key) ?? null) : null;
  const result = solveToBand({
    entity: { companyId: cw.company.id, companyName: cw.company.name, activity, curves: reg.curves.filter((c) => c.activityKey === key), employees: cw.employees },
    targetBand: p.targetBand,
    byDate,
    options: p.options,
    cost: { company: cw.company, ...ctx, months: 12 },
  });
  return {
    result: canSeeDisability(viewerRole) ? result : restrictSolve(result, restrictFlags),
    companyName: cw.company.name,
    disclaimer: ESTIMATE_DISCLAIMER,
    settingsHref: nitaqatSettingsHref(cw.company.id),
  };
}

export async function runHireScenario(p: HireScenarioParams): Promise<{ result: HireScenarioResult; assumptionEvidence: Record<string, RuleEvidence>; horizon: number }> {
  const startMonth = p.startMonth ?? todayKey().slice(0, 7);
  const date = new Date(`${startMonth}-01T00:00:00.000Z`);
  const [cw, reg, ctx] = await Promise.all([companyWorkforce(p.companyId, date), loadRegisterData(), loadCostContextRows()]);
  const known = new Set(cw.employees.map((e) => e.id));
  for (const c of p.candidates) if (c.overtimeEmployeeId && !known.has(c.overtimeEmployeeId)) throw notFound('الموظف المختار للعمل الإضافي ليس من موظفي هذه الشركة');
  const key = cw.company.nitaqatActivityKey ?? null;
  const activity = key ? (reg.activities.find((a) => a.key === key) ?? null) : null;
  const result = hireScenario({
    company: cw.company,
    companyEmployees: cw.employees,
    nitaqat: { activity, curves: reg.curves.filter((c) => c.activityKey === key) },
    decisions: reg.decisions,
    ...ctx,
    startMonth,
    candidates: p.candidates,
  });
  const evidence = {
    ...assumptionEvidence(ctx.assumptions, cw.company.id, 'base'),
    ...companySettingsEvidence({ companyId: cw.company.id, name: cw.company.name, ...(cw.company.costSettings ?? { overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null }) }),
  };
  return { result, assumptionEvidence: evidence, horizon: p.months };
}

export { companySettingsHref };

// Decision dashboard aggregation ("لوحة القرار"). PURE: builds on a TrueCostResult.
import { roundMoney } from '@/lib/money';
import { RULE_KEYS as K, gosiRateKey, normalizeStatus, ymd } from '@/lib/workforce/rules';
import { ENGINE_VERSION, ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import type {
  CostLineKey,
  FlagCode,
  GosiRateRow,
  GroupTotals,
  MoneyTriple,
  RuleRow,
  TrueCostResult,
  WfFlag,
  WfStatus,
} from '@/lib/workforce/types';

export interface UpcomingEvent {
  kind: 'RULE' | 'GOSI_RATE';
  key: string;
  label: string;
  /** 'YYYY-MM-DD'. */
  effectiveFrom: string;
  /** First projected month the engine applies it to ('YYYY-MM'). */
  appliesFromMonth: string;
  value: number | null;
  previousValue: number | null;
  unit: string | null;
  status: WfStatus;
  sourceUrl: string | null;
  /** Estimated change of the monthly employer cost for this workforce (null = not estimated). */
  estimatedMonthlyImpact: number | null;
  /** Employees affected in that month (null = not estimated). */
  affected: number | null;
  impactBasis: string;
}

export interface LegalCompanyMix {
  companyId: string;
  name: string;
  isIndustrialLicensed: boolean;
  headcount: number;
  saudi: number;
  gcc: number;
  expat: number;
  exempt: number;
  /** Expats at the 700 rate. */
  within: number;
  /** Expats at the 800 rate. */
  above: number;
  industrialZero: boolean;
  monthlyLevy: number;
  /**
   * Raw ratio saudi ÷ (saudi + expat) × 100 (GCC excluded from both). NOT the Nitaqat weighted rate
   * (weights, caps and 26-week averages come in phase 2).
   */
  rawSaudiRatioPct: number | null;
}

export interface DataQualityItem {
  code: FlagCode;
  severity: WfFlag['severity'];
  /** Number of flags. */
  count: number;
  /** Distinct employees concerned. */
  employees: number;
  /** One example message (Arabic). */
  message: string;
}

export interface OverviewResult {
  engineVersion: string;
  startMonth: string;
  months: number;
  disclaimer: string;
  kpis: {
    thisMonth: MoneyTriple;
    next12: MoneyTriple;
    next36: MoneyTriple;
    headcount: number;
    saudi: number;
    gcc: number;
    expat: number;
    /** Art. 84 liability if every employee were terminated by the employer the day before the first month. */
    eosbLiabilityEmployer: number;
    /** Art. 85 liability if every employee resigned that day. */
    eosbLiabilityResignation: number;
  };
  composition: TrueCostResult['composition'];
  byCompany: GroupTotals[];
  byBranch: GroupTotals[];
  byDepartment: GroupTotals[];
  legalCompanies: LegalCompanyMix[];
  upcomingEvents: UpcomingEvent[];
  dataQuality: DataQualityItem[];
}

/** Keys whose change moves a cost line proportionally (impact = line total × (new/old − 1)). */
const PROPORTIONAL: Record<string, CostLineKey> = {
  [K.WORK_PERMIT_YEAR]: 'WORK_PERMIT',
  [K.IQAMA_YEAR]: 'IQAMA',
  [K.DEPENDENT_MONTH]: 'DEPENDENTS_FEE',
  [K.ERV_SINGLE]: 'EXIT_REENTRY',
};

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Month from which a version starting on `d` applies (first-day convention, see resolveRulesForMonth). */
function appliesFrom(d: Date, hasPrevious: boolean): string {
  if (d.getUTCDate() === 1 || !hasPrevious) return monthKey(d);
  return monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}

export function computeOverview(tc: TrueCostResult, opts: { rules: ReadonlyArray<RuleRow>; gosiRates: ReadonlyArray<GosiRateRow>; asOf?: Date }): OverviewResult {
  const first = tc.monthKeys[0];
  const last = tc.monthKeys[tc.monthKeys.length - 1];
  const asOf = opts.asOf ?? new Date(`${first}-01T00:00:00.000Z`);
  const [ly, lm] = last.split('-').map(Number);
  const horizonEnd = new Date(Date.UTC(ly, lm, 0));
  const monthIdx = new Map(tc.monthKeys.map((k, i) => [k, i]));

  // KPIs
  let saudi = 0;
  let gcc = 0;
  let expat = 0;
  let eosbE = 0;
  let eosbR = 0;
  for (const e of tc.employees) {
    if (e.months[0]?.active) {
      if (e.nationalityClass === 'SAUDI') saudi++;
      else if (e.nationalityClass === 'GCC') gcc++;
      else expat++;
    }
    eosbE += e.liabilities.eosbEmployerAtStart;
    eosbR += e.liabilities.eosbResignationAtStart;
  }

  const legalCompanies: LegalCompanyMix[] = tc.companies.map((c) => {
    const m = c.months[0];
    const denom = m.saudi + m.expat;
    return {
      companyId: c.companyId,
      name: c.name,
      isIndustrialLicensed: c.isIndustrialLicensed,
      headcount: m.headcount,
      saudi: m.saudi,
      gcc: m.gcc,
      expat: m.expat,
      exempt: m.exempt,
      within: m.within,
      above: m.above,
      industrialZero: m.industrialZero,
      monthlyLevy: m.levyTotal,
      rawSaudiRatioPct: denom > 0 ? Math.round((m.saudi / denom) * 10000) / 100 : null,
    };
  });

  // Upcoming regulatory events
  const events: UpcomingEvent[] = [];
  const byKey = new Map<string, RuleRow[]>();
  for (const r of opts.rules) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  for (const [key, list] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    sorted.forEach((r, idx) => {
      const t = r.effectiveFrom.getTime();
      if (t <= asOf.getTime() || t > horizonEnd.getTime()) return;
      const prev = idx > 0 ? sorted[idx - 1] : null;
      const applies = appliesFrom(r.effectiveFrom, !!prev);
      const i = monthIdx.get(applies);
      let impact: number | null = null;
      let affected: number | null = null;
      let impactBasis = 'غير مقدَّر آلياً';
      const newV = typeof r.value === 'number' ? r.value : null;
      const oldV = prev && typeof prev.value === 'number' ? prev.value : null;
      if (i !== undefined && newV !== null) {
        if (key === K.LEVY_WITHIN || key === K.LEVY_ABOVE) {
          const count = tc.companies.reduce((s, c) => s + (key === K.LEVY_WITHIN ? c.months[i].within : c.months[i].above), 0);
          affected = count;
          impact = roundMoney((newV - (oldV ?? 0)) * count);
          impactBasis = `(${newV} − ${oldV ?? 0}) × ${count} وافد`;
        } else if (PROPORTIONAL[key] && oldV) {
          const lineKey = PROPORTIONAL[key];
          const ref = i > 0 ? tc.series[i - 1].byLine[lineKey] ?? 0 : tc.series[i].byLine[lineKey] ?? 0;
          impact = roundMoney(i > 0 ? ref * (newV / oldV - 1) : ref - ref * (oldV / newV));
          impactBasis = `إجمالي البند × (${newV} ÷ ${oldV} − 1)`;
        } else if (key === K.INDUSTRIAL_LEVY_CANCELLED) {
          const saved = tc.companies.filter((c) => c.isIndustrialLicensed).reduce((s, c) => s + (i > 0 ? c.months[i - 1].levyTotal : 0), 0);
          impact = roundMoney(-saved);
          impactBasis = 'إلغاء المقابل المالي للمنشآت الصناعية المرخّصة';
        }
      }
      events.push({
        kind: 'RULE',
        key,
        label: r.label ?? key,
        effectiveFrom: ymd(r.effectiveFrom)!,
        appliesFromMonth: applies,
        value: newV,
        previousValue: oldV,
        unit: r.unit ?? null,
        status: normalizeStatus(r.status),
        sourceUrl: r.sourceUrl ?? null,
        estimatedMonthlyImpact: impact,
        affected,
        impactBasis,
      });
    });
  }

  const rateGroups = new Map<string, GosiRateRow[]>();
  for (const r of opts.gosiRates) {
    const g = `${r.regime}|${r.isSaudi}`;
    const list = rateGroups.get(g) ?? [];
    list.push(r);
    rateGroups.set(g, list);
  }
  for (const [, list] of [...rateGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    sorted.forEach((r, idx) => {
      const t = r.effectiveFrom.getTime();
      if (t <= asOf.getTime() || t > horizonEnd.getTime()) return;
      const prev = idx > 0 ? sorted[idx - 1] : null;
      const applies = appliesFrom(r.effectiveFrom, !!prev);
      const i = monthIdx.get(applies);
      let impact: number | null = null;
      let affected: number | null = null;
      const delta = r.employerRate - (prev?.employerRate ?? 0);
      if (i !== undefined) {
        let wageSum = 0;
        affected = 0;
        for (const e of tc.employees) {
          const mo = e.months[i];
          if (!mo?.active || mo.gosiRegimeUsed !== String(r.regime)) continue;
          if ((e.nationalityClass === 'SAUDI') !== r.isSaudi) continue;
          affected++;
          wageSum += mo.contributoryWage * mo.factor;
        }
        impact = roundMoney((wageSum * delta) / 100);
      }
      events.push({
        kind: 'GOSI_RATE',
        key: gosiRateKey({ regime: String(r.regime), isSaudi: r.isSaudi, effectiveFrom: r.effectiveFrom }),
        label: `تأمينات ${r.regime === 'NEW' ? 'النظام الجديد' : 'النظام القديم'} (${r.isSaudi ? 'سعودي' : 'غير سعودي'}): صاحب العمل ${prev?.employerRate ?? '—'}% ← ${r.employerRate}%`,
        effectiveFrom: ymd(r.effectiveFrom)!,
        appliesFromMonth: applies,
        value: r.employerRate,
        previousValue: prev?.employerRate ?? null,
        unit: 'PERCENT',
        status: r.isProvisional ? 'PROVISIONAL' : 'VERIFIED_PRIMARY',
        sourceUrl: null,
        estimatedMonthlyImpact: impact,
        affected,
        impactBasis: `${delta >= 0 ? '+' : ''}${Math.round(delta * 10000) / 10000}% × الأجور الخاضعة للمتأثرين`,
      });
    });
  }
  events.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.key.localeCompare(b.key));

  // Data quality
  const dq = new Map<FlagCode, { severity: WfFlag['severity']; count: number; emps: Set<string>; message: string }>();
  for (const f of tc.flags) {
    const d = dq.get(f.code) ?? { severity: f.severity, count: 0, emps: new Set<string>(), message: f.message };
    d.count++;
    if (f.employeeId) d.emps.add(f.employeeId);
    dq.set(f.code, d);
  }
  const sevRank = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  const dataQuality: DataQualityItem[] = [...dq.entries()]
    .map(([code, d]) => ({ code, severity: d.severity, count: d.count, employees: d.emps.size, message: d.message }))
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.count - a.count || a.code.localeCompare(b.code));

  return {
    engineVersion: ENGINE_VERSION,
    startMonth: first,
    months: tc.monthKeys.length,
    disclaimer: ESTIMATE_DISCLAIMER,
    kpis: {
      thisMonth: tc.totals.month1,
      next12: tc.totals.next12,
      next36: tc.totals.next36,
      headcount: tc.series[0]?.headcount ?? 0,
      saudi,
      gcc,
      expat,
      eosbLiabilityEmployer: roundMoney(eosbE),
      eosbLiabilityResignation: roundMoney(eosbR),
    },
    composition: tc.composition,
    byCompany: tc.byCompany,
    byBranch: tc.byBranch,
    byDepartment: tc.byDepartment,
    legalCompanies,
    upcomingEvents: events,
    dataQuality,
  };
}

// Server side of «حساسية القرار» (SPEC §11): validates the decision, loads the SAME engine inputs as the
// decision's own endpoint (hire-scenario / exit-cost / plans/[id]) and runs the pure
// src/lib/workforce/sensitivity.ts. Shared by /api/workforce/sensitivity and the Excel export. Read-only.
import 'server-only';
import { z } from 'zod';
import { badRequest, notFound } from '@/lib/http';
import { zId } from '@/lib/validation';
import { loadCostContextRows, loadLegalCompanyWorkforce, loadLocalizationDecisions, loadNitaqatRegister } from '@/lib/workforce/load';
import { parseDecision } from '@/lib/workforce/saudization';
import { attachReference, exitSensitivity, hireSensitivity, planSensitivity, RANGE_FACTOR_KEYS, type RangeOverrides, type SensitivityResult } from '@/lib/workforce/sensitivity';
import type { HireScenarioInput } from '@/lib/workforce/hiring';
import type { RuleEvidence } from '@/lib/workforce/types';
import { exitCostSchema } from '../_lib/schemas';
import { hireScenarioSchema } from '../_lib/saudization-schemas';
import { currentDecisions } from '../_lib/saudization';
import { runExitCost } from '../_lib/server';
import { assumptionEvidence, companySettingsEvidence, ASSUMPTION_BOUNDS } from '../_lib/views';
import { frozenProjection, loadPlanBase, loadPlanOr404, toDefinition, turnoverAsOfFor } from '../plans/_lib/server';
import { assertCompanyVisible, type WfScope } from '../_lib/scope';
import { formatMoney } from '@/lib/money';
import { todayKey } from '@/lib/dates';

const toNumber = (v: unknown) => (v === '' || v === null || v === undefined ? undefined : typeof v === 'string' ? Number(v) : v);

/** Ranges given for this calculation only (never stored): {KEY: {low, base?, high}} within the assumption bounds. */
export const rangesSchema = z
  .object(
    Object.fromEntries(
      RANGE_FACTOR_KEYS.map((k) => {
        const b = ASSUMPTION_BOUNDS[k] ?? { min: 0, max: 1_000_000 };
        const n = z.preprocess(toNumber, z.number({ invalid_type_error: 'نطاق غير صالح' }).finite().min(b.min, 'النطاق خارج المسموح').max(b.max, 'النطاق خارج المسموح'));
        return [k, z.object({ low: n, base: n.optional(), high: n }).strict().refine((r) => r.low <= r.high, 'المنخفض يجب أن يكون ≤ المرتفع').optional()];
      }),
    ) as unknown as Record<(typeof RANGE_FACTOR_KEYS)[number], z.ZodTypeAny>,
  )
  .strict()
  .optional();

export const SENSITIVITY_DECISIONS = ['hire', 'exit', 'plan'] as const;
export type SensitivityDecisionParam = (typeof SENSITIVITY_DECISIONS)[number];

export const sensitivityBodySchema = z.discriminatedUnion(
  'decision',
  [
    z.object({ decision: z.literal('hire'), params: hireScenarioSchema, ranges: rangesSchema }).strict(),
    z.object({ decision: z.literal('exit'), params: exitCostSchema, ranges: rangesSchema }).strict(),
    z.object({ decision: z.literal('plan'), planId: zId, ranges: rangesSchema }).strict(),
  ],
  { errorMap: () => ({ message: 'نوع القرار: hire أو exit أو plan' }) },
);
export type SensitivityBody = z.infer<typeof sensitivityBodySchema>;

export const sensitivityQuerySchema = z.object({ decision: z.literal('plan', { errorMap: () => ({ message: 'الطلب بـ GET لخطة فقط (decision=plan&planId=…)؛ السيناريو والإنهاء بـ POST' }) }), planId: zId });

export interface SensitivityRun {
  result: SensitivityResult;
  /** «لماذا؟» evidence of the assumptions / company settings (sources sheet). */
  evidence: RuleEvidence[];
  /** Short description for the audit row (no names). */
  subject: Record<string, unknown>;
}

/** `s` = the caller's company scope (the employee, company or plan must be inside it: 404 otherwise). */
export async function runSensitivity(body: SensitivityBody, s: WfScope): Promise<SensitivityRun> {
  const ranges = (body.ranges ?? null) as RangeOverrides | null;
  if (body.decision === 'exit') {
    const out = await runExitCost(body.params, s);
    const result = exitSensitivity(out.input, { ranges });
    return { result, evidence: Object.values(out.assumptionEvidence), subject: { decision: 'exit', employeeId: body.params.employeeId, exitReason: body.params.exitReason } };
  }
  if (body.decision === 'plan') {
    const row = await loadPlanOr404(body.planId, s);
    const base = await loadPlanBase(row);
    const result = planSensitivity(base, toDefinition(row), { turnoverAsOf: turnoverAsOfFor(row.fromMonth), ranges });
    // An approved plan is judged against the projection frozen at approval: show both numbers.
    const frozen = row.status === 'APPROVED' || row.status === 'ARCHIVED' ? await frozenProjection(row.id) : null;
    if (frozen) {
      const t = frozen.projection.totals.horizon;
      const ref = attachReference(result, { label: 'المعتمد (اللقطة المجمّدة عند الاعتماد)', createdAt: frozen.createdAt, values: { total: t?.totalAfterHrdf ?? null, delta: t?.deltaAfterHrdf ?? null } });
      const live = result.outcomes.find((o) => o.id === 'total')?.base ?? 0;
      const approved = ref.values.total ?? null;
      const diff = ref.diffs.total ?? null;
      result.notes.unshift(
        approved === null || diff === null
          ? 'الخطة معتمدة: الأرقام هنا حساب حي بالبيانات الحالية.'
          : `الخطة معتمدة: الإجمالي المعتمد في لقطة الاعتماد ${formatMoney(approved)} ر.س، والأرقام هنا حساب حي بالبيانات الحالية (${formatMoney(live)} ر.س، الفرق ${formatMoney(diff)} ر.س). الحساسية تُقاس حول الحساب الحي.`,
      );
    }
    const cid = row.companyId ?? null;
    const settings = cid ? base.companies.find((c) => c.id === cid) : null;
    const evidence = [
      ...Object.values(assumptionEvidence(base.assumptions, cid, 'base')),
      ...(settings ? Object.values(companySettingsEvidence({ companyId: settings.id, name: settings.name, ...(settings.costSettings ?? { overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null }) })) : []),
    ];
    return { result, evidence, subject: { decision: 'plan', planId: row.id } };
  }
  const p = body.params;
  const input = await hireInput(p, s);
  const result = hireSensitivity(input, { horizon: p.months as 12 | 24 | 36, ranges });
  const c = input.company;
  const evidence = [
    ...Object.values(assumptionEvidence(input.assumptions, c.id, 'base')),
    ...Object.values(companySettingsEvidence({ companyId: c.id, name: c.name, ...(c.costSettings ?? { overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null }) })),
  ];
  return { result, evidence, subject: { decision: 'hire', companyId: p.companyId, candidates: p.candidates.map((x) => x.kind), months: p.months } };
}

/** The engine input of POST /api/workforce/hire-scenario (same loading as _lib/saudization.ts runHireScenario). */
async function hireInput(p: z.infer<typeof hireScenarioSchema>, s: WfScope): Promise<HireScenarioInput> {
  assertCompanyVisible(s, p.companyId);
  const startMonth = p.startMonth ?? todayKey().slice(0, 7);
  const date = new Date(`${startMonth}-01T00:00:00.000Z`);
  const [workforces, register, decisionRows, ctx] = await Promise.all([
    loadLegalCompanyWorkforce({ companyId: p.companyId, date, companyIds: s.companyIds }),
    loadNitaqatRegister(),
    loadLocalizationDecisions(),
    loadCostContextRows(undefined, s.companyIds),
  ]);
  const cw = workforces[0];
  if (!cw) throw notFound('الشركة غير موجودة');
  const known = new Set(cw.employees.map((e) => e.id));
  for (const c of p.candidates) if (c.overtimeEmployeeId && !known.has(c.overtimeEmployeeId)) throw notFound('الموظف المختار للعمل الإضافي ليس من موظفي هذه الشركة');
  const key = cw.company.nitaqatActivityKey ?? null;
  const activity = key ? (register.activities.find((a) => a.key === key) ?? null) : null;
  return {
    company: cw.company,
    companyEmployees: cw.employees,
    nitaqat: { activity, curves: register.curves.filter((c) => c.activityKey === key) },
    decisions: currentDecisions(decisionRows).map(parseDecision),
    ...ctx,
    startMonth,
    candidates: p.candidates,
  };
}

/** Parses the GET query (plan only) into a body. */
export function bodyFromQuery(q: Record<string, string>): SensitivityBody {
  const r = sensitivityQuerySchema.safeParse(q);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'بيانات الطلب غير صالحة');
  return { decision: 'plan', planId: r.data.planId };
}


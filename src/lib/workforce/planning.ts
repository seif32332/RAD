// Workforce plan («خطة القوى العاملة», SPEC module 6 and §8). PURE, deterministic (no clock: the caller passes
// every date), client-safe.
//
// A plan is SCENARIO data: planned hires, backfills, exits and raises live only in the plan tables
// (HeadcountPlan / PlannedPosition / PlanRaise). Nothing here writes Employee, SalaryChange, Allowance or
// Payroll: turning a plan into real salary changes belongs to the money gateway.
//
// projectPlan() — month by month over plan.months from plan.fromMonth:
// - Baseline: the current workforce of the plan scope (legal company, or all) priced by THE true cost
//   engine (computeTrueCost) with every other employee of the same legal companies (levy tiers).
// - NEW_HIRE / BACKFILL: hypothetical employees (as hiring.ts candidates) from their start month. A BACKFILL
//   names the leaver and starts at max(requested start, leaver's exit month) — the exit month is a
//   handover month when both coincide. The leaver's exit is the plan's EXIT position for that employee, else
//   the exit already recorded in the file (termination / contract end).
// - EXIT: the employee's costs stop after the last day of the exit month; the exit cost of computeExitCost
//   (the settlement screen's EOSB + notice + leave payout, notice assumed served) is a ONE-OFF line in that
//   month, and the EOSB provision already counted in the plan months for that employee (EOSB_ACCRUAL lines)
//   is released in the same month so the award is not counted twice.
// - PlanRaise: from the effective month, for the scope (ALL / COMPANY / DEPARTMENT / EMPLOYEE), employees
//   (and planned hires) employed before that month: pct of the basic in force that month, or a fixed amount;
//   the delta stays on top of later dated SalaryChange rows. The plan's raises REPLACE the ANNUAL_RAISE_PCT
//   assumption (a plan states its raises explicitly). They reach the engine as in-memory planned
//   SalaryChange inputs only.
// - ATTRITION: an annual rate r (plan.attritionPct, else the organisation's actual trailing-12-month
//   turnover) gives a separate statistical line −(1 − (1 − r)^(i/12)) × cost of the current employees without
//   a planned exit in month i (i = months since the plan start). No named person is removed.
// - Nitaqat at the end of every plan year per legal company (nitaqatEstimate with the planned workforce and
//   the planned wages) next to the same estimate without the plan; levy tiers per company with / without.
import { roundMoney } from '@/lib/money';
import { nationalityClass, type NationalityClass } from '@/lib/nationality';
import { computeTrueCost, COST_LINE_META, COST_LINE_ORDER } from '@/lib/workforce/true-cost';
import { computeExitCost } from '@/lib/workforce/exit-cost';
import { activeDays, addMonthsYm, fmt, monthEndUtc, monthStartUtc, parseMonth } from '@/lib/workforce/formulas';
import { candidateAllowances } from '@/lib/workforce/hiring';
import { BAND_LABELS, WAGE_FULL_WEIGHT, WAGE_HALF_WEIGHT, bandRank, nitaqatEstimate, nitaqatWage, type NitaqatActivityRow, type NitaqatBand, type NitaqatCurveRow } from '@/lib/workforce/nitaqat';
import { localizationCompliance, parseDecision, type LocalizationDecisionRow, type ParsedDecision } from '@/lib/workforce/saudization';
import { EMPLOYEE_EXIT_REASONS, EXIT_REASON_TO_TERMINATION, resolveTerminationReason, type EmployeeExitReason } from '@/lib/workforce/reasons';
import { ENGINE_VERSION, ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { MIN_GROUP_SIZE, SCOPE_SUPPRESSED_REASON, trailingTurnoverRate, type BmEmployee } from '@/lib/workforce/benchmarks';
import type { SettlementLeaveLike, SettlementLoanLike } from '@/lib/settlement';
import type {
  CostLineKey,
  CostLineKind,
  EmployeeCostResult,
  ExitLine,
  LineExplanation,
  MoneyTriple,
  RuleEvidence,
  RuleVersionRef,
  Scenario,
  TrueCostInput,
  TrueCostResult,
  WfEmployeeInput,
} from '@/lib/workforce/types';

/** Version of the plan layer (the cost engine version is ENGINE_VERSION). */
export const PLAN_ENGINE_VERSION = 'wf-plan-1.0.0';

// ---------------------------------------------------------------------------
// Lists and labels
// ---------------------------------------------------------------------------

export const PLAN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ARCHIVED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  DRAFT: 'مسودة',
  SUBMITTED: 'مقدَّمة للاعتماد',
  APPROVED: 'معتمدة',
  REJECTED: 'مرفوضة',
  ARCHIVED: 'مؤرشفة',
};

export const PLAN_MONTHS = [12, 24, 36] as const;
export type PlanMonths = (typeof PLAN_MONTHS)[number];

/**
 * Arabic count of months with the number agreement of the counted noun: 1 → «شهر واحد», 2 → «شهران»
 * («شهرين» after a preposition or as an object: `oblique`), 3–10 → «N أشهر», 11 and more (and 0) → «N شهراً».
 */
export function arabicMonths(n: number, oblique = false): string {
  if (n === 1) return 'شهر واحد';
  if (n === 2) return oblique ? 'شهرين' : 'شهران';
  if (n >= 3 && n <= 10) return `${n} أشهر`;
  return `${n} شهراً`;
}

/**
 * Plan vs actual: an actual joiner may fill a planned NEW_HIRE / BACKFILL only when the planned (effective)
 * start month ≤ the join month + this tolerance (months). Joining later than planned is a late fill;
 * joining more than a month before the planned start is an unplanned hire.
 */
export const PVA_START_TOLERANCE_MONTHS = 1;

export const POSITION_KINDS = ['NEW_HIRE', 'BACKFILL', 'EXIT'] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];
export const POSITION_KIND_LABELS: Record<PositionKind, string> = { NEW_HIRE: 'تعيين جديد', BACKFILL: 'إحلال (بديل)', EXIT: 'خروج مخطط' };

export const RAISE_SCOPES = ['ALL', 'COMPANY', 'DEPARTMENT', 'EMPLOYEE'] as const;
export type RaiseScope = (typeof RAISE_SCOPES)[number];
export const RAISE_SCOPE_LABELS: Record<RaiseScope, string> = { ALL: 'كل موظفي الخطة', COMPANY: 'شركة', DEPARTMENT: 'إدارة', EMPLOYEE: 'موظف' };

export const PLAN_NATIONALITY_CLASSES = ['SAUDI', 'EXPAT', 'GCC'] as const;
export type PlanNationalityClass = (typeof PLAN_NATIONALITY_CLASSES)[number];
export const PLAN_NATIONALITY_LABELS: Record<PlanNationalityClass, string> = { SAUDI: 'سعودي', EXPAT: 'وافد', GCC: 'خليجي' };

/** Exit reasons usable in a plan: those with a settlement reason (MUTUAL_AGREEMENT / OTHER need a choice). */
export const PLAN_EXIT_REASONS = EMPLOYEE_EXIT_REASONS.filter((r) => EXIT_REASON_TO_TERMINATION[r].terminationReason !== null) as EmployeeExitReason[];

/** Arabic labels (copy of the employee form's EXIT_REASON_LABELS: the lib layer does not import src/app). */
export const PLAN_EXIT_REASON_LABELS: Record<EmployeeExitReason, string> = {
  RESIGNATION: 'استقالة',
  EMPLOYER_TERMINATION: 'إنهاء من صاحب العمل',
  CONTRACT_END: 'انتهاء مدة العقد',
  MUTUAL_AGREEMENT: 'اتفاق الطرفين',
  ARTICLE_80: 'فصل وفق المادة 80',
  PROBATION: 'إنهاء خلال فترة التجربة',
  RETIREMENT: 'تقاعد',
  DEATH: 'وفاة',
  ABSCONDING: 'انقطاع عن العمل (تغيّب)',
  OTHER: 'سبب آخر',
};

// ---------------------------------------------------------------------------
// Versions and approval (maker-checker)
// ---------------------------------------------------------------------------

/** Who may create / edit / copy / submit a plan (= ROLE_GROUPS.WORKFORCE). */
export const PLAN_EDIT_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER', 'HR_MANAGER'] as const;
/** Who may approve / reject a submitted plan (= ROLE_GROUPS.OWNER). */
export const PLAN_DECIDE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN'] as const;

export type PlanAction = 'EDIT' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ARCHIVE' | 'COPY';

export type PlanDecision = { ok: true; nextStatus: PlanStatus } | { ok: false; httpStatus: 403 | 409; message: string };

const isStatus = (s: string): s is PlanStatus => (PLAN_STATUSES as ReadonlyArray<string>).includes(s);

/**
 * The version / approval rules of a plan (pure; the routes enforce them and write the audit):
 * - EDIT (header, positions, raises): DRAFT or REJECTED only; APPROVED plans are read-only (copy them).
 * - SUBMIT: DRAFT / REJECTED -> SUBMITTED by HR_MANAGER, FINANCE_MANAGER, COMPANY_ADMIN, SUPER_ADMIN.
 * - APPROVE / REJECT: SUBMITTED only, by an OWNER role (SUPER_ADMIN, COMPANY_ADMIN), never by the user who
 *   submitted it, nor by the user who created it, nor by any author of its content (`authorIds`: every user
 *   with a CREATE / UPDATE / DELETE audit row of the plan header, its positions or its raises, submissions
 *   included) — maker-checker, no override. Unknown submitter -> refused.
 * - ARCHIVE: DRAFT / REJECTED by the editing roles, APPROVED by an OWNER role; a SUBMITTED plan is decided
 *   first.
 * - COPY: any status, editing roles; the copy is a new DRAFT (basedOnId).
 */
export function decidePlanAction(i: {
  action: PlanAction;
  status: string;
  actorId: string;
  actorRole: string;
  createdById?: string | null;
  submittedById?: string | null;
  /** Users who authored the plan's content (audit rows of the header, positions and raises). */
  authorIds?: ReadonlyArray<string> | null;
}): PlanDecision {
  const status: PlanStatus = isStatus(i.status) ? i.status : 'DRAFT';
  const canEdit = (PLAN_EDIT_ROLES as ReadonlyArray<string>).includes(i.actorRole);
  const canDecide = (PLAN_DECIDE_ROLES as ReadonlyArray<string>).includes(i.actorRole);
  const label = PLAN_STATUS_LABELS[status];
  const deny = (message: string): PlanDecision => ({ ok: false, httpStatus: 403, message });
  const conflict = (message: string): PlanDecision => ({ ok: false, httpStatus: 409, message });
  switch (i.action) {
    case 'COPY':
      return canEdit ? { ok: true, nextStatus: 'DRAFT' } : deny('ليس لديك صلاحية نسخ الخطط');
    case 'EDIT':
      if (!canEdit) return deny('ليس لديك صلاحية تعديل الخطط');
      if (status === 'DRAFT' || status === 'REJECTED') return { ok: true, nextStatus: status };
      return conflict(status === 'APPROVED' ? 'الخطة معتمدة ولا تُعدَّل: انسخها لإنشاء نسخة جديدة' : `الخطة ${label}: لا تُعدَّل إلا المسودة أو المرفوضة`);
    case 'SUBMIT':
      if (!canEdit) return deny('ليس لديك صلاحية تقديم الخطط');
      if (status === 'DRAFT' || status === 'REJECTED') return { ok: true, nextStatus: 'SUBMITTED' };
      return conflict(`الخطة ${label}: لا تُقدَّم إلا المسودة أو المرفوضة`);
    case 'APPROVE':
    case 'REJECT': {
      if (!canDecide) return deny('اعتماد الخطة أو رفضها للمالك وصاحب العمل فقط');
      if (status !== 'SUBMITTED') return conflict(`الخطة ${label}: لا يُعتمد أو يُرفض إلا ما قُدِّم للاعتماد`);
      if (!i.submittedById) return conflict('تعذر معرفة من قدّم الخطة: أعد تقديمها ثم اعتمدها');
      if (i.submittedById === i.actorId) return deny('لا يعتمد الخطة أو يرفضها من قدّمها (الفصل بين المُعِدّ والمعتمِد)');
      if (i.createdById && i.createdById === i.actorId) return deny('لا يعتمد الخطة أو يرفضها من أنشأها (الفصل بين المُعِدّ والمعتمِد)');
      if (i.authorIds?.includes(i.actorId)) return deny('لا يعتمد الخطة أو يرفضها من شارك في إعدادها: عدّل بياناتها أو بنودها أو زياداتها أو قدّمها من قبل (الفصل بين المُعِدّ والمعتمِد)');
      return { ok: true, nextStatus: i.action === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
    }
    case 'ARCHIVE':
      if (status === 'ARCHIVED') return conflict('الخطة مؤرشفة من قبل');
      if (status === 'SUBMITTED') return conflict('الخطة مقدَّمة للاعتماد: تُعتمد أو تُرفض أولاً');
      if (status === 'APPROVED') return canDecide ? { ok: true, nextStatus: 'ARCHIVED' } : deny('أرشفة الخطة المعتمدة للمالك وصاحب العمل فقط');
      return canEdit ? { ok: true, nextStatus: 'ARCHIVED' } : deny('ليس لديك صلاحية أرشفة الخطط');
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanPositionInput {
  id: string;
  kind: string;
  title: string;
  companyId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  nationalityClass?: string | null;
  gosiRegime?: string | null;
  gender?: string | null;
  occupationName?: string | null;
  basicSalary?: number | null;
  housingAllowance?: number | null;
  otherAllowances?: number | null;
  dependentsCount?: number | null;
  medicalClass?: string | null;
  /** First day of the month (or 'YYYY-MM'). */
  startMonth?: Date | string | null;
  exitEmployeeId?: string | null;
  exitMonth?: Date | string | null;
  exitReason?: string | null;
  notes?: string | null;
}

export interface PlanRaiseInput {
  id: string;
  scope: string;
  scopeId?: string | null;
  pct?: number | null;
  amount?: number | null;
  effectiveMonth: Date | string;
  notes?: string | null;
}

export interface PlanDefinition {
  id: string;
  name: string;
  /** Legal company of the plan (null = every company). */
  companyId?: string | null;
  fromMonth: Date | string;
  months: number;
  /** Annual attrition % (null = the organisation's actual trailing-12-month turnover; 0 = none). */
  attritionPct?: number | null;
  positions: ReadonlyArray<PlanPositionInput>;
  raises: ReadonlyArray<PlanRaiseInput>;
}

/** Join / leave dates for the turnover rate (every employee ever, terminated ones included). */
export interface TurnoverEmployee {
  id: string;
  joinDate: Date;
  terminationDate?: Date | null;
  isTerminated?: boolean | null;
  legalCompanyId?: string | null;
}

export interface PlanBaseInput extends TrueCostInput {
  /** Leaves and loans of the employees with a planned EXIT (exit cost, as the settlement screen loads them). */
  exitDetails?: Readonly<Record<string, { leaves: ReadonlyArray<SettlementLeaveLike>; loans: ReadonlyArray<SettlementLoanLike> }>>;
  /** Nitaqat register (activities and curves); null = no Nitaqat estimate. */
  nitaqat?: { activities: ReadonlyArray<NitaqatActivityRow>; curves: ReadonlyArray<NitaqatCurveRow> } | null;
  /** Localization decisions in force (newest row per group). */
  decisions?: ReadonlyArray<LocalizationDecisionRow | ParsedDecision>;
  branches?: ReadonlyArray<{ id: string; name: string; city?: string | null }>;
  departments?: ReadonlyArray<{ id: string; name: string }>;
  /** For the default attrition rate (planTurnover). */
  turnoverEmployees?: ReadonlyArray<TurnoverEmployee>;
}

export interface PlanProjectOptions {
  scenario?: Scenario;
  /** Date of the default attrition rate (trailing 12 months up to it). Omitted = no default rate. */
  turnoverAsOf?: Date | null;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type PlanFlagCode =
  | 'SAUDI_WAGE_BELOW_NITAQAT'
  | 'EXIT_LOCALIZATION_SHORTFALL'
  | 'BACKFILL_NO_EXIT'
  | 'EXIT_EMPLOYEE_UNKNOWN'
  | 'EXIT_OUTSIDE_PLAN'
  | 'EXIT_ALREADY_RECORDED'
  | 'DUPLICATE_EXIT'
  | 'START_OUTSIDE_PLAN'
  | 'START_BEFORE_PLAN'
  | 'OUTSIDE_SCOPE'
  | 'EXIT_REASON_NEEDS_CHOICE'
  | 'EXIT_DETAILS_MISSING'
  | 'POSITION_INCOMPLETE'
  | 'RAISE_NO_MATCH'
  | 'RAISE_OUTSIDE_PLAN'
  | 'ATTRITION_DEFAULT'
  | 'ATTRITION_NO_HISTORY'
  | 'ANNUAL_RAISE_REPLACED'
  | 'NITAQAT_BAND_DROP'
  | 'NITAQAT_NOT_ESTIMATED';

export interface PlanFlag {
  code: PlanFlagCode;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  positionId?: string;
  raiseId?: string;
  companyId?: string;
}

export interface PlanHeadcount {
  total: number;
  saudi: number;
  gcc: number;
  expat: number;
  /** Planned hires / backfills active in the month. */
  hires: number;
  /** Current employees (of the scope) no longer employed because of a planned exit. */
  plannedExits: number;
}

export interface PlanMonth extends MoneyTriple {
  month: string;
  headcount: PlanHeadcount;
  /** Statistical leavers (attrition), not removed from the head count. */
  expectedLeavers: number;
  /** Salary + recurring allowances + employer GOSI (the part comparable with payroll). */
  comparable: number;
  levy: number;
  exitOneOff: number;
  exitAccrualRelease: number;
  attrition: MoneyTriple;
  /** cost + exit lines + attrition cost. */
  totalBeforeHrdf: number;
  /** net + exit lines + attrition net. */
  totalAfterHrdf: number;
  /** Same workforce without the plan (current employees, no raises / hires / exits). */
  baseline: MoneyTriple & { headcount: number };
}

export interface PlanWindow extends MoneyTriple {
  months: number;
  comparable: number;
  levy: number;
  exitOneOff: number;
  exitAccrualRelease: number;
  attrition: MoneyTriple;
  totalBeforeHrdf: number;
  totalAfterHrdf: number;
  baseline: MoneyTriple;
  /** totalAfterHrdf − baseline.net: what the plan adds. */
  deltaAfterHrdf: number;
}

export type PlanWindowKey = '12' | '24' | '36' | 'horizon';

export interface PlanItemLine {
  key: CostLineKey;
  label: string;
  kind: CostLineKind;
  amount: number;
}

export interface PlanItemResult {
  positionId: string;
  kind: PositionKind;
  title: string;
  /** Engine id: 'plan:<positionId>' for a hire, the employee id for an exit. */
  employeeId: string | null;
  employeeName: string | null;
  companyId: string | null;
  departmentId: string | null;
  nationalityClass: NationalityClass | null;
  /** 'YYYY-MM' of the (effective) start; null for an exit or when not computed. */
  start: string | null;
  /** 'YYYY-MM' of the exit (exit, or the leaver of a backfill). */
  exit: string | null;
  lastWorkingDate: string | null;
  computed: boolean;
  firstMonthCost: number;
  /** Hire: its cost. Exit: its change (plan − the same employee staying), negative = saving. One-offs apart. */
  windows: Partial<Record<PlanWindowKey, MoneyTriple>>;
  lines: PlanItemLine[];
  exitCost: {
    reason: string;
    reasonLabel: string;
    settlementReason: string;
    payable: number;
    accrualRelease: number;
    risk: number;
    netToEmployee: number;
    yearsOfService: number;
    wageUsed: number;
    levyDeltaMonthly: number | null;
    lines: ExitLine[];
  } | null;
  why: string[];
  flags: PlanFlag[];
}

export interface PlanRaiseResult {
  raiseId: string;
  scope: RaiseScope;
  scopeId: string | null;
  pct: number | null;
  amount: number | null;
  effectiveMonth: string;
  employees: number;
  /** Sum of the monthly basic increases in the effective month. */
  basicDeltaMonthly: number;
  /** Basic increase over the plan (prorated for partial months). */
  basicDeltaTotal: number;
  why: string[];
  flags: PlanFlag[];
}

export interface NitaqatBrief {
  status: string;
  message: string | null;
  band: NitaqatBand | null;
  pct: number;
  x: number;
  saudiWeighted: number;
  expats: number;
}

export interface PlanCompanyYear {
  yearIndex: number;
  month: string;
  date: string;
  nitaqat: { plan: NitaqatBrief; baseline: NitaqatBrief; change: 'UP' | 'DOWN' | 'SAME' | null } | null;
  levy: {
    plan: { saudi: number; expat: number; within: number; above: number; exempt: number; levyTotal: number };
    baseline: { saudi: number; expat: number; within: number; above: number; exempt: number; levyTotal: number };
  };
}

export interface PlanCompanyResult {
  companyId: string;
  name: string;
  years: PlanCompanyYear[];
  /** Company levy with the plan − without, per window (all of the company's expats). */
  levyDelta: Partial<Record<PlanWindowKey, number>>;
}

export interface PlanTurnover {
  from: string;
  to: string;
  /** null when the scope is too small to show (below 5 on average). */
  leavers: number | null;
  avgHeadcount: number | null;
  /** Percent over the 12 months (null = not available). */
  ratePct: number | null;
  basis: string;
}

/** One person of the plan (employee or planned hire): monthly planned amounts for plan-vs-actual. */
export interface PlanPerson {
  id: string;
  kind: 'EMPLOYEE' | 'HIRE';
  positionId: string | null;
  name: string;
  employeeNo: string | null;
  legalCompanyId: string | null;
  departmentId: string | null;
  nationalityClass: NationalityClass;
  /** Salary + recurring allowances + employer GOSI per plan month. */
  comparable: number[];
  gosi: number[];
  plannedExitMonth: string | null;
}

export interface PlanExplanation extends LineExplanation {
  basis?: string;
}

export interface PlanProjection {
  engineVersion: string;
  planEngineVersion: string;
  disclaimer: string;
  planId: string;
  planName: string;
  scenario: Scenario;
  fromMonth: string;
  months: number;
  monthKeys: string[];
  scope: { companyId: string | null; employees: number };
  series: PlanMonth[];
  totals: Partial<Record<PlanWindowKey, PlanWindow>>;
  composition: Array<{ key: string; label: string; kind: CostLineKind | 'PLAN'; horizon: number; w12: number }>;
  attrition: { pct: number; source: 'PLAN' | 'ACTUAL' | 'NONE'; turnover: PlanTurnover | null; basis: string };
  raisesEffect: Partial<Record<PlanWindowKey, MoneyTriple>>;
  items: PlanItemResult[];
  raises: PlanRaiseResult[];
  companies: PlanCompanyResult[];
  flags: PlanFlag[];
  /** True cost engine flags of the plan workforce, grouped (no names). */
  engineFlags: Array<{ code: string; severity: 'ERROR' | 'WARNING' | 'INFO'; count: number; message: string | null }>;
  explanations: Record<string, PlanExplanation>;
  rulesUsed: RuleVersionRef[];
  assumptions: string[];
  people: PlanPerson[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

interface PMonth {
  i: number;
  key: string;
  start: Date;
  end: Date;
  days: number;
}

const ymKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 'YYYY-MM' of a Date (UTC) or a 'YYYY-MM[-DD]' string; null when empty / invalid. */
export function planMonthKey(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const p = parseMonth(v instanceof Date ? v : String(v));
    return ymKey(p.year, p.month);
  } catch {
    return null;
  }
}

function buildMonths(fromKey: string, n: number): PMonth[] {
  const s = parseMonth(fromKey);
  return Array.from({ length: n }, (_, i) => {
    const ym = addMonthsYm(s.year, s.month, i);
    const start = monthStartUtc(ym.year, ym.month);
    const end = monthEndUtc(ym.year, ym.month);
    return { i, key: ymKey(ym.year, ym.month), start, end, days: end.getUTCDate() };
  });
}

/** Months from `fromKey` to `key` (negative before). */
function offsetOf(fromKey: string, key: string): number {
  const a = parseMonth(fromKey);
  const b = parseMonth(key);
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

function earliest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (a && b) return a.getTime() <= b.getTime() ? a : b;
  return a ?? b ?? null;
}

const zero = (): MoneyTriple => ({ cost: 0, subsidy: 0, net: 0 });
const roundTriple = (t: MoneyTriple): MoneyTriple => ({ cost: roundMoney(t.cost), subsidy: roundMoney(t.subsidy), net: roundMoney(t.net) });
const sumTriples = (xs: ReadonlyArray<MoneyTriple>): MoneyTriple => roundTriple(xs.reduce((a, t) => ({ cost: a.cost + t.cost, subsidy: a.subsidy + t.subsidy, net: a.net + t.net }), zero()));
const subTriple = (a: MoneyTriple, b: MoneyTriple): MoneyTriple => roundTriple({ cost: a.cost - b.cost, subsidy: a.subsidy - b.subsidy, net: a.net - b.net });
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Window keys available for a plan of `n` months ('12' / '24' / '36' when they fit, and 'horizon'). */
export function planWindowKeys(n: number): PlanWindowKey[] {
  const out: PlanWindowKey[] = [];
  for (const w of [12, 24, 36] as const) if (w <= n) out.push(String(w) as PlanWindowKey);
  out.push('horizon');
  return out;
}
const windowLength = (k: PlanWindowKey, n: number) => (k === 'horizon' ? n : Math.min(n, Number(k)));

const PLAN_NATIONALITY_TEXT: Record<PlanNationalityClass, string> = { SAUDI: 'سعودي', GCC: 'خليجي', EXPAT: 'وافد' };

function normClass(v: string | null | undefined): PlanNationalityClass | null {
  const s = (v ?? '').trim().toUpperCase();
  return (PLAN_NATIONALITY_CLASSES as ReadonlyArray<string>).includes(s) ? (s as PlanNationalityClass) : null;
}

function normKind(v: string): PositionKind | null {
  return (POSITION_KINDS as ReadonlyArray<string>).includes(v) ? (v as PositionKind) : null;
}

// ---------------------------------------------------------------------------
// Turnover (the default attrition rate)
// ---------------------------------------------------------------------------

/**
 * The organisation's actual turnover of the 12 calendar months ending with the month of `asOf`, computed by
 * THE internal-benchmarks function (benchmarks.ts trailingTurnoverRate: every termination, voluntary or
 * not, ÷ the average of the month-end head counts × 100), limited to the plan's legal company. Same privacy
 * rule as «المؤشرات الداخلية»: a scope whose average head count is below 5 gives no rate.
 */
export function planTurnover(employees: ReadonlyArray<TurnoverEmployee>, asOf: Date, opts: { companyId?: string | null } = {}): PlanTurnover {
  const list: BmEmployee[] = employees
    .filter((e) => !opts.companyId || e.legalCompanyId === opts.companyId)
    .map((e) => ({ id: e.id, joinDate: e.joinDate, isTerminated: e.isTerminated ?? !!e.terminationDate, terminationDate: e.terminationDate ?? null, legalCompanyId: e.legalCompanyId ?? null }));
  const t = trailingTurnoverRate(list, asOf, 12, { minGroupSize: 0 });
  const o = t.overall;
  const period = `${o.period.from} – ${o.period.to}`;
  if (t.averageHeadcount < MIN_GROUP_SIZE) {
    return { from: o.period.from, to: o.period.to, leavers: null, avgHeadcount: null, ratePct: null, basis: `${SCOPE_SUPPRESSED_REASON} (${period})` };
  }
  return {
    from: o.period.from,
    to: o.period.to,
    leavers: t.exits,
    avgHeadcount: t.averageHeadcount,
    ratePct: o.value,
    basis: o.value === null ? `${o.reason ?? 'لا توجد بيانات كافية'} (${period})` : `${t.exits} خروج ÷ متوسط العدد في نهاية كل شهر ${t.averageHeadcount} × 100 = ${o.value}% (${period}، كما في «المؤشرات الداخلية»)`,
  };
}

// ---------------------------------------------------------------------------
// Salary paths (dated changes + plan raises)
// ---------------------------------------------------------------------------

/** Basic per plan month from the dated SalaryChange rows (as computeTrueCost, without ANNUAL_RAISE_PCT). */
function basicPath(e: WfEmployeeInput, months: ReadonlyArray<PMonth>): number[] {
  const hs = months[0].start.getTime();
  const changes = (e.salaryChanges ?? []).filter((c) => c.effectiveDate.getTime() >= hs && Number.isFinite(c.basicSalary)).sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  let cur = roundMoney(e.basicSalary ?? 0);
  let ci = 0;
  return months.map((m) => {
    while (ci < changes.length && changes[ci].effectiveDate.getTime() <= m.end.getTime()) {
      cur = roundMoney(changes[ci].basicSalary);
      ci++;
    }
    return cur;
  });
}

interface ResolvedRaise {
  r: PlanRaiseInput;
  scope: RaiseScope;
  idx: number;
  key: string;
  employees: number;
  deltaMonthly: number;
  deltaTotal: number;
}

function raiseMatches(rr: ResolvedRaise, e: WfEmployeeInput): boolean {
  const id = rr.r.scopeId ?? null;
  switch (rr.scope) {
    case 'ALL':
      return true;
    case 'COMPANY':
      return !!id && e.legalCompanyId === id;
    case 'DEPARTMENT':
      return !!id && e.departmentId === id;
    case 'EMPLOYEE':
      return !!id && e.id === id;
  }
}

/**
 * Applies the plan raises to one employee (or planned hire) whose exit is `exit`: returns the basic path and,
 * when any raise applies, the employee with in-memory planned SalaryChange inputs (history kept for HRDF).
 */
function applyRaises(
  e: WfEmployeeInput,
  exit: Date | null,
  months: ReadonlyArray<PMonth>,
  raises: ResolvedRaise[],
  record: boolean,
): { path: number[]; employee: WfEmployeeInput; affected: boolean } {
  const path = basicPath(e, months);
  let affected = false;
  for (const rr of raises) {
    if (!raiseMatches(rr, e)) continue;
    const m = months[rr.idx];
    if (e.joinDate.getTime() >= m.start.getTime()) continue; // employed before the raise month only
    if (exit && exit.getTime() < m.start.getTime()) continue;
    const delta = rr.r.pct !== null && rr.r.pct !== undefined ? roundMoney((path[rr.idx] * rr.r.pct) / 100) : roundMoney(num(rr.r.amount));
    if (delta === 0) continue;
    let total = 0;
    for (let i = rr.idx; i < months.length; i++) {
      path[i] = Math.max(0, roundMoney(path[i] + delta));
      total += (delta * activeDays(months[i].start, months[i].end, e.joinDate, exit)) / months[i].days;
    }
    affected = true;
    if (record) {
      rr.employees++;
      rr.deltaMonthly = roundMoney(rr.deltaMonthly + delta);
      rr.deltaTotal = roundMoney(rr.deltaTotal + total);
    }
  }
  if (!affected) return { path, employee: e, affected };
  const hs = months[0].start.getTime();
  const history = (e.salaryChanges ?? []).filter((c) => c.effectiveDate.getTime() < hs);
  const synth: Array<{ effectiveDate: Date; basicSalary: number; isPlanned: boolean }> = [];
  let prev = roundMoney(e.basicSalary ?? 0);
  path.forEach((b, i) => {
    if (b !== prev) synth.push({ effectiveDate: months[i].start, basicSalary: b, isPlanned: true });
    prev = b;
  });
  return { path, employee: { ...e, salaryChanges: [...history, ...synth] }, affected };
}

// ---------------------------------------------------------------------------
// projectPlan
// ---------------------------------------------------------------------------

interface ResolvedExit {
  position: PlanPositionInput;
  employee: WfEmployeeInput;
  lwd: Date;
  idx: number;
  reason: string;
}

interface ResolvedHire {
  position: PlanPositionInput;
  kind: 'NEW_HIRE' | 'BACKFILL';
  employee: WfEmployeeInput;
  cls: PlanNationalityClass;
  joinIdx: number;
  leaverName: string | null;
  leaverExitKey: string | null;
  requestedKey: string;
  why: string[];
}

const COMPARABLE_KEYS: ReadonlyArray<CostLineKey> = ['BASIC', 'ALLOWANCES', 'GOSI_EMPLOYER'];

function lineKind(k: CostLineKey): CostLineKind {
  return k === 'HRDF_SUBSIDY' ? 'SUBSIDY' : k === 'LEAVE_ACCRUAL' ? 'MEMO' : 'COST';
}

function monthLineSum(r: EmployeeCostResult, i: number, keys: ReadonlyArray<CostLineKey>): number {
  const m = r.months[i];
  if (!m) return 0;
  let s = 0;
  for (const l of m.lines) if (keys.includes(l.key)) s += l.amount;
  return roundMoney(s);
}

function brief(e: ReturnType<typeof nitaqatEstimate>): NitaqatBrief {
  return { status: e.status, message: e.message, band: e.band, pct: e.pct, x: e.counts.x, saudiWeighted: e.counts.saudiWeighted, expats: e.counts.expats };
}

function windowsOf(perMonth: ReadonlyArray<MoneyTriple>, n: number): Partial<Record<PlanWindowKey, MoneyTriple>> {
  const out: Partial<Record<PlanWindowKey, MoneyTriple>> = {};
  for (const k of planWindowKeys(n)) out[k] = sumTriples(perMonth.slice(0, windowLength(k, n)));
  return out;
}

/** SPEC §8: month-by-month projection of a workforce plan (see the header of this file). */
export function projectPlan(base: PlanBaseInput, plan: PlanDefinition, options: PlanProjectOptions = {}): PlanProjection {
  const scenario: Scenario = options.scenario ?? 'base';
  const n = Math.max(1, Math.min(36, Math.floor(plan.months || 12)));
  const fromKey = planMonthKey(plan.fromMonth);
  if (!fromKey) throw new Error(`invalid plan fromMonth: ${String(plan.fromMonth)}`);
  const months = buildMonths(fromKey, n);
  const hStart = months[0].start;
  const hEnd = months[n - 1].end;
  const flags: PlanFlag[] = [];
  const scopeCompany = plan.companyId || null;
  const companies = new Map(base.companies.map((c) => [c.id, c]));
  const branches = new Map((base.branches ?? []).map((b) => [b.id, b]));
  const departments = new Map((base.departments ?? []).map((d) => [d.id, d]));

  // The plan's raises replace the annual raise assumption.
  const replacedRaise = base.assumptions.filter((a) => a.key === 'ANNUAL_RAISE_PCT' && (num(a.value) !== 0 || !!a.valueJson));
  const assumptions = base.assumptions.filter((a) => a.key !== 'ANNUAL_RAISE_PCT');
  if (replacedRaise.length) flags.push({ code: 'ANNUAL_RAISE_REPLACED', severity: 'INFO', message: 'افتراض «نسبة الزيادة السنوية» لا يُطبَّق في الخطة: الزيادات هي ما تنص عليه الخطة فقط' });

  const all = [...base.employees].sort(byId);
  const empById = new Map(all.map((e) => [e.id, e]));
  const inScope = (e: WfEmployeeInput) => !scopeCompany || e.legalCompanyId === scopeCompany;
  const recordedExit = (e: WfEmployeeInput) => earliest(e.terminationDate ?? null, e.contractEndDate ?? null);
  const inHorizon = (e: WfEmployeeInput) => {
    if (e.joinDate.getTime() > hEnd.getTime()) return false;
    const x = recordedExit(e);
    return !x || x.getTime() >= hStart.getTime();
  };
  const scopeEmployees = all.filter((e) => inScope(e) && inHorizon(e));
  const scopeIds = new Set(scopeEmployees.map((e) => e.id));

  const posFlags = new Map<string, PlanFlag[]>();
  const flagPos = (p: PlanPositionInput, f: Omit<PlanFlag, 'positionId'>) => {
    const full: PlanFlag = { ...f, positionId: p.id };
    flags.push(full);
    const list = posFlags.get(p.id) ?? [];
    list.push(full);
    posFlags.set(p.id, list);
  };
  const keyOrder = (p: PlanPositionInput) => planMonthKey(p.kind === 'EXIT' ? p.exitMonth : p.startMonth) ?? fromKey;
  const positions = [...plan.positions].sort((a, b) => keyOrder(a).localeCompare(keyOrder(b)) || byId(a, b));

  // ---- Exits ----
  const exits = new Map<string, ResolvedExit>();
  for (const p of positions) {
    if (p.kind !== 'EXIT') continue;
    const e = p.exitEmployeeId ? empById.get(p.exitEmployeeId) : undefined;
    if (!e) {
      flagPos(p, { code: 'EXIT_EMPLOYEE_UNKNOWN', severity: 'ERROR', message: `«${p.title}»: الموظف المغادر غير موجود أو لا يعمل خلال فترة الخطة` });
      continue;
    }
    if (!scopeIds.has(e.id)) {
      flagPos(p, { code: 'OUTSIDE_SCOPE', severity: 'ERROR', message: `«${p.title}»: الموظف ${e.name} خارج نطاق الخطة أو فترتها` });
      continue;
    }
    const key = planMonthKey(p.exitMonth);
    const idx = key ? offsetOf(fromKey, key) : -1;
    if (!key || idx < 0 || idx >= n) {
      flagPos(p, { code: 'EXIT_OUTSIDE_PLAN', severity: 'WARNING', message: `«${p.title}»: شهر الخروج ${key ?? '—'} خارج فترة الخطة: لم يُحسب` });
      continue;
    }
    let lwd = months[idx].end;
    const rec = recordedExit(e);
    if (rec && rec.getTime() < lwd.getTime()) {
      flagPos(p, { code: 'EXIT_ALREADY_RECORDED', severity: 'INFO', message: `«${p.title}»: خروج ${e.name} مسجّل في ${ymd(rec)} قبل الخروج المخطط: اعتُمد الأسبق` });
      lwd = rec;
    }
    const prev = exits.get(e.id);
    if (prev) {
      flagPos(p, { code: 'DUPLICATE_EXIT', severity: 'WARNING', message: `«${p.title}»: خروج مكرر للموظف ${e.name}: اعتُمد الأسبق` });
      if (prev.lwd.getTime() <= lwd.getTime()) continue;
    }
    const lwdIdx = offsetOf(fromKey, planMonthKey(lwd)!);
    exits.set(e.id, { position: p, employee: e, lwd, idx: Math.max(0, lwdIdx), reason: p.exitReason ?? '' });
  }
  const exitDateOf = (e: WfEmployeeInput): Date | null => {
    const x = exits.get(e.id);
    return x ? earliest(x.lwd, recordedExit(e)) : recordedExit(e);
  };

  // ---- Raises ----
  const resolvedRaises: ResolvedRaise[] = [];
  const raiseFlags = new Map<string, PlanFlag[]>();
  const flagRaise = (r: PlanRaiseInput, f: Omit<PlanFlag, 'raiseId'>) => {
    const full = { ...f, raiseId: r.id };
    flags.push(full);
    raiseFlags.set(r.id, [...(raiseFlags.get(r.id) ?? []), full]);
  };
  const raisesSorted = [...plan.raises].sort((a, b) => (planMonthKey(a.effectiveMonth) ?? '').localeCompare(planMonthKey(b.effectiveMonth) ?? '') || byId(a, b));
  for (const r of raisesSorted) {
    const key = planMonthKey(r.effectiveMonth);
    const idx = key ? offsetOf(fromKey, key) : -1;
    const scope = (RAISE_SCOPES as ReadonlyArray<string>).includes(r.scope) ? (r.scope as RaiseScope) : 'ALL';
    if (!key || idx < 0 || idx >= n) {
      flagRaise(r, { code: 'RAISE_OUTSIDE_PLAN', severity: 'WARNING', message: `زيادة من ${key ?? '—'} خارج فترة الخطة: لم تُطبَّق` });
      continue;
    }
    resolvedRaises.push({ r, scope, idx, key, employees: 0, deltaMonthly: 0, deltaTotal: 0 });
  }

  // ---- Planned hires / backfills ----
  const hires: ResolvedHire[] = [];
  for (const p of positions) {
    const kind = normKind(p.kind);
    if (kind !== 'NEW_HIRE' && kind !== 'BACKFILL') continue;
    const cls = normClass(p.nationalityClass);
    const basic = num(p.basicSalary);
    if (!cls || basic <= 0) {
      flagPos(p, { code: 'POSITION_INCOMPLETE', severity: 'ERROR', message: `«${p.title}»: الجنسية والراتب الأساسي مطلوبان: لم تُحسب` });
      continue;
    }
    if (scopeCompany && p.companyId && p.companyId !== scopeCompany) {
      flagPos(p, { code: 'OUTSIDE_SCOPE', severity: 'ERROR', message: `«${p.title}»: الشركة خارج نطاق الخطة` });
      continue;
    }
    const requestedKey = planMonthKey(p.startMonth) ?? fromKey;
    let joinKey = requestedKey;
    const why: string[] = [];
    let leaverName: string | null = null;
    let leaverExitKey: string | null = null;
    let leaver: WfEmployeeInput | undefined;
    if (kind === 'BACKFILL') {
      leaver = p.exitEmployeeId ? empById.get(p.exitEmployeeId) : undefined;
      leaverName = leaver?.name ?? null;
      const x = leaver ? exitDateOf(leaver) : null;
      if (!leaver || !x) {
        flagPos(p, { code: 'BACKFILL_NO_EXIT', severity: 'WARNING', message: `«${p.title}»: لا خروج مخطط أو مسجّل للموظف الذي يُستبدل: حُسب البديل كتعيين إضافي من ${requestedKey}` });
      } else {
        leaverExitKey = planMonthKey(x)!;
        if (leaverExitKey > joinKey) joinKey = leaverExitKey;
        why.push(
          `يبدأ البديل في ${joinKey} = الأحدث بين البداية المطلوبة ${requestedKey} وشهر خروج ${leaver.name} (${leaverExitKey})${joinKey === leaverExitKey ? '؛ يتداخل مع المغادر في شهر خروجه (شهر تسليم)' : ''}.`,
        );
      }
    }
    let joinIdx = offsetOf(fromKey, joinKey);
    if (joinIdx >= n) {
      flagPos(p, { code: 'START_OUTSIDE_PLAN', severity: 'WARNING', message: `«${p.title}»: البداية ${joinKey} بعد نهاية الخطة: لا كلفة داخلها` });
      hires.push({ position: p, kind, employee: null as unknown as WfEmployeeInput, cls, joinIdx, leaverName, leaverExitKey, requestedKey, why });
      continue;
    }
    if (joinIdx < 0) {
      flagPos(p, { code: 'START_BEFORE_PLAN', severity: 'INFO', message: `«${p.title}»: البداية ${joinKey} قبل بداية الخطة: حُسبت من ${fromKey}` });
      joinIdx = 0;
    }
    const legal = p.companyId || scopeCompany || leaver?.legalCompanyId || null;
    const branch = p.branchId ? branches.get(p.branchId) : undefined;
    const dept = p.departmentId ? departments.get(p.departmentId) : undefined;
    const housing = num(p.housingAllowance);
    const other = num(p.otherAllowances);
    const employee: WfEmployeeInput = {
      id: `plan:${p.id}`,
      name: p.title,
      employeeNo: null,
      nationality: PLAN_NATIONALITY_TEXT[cls],
      gender: p.gender === 'FEMALE' ? 'FEMALE' : 'MALE',
      dateOfBirth: null,
      joinDate: months[joinIdx].start,
      basicSalary: roundMoney(basic),
      allowances: candidateAllowances({ housingAllowance: housing, otherAllowances: other }),
      gosiRegime: cls === 'SAUDI' ? (p.gosiRegime === 'OLD' ? 'OLD' : 'NEW') : null,
      legalCompanyId: legal,
      branchId: p.branchId ?? null,
      branchName: branch?.name ?? null,
      branchCity: branch?.city ?? null,
      departmentId: p.departmentId ?? null,
      departmentName: dept?.name ?? null,
      contractType: 'FULL_TIME',
      occupationName: p.occupationName ?? null,
      medicalInsuranceClass: p.medicalClass ?? null,
      dependentsCount: cls === 'EXPAT' ? Math.max(0, Math.floor(num(p.dependentsCount))) : null,
      dependentsFeePaidBy: null,
      isDisabled: false,
      isStudent: false,
      isPlanned: true,
      qiwaContractDocumented: true,
      qiwaContractDocumentedAt: null,
    };
    if (cls === 'SAUDI') {
      const wage = nitaqatWage(employee);
      if (wage < WAGE_FULL_WEIGHT) {
        const w = wage >= WAGE_HALF_WEIGHT ? 0.5 : 0;
        flagPos(p, {
          code: 'SAUDI_WAGE_BELOW_NITAQAT',
          severity: 'WARNING',
          message: `«${p.title}»: الأجر المسجّل في التأمينات ${fmt(wage)} (الأساسي + السكن) أقل من ${fmt(WAGE_FULL_WEIGHT)}: يُحتسب في نطاقات بوزن ${w} لا 1`,
        });
      }
    }
    why.unshift(
      `${POSITION_KIND_LABELS[kind]} ${PLAN_NATIONALITY_LABELS[cls]} افتراضي من ${months[joinIdx].key}: الأساسي ${fmt(basic)}${housing ? ` + سكن ${fmt(housing)}` : ''}${other ? ` + بدلات ${fmt(other)}` : ''}، بمحرك الكلفة الحقيقية نفسه${cls === 'SAUDI' ? ` (التأمينات بالنظام ${employee.gosiRegime === 'OLD' ? 'القديم' : 'الجديد'}، ودعم هدف في فترة تقديمه)` : cls === 'EXPAT' ? ' (المقابل المالي حسب ترتيبه في الكيان، ورخصة العمل والإقامة)' : ''}، وإعدادات الكلفة لشركته.`,
    );
    hires.push({ position: p, kind, employee, cls, joinIdx, leaverName, leaverExitKey, requestedKey, why });
  }
  const liveHires = hires.filter((h) => h.employee);

  // ---- Plan workforce (exits, raises) ----
  const raisedById = new Map<string, WfEmployeeInput>();
  const pathById = new Map<string, number[]>();
  const noRaiseById = new Map<string, WfEmployeeInput>();
  const affected = new Set<string>();
  const planEmployees: WfEmployeeInput[] = all.map((e) => {
    const x = exits.get(e.id);
    const withExit: WfEmployeeInput = x ? { ...e, terminationDate: x.lwd } : e;
    if (!scopeIds.has(e.id)) {
      pathById.set(e.id, basicPath(e, months));
      return withExit;
    }
    const r = applyRaises(withExit, exitDateOf(e), months, resolvedRaises, true);
    pathById.set(e.id, r.path);
    if (r.affected) {
      affected.add(e.id);
      noRaiseById.set(e.id, withExit);
    }
    raisedById.set(e.id, r.employee);
    return r.employee;
  });
  for (const h of liveHires) {
    const r = applyRaises(h.employee, null, months, resolvedRaises, true);
    pathById.set(h.employee.id, r.path);
    if (r.affected) {
      affected.add(h.employee.id);
      noRaiseById.set(h.employee.id, h.employee);
    }
    h.employee = r.employee;
    planEmployees.push(r.employee);
  }
  for (const rr of resolvedRaises) {
    if (rr.employees === 0) flagRaise(rr.r, { code: 'RAISE_NO_MATCH', severity: 'WARNING', message: `الزيادة من ${rr.key} لا تنطبق على أي موظف (النطاق أو تاريخ المباشرة)` });
  }

  const engineInput = (employees: ReadonlyArray<WfEmployeeInput>): TrueCostInput => ({
    employees,
    companies: base.companies,
    rules: base.rules,
    gosiRates: base.gosiRates,
    assumptions,
    payrollSettings: base.payrollSettings,
    annualLeaveDaysSetting: base.annualLeaveDaysSetting,
  });
  const opts = (ids: ReadonlyArray<string>) => ({ startMonth: fromKey, months: n, scenario, employeeIds: [...ids] });
  const hireIds = liveHires.map((h) => h.employee.id);
  const reported = [...scopeIds, ...hireIds];
  const tcPlan = computeTrueCost(engineInput(planEmployees), opts(reported));
  const tcBase = computeTrueCost(engineInput(all), opts([...scopeIds]));
  const planRes = new Map(tcPlan.employees.map((r) => [r.employeeId, r]));
  const baseRes = new Map(tcBase.employees.map((r) => [r.employeeId, r]));

  // Raises effect (same workforce, affected employees without the raises; the levy does not depend on wages).
  let tcNoRaise: TrueCostResult | null = null;
  if (affected.size) tcNoRaise = computeTrueCost(engineInput(planEmployees.map((e) => noRaiseById.get(e.id) ?? e)), opts([...affected]));
  // Exit effect (same workforce, leavers staying with the plan's raises).
  let tcNoExit: TrueCostResult | null = null;
  if (exits.size) {
    const stay = new Map<string, WfEmployeeInput>();
    for (const x of exits.values()) stay.set(x.employee.id, applyRaises(x.employee, recordedExit(x.employee), months, resolvedRaises, false).employee);
    tcNoExit = computeTrueCost(engineInput(planEmployees.map((e) => stay.get(e.id) ?? e)), opts([...stay.keys()]));
  }

  // ---- Exit one-offs ----
  const exitOneOff = new Array<number>(n).fill(0);
  const exitRelease = new Array<number>(n).fill(0);
  const exitResults = new Map<string, PlanItemResult['exitCost']>();
  const exitRules: RuleVersionRef[] = [];
  const exitExplainRules: RuleEvidence[] = [];
  const planById = new Map(planEmployees.map((e) => [e.id, e]));
  for (const x of [...exits.values()].sort((a, b) => a.lwd.getTime() - b.lwd.getTime() || byId(a.employee, b.employee))) {
    const p = x.position;
    const pe = planById.get(x.employee.id)!;
    const mapping = resolveTerminationReason(x.reason);
    if (!mapping.terminationReason) {
      flagPos(p, { code: 'EXIT_REASON_NEEDS_CHOICE', severity: 'ERROR', message: `«${p.title}»: سبب الخروج يحتاج تحديد أساس التسوية: لم تُحسب تكاليف الخروج` });
      continue;
    }
    const details = base.exitDetails?.[x.employee.id];
    if (!details) flagPos(p, { code: 'EXIT_DETAILS_MISSING', severity: 'INFO', message: `«${p.title}»: الإجازات والسلف غير محمّلة: بدل الإجازة والسلف غير محسوبة` });
    const legal = pe.legalCompanyId || null;
    const settingsId = pe.legalCompanyId || pe.actualCompanyId || null;
    try {
      const r = computeExitCost({
        employee: { ...pe, leaves: details?.leaves ?? [], loans: details?.loans ?? [] },
        reason: x.reason,
        lastWorkingDate: x.lwd,
        noticeServed: true,
        companyEmployees: legal ? planEmployees.filter((e) => e.legalCompanyId === legal) : [],
        company: legal ? (companies.get(legal) ?? null) : null,
        settingsCompany: settingsId ? (companies.get(settingsId) ?? null) : null,
        rules: base.rules,
        gosiRates: base.gosiRates,
        assumptions,
        scenario,
        annualLeaveDaysSetting: base.annualLeaveDaysSetting,
        payrollSettings: base.payrollSettings,
        salaryBasis: 'total',
      });
      const rp = planRes.get(pe.id);
      let accrued = 0;
      if (rp) for (let i = 0; i <= x.idx && i < n; i++) accrued += monthLineSum(rp, i, ['EOSB_ACCRUAL']);
      const release = roundMoney(-accrued);
      exitOneOff[x.idx] = roundMoney(exitOneOff[x.idx] + r.totals.payable);
      exitRelease[x.idx] = roundMoney(exitRelease[x.idx] + release);
      exitRules.push(...r.rulesUsed);
      for (const ex of Object.values(r.explanations)) if (ex) exitExplainRules.push(...ex.rules);
      exitResults.set(p.id, {
        reason: x.reason,
        reasonLabel: PLAN_EXIT_REASON_LABELS[x.reason as EmployeeExitReason] ?? x.reason,
        settlementReason: r.reason,
        payable: r.totals.payable,
        accrualRelease: release,
        risk: r.totals.risk,
        netToEmployee: r.totals.netToEmployee,
        yearsOfService: r.yearsOfService,
        wageUsed: r.wageUsed,
        levyDeltaMonthly: r.levyImpact ? r.levyImpact.deltaMonthly : null,
        lines: r.lines,
      });
    } catch {
      flagPos(p, { code: 'EXIT_REASON_NEEDS_CHOICE', severity: 'ERROR', message: `«${p.title}»: تعذر حساب تكاليف الخروج لهذا السبب` });
    }
  }

  // ---- Attrition ----
  let attrPct = 0;
  let attrSource: 'PLAN' | 'ACTUAL' | 'NONE' = 'NONE';
  let turnover: PlanTurnover | null = null;
  if (plan.attritionPct !== null && plan.attritionPct !== undefined && Number.isFinite(plan.attritionPct)) {
    attrPct = Math.max(0, Math.min(100, plan.attritionPct));
    attrSource = 'PLAN';
  } else if (base.turnoverEmployees && options.turnoverAsOf) {
    turnover = planTurnover(base.turnoverEmployees, options.turnoverAsOf, { companyId: scopeCompany });
    attrSource = 'ACTUAL';
    if (turnover.ratePct === null) {
      flags.push({ code: 'ATTRITION_NO_HISTORY', severity: 'WARNING', message: `لا دوران فعلي يُستخدم افتراضياً: ${turnover.basis}. أدخل نسبة في الخطة إن لزم` });
    } else {
      attrPct = Math.min(100, turnover.ratePct);
      flags.push({ code: 'ATTRITION_DEFAULT', severity: 'INFO', message: `الدوران المفترض ${attrPct}% سنوياً = الدوران الفعلي للمنشأة في 12 شهراً (${turnover.from} – ${turnover.to})` });
    }
  }
  const a = attrPct / 100;
  const survivors = [...scopeIds].filter((id) => !exits.has(id)).sort();

  // ---- Series ----
  const series: PlanMonth[] = months.map((m) => {
    const t = tcPlan.series[m.i];
    const b = tcBase.series[m.i];
    const hc: PlanHeadcount = { total: 0, saudi: 0, gcc: 0, expat: 0, hires: 0, plannedExits: 0 };
    let comparable = 0;
    for (const r of tcPlan.employees) {
      if (r.months[m.i]?.active) {
        hc.total++;
        if (r.nationalityClass === 'SAUDI') hc.saudi++;
        else if (r.nationalityClass === 'GCC') hc.gcc++;
        else hc.expat++;
        if (r.isPlanned) hc.hires++;
      }
      comparable += monthLineSum(r, m.i, COMPARABLE_KEYS);
    }
    for (const x of exits.values()) {
      const rb = baseRes.get(x.employee.id);
      if (rb?.months[m.i]?.active && !planRes.get(x.employee.id)?.months[m.i]?.active) hc.plannedExits++;
    }
    let sc = 0;
    let ss = 0;
    let shc = 0;
    for (const id of survivors) {
      const r = planRes.get(id);
      const mo = r?.months[m.i];
      if (!mo?.active) continue;
      sc += mo.totals.cost;
      ss += mo.totals.subsidy;
      shc++;
    }
    const f = a > 0 ? 1 - Math.pow(1 - a, m.i / 12) : 0;
    const ac = roundMoney(-f * sc);
    const as = roundMoney(-f * ss);
    const attrition = { cost: ac, subsidy: as, net: roundMoney(ac + as) };
    const oneOff = exitOneOff[m.i];
    const release = exitRelease[m.i];
    return {
      month: m.key,
      cost: t.cost,
      subsidy: t.subsidy,
      net: t.net,
      headcount: hc,
      expectedLeavers: round2(f * shc),
      comparable: roundMoney(comparable),
      levy: roundMoney(t.byLine.EXPAT_LEVY ?? 0),
      exitOneOff: oneOff,
      exitAccrualRelease: release,
      attrition,
      totalBeforeHrdf: roundMoney(t.cost + oneOff + release + attrition.cost),
      totalAfterHrdf: roundMoney(t.net + oneOff + release + attrition.net),
      baseline: { cost: b.cost, subsidy: b.subsidy, net: b.net, headcount: b.headcount },
    };
  });

  const totals: Partial<Record<PlanWindowKey, PlanWindow>> = {};
  for (const k of planWindowKeys(n)) {
    const s = series.slice(0, windowLength(k, n));
    const sum = (f: (x: PlanMonth) => number) => roundMoney(s.reduce((acc, x) => acc + f(x), 0));
    const baseline = sumTriples(s.map((x) => x.baseline));
    const totalAfter = sum((x) => x.totalAfterHrdf);
    totals[k] = {
      months: s.length,
      ...sumTriples(s),
      comparable: sum((x) => x.comparable),
      levy: sum((x) => x.levy),
      exitOneOff: sum((x) => x.exitOneOff),
      exitAccrualRelease: sum((x) => x.exitAccrualRelease),
      attrition: sumTriples(s.map((x) => x.attrition)),
      totalBeforeHrdf: sum((x) => x.totalBeforeHrdf),
      totalAfterHrdf: totalAfter,
      baseline,
      deltaAfterHrdf: roundMoney(totalAfter - baseline.net),
    };
  }

  // ---- Composition ----
  const composition: PlanProjection['composition'] = COST_LINE_ORDER.filter((k) => tcPlan.series.some((s) => s.byLine[k] !== undefined)).map((k) => ({
    key: k,
    label: COST_LINE_META[k].label,
    kind: lineKind(k),
    horizon: roundMoney(tcPlan.series.reduce((s, x) => s + (x.byLine[k] ?? 0), 0)),
    w12: roundMoney(tcPlan.series.slice(0, 12).reduce((s, x) => s + (x.byLine[k] ?? 0), 0)),
  }));
  const planLine = (key: string, label: string, f: (x: PlanMonth) => number) => {
    const horizon = roundMoney(series.reduce((s, x) => s + f(x), 0));
    if (horizon !== 0) composition.push({ key, label, kind: 'PLAN', horizon, w12: roundMoney(series.slice(0, 12).reduce((s, x) => s + f(x), 0)) });
  };
  planLine('EXIT_ONE_OFF', 'تكاليف الخروج لمرة واحدة', (x) => x.exitOneOff);
  planLine('EXIT_ACCRUAL_RELEASE', 'استرداد مخصص نهاية الخدمة للمغادرين', (x) => x.exitAccrualRelease);
  planLine('ATTRITION', 'الدوران المتوقع (إحصائي)', (x) => x.attrition.cost);

  // ---- Raises ----
  const raisesEffect: Partial<Record<PlanWindowKey, MoneyTriple>> = {};
  if (tcNoRaise) {
    const withR = [...affected].map((id) => planRes.get(id)).filter((r): r is EmployeeCostResult => !!r);
    const noR = new Map(tcNoRaise.employees.map((r) => [r.employeeId, r]));
    const perMonth = months.map((m) => {
      let c = 0;
      let s = 0;
      for (const r of withR) {
        const o = noR.get(r.employeeId);
        c += (r.months[m.i]?.totals.cost ?? 0) - (o?.months[m.i]?.totals.cost ?? 0);
        s += (r.months[m.i]?.totals.subsidy ?? 0) - (o?.months[m.i]?.totals.subsidy ?? 0);
      }
      return { cost: c, subsidy: s, net: c + s };
    });
    Object.assign(raisesEffect, windowsOf(perMonth, n));
  }
  const raises: PlanRaiseResult[] = raisesSorted.map((r) => {
    const rr = resolvedRaises.find((x) => x.r.id === r.id);
    const scope = (RAISE_SCOPES as ReadonlyArray<string>).includes(r.scope) ? (r.scope as RaiseScope) : 'ALL';
    const what = r.pct !== null && r.pct !== undefined ? `${r.pct}% من الأساسي` : `${fmt(num(r.amount))} ريال شهرياً على الأساسي`;
    const target = scope === 'ALL' ? 'كل موظفي الخطة' : `${RAISE_SCOPE_LABELS[scope]} ${r.scopeId ?? ''}`.trim();
    return {
      raiseId: r.id,
      scope,
      scopeId: r.scopeId ?? null,
      pct: r.pct ?? null,
      amount: r.amount ?? null,
      effectiveMonth: planMonthKey(r.effectiveMonth) ?? '',
      employees: rr?.employees ?? 0,
      basicDeltaMonthly: rr?.deltaMonthly ?? 0,
      basicDeltaTotal: rr?.deltaTotal ?? 0,
      why: rr
        ? [
            `زيادة ${what} من ${rr.key} على ${target}: ${rr.employees} موظف ممن باشروا قبل ${rr.key}، بزيادة ${fmt(rr.deltaMonthly)} ريال شهرياً على الأساسي في شهر السريان، و${fmt(rr.deltaTotal)} على الأساسي طوال الخطة.`,
            'تتبع الزيادة التأمينات ومكافأة نهاية الخدمة ودعم هدف (بعد فترة تقديمه) في محرك الكلفة الحقيقية؛ لا تُكتب في ملف الموظف ولا في المسير.',
          ]
        : [],
      flags: raiseFlags.get(r.id) ?? [],
    };
  });

  // ---- Items ----
  const itemLines = (r: EmployeeCostResult | undefined, minus?: EmployeeCostResult): PlanItemLine[] => {
    if (!r) return [];
    const keys = COST_LINE_ORDER.filter((k) => r.byLine[k] !== undefined || (minus && minus.byLine[k] !== undefined));
    return keys
      .map((k) => ({ key: k, label: COST_LINE_META[k].label, kind: lineKind(k), amount: roundMoney((r.byLine[k] ?? 0) - (minus?.byLine[k] ?? 0)) }))
      .filter((l) => l.amount !== 0);
  };
  const items: PlanItemResult[] = [];
  for (const p of positions) {
    const kind = normKind(p.kind) ?? 'NEW_HIRE';
    const base0 = {
      positionId: p.id,
      kind,
      title: p.title,
      companyId: p.companyId ?? scopeCompany ?? null,
      departmentId: p.departmentId ?? null,
      flags: posFlags.get(p.id) ?? [],
    };
    if (kind === 'EXIT') {
      const x = [...exits.values()].find((e) => e.position.id === p.id);
      const e = p.exitEmployeeId ? empById.get(p.exitEmployeeId) : undefined;
      if (!x) {
        items.push({ ...base0, employeeId: p.exitEmployeeId ?? null, employeeName: e?.name ?? null, nationalityClass: e ? nationalityClass(e.nationality) : null, start: null, exit: planMonthKey(p.exitMonth), lastWorkingDate: null, computed: false, firstMonthCost: 0, windows: {}, lines: [], exitCost: null, why: [] });
        continue;
      }
      const rp = planRes.get(x.employee.id);
      const rs = tcNoExit?.employees.find((r) => r.employeeId === x.employee.id);
      const perMonth = months.map((m) => subTriple(rp?.months[m.i]?.totals ?? zero(), rs?.months[m.i]?.totals ?? zero()));
      const ec = exitResults.get(p.id) ?? null;
      const why = [
        `خروج ${x.employee.name} بعد ${ymd(x.lwd)} (${PLAN_EXIT_REASON_LABELS[x.reason as EmployeeExitReason] ?? x.reason}): تتوقف كلفته الشهرية بعده، ويظهر أثره مقارنة ببقائه بزيادات الخطة نفسها.`,
      ];
      if (ec) {
        why.push(
          `تكاليف الخروج ${fmt(ec.payable)} لمرة واحدة في ${months[x.idx].key}: مكافأة نهاية الخدمة وبدل الإشعار وبدل الإجازة بحساب شاشة التصفية نفسه (computeExitCost)، مع افتراض العمل بمدة الإشعار.`,
          `يُسترد ${fmt(-ec.accrualRelease)} مما احتُسب من مخصص نهاية الخدمة لهذا الموظف في أشهر الخطة حتى خروجه، لأن المكافأة المدفوعة تشمله فلا تُحسب مرتين.`,
        );
        if (ec.risk > 0) why.push(`خطر المادة 77 إن نوزع الإنهاء: ${fmt(ec.risk)} (خارج الإجمالي).`);
        if (ec.levyDeltaMonthly) why.push(`تغيّر المقابل المالي لبقية الوافدين بعد الخروج: ${fmt(ec.levyDeltaMonthly)} شهرياً (ضمن سلسلة الشركة).`);
      }
      items.push({
        ...base0,
        companyId: x.employee.legalCompanyId ?? null,
        departmentId: x.employee.departmentId ?? null,
        employeeId: x.employee.id,
        employeeName: x.employee.name,
        nationalityClass: nationalityClass(x.employee.nationality),
        start: null,
        exit: months[x.idx].key,
        lastWorkingDate: ymd(x.lwd),
        computed: true,
        firstMonthCost: 0,
        windows: windowsOf(perMonth, n),
        lines: itemLines(rp, rs),
        exitCost: ec,
        why,
      });
      continue;
    }
    const h = hires.find((x) => x.position.id === p.id);
    if (!h || !h.employee) {
      items.push({ ...base0, employeeId: null, employeeName: null, nationalityClass: h ? h.cls : normClass(p.nationalityClass), start: h ? planMonthKey(p.startMonth) : null, exit: h?.leaverExitKey ?? null, lastWorkingDate: null, computed: false, firstMonthCost: 0, windows: {}, lines: [], exitCost: null, why: h?.why ?? [] });
      continue;
    }
    const r = planRes.get(h.employee.id);
    const first = r?.months.find((m) => m.active);
    items.push({
      ...base0,
      companyId: h.employee.legalCompanyId ?? null,
      employeeId: h.employee.id,
      employeeName: h.leaverName,
      nationalityClass: h.cls,
      start: months[h.joinIdx].key,
      exit: h.leaverExitKey,
      lastWorkingDate: null,
      computed: true,
      firstMonthCost: first?.totals.cost ?? 0,
      windows: r ? windowsOf(r.months.map((m) => m.totals), n) : {},
      lines: itemLines(r),
      exitCost: null,
      why: h.why,
    });
  }

  // ---- Companies: Nitaqat at the end of every plan year, levy tiers ----
  const companyIds = [...new Set([...scopeEmployees.map((e) => e.legalCompanyId), ...liveHires.map((h) => h.employee.legalCompanyId)].filter((x): x is string => !!x))].sort();
  const stateAt = (list: ReadonlyArray<WfEmployeeInput>, idx: number, paths: (e: WfEmployeeInput) => number[] | undefined) =>
    list.map((e) => {
      const p = paths(e);
      return p ? { ...e, basicSalary: p[idx] } : e;
    });
  const basePaths = new Map(all.map((e) => [e.id, basicPath(e, months)]));
  const yearEnds = Array.from({ length: Math.floor(n / 12) }, (_, y) => 12 * (y + 1) - 1);
  if (!yearEnds.length) yearEnds.push(n - 1);
  if (!base.nitaqat && companyIds.length) flags.push({ code: 'NITAQAT_NOT_ESTIMATED', severity: 'INFO', message: 'سجل نطاقات غير محمّل: لم يُقدَّر النطاق في نهاية كل سنة' });
  const levyOf = (tc: TrueCostResult, cid: string, idx: number) => {
    const m = tc.companies.find((c) => c.companyId === cid)?.months[idx];
    return { saudi: m?.saudi ?? 0, expat: m?.expat ?? 0, within: m?.within ?? 0, above: m?.above ?? 0, exempt: m?.exempt ?? 0, levyTotal: m?.levyTotal ?? 0 };
  };
  const companiesOut: PlanCompanyResult[] = companyIds.map((cid) => {
    const company = companies.get(cid);
    const activityKey = company?.nitaqatActivityKey ?? null;
    const activity = activityKey && base.nitaqat ? (base.nitaqat.activities.find((x) => x.key === activityKey) ?? null) : null;
    const curves = activityKey && base.nitaqat ? base.nitaqat.curves.filter((c) => c.activityKey === activityKey) : [];
    const planCo = planEmployees.filter((e) => e.legalCompanyId === cid);
    const baseCo = all.filter((e) => e.legalCompanyId === cid);
    const years: PlanCompanyYear[] = yearEnds.map((idx, y) => {
      const date = months[idx].end;
      let nit: PlanCompanyYear['nitaqat'] = null;
      if (base.nitaqat) {
        const entity = { companyId: cid, companyName: company?.name ?? cid, activity, curves };
        const planEst = brief(nitaqatEstimate({ ...entity, employees: stateAt(planCo, idx, (e) => pathById.get(e.id)) }, date, { average: false }));
        const baseEst = brief(nitaqatEstimate({ ...entity, employees: stateAt(baseCo, idx, (e) => basePaths.get(e.id)) }, date, { average: false }));
        const change = planEst.band && baseEst.band ? (bandRank(planEst.band) > bandRank(baseEst.band) ? 'UP' : bandRank(planEst.band) < bandRank(baseEst.band) ? 'DOWN' : 'SAME') : null;
        if (change === 'DOWN') {
          flags.push({
            code: 'NITAQAT_BAND_DROP',
            severity: 'WARNING',
            companyId: cid,
            message: `${company?.name ?? cid}: بنهاية السنة ${y + 1} من الخطة (${months[idx].key}) يصبح النطاق ${BAND_LABELS[planEst.band!]} (${planEst.pct}%) بدل ${BAND_LABELS[baseEst.band!]} (${baseEst.pct}%) دون الخطة`,
          });
        }
        nit = { plan: planEst, baseline: baseEst, change };
      }
      return { yearIndex: y + 1, month: months[idx].key, date: ymd(date), nitaqat: nit, levy: { plan: levyOf(tcPlan, cid, idx), baseline: levyOf(tcBase, cid, idx) } };
    });
    const levyDelta: Partial<Record<PlanWindowKey, number>> = {};
    for (const k of planWindowKeys(n)) {
      let s = 0;
      for (let i = 0; i < windowLength(k, n); i++) s += levyOf(tcPlan, cid, i).levyTotal - levyOf(tcBase, cid, i).levyTotal;
      levyDelta[k] = roundMoney(s);
    }
    return { companyId: cid, name: company?.name ?? cid, years, levyDelta };
  });

  // ---- Localization shortfall created by an exit ----
  const decisions = (base.decisions ?? []).map((d) => ('phases' in d && Array.isArray((d as ParsedDecision).phases) ? (d as ParsedDecision) : parseDecision(d as LocalizationDecisionRow)));
  if (decisions.length) {
    for (const x of exits.values()) {
      const cid = x.employee.legalCompanyId;
      if (!cid) continue;
      const date = new Date(x.lwd.getTime() + DAY_MS);
      const idx = Math.min(n - 1, Math.max(0, offsetOf(fromKey, planMonthKey(date)!)));
      const after = stateAt(planEmployees.filter((e) => e.legalCompanyId === cid), idx, (e) => pathById.get(e.id));
      const stayed = after.map((e) => (e.id === x.employee.id ? { ...e, terminationDate: x.employee.terminationDate ?? null } : e));
      const ca = localizationCompliance({ companyId: cid, employees: after, decisions }, date);
      const cb = localizationCompliance({ companyId: cid, employees: stayed, decisions }, date);
      for (const it of ca.items) {
        const before = cb.items.find((b) => b.decisionId === it.decisionId);
        if (!it.applies || !before) continue;
        if (it.shortfallReplacements > before.shortfallReplacements || (before.compliant !== false && it.compliant === false)) {
          flagPos(x.position, {
            code: 'EXIT_LOCALIZATION_SHORTFALL',
            severity: 'WARNING',
            companyId: cid,
            message: `«${x.position.title}»: بعد خروج ${x.employee.name} تصبح نسبة ${it.groupNameAr} ${it.actualPct ?? 0}% والمطلوب ${it.requiredPct}%: ينقص ${it.shortfallReplacements} سعودي (كان ${before.shortfallReplacements})`,
          });
        }
      }
    }
  }
  // Items carry their flags (the localization flags were added after the items were built).
  for (const it of items) it.flags = posFlags.get(it.positionId) ?? [];

  // ---- People (plan vs actual) ----
  const hireByEmp = new Map(liveHires.map((h) => [h.employee.id, h]));
  const people: PlanPerson[] = tcPlan.employees
    .map((r) => {
      const h = hireByEmp.get(r.employeeId);
      const x = exits.get(r.employeeId);
      return {
        id: r.employeeId,
        kind: h ? ('HIRE' as const) : ('EMPLOYEE' as const),
        positionId: h ? h.position.id : null,
        name: r.name,
        employeeNo: r.employeeNo,
        legalCompanyId: r.legalCompanyId,
        departmentId: r.departmentId,
        nationalityClass: r.nationalityClass,
        comparable: months.map((m) => monthLineSum(r, m.i, COMPARABLE_KEYS)),
        gosi: months.map((m) => monthLineSum(r, m.i, ['GOSI_EMPLOYER'])),
        plannedExitMonth: x ? months[x.idx].key : null,
      };
    })
    .sort(byId);

  // ---- Explanations ----
  const explanations: Record<string, PlanExplanation> = {};
  for (const [k, v] of Object.entries(tcPlan.explanations)) if (v) explanations[k] = v;
  const dedupEvidence = (xs: ReadonlyArray<RuleEvidence>) => {
    const m = new Map<string, RuleEvidence>();
    for (const e of xs) m.set(`${e.key}@${e.effectiveFrom ?? ''}`, e);
    return [...m.values()].sort((p, q) => p.key.localeCompare(q.key) || String(p.effectiveFrom).localeCompare(String(q.effectiveFrom)));
  };
  explanations.EXIT_ONE_OFF = {
    label: 'تكاليف الخروج لمرة واحدة',
    formulaText: 'مكافأة نهاية الخدمة حسب السبب (المواد 84 و85 و87 و54) + بدل الإشعار + بدل الإجازة غير المستخدمة، بحساب شاشة التصفية نفسه في شهر الخروج، مع افتراض العمل بمدة الإشعار. راتب الشهر الأخير في المسير لا هنا.',
    rules: dedupEvidence(exitExplainRules),
  };
  explanations.EXIT_ACCRUAL_RELEASE = {
    label: 'استرداد مخصص نهاية الخدمة للمغادرين',
    formulaText: '− مجموع سطر «استحقاق مكافأة نهاية الخدمة» للمغادر من بداية الخطة حتى شهر خروجه: المكافأة المدفوعة عند الخروج تشمله فلا يُحسب مرتين.',
    rules: [],
  };
  explanations.ATTRITION = {
    label: 'الدوران المتوقع (إحصائي)',
    formulaText: '− (1 − (1 − r)^(i ÷ 12)) × كلفة الموظفين الحاليين غير المخطط خروجهم في الشهر i (i = الأشهر منذ بداية الخطة)، على الكلفة والدعم كليهما. لا يُحذف أحد بالاسم ولا يتغير العدد المسمّى.',
    rules: [],
    basis:
      attrSource === 'PLAN'
        ? `r = ${attrPct}% سنوياً (إدخال الخطة)`
        : attrSource === 'ACTUAL' && turnover?.ratePct !== null && turnover
          ? `r = ${attrPct}% سنوياً = الدوران الفعلي: ${turnover.basis}`
          : 'لا دوران محسوب (أدخل نسبة في الخطة)',
  };

  const rulesMap = new Map<string, RuleVersionRef>();
  for (const r of [...tcPlan.rulesUsed, ...exitRules]) rulesMap.set(`${r.key}@${r.effectiveFrom}`, r);
  const rulesUsed = [...rulesMap.values()].sort((p, q) => p.key.localeCompare(q.key) || String(p.effectiveFrom).localeCompare(String(q.effectiveFrom)));

  const engineFlags = new Map<string, { code: string; severity: 'ERROR' | 'WARNING' | 'INFO'; count: number; message: string | null }>();
  for (const f of tcPlan.flags) {
    const cur = engineFlags.get(f.code) ?? { code: f.code, severity: f.severity, count: 0, message: null };
    cur.count++;
    if (!f.employeeId && !cur.message) cur.message = f.message;
    engineFlags.set(f.code, cur);
  }

  return {
    engineVersion: ENGINE_VERSION,
    planEngineVersion: PLAN_ENGINE_VERSION,
    disclaimer: ESTIMATE_DISCLAIMER,
    planId: plan.id,
    planName: plan.name,
    scenario,
    fromMonth: fromKey,
    months: n,
    monthKeys: months.map((m) => m.key),
    scope: { companyId: scopeCompany, employees: scopeIds.size },
    series,
    totals,
    composition,
    attrition: { pct: attrPct, source: attrSource, turnover, basis: explanations.ATTRITION.basis ?? '' },
    raisesEffect,
    items,
    raises,
    companies: companiesOut,
    flags,
    engineFlags: [...engineFlags.values()].sort((p, q) => p.code.localeCompare(q.code)),
    explanations,
    rulesUsed,
    assumptions: [
      'الخطة سيناريو: لا يُكتب شيء في ملف الموظف ولا الرواتب ولا البدلات ولا المسير؛ التحويل إلى قرار فعلي يمر ببوابة المال.',
      'الأساس: موظفو نطاق الخطة الحاليون بمحرك الكلفة الحقيقية، مع بقية موظفي الكيان القانوني نفسه لشرائح المقابل المالي.',
      'التعيين والإحلال موظفون افتراضيون يباشرون أول الشهر، ويُفترض توثيق عقودهم في قوى؛ السعودي الجديد بالنظام الجديد للتأمينات ما لم يُحدَّد غيره.',
      'الخروج المخطط في آخر يوم من شهره، مع العمل بمدة الإشعار؛ وتكاليفه لمرة واحدة في شهره مع استرداد مخصص نهاية الخدمة المحسوب في أشهر الخطة.',
      'الزيادات المخططة تحل محل افتراض «نسبة الزيادة السنوية»، وتنطبق على من باشر قبل شهر السريان.',
      'الدوران سطر إحصائي منفصل لا يحذف أحداً بالاسم؛ ولا يدخل في تقدير نطاقات.',
      'نطاقات في نهاية كل سنة من الخطة تقدير لحظي بالأجور المخططة؛ المرجع الرسمي منصة قوى.',
    ],
    people,
  };
}

// ---------------------------------------------------------------------------
// Plan vs actual
// ---------------------------------------------------------------------------

/** Stored Payroll row (columns of the Payroll model). */
export interface PayrollActualRow {
  employeeId: string;
  year: number;
  month: number;
  status: string;
  basicSalary: number;
  totalAllowances: number;
  overtimeCost: number;
  gosiEmployer: number;
  bonusAmount: number;
}

export interface ActualEmployeeInfo {
  id: string;
  name: string;
  employeeNo?: string | null;
  joinDate: Date;
  terminationDate?: Date | null;
  isTerminated?: boolean | null;
  legalCompanyId?: string | null;
  departmentId?: string | null;
  nationality?: string | null;
}

export const PVA_DRIVERS = ['SALARY_DIFF', 'HIRE_FILLED_DIFF', 'UNPLANNED_HIRE', 'PLANNED_HIRE_NOT_DONE', 'UNPLANNED_EXIT', 'PLANNED_EXIT_NOT_DONE', 'MISSING_ROW', 'OVERTIME_BONUS', 'OTHER_UNPLANNED'] as const;
export type PvaDriverKey = (typeof PVA_DRIVERS)[number];
export const PVA_DRIVER_LABELS: Record<PvaDriverKey, string> = {
  SALARY_DIFF: 'فرق رواتب الموظفين المخطط لهم',
  HIRE_FILLED_DIFF: 'تعيينات مخططة تمّت (فرق الأجر أو التوقيت)',
  UNPLANNED_HIRE: 'تعيينات غير مخططة',
  PLANNED_HIRE_NOT_DONE: 'تعيينات مخططة لم تتم',
  UNPLANNED_EXIT: 'خروج غير مخطط',
  PLANNED_EXIT_NOT_DONE: 'خروج مخطط لم يتم (ما زال في المسير)',
  MISSING_ROW: 'موظفون مخطط لهم بلا سطر مسير معتمد',
  OVERTIME_BONUS: 'عمل إضافي ومكافآت لمرة واحدة (خارج الخطة)',
  OTHER_UNPLANNED: 'موظفون خارج أساس الخطة',
};

export interface PvaMonth {
  month: string;
  /** Planned salary + allowances + employer GOSI (GOSI excluded on both sides in a partial month). */
  planned: number;
  /** Actual gross (basic + allowances incl. bonuses + overtime) + employer GOSI (GOSI excluded when partial). */
  actual: number;
  variance: number;
  variancePct: number | null;
  plannedHeadcount: number;
  actualHeadcount: number;
  headcountVariance: number;
  /** Rows without a stored employer GOSI (generated before the breakdown columns existed). */
  partial: boolean;
  partialRows: number;
  rows: number;
  actualBreakdown: { basic: number; allowances: number; bonus: number; overtime: number; gosiEmployer: number };
  drivers: Partial<Record<PvaDriverKey, number>>;
}

export interface PvaDriver {
  key: PvaDriverKey;
  label: string;
  amount: number;
  count: number;
  people: Array<{ id: string; name: string; amount: number }>;
}

export interface PlanVsActualResult {
  asOf: string;
  months: PvaMonth[];
  /** Plan months up to asOf without an APPROVED / PAID payroll (not compared). */
  monthsWithoutPayroll: string[];
  cumulative: { planned: number; actual: number; variance: number; variancePct: number | null; partial: boolean; months: number };
  drivers: PvaDriver[];
  explanations: string[];
}

const PAID_STATUSES = new Set(['APPROVED', 'PAID']);

/**
 * Plan vs actual for the plan months ≤ asOf that have APPROVED / PAID payroll rows (SPEC §8):
 * planned = salary + recurring allowances + employer GOSI of every plan person (one-offs, attrition and the
 * statistical lines excluded); actual = the payroll's gross (basic + allowances + overtime) + employer GOSI.
 * A month with a row lacking the stored employer GOSI (older than the breakdown migration) is PARTIAL: GOSI is
 * excluded on both sides. The variance is decomposed exactly into drivers (sum of drivers = variance):
 * salary differences of planned people, planned hires filled by actual joiners (matched by company,
 * department and nationality class, in date order, and only when the planned start month ≤ the join month +
 * PVA_START_TOLERANCE_MONTHS: an earlier joiner is an unplanned hire), unplanned hires / exits, planned hires / exits not done,
 * overtime and one-off bonuses (not in the plan). `payrollRows` must already be limited to the plan scope.
 */
export function planVsActual(
  plan: Pick<PlanDefinition, 'fromMonth' | 'companyId'>,
  projection: Pick<PlanProjection, 'monthKeys' | 'series' | 'people' | 'items'>,
  payrollRows: ReadonlyArray<PayrollActualRow>,
  asOf: Date,
  ctx: { employees?: ReadonlyArray<ActualEmployeeInfo> } = {},
): PlanVsActualResult {
  const asOfKey = planMonthKey(asOf)!;
  const fromKey = planMonthKey(plan.fromMonth) ?? projection.monthKeys[0];
  const planStart = parseMonth(fromKey);
  const planStartDate = monthStartUtc(planStart.year, planStart.month);
  const info = new Map((ctx.employees ?? []).map((e) => [e.id, e]));
  const nameOf = (id: string) => info.get(id)?.name ?? projection.people.find((p) => p.id === id)?.name ?? id;
  const considered = projection.monthKeys.map((k, i) => ({ k, i })).filter((m) => m.k <= asOfKey);
  const rowsByMonth = new Map<string, PayrollActualRow[]>();
  for (const r of payrollRows) {
    if (!PAID_STATUSES.has(String(r.status))) continue;
    const k = ymKey(r.year, r.month);
    const list = rowsByMonth.get(k) ?? [];
    list.push(r);
    rowsByMonth.set(k, list);
  }

  // Match planned hires with actual joiners.
  const people = [...projection.people].sort(byId);
  const planned = new Set(people.filter((p) => p.kind === 'EMPLOYEE').map((p) => p.id));
  const joiners = [...info.values()]
    .filter((e) => !planned.has(e.id) && e.joinDate.getTime() >= planStartDate.getTime() && e.joinDate.getTime() <= asOf.getTime())
    .sort((a, b) => a.joinDate.getTime() - b.joinDate.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hires = people
    .filter((p) => p.kind === 'HIRE')
    .map((p) => ({ p, first: p.comparable.findIndex((v) => v !== 0), item: projection.items.find((it) => it.positionId === p.positionId) }))
    .sort((a, b) => (a.first < 0 ? 1e9 : a.first) - (b.first < 0 ? 1e9 : b.first) || byId(a.p, b.p));
  const matchOf = new Map<string, string>();
  const matchedJoiners = new Set<string>();
  const monthIndex = (key: string) => {
    const pm = parseMonth(key);
    return pm.year * 12 + pm.month;
  };
  for (const h of hires) {
    // Planned (effective) start of the position; else its first costed plan month.
    const startKey = h.item?.start ?? (h.first >= 0 ? projection.monthKeys[h.first] : null);
    const earliest = startKey ? monthIndex(startKey) - PVA_START_TOLERANCE_MONTHS : -Infinity;
    const j = joiners.find(
      (e) =>
        !matchedJoiners.has(e.id) &&
        monthIndex(planMonthKey(e.joinDate)!) >= earliest &&
        (!h.item?.companyId || e.legalCompanyId === h.item.companyId) &&
        (!h.item?.departmentId || e.departmentId === h.item.departmentId) &&
        nationalityClass(e.nationality) === h.p.nationalityClass,
    );
    if (j) {
      matchOf.set(h.p.id, j.id);
      matchedJoiners.add(j.id);
    }
  }

  const driverPeople = new Map<PvaDriverKey, Map<string, number>>();
  const addDriver = (d: Partial<Record<PvaDriverKey, number>>, key: PvaDriverKey, amount: number, personId: string) => {
    if (amount === 0) return;
    d[key] = roundMoney((d[key] ?? 0) + amount);
    const m = driverPeople.get(key) ?? new Map<string, number>();
    m.set(personId, roundMoney((m.get(personId) ?? 0) + amount));
    driverPeople.set(key, m);
  };

  const months: PvaMonth[] = [];
  const without: string[] = [];
  for (const { k, i } of considered) {
    const rows = rowsByMonth.get(k) ?? [];
    if (!rows.length) {
      without.push(k);
      continue;
    }
    const partialRows = rows.filter((r) => num(r.gosiEmployer) <= 0 && num(r.basicSalary) + num(r.totalAllowances) > 0).length;
    const partial = partialRows > 0;
    const byEmp = new Map(rows.map((r) => [r.employeeId, r]));
    const comp = (r: PayrollActualRow) => roundMoney(num(r.basicSalary) + num(r.totalAllowances) - num(r.bonusAmount) + (partial ? 0 : num(r.gosiEmployer)));
    const extra = (r: PayrollActualRow) => roundMoney(num(r.overtimeCost) + num(r.bonusAmount));
    const planOf = (p: PlanPerson) => roundMoney((p.comparable[i] ?? 0) - (partial ? (p.gosi[i] ?? 0) : 0));
    const drivers: Partial<Record<PvaDriverKey, number>> = {};
    const used = new Set<string>();
    let plannedTotal = 0;
    const endOfMonth = monthEndUtc(Number(k.slice(0, 4)), Number(k.slice(5, 7)));
    for (const p of people) {
      const pv = planOf(p);
      plannedTotal += pv;
      const actualId = p.kind === 'EMPLOYEE' ? p.id : (matchOf.get(p.id) ?? null);
      const row = actualId ? byEmp.get(actualId) : undefined;
      if (row && actualId) {
        used.add(actualId);
        const diff = roundMoney(comp(row) - pv);
        if (p.kind === 'HIRE') addDriver(drivers, 'HIRE_FILLED_DIFF', diff, actualId);
        else if (pv === 0 && p.plannedExitMonth && k > p.plannedExitMonth) addDriver(drivers, 'PLANNED_EXIT_NOT_DONE', diff, actualId);
        else addDriver(drivers, 'SALARY_DIFF', diff, actualId);
      } else if (pv !== 0) {
        if (p.kind === 'HIRE') addDriver(drivers, 'PLANNED_HIRE_NOT_DONE', -pv, p.id);
        else {
          const e = info.get(p.id);
          const gone = !!e && e.isTerminated !== false && !!e.terminationDate && e.terminationDate.getTime() <= endOfMonth.getTime();
          addDriver(drivers, gone ? 'UNPLANNED_EXIT' : 'MISSING_ROW', -pv, p.id);
        }
      }
    }
    let actualTotal = 0;
    let hcActual = 0;
    const breakdown = { basic: 0, allowances: 0, bonus: 0, overtime: 0, gosiEmployer: 0 };
    for (const r of [...rows].sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1))) {
      hcActual++;
      actualTotal += comp(r) + extra(r);
      breakdown.basic += num(r.basicSalary);
      breakdown.allowances += num(r.totalAllowances) - num(r.bonusAmount);
      breakdown.bonus += num(r.bonusAmount);
      breakdown.overtime += num(r.overtimeCost);
      breakdown.gosiEmployer += num(r.gosiEmployer);
      addDriver(drivers, 'OVERTIME_BONUS', extra(r), r.employeeId);
      if (used.has(r.employeeId)) continue;
      const e = info.get(r.employeeId);
      const joined = !!e && e.joinDate.getTime() >= planStartDate.getTime();
      addDriver(drivers, joined ? 'UNPLANNED_HIRE' : 'OTHER_UNPLANNED', comp(r), r.employeeId);
    }
    plannedTotal = roundMoney(plannedTotal);
    actualTotal = roundMoney(actualTotal);
    const variance = roundMoney(actualTotal - plannedTotal);
    const plannedHc = projection.series[i]?.headcount.total ?? 0;
    months.push({
      month: k,
      planned: plannedTotal,
      actual: actualTotal,
      variance,
      variancePct: plannedTotal ? round2((variance / plannedTotal) * 100) : null,
      plannedHeadcount: plannedHc,
      actualHeadcount: hcActual,
      headcountVariance: hcActual - plannedHc,
      partial,
      partialRows,
      rows: rows.length,
      actualBreakdown: {
        basic: roundMoney(breakdown.basic),
        allowances: roundMoney(breakdown.allowances),
        bonus: roundMoney(breakdown.bonus),
        overtime: roundMoney(breakdown.overtime),
        gosiEmployer: roundMoney(breakdown.gosiEmployer),
      },
      drivers,
    });
  }

  const cPlanned = roundMoney(months.reduce((s, m) => s + m.planned, 0));
  const cActual = roundMoney(months.reduce((s, m) => s + m.actual, 0));
  const cVar = roundMoney(cActual - cPlanned);
  const drivers: PvaDriver[] = PVA_DRIVERS.map((key) => {
    const amount = roundMoney(months.reduce((s, m) => s + (m.drivers[key] ?? 0), 0));
    const ppl = [...(driverPeople.get(key) ?? new Map<string, number>()).entries()]
      .filter(([, v]) => v !== 0)
      .map(([id, v]) => ({ id, name: nameOf(id), amount: v }))
      .sort((p, q) => Math.abs(q.amount) - Math.abs(p.amount) || (p.id < q.id ? -1 : 1));
    return { key, label: PVA_DRIVER_LABELS[key], amount, count: ppl.length, people: ppl.slice(0, 10) };
  }).filter((d) => d.amount !== 0 || d.count > 0);

  const explanations: string[] = [];
  if (!months.length) explanations.push('لا توجد أشهر في الخطة حتى هذا التاريخ لها مسير معتمد أو مصروف.');
  else {
    explanations.push(
      `المخطط ${fmt(cPlanned)} والفعلي ${fmt(cActual)} في ${arabicMonths(months.length, true)}: الفرق ${fmt(cVar)}${cPlanned ? ` (${round2((cVar / cPlanned) * 100)}%)` : ''}.`,
    );
    for (const d of [...drivers].sort((p, q) => Math.abs(q.amount) - Math.abs(p.amount)).slice(0, 4)) {
      if (d.amount === 0) continue;
      explanations.push(`${d.label}: ${fmt(d.amount)} (${d.count} ${d.count === 1 ? 'موظف' : 'موظفين'}${d.people[0] ? `، أكبرهم ${d.people[0].name} ${fmt(d.people[0].amount)}` : ''}).`);
    }
    if (months.some((m) => m.partial)) explanations.push('أشهر جزئية: بعض سطور المسير قبل تخزين حصة صاحب العمل في التأمينات، فاستُبعدت التأمينات من المخطط والفعلي في تلك الأشهر.');
  }
  return {
    asOf: ymd(asOf),
    months,
    monthsWithoutPayroll: without,
    cumulative: { planned: cPlanned, actual: cActual, variance: cVar, variancePct: cPlanned ? round2((cVar / cPlanned) * 100) : null, partial: months.some((m) => m.partial), months: months.length },
    drivers,
    explanations,
  };
}

// ---------------------------------------------------------------------------
// Compare versions
// ---------------------------------------------------------------------------

export interface PlanCompareColumn {
  planId: string;
  name: string;
  status: string;
  fromMonth: string;
  months: number;
  frozen: boolean;
  totals: Partial<Record<PlanWindowKey, { totalBeforeHrdf: number; totalAfterHrdf: number; deltaAfterHrdf: number; exitOneOff: number; attrition: number }>>;
  headcount: { start: PlanHeadcount | null; end: PlanHeadcount | null };
  positions: Record<PositionKind, number>;
  raises: number;
  nitaqat: Array<{ companyId: string; name: string; years: Array<{ yearIndex: number; month: string; band: NitaqatBand | null; pct: number | null; status: string }> }>;
  /** totalAfterHrdf − the first column's, per window. */
  vsFirst: Partial<Record<PlanWindowKey, number>>;
}

/** Side-by-side summary of 2–3 plan versions (the first column is the reference). */
export function comparePlanProjections(list: ReadonlyArray<{ plan: { id: string; name: string; status: string }; projection: PlanProjection; frozen?: boolean }>): PlanCompareColumn[] {
  const cols = list.map(({ plan, projection: p, frozen }) => {
    const totals: PlanCompareColumn['totals'] = {};
    for (const [k, w] of Object.entries(p.totals) as Array<[PlanWindowKey, PlanWindow]>) {
      totals[k] = { totalBeforeHrdf: w.totalBeforeHrdf, totalAfterHrdf: w.totalAfterHrdf, deltaAfterHrdf: w.deltaAfterHrdf, exitOneOff: w.exitOneOff, attrition: w.attrition.net };
    }
    const positions: Record<PositionKind, number> = { NEW_HIRE: 0, BACKFILL: 0, EXIT: 0 };
    for (const it of p.items) positions[it.kind]++;
    return {
      planId: plan.id,
      name: plan.name,
      status: plan.status,
      fromMonth: p.fromMonth,
      months: p.months,
      frozen: !!frozen,
      totals,
      headcount: { start: p.series[0]?.headcount ?? null, end: p.series[p.series.length - 1]?.headcount ?? null },
      positions,
      raises: p.raises.length,
      nitaqat: p.companies.map((c) => ({
        companyId: c.companyId,
        name: c.name,
        years: c.years.map((y) => ({ yearIndex: y.yearIndex, month: y.month, band: y.nitaqat?.plan.band ?? null, pct: y.nitaqat ? y.nitaqat.plan.pct : null, status: y.nitaqat?.plan.status ?? 'NOT_ESTIMATED' })),
      })),
      vsFirst: {} as Partial<Record<PlanWindowKey, number>>,
    };
  });
  const first = cols[0];
  for (const c of cols) {
    for (const k of Object.keys(c.totals) as PlanWindowKey[]) {
      const f = first?.totals[k];
      if (f && c.totals[k]) c.vsFirst[k] = roundMoney(c.totals[k]!.totalAfterHrdf - f.totalAfterHrdf);
    }
  }
  return cols;
}

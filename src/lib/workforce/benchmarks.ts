// Internal benchmarks («المؤشرات الداخلية», SPEC §1 module 7 and §9). PURE, deterministic, client-safe.
//
// Principle (SPEC «لا أرقام مخترعة»): every value is computed ONLY from the organisation's own records in
// Radeef. There is no default, no industry figure and no fallback number: when the data is insufficient the
// metric value is null with a reason («لا توجد بيانات كافية»). Every metric carries its numerator,
// denominator, period, formula and data-quality notes («كيف حُسب؟»).
//
// Conventions (documented in SPEC §9):
// - Period = the N calendar months ending with the month of `asOf` (the current month counts up to `asOf`).
//   Monthly buckets are calendar months; the snapshot of a month is its last day (or `asOf`).
// - Employed on day d: joinDate <= d and (no exit or exit >= d); exit = terminationDate of a terminated
//   employee (the last day of employment). A terminated employee without a termination date cannot be
//   placed in time: excluded and counted in the data-quality notes.
// - Average headcount = mean of the month-end headcounts of the period (N points).
// - Privacy: aggregated only, no names. Any breakdown group smaller than MIN_GROUP_SIZE (5) is suppressed
//   («أقل من 5»); while the suppressed groups together are below 5, the next smallest group is suppressed
//   too (otherwise total − others reveals them). A scope (company / branch / department filter) whose average
//   headcount is below 5 shows no metric at all, and a sub-scope that would reveal a small group by
//   subtraction from a wider scope is hidden too (scopeDisclosure). Per-case / per-person metrics computed
//   on fewer than 5 cases are hidden («أقل من 5 حالات»).
import { roundMoney } from '@/lib/money';
import { nationalityClass, type NationalityClass } from '@/lib/nationality';
import { addMonthsYm, eosbLiability, fmt, monthEndUtc, monthStartUtc } from '@/lib/workforce/formulas';

export const BENCHMARK_SOURCE = 'بيانات المنشأة في رديف' as const;
export const INSUFFICIENT_DATA = 'لا توجد بيانات كافية';
export const MIN_GROUP_SIZE = 5;
export const SUPPRESSED_TEXT = 'أقل من 5';
export const COMPLEMENTARY_SUPPRESSED_TEXT = 'محجوب لحماية مجموعة صغيرة';
export const SCOPE_SUPPRESSED_REASON = 'أقل من 5 موظفين في النطاق المختار: لا تُعرض المؤشرات حمايةً للخصوصية';
/** A sub-scope whose figures would reveal a small group by subtraction from a wider scope. */
export const SCOPE_COMPLEMENT_REASON = 'النطاق المختار محجوب لحماية مجموعة صغيرة: أرقامه مع النطاق الأوسع تكشف مجموعة أقل من 5 بالطرح';
/** A per-case / per-person metric computed on fewer than 5 cases. */
export const SMALL_COUNT_TEXT = 'أقل من 5 حالات';
export const SMALL_COUNT_REASON = `${SMALL_COUNT_TEXT}: لا تُعرض القيمة حمايةً للخصوصية`;
export const BENCHMARK_PERIODS = [3, 6, 12, 24] as const;
export type BenchmarkPeriodMonths = (typeof BENCHMARK_PERIODS)[number];

/** Payment request document types counted as government fees of an employee (iqama / permit / visa). */
export const GOV_FEE_DOCUMENT_PATTERN = /IQAMA|PERMIT|VISA|EXIT_REENTRY|RESIDENCE/i;

const DAY_MS = 86400000;
const YEAR_DAYS = 365.25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BmUnit = 'PERCENT' | 'SAR' | 'DAYS' | 'YEARS' | 'HOURS' | 'COUNT';

export interface BmPeriod {
  /** 'YYYY-MM-DD' first day of the first month. */
  from: string;
  /** 'YYYY-MM-DD' = asOf. */
  to: string;
  months: number;
  /** 'YYYY-MM' of every month of the period, oldest first. */
  monthKeys: string[];
  /** The last month is counted up to `to` only. */
  partialLastMonth: boolean;
}

export interface BenchmarkMetric {
  key: string;
  label: string;
  unit: BmUnit;
  /** null = not computable (see reason) or suppressed. */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  numeratorLabel: string;
  denominatorLabel: string;
  /** Arabic formula («كيف حُسب؟»). */
  formula: string;
  period: BmPeriod;
  dataQuality: string[];
  source: typeof BENCHMARK_SOURCE;
  /** Why value is null. */
  reason: string | null;
  /** Approximation (no dedicated timestamp / lump sums): shown as «تقريبي». */
  approximate: boolean;
  /** Secondary values (median, annualized...). */
  extra?: Record<string, number | null>;
}

export interface BreakdownRow {
  key: string;
  label: string;
  /** Group size tested against MIN_GROUP_SIZE (null when suppressed). */
  size: number | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  suppressed: boolean;
  /** «أقل من 5» or «محجوب لحماية مجموعة صغيرة». */
  suppressedText: string | null;
  extra?: Record<string, number | null>;
}

export interface SeriesPoint {
  month: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  suppressed: boolean;
}

export interface BmEmployee {
  id: string;
  joinDate: Date;
  isTerminated: boolean;
  /** Last day of employment (terminated employees). */
  terminationDate: Date | null;
  exitVoluntary?: boolean | null;
  exitReason?: string | null;
  nationality?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  branchId?: string | null;
  legalCompanyId?: string | null;
  basicSalary?: number | null;
  /** Sum of the recurring (monthly) allowances. */
  monthlyAllowances?: number | null;
}

/** APPROVED / PAID payroll row. */
export interface BmPayrollRow {
  employeeId: string;
  year: number;
  month: number;
  basicSalary: number;
  totalAllowances: number;
  overtimeCost: number;
  bonusAmount?: number | null;
  gosiEmployer: number;
}

/** APPROVED overtime request. */
export interface BmOvertimeRequest {
  employeeId: string;
  date: Date;
  hours: number | null;
  amount?: number | null;
  type?: string | null;
}

/** Attendance days per employee and calendar month (status PRESENT / ABSENT). */
export interface BmAttendanceMonth {
  employeeId: string;
  month: string;
  present: number;
  absent: number;
}

/** APPROVED / COMPLETED leave. */
export interface BmLeave {
  employeeId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
}

export interface BmSettlement {
  employeeId: string;
  type: string;
  status: string;
  endOfServiceAmount: number | null;
  leaveCompensation: number | null;
  terminationReason: string | null;
  lastWorkingDate: Date | null;
  createdAt: Date;
  /** 'basic' | 'total' (null = total). */
  salaryBasis?: string | null;
}

/** FULFILLED job request. */
export interface BmJobRequest {
  id: string;
  createdAt: Date;
  /** JobRequest.updatedAt (the FULFILLED status has no timestamp of its own). */
  fulfilledAt: Date;
  /** updatedAt of the earliest HIRED application, when any. */
  hiredAt?: Date | null;
  departmentId?: string | null;
}

/** PAID / COMPLETED payment request of an employee document (iqama / permit / visa). */
export interface BmGovFeePayment {
  employeeId: string;
  documentType: string;
  amount: number;
  /** PaymentRequest.updatedAt (no paidAt column). */
  paidAt: Date;
}

export interface BenchmarksInput {
  employees: ReadonlyArray<BmEmployee>;
  payrolls: ReadonlyArray<BmPayrollRow>;
  overtimeRequests: ReadonlyArray<BmOvertimeRequest>;
  attendance: ReadonlyArray<BmAttendanceMonth>;
  leaves: ReadonlyArray<BmLeave>;
  settlements: ReadonlyArray<BmSettlement>;
  jobRequests: ReadonlyArray<BmJobRequest>;
  govFees: ReadonlyArray<BmGovFeePayment>;
  /** User-entered assumptions (RECRUITMENT_COST_SAUDI / _EXPAT); null = not entered. */
  recruitmentCost?: { saudi: number | null; expat: number | null };
}

export interface BenchmarksOptions {
  asOf: Date;
  months: number;
  /** Default MIN_GROUP_SIZE (5). */
  minGroupSize?: number;
  /**
   * Result of scopeDisclosure() for a sub-scope query (company / branch / department filter): hide the
   * whole scope (with the reason) and / or the listed months of every monthly series.
   */
  disclosure?: ScopeDisclosure | null;
}

export interface TurnoverResult {
  /** Exits ÷ average headcount × 100 over the period (percent). */
  overall: BenchmarkMetric;
  voluntary: BenchmarkMetric;
  involuntary: BenchmarkMetric;
  unknownType: BenchmarkMetric;
  exits: number;
  averageHeadcount: number;
  /** Monthly: exits of the month ÷ headcount at the month end × 100. */
  series: SeriesPoint[];
  byNationality: BreakdownRow[];
  byDepartment: BreakdownRow[];
  byTenure: BreakdownRow[];
}

export interface BenchmarksResult {
  period: BmPeriod;
  asOf: string;
  source: typeof BENCHMARK_SOURCE;
  minGroupSize: number;
  headcount: { start: number; end: number; average: number };
  /** The scope is smaller than the minimum group: every metric is hidden. */
  scopeSuppressed: boolean;
  turnover: TurnoverResult;
  tenure: { active: BenchmarkMetric; leavers: BenchmarkMetric };
  newHireAttrition: { m3: BenchmarkMetric; m6: BenchmarkMetric };
  timeToHire: BenchmarkMetric;
  overtime: {
    hours: BenchmarkMetric;
    cost: BenchmarkMetric;
    hoursPerEmployeePerMonth: BenchmarkMetric;
    series: Array<{ month: string; hours: number | null; cost: number | null; suppressed: boolean }>;
    byDepartment: BreakdownRow[];
  };
  absence: {
    rate: BenchmarkMetric;
    sickDaysPerEmployee: BenchmarkMetric;
    series: SeriesPoint[];
    byDepartment: BreakdownRow[];
    sickByDepartment: BreakdownRow[];
  };
  endOfService: { paidPerExit: BenchmarkMetric; paidVsAccrued: BenchmarkMetric };
  govFees: { perExpatPerYear: BenchmarkMetric };
  costPerEmployee: { perMonth: BenchmarkMetric; series: SeriesPoint[]; byDepartment: BreakdownRow[] };
  turnoverCost: { total: BenchmarkMetric; perExit: BenchmarkMetric };
}

// ---------------------------------------------------------------------------
// Dates and small helpers
// ---------------------------------------------------------------------------

function dayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function keyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** `d` + n calendar months, day clamped to the target month (31 Jan + 1 = 28/29 Feb). */
export function addMonthsClamped(d: Date, n: number): Date {
  const t = addMonthsYm(d.getUTCFullYear(), d.getUTCMonth() + 1, n);
  const last = monthEndUtc(t.year, t.month).getUTCDate();
  return new Date(Date.UTC(t.year, t.month - 1, Math.min(d.getUTCDate(), last)));
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sum(xs: ReadonlyArray<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function median(xs: ReadonlyArray<number>): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The period of `months` calendar months ending with the month of `asOf` (asOf included). */
export function benchmarkPeriod(asOf: Date, months: number): BmPeriod & { fromDate: Date; toDate: Date } {
  const n = Math.max(1, Math.floor(months));
  const to = dayUtc(asOf);
  const y = to.getUTCFullYear();
  const m = to.getUTCMonth() + 1;
  const first = addMonthsYm(y, m, -(n - 1));
  const from = monthStartUtc(first.year, first.month);
  const monthKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = addMonthsYm(first.year, first.month, i);
    monthKeys.push(keyOf(t.year, t.month));
  }
  return { from: ymd(from), to: ymd(to), months: n, monthKeys, partialLastMonth: to.getTime() < monthEndUtc(y, m).getTime(), fromDate: from, toDate: to };
}

/** Month-end snapshot date of a month key (the last month: asOf). */
function snapshotOf(key: string, asOf: Date): Date {
  const [yy, mm] = key.split('-').map(Number);
  const end = monthEndUtc(yy, mm);
  return end.getTime() > asOf.getTime() ? asOf : end;
}

function publicPeriod(p: BmPeriod): BmPeriod {
  return { from: p.from, to: p.to, months: p.months, monthKeys: p.monthKeys, partialLastMonth: p.partialLastMonth };
}

/** Exit (last employed day) of an employee; undefined = terminated without a date (cannot be placed). */
function exitOf(e: BmEmployee): Date | null | undefined {
  if (!e.isTerminated) return null;
  return e.terminationDate ? dayUtc(e.terminationDate) : undefined;
}

function employedOn(e: BmEmployee, d: Date): boolean {
  const exit = exitOf(e);
  if (exit === undefined) return false;
  return dayUtc(e.joinDate).getTime() <= d.getTime() && (exit === null || exit.getTime() >= d.getTime());
}

function yearsBetween(a: Date, b: Date): number {
  return (dayUtc(b).getTime() - dayUtc(a).getTime()) / DAY_MS / YEAR_DAYS;
}

function inRange(d: Date, from: Date, to: Date): boolean {
  const t = dayUtc(d).getTime();
  return t >= from.getTime() && t <= to.getTime();
}

// ---------------------------------------------------------------------------
// Metric factory
// ---------------------------------------------------------------------------

interface MetricSpec {
  key: string;
  label: string;
  unit: BmUnit;
  numeratorLabel: string;
  denominatorLabel: string;
  formula: string;
  approximate?: boolean;
}

function metric(
  spec: MetricSpec,
  period: BmPeriod,
  numerator: number | null,
  denominator: number | null,
  value: number | null,
  dataQuality: string[],
  reason: string | null = null,
  extra?: Record<string, number | null>,
): BenchmarkMetric {
  const ok = value !== null && Number.isFinite(value);
  return {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    value: ok ? value : null,
    numerator,
    denominator,
    numeratorLabel: spec.numeratorLabel,
    denominatorLabel: spec.denominatorLabel,
    formula: spec.formula,
    period: publicPeriod(period),
    dataQuality,
    source: BENCHMARK_SOURCE,
    reason: ok ? null : (reason ?? INSUFFICIENT_DATA),
    approximate: !!spec.approximate,
    ...(extra ? { extra } : {}),
  };
}

/** Same metric with no value (scope too small / suppressed). */
function hidden(m: BenchmarkMetric, reason: string): BenchmarkMetric {
  return {
    ...m,
    value: null,
    numerator: null,
    denominator: null,
    reason,
    // Notes carrying counts («2 من 3 طلباً», «عيّنة صغيرة (2 طلبات)») would reveal the hidden sample.
    dataQuality: m.dataQuality.filter((q) => !/\d/.test(q)),
    ...(m.extra ? { extra: Object.fromEntries(Object.keys(m.extra).map((k) => [k, null])) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Suppression (minimum group size)
// ---------------------------------------------------------------------------

export interface GroupInput {
  key: string;
  label: string;
  size: number;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  extra?: Record<string, number | null>;
}

/**
 * Applies the minimum group size to a breakdown: groups with size 0 are dropped; groups with
 * size < min are suppressed («أقل من 5»); while the suppressed groups together are smaller than min (e.g.
 * exactly one small group, or two of 2 people each) and others remain, the smallest remaining group is
 * suppressed as well («محجوب لحماية مجموعة صغيرة») so the suppressed ones cannot be recovered as
 * total − others. Suppressed rows carry no size, value, numerator or extra.
 */
export function suppressGroups(groups: ReadonlyArray<GroupInput>, min: number = MIN_GROUP_SIZE): BreakdownRow[] {
  const rows = groups.filter((g) => g.size > 0);
  const small = new Set(rows.filter((g) => g.size < min).map((g) => g.key));
  const complementary = new Set<string>();
  if (small.size > 0) {
    const rest = rows.filter((g) => !small.has(g.key)).sort((a, b) => a.size - b.size || a.key.localeCompare(b.key));
    let hiddenSize = sum(rows.filter((g) => small.has(g.key)).map((g) => g.size));
    for (const g of rest) {
      if (hiddenSize >= min && complementary.size + small.size > 1) break;
      complementary.add(g.key);
      hiddenSize += g.size;
    }
  }
  return rows.map((g) => {
    const text = small.has(g.key) ? SUPPRESSED_TEXT : complementary.has(g.key) ? COMPLEMENTARY_SUPPRESSED_TEXT : null;
    if (text) {
      return {
        key: g.key,
        label: g.label,
        size: null,
        value: null,
        numerator: null,
        denominator: null,
        suppressed: true,
        suppressedText: text,
        ...(g.extra ? { extra: Object.fromEntries(Object.keys(g.extra).map((k) => [k, null])) } : {}),
      };
    }
    return { key: g.key, label: g.label, size: r1(g.size), value: g.value, numerator: g.numerator, denominator: g.denominator, suppressed: false, suppressedText: null, ...(g.extra ? { extra: g.extra } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Headcount
// ---------------------------------------------------------------------------

/** Employees employed on `d`. */
export function headcountOn(employees: ReadonlyArray<BmEmployee>, d: Date): number {
  const day = dayUtc(d);
  let n = 0;
  for (const e of employees) if (employedOn(e, day)) n++;
  return n;
}

/** Mean of the month-end headcounts of the period, per group key (key computed at each snapshot). */
function averageHeadcountBy(employees: ReadonlyArray<BmEmployee>, snapshots: ReadonlyArray<Date>, keyFn: (e: BmEmployee, d: Date) => string | null): Map<string, number> {
  const totals = new Map<string, number>();
  for (const d of snapshots) {
    for (const e of employees) {
      if (!employedOn(e, d)) continue;
      const k = keyFn(e, d);
      if (k === null) continue;
      totals.set(k, (totals.get(k) ?? 0) + 1);
    }
  }
  const out = new Map<string, number>();
  for (const [k, v] of totals) out.set(k, v / Math.max(1, snapshots.length));
  return out;
}

export const NATIONALITY_CLASS_LABELS: Record<NationalityClass, string> = { SAUDI: 'سعودي', GCC: 'خليجي', EXPAT: 'وافد' };

export const TENURE_BANDS = [
  { key: 'LT1', label: 'أقل من سنة', max: 1 },
  { key: 'Y1_3', label: 'من سنة إلى أقل من 3', max: 3 },
  { key: 'Y3_5', label: 'من 3 إلى أقل من 5 سنوات', max: 5 },
  { key: 'Y5_10', label: 'من 5 إلى أقل من 10 سنوات', max: 10 },
  { key: 'Y10P', label: '10 سنوات فأكثر', max: Infinity },
] as const;

export function tenureBand(years: number): (typeof TENURE_BANDS)[number] {
  return TENURE_BANDS.find((b) => years < b.max) ?? TENURE_BANDS[TENURE_BANDS.length - 1];
}

const NO_DEPARTMENT = '__none__';
const deptKey = (e: BmEmployee) => e.departmentId || NO_DEPARTMENT;
function deptLabels(employees: ReadonlyArray<BmEmployee>): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of employees) m.set(deptKey(e), e.departmentName || (e.departmentId ? 'إدارة' : 'بدون إدارة'));
  return m;
}

/** Data-quality notes about the employee records themselves. */
function employeeQuality(employees: ReadonlyArray<BmEmployee>): string[] {
  const out: string[] = [];
  const noDate = employees.filter((e) => e.isTerminated && !e.terminationDate).length;
  if (noDate) out.push(`${noDate} موظف منتهي الخدمة بلا تاريخ إنهاء: مستبعد من العدد والخروج`);
  const bad = employees.filter((e) => e.isTerminated && e.terminationDate && dayUtc(e.terminationDate).getTime() < dayUtc(e.joinDate).getTime()).length;
  if (bad) out.push(`${bad} موظف تاريخ إنهائه قبل تاريخ مباشرته: مستبعد`);
  return out;
}

function validEmployees(employees: ReadonlyArray<BmEmployee>): BmEmployee[] {
  return employees.filter((e) => !(e.isTerminated && e.terminationDate && dayUtc(e.terminationDate).getTime() < dayUtc(e.joinDate).getTime()));
}

// ---------------------------------------------------------------------------
// Turnover
// ---------------------------------------------------------------------------

const TURNOVER_SPEC: MetricSpec = {
  key: 'TURNOVER',
  label: 'معدل الدوران الفعلي',
  unit: 'PERCENT',
  numeratorLabel: 'حالات الخروج في الفترة',
  denominatorLabel: 'متوسط عدد الموظفين (نهاية كل شهر)',
  formula: 'حالات الخروج (تاريخ الإنهاء داخل الفترة) ÷ متوسط عدد الموظفين في نهاية كل شهر من الفترة × 100',
};

/**
 * Trailing turnover of `employees` over the `months` calendar months ending with the month of `asOf`
 * (default 12). `overall.value` is a PERCENT (12.5 = 12.5%); `overall.numerator` = exits,
 * `overall.denominator` = average headcount. Exits are split by Employee.exitVoluntary (true /
 * false / not recorded) and broken down by nationality class, department and tenure band at exit, each
 * group suppressed below `minGroupSize` (default 5, pass 0 for no suppression). No scope suppression here:
 * the caller decides (computeBenchmarks hides everything for a scope below 5).
 */
export function trailingTurnoverRate(employees: ReadonlyArray<BmEmployee>, asOf: Date, months = 12, opts: { minGroupSize?: number } = {}): TurnoverResult {
  const min = opts.minGroupSize ?? MIN_GROUP_SIZE;
  const p = benchmarkPeriod(asOf, months);
  const valid = validEmployees(employees);
  const snaps = p.monthKeys.map((k) => snapshotOf(k, p.toDate));
  const hcs = snaps.map((d) => headcountOn(valid, d));
  const avg = hcs.length ? sum(hcs) / hcs.length : 0;
  const exited = valid.filter((e) => {
    const x = exitOf(e);
    return x instanceof Date && inRange(x, p.fromDate, p.toDate);
  });
  const exits = exited.length;
  const quality = employeeQuality(employees);
  const vol = exited.filter((e) => e.exitVoluntary === true).length;
  const invol = exited.filter((e) => e.exitVoluntary === false).length;
  const unknown = exits - vol - invol;
  if (unknown > 0) quality.push(`${unknown} حالة خروج دون تحديد «طوعي أم لا» في ملف الموظف`);
  const rate = (n: number) => (avg > 0 ? r2((n / avg) * 100) : null);
  const annualized = avg > 0 ? r2(((exits / avg) * 100 * 12) / p.months) : null;
  const overall = metric(TURNOVER_SPEC, p, exits, r2(avg), rate(exits), quality, avg > 0 ? null : INSUFFICIENT_DATA, { annualized });
  const sub = (key: string, label: string, n: number) =>
    metric({ ...TURNOVER_SPEC, key, label, numeratorLabel: `حالات الخروج (${label})` }, p, n, r2(avg), rate(n), [], avg > 0 ? null : INSUFFICIENT_DATA);

  const series: SeriesPoint[] = p.monthKeys.map((k, i) => {
    const n = exited.filter((e) => monthKey(exitOf(e) as Date) === k).length;
    const hc = hcs[i];
    const suppressed = hc < min;
    return { month: k, value: suppressed || hc === 0 ? null : r2((n / hc) * 100), numerator: suppressed ? null : n, denominator: suppressed ? null : hc, suppressed };
  });

  const breakdown = (keyFn: (e: BmEmployee, d: Date) => string, labels: Map<string, string>, order?: ReadonlyArray<string>): BreakdownRow[] => {
    const avgBy = averageHeadcountBy(valid, snaps, keyFn);
    const exitsBy = new Map<string, number>();
    for (const e of exited) {
      const k = keyFn(e, exitOf(e) as Date);
      exitsBy.set(k, (exitsBy.get(k) ?? 0) + 1);
    }
    const keys = [...new Set([...avgBy.keys(), ...exitsBy.keys()])];
    keys.sort((a, b) => (order ? order.indexOf(a) - order.indexOf(b) : (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b)));
    return suppressGroups(
      keys.map((k) => {
        const a = avgBy.get(k) ?? 0;
        const n = exitsBy.get(k) ?? 0;
        return { key: k, label: labels.get(k) ?? k, size: a, value: a > 0 ? r2((n / a) * 100) : null, numerator: n, denominator: r2(a) };
      }),
      min,
    );
  };

  const natKey = (e: BmEmployee) => nationalityClass(e.nationality);
  const tenureKey = (e: BmEmployee, d: Date) => tenureBand(yearsBetween(e.joinDate, d)).key;
  return {
    overall,
    voluntary: sub('TURNOVER_VOLUNTARY', 'خروج طوعي', vol),
    involuntary: sub('TURNOVER_INVOLUNTARY', 'خروج غير طوعي', invol),
    unknownType: sub('TURNOVER_UNKNOWN', 'خروج غير مصنّف', unknown),
    exits,
    averageHeadcount: r2(avg),
    series,
    byNationality: breakdown(natKey, new Map(Object.entries(NATIONALITY_CLASS_LABELS)), ['SAUDI', 'GCC', 'EXPAT']),
    byDepartment: breakdown(deptKey, deptLabels(valid)),
    byTenure: breakdown(tenureKey, new Map(TENURE_BANDS.map((b) => [b.key, b.label])), TENURE_BANDS.map((b) => b.key)),
  };
}

// ---------------------------------------------------------------------------
// Tenure and new-hire attrition
// ---------------------------------------------------------------------------

/** Average years of service of the employees employed on asOf, and of the leavers of the period at exit. */
export function averageTenure(employees: ReadonlyArray<BmEmployee>, asOf: Date, months: number): { active: BenchmarkMetric; leavers: BenchmarkMetric } {
  const p = benchmarkPeriod(asOf, months);
  const valid = validEmployees(employees);
  const active = valid.filter((e) => employedOn(e, p.toDate));
  const activeYears = sum(active.map((e) => yearsBetween(e.joinDate, p.toDate)));
  const leavers = valid.filter((e) => {
    const x = exitOf(e);
    return x instanceof Date && inRange(x, p.fromDate, p.toDate);
  });
  const leaverYears = sum(leavers.map((e) => yearsBetween(e.joinDate, exitOf(e) as Date)));
  const spec: MetricSpec = {
    key: 'TENURE_ACTIVE',
    label: 'متوسط مدة الخدمة (الموظفون الحاليون)',
    unit: 'YEARS',
    numeratorLabel: 'مجموع سنوات الخدمة حتى نهاية الفترة',
    denominatorLabel: 'عدد الموظفين في نهاية الفترة',
    formula: 'مجموع (نهاية الفترة − تاريخ المباشرة) بالسنوات ÷ عدد الموظفين في نهاية الفترة',
  };
  return {
    active: metric(spec, p, r2(activeYears), active.length, active.length ? r2(activeYears / active.length) : null, employeeQuality(employees)),
    leavers: metric(
      { ...spec, key: 'TENURE_LEAVERS', label: 'متوسط مدة الخدمة عند الخروج', numeratorLabel: 'مجموع سنوات الخدمة عند الخروج', denominatorLabel: 'حالات الخروج في الفترة', formula: 'مجموع (تاريخ الإنهاء − تاريخ المباشرة) بالسنوات ÷ حالات الخروج في الفترة' },
      p,
      r2(leaverYears),
      leavers.length,
      leavers.length ? r2(leaverYears / leavers.length) : null,
      [],
    ),
  };
}

/**
 * Share of new hires who left within their first `withinMonths` months. Cohort = employees whose first
 * `withinMonths` months ENDED inside the period (joinDate + withinMonths in [from, asOf]), so every
 * member was observed for the whole window. Left = exit before joinDate + withinMonths.
 */
export function newHireAttrition(employees: ReadonlyArray<BmEmployee>, asOf: Date, months: number, withinMonths: 3 | 6): BenchmarkMetric {
  const p = benchmarkPeriod(asOf, months);
  const valid = validEmployees(employees).filter((e) => exitOf(e) !== undefined);
  const cohort = valid.filter((e) => inRange(addMonthsClamped(dayUtc(e.joinDate), withinMonths), p.fromDate, p.toDate));
  const left = cohort.filter((e) => {
    const x = exitOf(e);
    return x instanceof Date && x.getTime() < addMonthsClamped(dayUtc(e.joinDate), withinMonths).getTime();
  });
  const spec: MetricSpec = {
    key: withinMonths === 3 ? 'NEW_HIRE_ATTRITION_3M' : 'NEW_HIRE_ATTRITION_6M',
    label: `خروج المعيَّنين الجدد خلال أول ${withinMonths === 3 ? '3 أشهر' : '6 أشهر'}`,
    unit: 'PERCENT',
    numeratorLabel: `من خرج قبل إكمال ${withinMonths} أشهر`,
    denominatorLabel: `المعيَّنون الذين اكتملت أشهرهم ${withinMonths === 3 ? 'الثلاثة' : 'الستة'} الأولى خلال الفترة`,
    formula: `من خرج قبل (تاريخ المباشرة + ${withinMonths} أشهر) ÷ المعيَّنين الذين يقع (تاريخ المباشرة + ${withinMonths} أشهر) داخل الفترة × 100`,
  };
  return metric(spec, p, left.length, cohort.length, cohort.length ? r2((left.length / cohort.length) * 100) : null, cohort.length ? [] : ['لا يوجد معيَّنون اكتملت فترتهم الأولى داخل الفترة']);
}

// ---------------------------------------------------------------------------
// Time to hire (approximation)
// ---------------------------------------------------------------------------

export function timeToHire(jobRequests: ReadonlyArray<BmJobRequest>, asOf: Date, months: number): BenchmarkMetric {
  const p = benchmarkPeriod(asOf, months);
  const days: number[] = [];
  let usedHired = 0;
  for (const j of jobRequests) {
    const end = j.hiredAt ?? j.fulfilledAt;
    if (!inRange(end, p.fromDate, p.toDate)) continue;
    if (j.hiredAt) usedHired++;
    days.push(Math.max(0, Math.round((dayUtc(end).getTime() - dayUtc(j.createdAt).getTime()) / DAY_MS)));
  }
  const spec: MetricSpec = {
    key: 'TIME_TO_HIRE',
    label: 'مدة التوظيف (تقريبي)',
    unit: 'DAYS',
    numeratorLabel: 'مجموع الأيام من إنشاء طلب الوظيفة حتى تعيين المرشح',
    denominatorLabel: 'طلبات الوظائف المكتملة (تم التوظيف) في الفترة',
    formula: 'متوسط (تاريخ تعيين المرشح أو آخر تحديث لطلب الوظيفة المكتمل − تاريخ إنشاء الطلب) بالأيام',
    approximate: true,
  };
  const q = [
    'تقريبي: لا يوجد في رديف تاريخ مخصص لاكتمال التوظيف؛ يُستخدم آخر تحديث لطلب المرشح «تم التوظيف»، وإلا آخر تحديث لطلب الوظيفة المكتمل (أي تعديل لاحق يغيّره)',
  ];
  if (days.length) q.push(`${usedHired} من ${days.length} طلباً بتاريخ المرشح المعيَّن`);
  if (days.length > 0 && days.length < MIN_GROUP_SIZE) q.push(`عيّنة صغيرة (${days.length} طلبات)`);
  const total = sum(days);
  const med = median(days);
  return metric(spec, p, total, days.length, days.length ? r1(total / days.length) : null, q, null, { median: med === null ? null : r1(med) });
}

// ---------------------------------------------------------------------------
// The whole benchmark set
// ---------------------------------------------------------------------------

function payrollCost(r: BmPayrollRow): number {
  return (r.basicSalary ?? 0) + (r.totalAllowances ?? 0) + (r.overtimeCost ?? 0) + (r.gosiEmployer ?? 0);
}

/** Leave days of a leave inside [from, to]: totalDays prorated by the calendar days of the overlap. */
export function leaveDaysInPeriod(l: BmLeave, from: Date, to: Date): number {
  const s = dayUtc(l.startDate).getTime();
  const e = dayUtc(l.endDate).getTime();
  if (e < s) return 0;
  const os = Math.max(s, from.getTime());
  const oe = Math.min(e, to.getTime());
  if (oe < os) return 0;
  const span = Math.round((e - s) / DAY_MS) + 1;
  const overlap = Math.round((oe - os) / DAY_MS) + 1;
  return (l.totalDays ?? span) * (overlap / span);
}

/** Wage used for the engine's art. 84 accrual of a settlement (settlement basis; current salary data). */
function settlementWage(e: BmEmployee, basis: string | null | undefined): number {
  const basic = e.basicSalary ?? 0;
  return roundMoney(basis === 'basic' ? basic : basic + (e.monthlyAllowances ?? 0));
}

export function computeBenchmarks(input: BenchmarksInput, options: BenchmarksOptions): BenchmarksResult {
  const min = options.minGroupSize ?? MIN_GROUP_SIZE;
  const p = benchmarkPeriod(options.asOf, options.months);
  const employees = validEmployees(input.employees);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const inScope = (id: string) => byId.has(id);
  const snaps = p.monthKeys.map((k) => snapshotOf(k, p.toDate));
  const hcs = snaps.map((d) => headcountOn(employees, d));
  const avgHc = hcs.length ? sum(hcs) / hcs.length : 0;
  const labels = deptLabels(employees);
  const periodKeys = new Set(p.monthKeys);

  const turnover = trailingTurnoverRate(input.employees, options.asOf, p.months, { minGroupSize: min });
  const tenure = averageTenure(input.employees, options.asOf, p.months);
  const m3 = newHireAttrition(input.employees, options.asOf, p.months, 3);
  const m6 = newHireAttrition(input.employees, options.asOf, p.months, 6);
  const tth = timeToHire(input.jobRequests, options.asOf, p.months);

  // --- Payroll rows of the period (APPROVED / PAID, employees in scope) ---
  const payrolls = input.payrolls.filter((r) => inScope(r.employeeId) && periodKeys.has(keyOf(r.year, r.month)));
  const payrollMonths = new Set(payrolls.map((r) => keyOf(r.year, r.month)));
  const missingPayrollMonths = p.monthKeys.filter((k) => !payrollMonths.has(k));

  // --- Overtime ---
  const ot = input.overtimeRequests.filter((o) => inScope(o.employeeId) && inRange(o.date, p.fromDate, p.toDate));
  const otHours = sum(ot.map((o) => o.hours ?? 0));
  const otCost = sum(payrolls.map((r) => r.overtimeCost ?? 0));
  const otQuality: string[] = [];
  const lump = ot.filter((o) => (o.type ?? 'HOURS') === 'LUMP_SUM').length;
  if (lump) otQuality.push(`${lump} طلب إضافي بمبلغ مقطوع دون ساعات: لا يدخل في الساعات`);
  if (missingPayrollMonths.length) otQuality.push(`أشهر بلا مسير معتمد أو مصروف: ${missingPayrollMonths.join('، ')}`);
  const empMonths = avgHc * p.months;
  const otHoursMetric = metric(
    { key: 'OVERTIME_HOURS', label: 'ساعات العمل الإضافي المعتمدة', unit: 'HOURS', numeratorLabel: 'مجموع ساعات طلبات الإضافي المعتمدة', denominatorLabel: '—', formula: 'مجموع ساعات طلبات العمل الإضافي المعتمدة بتاريخ العمل داخل الفترة' },
    p,
    r2(otHours),
    null,
    ot.length ? r2(otHours) : null,
    otQuality,
  );
  const otCostMetric = metric(
    { key: 'OVERTIME_COST', label: 'كلفة العمل الإضافي المصروفة شهرياً', unit: 'SAR', numeratorLabel: 'مجموع «الإضافي» في المسيرات المعتمدة والمصروفة', denominatorLabel: 'أشهر الفترة', formula: 'مجموع عمود العمل الإضافي في المسيرات المعتمدة والمصروفة ÷ عدد أشهر الفترة' },
    p,
    roundMoney(otCost),
    p.months,
    payrolls.length ? roundMoney(otCost / p.months) : null,
    otQuality,
  );
  const otPerEmp = metric(
    { key: 'OVERTIME_HOURS_PER_EMPLOYEE', label: 'ساعات الإضافي لكل موظف شهرياً', unit: 'HOURS', numeratorLabel: 'ساعات الإضافي المعتمدة', denominatorLabel: 'متوسط عدد الموظفين × أشهر الفترة', formula: 'ساعات الإضافي المعتمدة ÷ (متوسط عدد الموظفين × عدد الأشهر)' },
    p,
    r2(otHours),
    r2(empMonths),
    empMonths > 0 && ot.length ? r2(otHours / empMonths) : null,
    otQuality,
  );
  const otSeries = p.monthKeys.map((k, i) => {
    const suppressed = hcs[i] < min;
    const h = sum(ot.filter((o) => monthKey(dayUtc(o.date)) === k).map((o) => o.hours ?? 0));
    const c = sum(payrolls.filter((r) => keyOf(r.year, r.month) === k).map((r) => r.overtimeCost ?? 0));
    return { month: k, hours: suppressed ? null : r2(h), cost: suppressed || !payrollMonths.has(k) ? null : roundMoney(c), suppressed };
  });
  const deptSize = averageHeadcountBy(employees, snaps, (e) => deptKey(e));
  const deptKeys = [...deptSize.keys()].sort((a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b));
  const otByDept = suppressGroups(
    deptKeys.map((k) => {
      const h = sum(ot.filter((o) => deptKey(byId.get(o.employeeId)!) === k).map((o) => o.hours ?? 0));
      const c = sum(payrolls.filter((r) => deptKey(byId.get(r.employeeId)!) === k).map((r) => r.overtimeCost ?? 0));
      const size = deptSize.get(k) ?? 0;
      return {
        key: k,
        label: labels.get(k) ?? k,
        size,
        value: roundMoney(c / p.months),
        numerator: roundMoney(c),
        denominator: p.months,
        extra: { hours: r2(h), hoursPerMonth: r2(h / p.months), costPerMonth: roundMoney(c / p.months), hoursPerEmployeePerMonth: size > 0 ? r2(h / (size * p.months)) : null },
      };
    }),
    min,
  );

  // --- Absence and sick leave ---
  const att = input.attendance.filter((a) => inScope(a.employeeId) && periodKeys.has(a.month));
  const present = sum(att.map((a) => a.present));
  const absent = sum(att.map((a) => a.absent));
  const absQuality = ['المقام أيام الحضور المسجّلة (حاضر أو غائب) فقط: اليوم بلا سجل حضور لا يُحتسب، والإجازات خارج هذا المؤشر'];
  const absenceRate = metric(
    { key: 'ABSENCE_RATE', label: 'معدل الغياب', unit: 'PERCENT', numeratorLabel: 'أيام الغياب المسجّلة', denominatorLabel: 'أيام الحضور المسجّلة (حاضر + غائب)', formula: 'أيام «غائب» ÷ (أيام «حاضر» + أيام «غائب») في سجل الحضور × 100' },
    p,
    absent,
    present + absent,
    present + absent > 0 ? r2((absent / (present + absent)) * 100) : null,
    absQuality,
  );
  const absSeries: SeriesPoint[] = p.monthKeys.map((k) => {
    const rows = att.filter((a) => a.month === k);
    const people = new Set(rows.map((a) => a.employeeId)).size;
    const pr = sum(rows.map((a) => a.present));
    const ab = sum(rows.map((a) => a.absent));
    const suppressed = people > 0 && people < min;
    return { month: k, value: suppressed || pr + ab === 0 ? null : r2((ab / (pr + ab)) * 100), numerator: suppressed ? null : ab, denominator: suppressed ? null : pr + ab, suppressed };
  });
  const attDeptKeys = [...new Set(att.map((a) => deptKey(byId.get(a.employeeId)!)))].sort((a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b));
  const absByDept = suppressGroups(
    attDeptKeys.map((k) => {
      const rows = att.filter((a) => deptKey(byId.get(a.employeeId)!) === k);
      const pr = sum(rows.map((a) => a.present));
      const ab = sum(rows.map((a) => a.absent));
      return { key: k, label: labels.get(k) ?? k, size: new Set(rows.map((a) => a.employeeId)).size, value: pr + ab > 0 ? r2((ab / (pr + ab)) * 100) : null, numerator: ab, denominator: pr + ab };
    }),
    min,
  );
  const sick = input.leaves.filter((l) => inScope(l.employeeId) && l.leaveType === 'SICK');
  const sickDaysList = sick.map((l) => ({ l, d: leaveDaysInPeriod(l, p.fromDate, p.toDate) })).filter((x) => x.d > 0);
  const sickDays = sum(sickDaysList.map((x) => x.d));
  const sickQuality = ['الإجازات المرضية المعتمدة أو المكتملة؛ الإجازة الممتدة خارج الفترة تُحتسب بنسبة أيامها داخلها', 'عدد الموظفين بديل تقريبي للموظف بدوام كامل (الدوام الجزئي غير موزون)'];
  const sickPerEmp = metric(
    { key: 'SICK_DAYS_PER_EMPLOYEE', label: 'أيام الإجازة المرضية لكل موظف', unit: 'DAYS', numeratorLabel: 'أيام الإجازة المرضية في الفترة', denominatorLabel: 'متوسط عدد الموظفين', formula: 'أيام الإجازة المرضية داخل الفترة ÷ متوسط عدد الموظفين' },
    p,
    r2(sickDays),
    r2(avgHc),
    avgHc > 0 ? r2(sickDays / avgHc) : null,
    sickQuality,
    null,
    { perYear: avgHc > 0 ? r2(((sickDays / avgHc) * 12) / p.months) : null },
  );
  const sickByDept = suppressGroups(
    deptKeys.map((k) => {
      const d = sum(sickDaysList.filter((x) => deptKey(byId.get(x.l.employeeId)!) === k).map((x) => x.d));
      const size = deptSize.get(k) ?? 0;
      return { key: k, label: labels.get(k) ?? k, size, value: size > 0 ? r2(d / size) : null, numerator: r2(d), denominator: r2(size) };
    }),
    min,
  );

  // --- End of service actually paid ---
  const eosSettlements = input.settlements.filter((s) => inScope(s.employeeId) && s.type === 'END_OF_SERVICE' && s.status === 'PAID' && inRange(s.lastWorkingDate ?? s.createdAt, p.fromDate, p.toDate));
  const approvedUnpaid = input.settlements.filter((s) => inScope(s.employeeId) && s.type === 'END_OF_SERVICE' && s.status === 'OWNER_APPROVED' && inRange(s.lastWorkingDate ?? s.createdAt, p.fromDate, p.toDate)).length;
  const eosPaid = sum(eosSettlements.map((s) => s.endOfServiceAmount ?? 0));
  const leavePaid = sum(eosSettlements.map((s) => s.leaveCompensation ?? 0));
  const eosQuality = ['تصفيات نهاية الخدمة بحالة «مدفوعة» بتاريخ آخر يوم عمل داخل الفترة (وإلا تاريخ إنشاء التصفية)'];
  if (approvedUnpaid) eosQuality.push(`${approvedUnpaid} تصفية معتمدة لم تُدفع بعد: غير محتسبة`);
  const paidPerExit = metric(
    { key: 'EOSB_PAID_PER_EXIT', label: 'مكافأة نهاية الخدمة المدفوعة فعلاً لكل خروج', unit: 'SAR', numeratorLabel: 'مجموع مكافآت نهاية الخدمة المدفوعة', denominatorLabel: 'تصفيات نهاية الخدمة المدفوعة', formula: 'مجموع «مبلغ نهاية الخدمة» في التصفيات المدفوعة ÷ عددها' },
    p,
    roundMoney(eosPaid),
    eosSettlements.length,
    eosSettlements.length ? roundMoney(eosPaid / eosSettlements.length) : null,
    eosQuality,
  );
  let accrued = 0;
  let paidMatched = 0;
  let unmatched = 0;
  for (const s of eosSettlements) {
    const e = byId.get(s.employeeId);
    if (!e || !s.lastWorkingDate) {
      unmatched++;
      continue;
    }
    accrued += eosbLiability(settlementWage(e, s.salaryBasis), e.joinDate, dayUtc(s.lastWorkingDate), 'EMPLOYER');
    paidMatched += s.endOfServiceAmount ?? 0;
  }
  const vsQuality = [
    'الاستحقاق حسب المحرك: المادة 84 (إنهاء صاحب العمل) بأجر التصفية (الأساسي أو الإجمالي) من بيانات الراتب الحالية في ملف الموظف حتى آخر يوم عمل',
    'الفرق يعكس أسباب الخروج (الاستقالة تُنقص المكافأة حسب المادة 85) وتغيّر الأجر',
  ];
  if (unmatched) vsQuality.push(`${unmatched} تصفية بلا آخر يوم عمل: مستبعدة من المقارنة`);
  const paidVsAccrued = metric(
    { key: 'EOSB_PAID_VS_ACCRUED', label: 'المدفوع فعلاً مقابل استحقاق المحرك', unit: 'PERCENT', numeratorLabel: 'نهاية الخدمة المدفوعة', denominatorLabel: 'استحقاق المادة 84 حسب المحرك لنفس الحالات', formula: 'مجموع المدفوع ÷ مجموع الاستحقاق المقدّر (المادة 84) لنفس التصفيات × 100' },
    p,
    roundMoney(paidMatched),
    roundMoney(accrued),
    accrued > 0 ? r2((paidMatched / accrued) * 100) : null,
    vsQuality,
  );

  // --- Government fees per expat ---
  const fees = input.govFees.filter((f) => inScope(f.employeeId) && GOV_FEE_DOCUMENT_PATTERN.test(f.documentType) && inRange(f.paidAt, p.fromDate, p.toDate));
  const feeTotal = sum(fees.map((f) => f.amount));
  const expatAvg = averageHeadcountBy(employees, snaps, (e) => (nationalityClass(e.nationality) === 'EXPAT' ? 'EXPAT' : null)).get('EXPAT') ?? 0;
  const feeQuality = [
    'مبالغ أوامر الدفع مقطوعة: قد يجمع أمر واحد رسوم الإقامة ورخصة العمل والمقابل المالي، فلا تُفصَّل حسب النوع',
    'تاريخ الدفع تقريبي: آخر تحديث لأمر الدفع (لا يوجد تاريخ سداد مخصص)',
    'أوامر الدفع المرتبطة بموظف فقط (تجديد الإقامة ونحوه)؛ تأشيرات الاستقدام غير مرتبطة بموظف قائم',
  ];
  const feeSuppressed = expatAvg > 0 && expatAvg < min;
  const perExpat = feeSuppressed
    ? metric(
        { key: 'GOV_FEES_PER_EXPAT', label: 'الرسوم الحكومية المدفوعة لكل وافد سنوياً', unit: 'SAR', numeratorLabel: '', denominatorLabel: '', formula: '', approximate: true },
        p,
        null,
        null,
        null,
        feeQuality,
        `عدد الوافدين ${SUPPRESSED_TEXT}`,
      )
    : metric(
        {
          key: 'GOV_FEES_PER_EXPAT',
          label: 'الرسوم الحكومية المدفوعة لكل وافد سنوياً',
          unit: 'SAR',
          numeratorLabel: 'أوامر الدفع المدفوعة (إقامة، رخصة عمل، تأشيرة)',
          denominatorLabel: 'متوسط عدد الوافدين',
          formula: 'مجموع أوامر الدفع المدفوعة ÷ متوسط عدد الوافدين × (12 ÷ أشهر الفترة)',
          approximate: true,
        },
        p,
        roundMoney(feeTotal),
        r2(expatAvg),
        expatAvg > 0 && fees.length ? roundMoney(((feeTotal / expatAvg) * 12) / p.months) : null,
        feeQuality,
      );

  // --- Cost per employee per month (payroll) ---
  const costTotal = sum(payrolls.map(payrollCost));
  const costQuality = ['من المسيرات المعتمدة والمصروفة: الأساسي + البدلات (ومنها المكافآت) + الإضافي + حصة صاحب العمل في التأمينات', 'لا يشمل الرسوم الحكومية ولا التأمين الطبي ولا نهاية الخدمة (انظر «الكلفة الحقيقية»)'];
  if (missingPayrollMonths.length) costQuality.push(`أشهر بلا مسير معتمد أو مصروف: ${missingPayrollMonths.join('، ')}`);
  const costPer = metric(
    { key: 'COST_PER_EMPLOYEE_MONTH', label: 'كلفة الموظف شهرياً (من المسيرات)', unit: 'SAR', numeratorLabel: 'مجموع كلفة المسيرات', denominatorLabel: 'أسطر المسير (موظف × شهر)', formula: '(الأساسي + البدلات + الإضافي + حصة صاحب العمل في التأمينات) ÷ عدد أسطر المسير' },
    p,
    roundMoney(costTotal),
    payrolls.length,
    payrolls.length ? roundMoney(costTotal / payrolls.length) : null,
    costQuality,
  );
  const costSeries: SeriesPoint[] = p.monthKeys.map((k) => {
    const rows = payrolls.filter((r) => keyOf(r.year, r.month) === k);
    const suppressed = rows.length > 0 && rows.length < min;
    const c = sum(rows.map(payrollCost));
    return { month: k, value: suppressed || !rows.length ? null : roundMoney(c / rows.length), numerator: suppressed ? null : roundMoney(c), denominator: suppressed ? null : rows.length, suppressed };
  });
  const payDeptKeys = [...new Set(payrolls.map((r) => deptKey(byId.get(r.employeeId)!)))].sort((a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b));
  const costByDept = suppressGroups(
    payDeptKeys.map((k) => {
      const rows = payrolls.filter((r) => deptKey(byId.get(r.employeeId)!) === k);
      const c = sum(rows.map(payrollCost));
      return { key: k, label: labels.get(k) ?? k, size: new Set(rows.map((r) => r.employeeId)).size, value: rows.length ? roundMoney(c / rows.length) : null, numerator: roundMoney(c), denominator: rows.length };
    }),
    min,
  );

  // --- Cost of turnover ---
  const exited = employees.filter((e) => {
    const x = exitOf(e);
    return x instanceof Date && inRange(x, p.fromDate, p.toDate);
  });
  const rc = input.recruitmentCost ?? { saudi: null, expat: null };
  let recruitment = 0;
  let recruitmentMissing = 0;
  for (const e of exited) {
    const v = nationalityClass(e.nationality) === 'SAUDI' ? rc.saudi : rc.expat;
    if (typeof v === 'number') recruitment += v;
    else recruitmentMissing++;
  }
  const paidIds = new Set(eosSettlements.map((s) => s.employeeId));
  const noSettlement = exited.filter((e) => !paidIds.has(e.id)).length;
  const tcQuality = ['نهاية الخدمة وبدل الإجازة من التصفيات المدفوعة فعلاً في الفترة'];
  if (recruitmentMissing === exited.length && exited.length) tcQuality.push('كلفة التوظيف غير مدخلة في الافتراضات: لم تُحتسب');
  else if (recruitmentMissing) tcQuality.push(`كلفة التوظيف غير مدخلة لـ ${recruitmentMissing} حالة (حسب الجنسية): لم تُحتسب لها`);
  else if (exited.length) tcQuality.push('كلفة التوظيف افتراض أدخلته المنشأة (الافتراضات)، لا رقم مرجعي');
  if (noSettlement) tcQuality.push(`${noSettlement} حالة خروج بلا تصفية مدفوعة في الفترة`);
  const tcTotal = eosPaid + leavePaid + recruitment;
  const tcSpec: MetricSpec = {
    key: 'TURNOVER_COST',
    label: 'كلفة الدوران (تقدير)',
    unit: 'SAR',
    numeratorLabel: 'نهاية الخدمة المدفوعة + بدل الإجازة المدفوع + كلفة التوظيف (إن أُدخلت)',
    denominatorLabel: '—',
    formula: 'نهاية الخدمة المدفوعة فعلاً + بدل الإجازة المدفوع في التصفيات + (عدد حالات الخروج × كلفة التوظيف من الافتراضات إن أُدخلت)',
  };
  const tcHas = exited.length > 0 || eosSettlements.length > 0;
  const turnoverCostTotal = metric(tcSpec, p, roundMoney(tcTotal), null, tcHas ? roundMoney(tcTotal) : null, tcQuality, null, {
    eosbPaid: roundMoney(eosPaid),
    leavePaid: roundMoney(leavePaid),
    recruitment: roundMoney(recruitment),
  });
  const turnoverCostPerExit = metric(
    { ...tcSpec, key: 'TURNOVER_COST_PER_EXIT', label: 'كلفة الدوران لكل حالة خروج', denominatorLabel: 'حالات الخروج في الفترة', formula: 'كلفة الدوران ÷ حالات الخروج في الفترة' },
    p,
    roundMoney(tcTotal),
    exited.length,
    exited.length ? roundMoney(tcTotal / exited.length) : null,
    tcQuality,
  );

  // --- Per-case / per-person metrics on fewer than `min` cases («أقل من 5 حالات», SPEC §9) ---
  const smallCount = (m: BenchmarkMetric, n: number) => (n > 0 && n < min ? hidden(m, SMALL_COUNT_REASON) : m);
  const attPeople = new Set(att.map((a) => a.employeeId)).size;
  const payPeople = new Set(payrolls.map((r) => r.employeeId)).size;
  const exitCases = Math.max(exited.length, eosSettlements.length);
  const hiddenMonths = new Set(options.disclosure?.hiddenMonths ?? []);
  const hideMonth = <T extends { month: string; suppressed: boolean }>(pt: T, blank: Partial<T>): T => (hiddenMonths.has(pt.month) ? { ...pt, ...blank, suppressed: true } : pt);
  const hideSeries = (s: SeriesPoint[]) => s.map((pt) => hideMonth(pt, { value: null, numerator: null, denominator: null }));

  const result: BenchmarksResult = {
    period: publicPeriod(p),
    asOf: p.to,
    source: BENCHMARK_SOURCE,
    minGroupSize: min,
    headcount: { start: hcs[0] ?? 0, end: hcs[hcs.length - 1] ?? 0, average: r2(avgHc) },
    scopeSuppressed: avgHc < min || !!options.disclosure?.hidden,
    turnover: { ...turnover, series: hideSeries(turnover.series) },
    tenure: { active: smallCount(tenure.active, tenure.active.denominator ?? 0), leavers: smallCount(tenure.leavers, tenure.leavers.denominator ?? 0) },
    newHireAttrition: { m3: smallCount(m3, m3.denominator ?? 0), m6: smallCount(m6, m6.denominator ?? 0) },
    timeToHire: smallCount(tth, tth.denominator ?? 0),
    overtime: { hours: otHoursMetric, cost: otCostMetric, hoursPerEmployeePerMonth: otPerEmp, series: otSeries.map((pt) => hideMonth(pt, { hours: null, cost: null })), byDepartment: otByDept },
    absence: { rate: smallCount(absenceRate, attPeople), sickDaysPerEmployee: sickPerEmp, series: hideSeries(absSeries), byDepartment: absByDept, sickByDepartment: sickByDept },
    endOfService: { paidPerExit: smallCount(paidPerExit, eosSettlements.length), paidVsAccrued: smallCount(paidVsAccrued, eosSettlements.length - unmatched) },
    govFees: { perExpatPerYear: perExpat },
    costPerEmployee: { perMonth: smallCount(costPer, payPeople), series: hideSeries(costSeries), byDepartment: costByDept },
    turnoverCost: { total: smallCount(turnoverCostTotal, exitCases), perExit: smallCount(turnoverCostPerExit, exitCases) },
  };
  if (!result.scopeSuppressed) return result;
  return suppressScope(result, avgHc < min ? SCOPE_SUPPRESSED_REASON : (options.disclosure?.reason ?? SCOPE_COMPLEMENT_REASON));
}

/** Every metric hidden, every breakdown and series emptied (scope below the minimum group size, or disclosure). */
function suppressScope(r: BenchmarksResult, reason: string = SCOPE_SUPPRESSED_REASON): BenchmarksResult {
  const h = (m: BenchmarkMetric) => hidden(m, reason);
  return {
    ...r,
    headcount: { start: 0, end: 0, average: 0 },
    turnover: { ...r.turnover, overall: h(r.turnover.overall), voluntary: h(r.turnover.voluntary), involuntary: h(r.turnover.involuntary), unknownType: h(r.turnover.unknownType), exits: 0, averageHeadcount: 0, series: [], byNationality: [], byDepartment: [], byTenure: [] },
    tenure: { active: h(r.tenure.active), leavers: h(r.tenure.leavers) },
    newHireAttrition: { m3: h(r.newHireAttrition.m3), m6: h(r.newHireAttrition.m6) },
    timeToHire: h(r.timeToHire),
    overtime: { hours: h(r.overtime.hours), cost: h(r.overtime.cost), hoursPerEmployeePerMonth: h(r.overtime.hoursPerEmployeePerMonth), series: [], byDepartment: [] },
    absence: { rate: h(r.absence.rate), sickDaysPerEmployee: h(r.absence.sickDaysPerEmployee), series: [], byDepartment: [], sickByDepartment: [] },
    endOfService: { paidPerExit: h(r.endOfService.paidPerExit), paidVsAccrued: h(r.endOfService.paidVsAccrued) },
    govFees: { perExpatPerYear: h(r.govFees.perExpatPerYear) },
    costPerEmployee: { perMonth: h(r.costPerEmployee.perMonth), series: [], byDepartment: [] },
    turnoverCost: { total: h(r.turnoverCost.total), perExit: h(r.turnoverCost.perExit) },
  };
}

// ---------------------------------------------------------------------------
// Sub-scope disclosure control (differencing between scopes, SPEC §9)
// ---------------------------------------------------------------------------

/** Organisation-unit fields of an employee: the whole organisation is read for the disclosure check. */
export type BmPopulationEmployee = Pick<BmEmployee, 'id' | 'joinDate' | 'isTerminated' | 'terminationDate' | 'departmentId' | 'branchId' | 'legalCompanyId'>;

export interface BenchmarkScopeFilter {
  /** Legal company (Employee.legalCompanyId). */
  companyId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
}

export interface ScopeDisclosure {
  /** The whole scope is hidden (reason given). */
  hidden: boolean;
  reason: string | null;
  /** Months hidden in every monthly series of the scope. */
  hiddenMonths: string[];
}

type ScopeDim = 'companyId' | 'branchId' | 'departmentId';
const SCOPE_DIMS: ReadonlyArray<ScopeDim> = ['companyId', 'branchId', 'departmentId'];
const NO_UNIT = '__none__';
type UnitAssignment = Partial<Record<ScopeDim, string>>;

function unitOf(e: BmPopulationEmployee, d: ScopeDim): string {
  const v = d === 'companyId' ? e.legalCompanyId : d === 'branchId' ? e.branchId : e.departmentId;
  return v || NO_UNIT;
}

/** Employed on at least one day of [from, to]. */
function employedDuring(e: BmPopulationEmployee, from: Date, to: Date): boolean {
  const x = exitOf(e as BmEmployee);
  if (x === undefined) return false;
  return dayUtc(e.joinDate).getTime() <= to.getTime() && (x === null || x.getTime() >= from.getTime());
}

/**
 * Whether a sub-scope (company / branch / department filter, any combination) may be shown, and which months
 * of its monthly series are hidden, so that no figure of a small group can be recovered by subtracting it
 * from a wider scope. `population` = every employee of the organisation (unit fields only).
 *
 * The scope S is compared with every WIDER scope W that contains it: W is built from the organisation units
 * S is homogeneous in (its filters, plus the company / branch / department all its people share), W ⊋ S, and
 * W is shown (average headcount ≥ min). S is hidden when:
 *   (a) its average month-end headcount is < min (SCOPE_SUPPRESSED_REASON);
 *   (b) W − S is protected: smaller than min (people present in the period but average < min), or itself a
 *       suppressed group of a partition published by a wider scope (SCOPE_COMPLEMENT_REASON);
 *   (c) S is a suppressed or complementary-suppressed group of the partition of such a W by a unit (its
 *       department / branch / company as listed in W's breakdown), with suppressGroups' rule
 *       (SCOPE_COMPLEMENT_REASON).
 * A month of the series is hidden when S's month-end headcount is < min, or, for a W shown that month,
 * W − S had someone employed during the month but fewer than min at its end.
 * Limit (documented): only scopes that CONTAIN S are compared; overlapping scopes of different kinds (a
 * department spread over several legal companies) are not cross-checked.
 */
export function scopeDisclosure(
  population: ReadonlyArray<BmPopulationEmployee>,
  filter: BenchmarkScopeFilter,
  asOf: Date,
  months: number,
  min: number = MIN_GROUP_SIZE,
): ScopeDisclosure {
  const F: UnitAssignment = {};
  for (const d of SCOPE_DIMS) {
    const v = filter[d];
    if (v) F[d] = v;
  }
  if (!Object.keys(F).length) return { hidden: false, reason: null, hiddenMonths: [] };
  const p = benchmarkPeriod(asOf, months);
  const snaps = p.monthKeys.map((k) => snapshotOf(k, p.toDate));
  const people = validEmployees(population as ReadonlyArray<BmEmployee>).filter((e) => employedDuring(e, p.fromDate, p.toDate));
  const matches = (e: BmPopulationEmployee, a: UnitAssignment) => SCOPE_DIMS.every((d) => a[d] === undefined || unitOf(e, d) === a[d]);
  const avgOf = (set: ReadonlyArray<BmEmployee>) => (snaps.length ? sum(snaps.map((d) => set.filter((e) => employedOn(e, d)).length)) / snaps.length : 0);
  const hide = (reason: string): ScopeDisclosure => ({ hidden: true, reason, hiddenMonths: [...p.monthKeys] });

  const sets = new Map<string, BmEmployee[]>();
  const setOf = (w: UnitAssignment): BmEmployee[] => {
    const k = JSON.stringify(w);
    let s = sets.get(k);
    if (!s) {
      s = people.filter((e) => matches(e, w));
      sets.set(k, s);
    }
    return s;
  };
  /** Units every member of `set` shares. */
  const closure = (set: ReadonlyArray<BmEmployee>): UnitAssignment => {
    const a: UnitAssignment = {};
    for (const d of SCOPE_DIMS) {
      const vals = new Set(set.map((e) => unitOf(e, d)));
      if (vals.size === 1) a[d] = [...vals][0];
    }
    return a;
  };
  const subsets = (a: UnitAssignment): UnitAssignment[] => {
    const keys = SCOPE_DIMS.filter((d) => a[d] !== undefined);
    const out: UnitAssignment[] = [];
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const w: UnitAssignment = {};
      keys.forEach((k, i) => {
        if (mask & (1 << i)) w[k] = a[k];
      });
      out.push(w);
    }
    return out;
  };
  const partitions = new Map<string, BreakdownRow[]>();
  const partition = (w: UnitAssignment, d: ScopeDim): BreakdownRow[] => {
    const k = `${JSON.stringify(w)}|${d}`;
    let rows = partitions.get(k);
    if (!rows) {
      const sizes = averageHeadcountBy(setOf(w), snaps, (e) => unitOf(e, d));
      rows = suppressGroups(
        [...sizes.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([key, size]) => ({ key, label: key, size, value: null, numerator: null, denominator: null })),
        min,
      );
      partitions.set(k, rows);
    }
    return rows;
  };
  /** A small group, or (almost exactly) a suppressed group of a partition published by a wider shown scope. */
  const isProtected = (group: ReadonlyArray<BmEmployee>): boolean => {
    if (!group.length) return false;
    if (avgOf(group) < min) return true;
    const h = closure(group);
    const ids = new Set(group.map((e) => e.id));
    for (const w of subsets(h)) {
      const ws = setOf(w);
      if (ws.length === group.length || avgOf(ws) < min) continue; // the same set, or W shows nothing
      for (const d of SCOPE_DIMS) {
        if (w[d] !== undefined || h[d] === undefined) continue;
        if (!partition(w, d).find((r) => r.key === h[d])?.suppressed) continue;
        const rest = ws.filter((e) => unitOf(e, d) === h[d] && !ids.has(e.id));
        if (!rest.length || avgOf(rest) < min) return true;
      }
    }
    return false;
  };

  const S = setOf(F);
  if (!S.length || avgOf(S) < min) return hide(SCOPE_SUPPRESSED_REASON); // (a)
  if (isProtected(S)) return hide(SCOPE_COMPLEMENT_REASON); // (c)
  const sIds = new Set(S.map((e) => e.id));
  const complements = subsets(closure(S))
    .map((w) => setOf(w))
    .filter((ws) => ws.length > S.length && avgOf(ws) >= min)
    .map((ws) => ({ ws, comp: ws.filter((e) => !sIds.has(e.id)) }));
  for (const { comp } of complements) if (isProtected(comp)) return hide(SCOPE_COMPLEMENT_REASON); // (b)

  const hiddenMonths: string[] = [];
  p.monthKeys.forEach((k, i) => {
    const d = snaps[i];
    const [yy, mm] = k.split('-').map(Number);
    const monthFrom = monthStartUtc(yy, mm);
    const atEnd = (set: ReadonlyArray<BmEmployee>) => set.filter((e) => employedOn(e, d)).length;
    if (atEnd(S) < min) {
      hiddenMonths.push(k);
      return;
    }
    for (const { ws, comp } of complements) {
      if (atEnd(ws) < min) continue;
      if (atEnd(comp) < min && comp.some((e) => employedDuring(e, monthFrom, d))) {
        hiddenMonths.push(k);
        return;
      }
    }
  });
  return { hidden: false, reason: null, hiddenMonths };
}

/** Short Arabic number text for a metric value (UI and «كيف حُسب؟»). */
export function formatMetricValue(value: number | null, unit: BmUnit): string {
  if (value === null) return '—';
  switch (unit) {
    case 'PERCENT':
      return `${r2(value)}%`;
    case 'SAR':
      return `${fmt(value)} ر.س`;
    case 'DAYS':
      return `${r1(value)} يوم`;
    case 'YEARS':
      return `${r2(value)} سنة`;
    case 'HOURS':
      return `${r2(value)} ساعة`;
    default:
      return String(r2(value));
  }
}

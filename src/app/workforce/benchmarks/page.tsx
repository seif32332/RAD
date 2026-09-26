"use client";

// «المؤشرات الداخلية» (SPEC §1 module 7, §9): turnover, tenure, new-hire attrition, time to hire, overtime,
// absence, sick leave, end of service actually paid, government fees per expat, cost per employee and the
// cost of turnover — computed ONLY from the organisation's own records (no industry figure). Aggregated:
// groups below 5 people show «أقل من 5». Each card has «كيف حُسب؟» (formula, numerator / denominator,
// period, data quality). Data: GET /api/workforce/benchmarks (this page only displays).
import React, { useMemo, useState } from 'react';
import { BarChart3, Info, ShieldCheck } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { formatMoney } from '@/lib/money';
import {
  BENCHMARK_PERIODS,
  formatMetricValue,
  type BenchmarkMetric,
  type BenchmarksResult,
  type BreakdownRow,
  type SeriesPoint,
} from '@/lib/workforce/benchmarks';
import { useApi } from '../_components/api';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Segmented, SelectField, WfPage } from '../_components/ui';

interface OptionsResponse {
  companies: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
}

type BenchmarksResponse = BenchmarksResult & {
  scope: { companyId: string | null; branchId: string | null; departmentId: string | null; companyName: string | null; branchName: string | null; departmentName: string | null };
  notes: string[];
};

const UNIT_HINT: Record<string, string> = { PERCENT: '%', SAR: 'ريال', DAYS: 'يوم', YEARS: 'سنة', HOURS: 'ساعة', COUNT: '' };

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
}

// ---------------------------------------------------------------------------
// «كيف حُسب؟»
// ---------------------------------------------------------------------------

function HowDialog({ metric, onClose }: { metric: BenchmarkMetric | null; onClose: () => void }) {
  return (
    <Modal open={!!metric} onClose={onClose} title={metric ? `كيف حُسب؟ ${metric.label}` : ''} tone="indigo" size="lg">
      {metric && (
        <div className="space-y-4 p-5 sm:p-6 text-[13px] font-bold text-slate-700">
          <p className="text-[22px] font-black text-slate-900" dir="auto">
            {metric.value === null ? '—' : formatMetricValue(metric.value, metric.unit)}
            {metric.approximate && <span className="mr-2 align-middle rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-black text-amber-800">تقريبي</span>}
          </p>
          {metric.reason && <p className="rounded-xl bg-slate-50 px-3 py-2 text-slate-600">{metric.reason}</p>}
          <div>
            <h3 className="text-[12px] font-black text-slate-500 mb-1">المعادلة</h3>
            <p className="leading-relaxed">{metric.formula || '—'}</p>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-200 p-3">
              <dt className="text-[11.5px] text-slate-500">البسط: {metric.numeratorLabel}</dt>
              <dd className="mt-1 text-[15px] font-black text-slate-900" dir="ltr">{fmtNum(metric.numerator)}</dd>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <dt className="text-[11.5px] text-slate-500">المقام: {metric.denominatorLabel}</dt>
              <dd className="mt-1 text-[15px] font-black text-slate-900" dir="ltr">{fmtNum(metric.denominator)}</dd>
            </div>
          </dl>
          {metric.extra && Object.keys(metric.extra).length > 0 && (
            <ul className="flex flex-wrap gap-2 text-[12px]">
              {Object.entries(metric.extra).map(([k, v]) => (
                <li key={k} className="rounded-lg bg-slate-50 px-2 py-1">
                  {EXTRA_LABELS[k] ?? k}: <span dir="ltr">{fmtNum(v)}</span>
                </li>
              ))}
            </ul>
          )}
          <p>
            الفترة: <span dir="ltr">{metric.period.from}</span> إلى <span dir="ltr">{metric.period.to}</span> ({metric.period.months} شهراً{metric.period.partialLastMonth ? '، والشهر الأخير حتى تاريخه' : ''})
          </p>
          {metric.dataQuality.length > 0 && (
            <div>
              <h3 className="text-[12px] font-black text-slate-500 mb-1">جودة البيانات</h3>
              <ul className="list-disc pr-5 space-y-1 text-[12.5px] leading-relaxed text-slate-600">
                {metric.dataQuality.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="flex items-center gap-2 text-[12px] text-slate-500">
            <ShieldCheck size={15} aria-hidden="true" /> المصدر: {metric.source}. لا رقم مرجعي خارجي ولا قيمة افتراضية.
          </p>
        </div>
      )}
    </Modal>
  );
}

const EXTRA_LABELS: Record<string, string> = {
  annualized: 'سنوياً (%)',
  median: 'الوسيط (يوم)',
  perYear: 'لكل موظف سنوياً',
  eosbPaid: 'نهاية الخدمة المدفوعة',
  leavePaid: 'بدل الإجازة المدفوع',
  recruitment: 'كلفة التوظيف (افتراض)',
  hours: 'الساعات',
  hoursPerMonth: 'ساعات شهرياً',
  costPerMonth: 'الكلفة شهرياً',
  hoursPerEmployeePerMonth: 'ساعات لكل موظف شهرياً',
};

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

function MetricCard({ metric, onHow, sub }: { metric: BenchmarkMetric; onHow: (m: BenchmarkMetric) => void; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-3xl border border-slate-100 bg-white p-4 sm:p-5 shadow-[0_10px_30px_rgba(0,0,0,0.02)] min-w-0">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[12.5px] font-black text-slate-500 leading-snug">{metric.label}</h3>
        {metric.approximate && <span className="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-black text-amber-800">تقريبي</span>}
      </div>
      {metric.value === null ? (
        <p className="mt-2 text-[13px] font-black text-slate-400 leading-snug">{metric.reason ?? 'لا توجد بيانات كافية'}</p>
      ) : (
        <p className="mt-2 text-[22px] sm:text-[24px] font-black text-slate-900 leading-tight" dir="auto">
          <span dir="ltr" className="tabular-nums">{metric.unit === 'SAR' ? formatMoney(metric.value) : fmtNum(metric.value)}</span>
          <span className="text-[12px] font-bold text-slate-400"> {UNIT_HINT[metric.unit]}</span>
        </p>
      )}
      {sub && <div className="mt-1 text-[11.5px] font-bold text-slate-500">{sub}</div>}
      <div className="mt-auto pt-3">
        <button type="button" onClick={() => onHow(metric)} className="rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-black text-indigo-700 hover:bg-indigo-100" aria-label={`كيف حُسب؟ ${metric.label}`}>
          كيف حُسب؟
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trend chart (SVG bars; suppressed months are gaps)
// ---------------------------------------------------------------------------

function TrendChart({ title, points, unit, color = 'fill-indigo-500' }: { title: string; points: ReadonlyArray<{ month: string; value: number | null; suppressed?: boolean }>; unit: string; color?: string }) {
  if (!points.length) return <EmptyBlock text="لا توجد بيانات" />;
  const bw = 10;
  const W = points.length * bw;
  const H = 100;
  const max = Math.max(0, ...points.map((p) => p.value ?? 0));
  const hasData = points.some((p) => p.value !== null);
  const step = Math.max(1, Math.ceil(points.length / 4));
  const ticks = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const shown = points.filter((p) => p.value !== null);
  const summary = hasData
    ? `${title}: من ${points[0].month} إلى ${points[points.length - 1].month}. أعلى قيمة ${fmtNum(max)} ${unit}.${points.some((p) => p.suppressed) ? ' أشهر محجوبة لأن العدد أقل من 5.' : ''}`
    : `${title}: لا توجد بيانات`;
  return (
    <figure className="w-full">
      <figcaption className="mb-2 text-[12.5px] font-black text-slate-700">{title}</figcaption>
      {hasData ? (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary} className="w-full h-28 sm:h-32 border-b border-slate-300">
            {points.map((p, i) => {
              const x = W - (i + 1) * bw;
              if (p.value === null) {
                return p.suppressed ? <rect key={p.month} x={x + bw * 0.1} y={H - 6} width={bw * 0.8} height={6} className="fill-slate-200"><title>{`${p.month}: أقل من 5`}</title></rect> : null;
              }
              const h = max > 0 ? (Math.max(0, p.value) / max) * H : 0;
              return (
                <rect key={p.month} x={x + bw * 0.15} y={H - h} width={bw * 0.7} height={h} className={color}>
                  <title>{`${p.month}: ${fmtNum(p.value)} ${unit}`}</title>
                </rect>
              );
            })}
          </svg>
          <div className="mt-1 flex justify-between text-[10.5px] font-bold text-slate-500" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t.month} dir="ltr">{t.month}</span>
            ))}
          </div>
          <p className="sr-only">{shown.map((p) => `${p.month}: ${fmtNum(p.value)} ${unit}`).join('، ')}</p>
        </>
      ) : (
        <p className="text-[12px] font-bold text-slate-400">لا توجد بيانات في الفترة</p>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Breakdown table with suppression
// ---------------------------------------------------------------------------

function BreakdownTable({
  caption,
  groupLabel,
  sizeLabel,
  valueLabel,
  rows,
  valueFmt,
  extraCols = [],
}: {
  caption: string;
  groupLabel: string;
  sizeLabel: string;
  valueLabel: string;
  rows: ReadonlyArray<BreakdownRow>;
  valueFmt: (v: number | null) => string;
  extraCols?: ReadonlyArray<{ key: string; label: string; fmt?: (v: number | null) => string; from?: 'numerator' | 'denominator' }>;
}) {
  if (!rows.length) return <EmptyBlock text="لا توجد بيانات في الفترة" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[440px] text-[12.5px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th scope="col" className="py-2 text-right font-black">{groupLabel}</th>
            <th scope="col" className="py-2 text-right font-black">{sizeLabel}</th>
            {extraCols.map((c) => (
              <th key={c.key} scope="col" className="py-2 text-right font-black">{c.label}</th>
            ))}
            <th scope="col" className="py-2 text-right font-black">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-slate-100 font-bold text-slate-700">
              <th scope="row" className="py-2 text-right font-black text-slate-800">{r.label}</th>
              {r.suppressed ? (
                <td colSpan={2 + extraCols.length} className="py-2 text-slate-400">{r.suppressedText}</td>
              ) : (
                <>
                  <td className="py-2 text-right" dir="ltr">{fmtNum(r.size, 1)}</td>
                  {extraCols.map((c) => {
                    const v = c.from ? r[c.from] : (r.extra?.[c.key] ?? null);
                    return (
                      <td key={c.key} className="py-2 text-right" dir="ltr">{c.fmt ? c.fmt(v) : fmtNum(v)}</td>
                    );
                  })}
                  <td className="py-2 text-right text-slate-900" dir="ltr">{valueFmt(r.value)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pctFmt = (v: number | null) => (v === null ? '—' : `${fmtNum(v)}%`);
const sarFmt = (v: number | null) => (v === null ? '—' : formatMoney(v));

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BenchmarksPage() {
  const [months, setMonths] = useState<number>(12);
  const [companyId, setCompanyId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [how, setHow] = useState<BenchmarkMetric | null>(null);
  const [turnoverTab, setTurnoverTab] = useState<'nat' | 'dept' | 'tenure'>('dept');
  const opts = useApi<OptionsResponse>('/api/workforce/options');
  const url = useMemo(() => {
    const p = new URLSearchParams({ months: String(months) });
    if (companyId) p.set('companyId', companyId);
    if (branchId) p.set('branchId', branchId);
    if (departmentId) p.set('departmentId', departmentId);
    return `/api/workforce/benchmarks?${p.toString()}`;
  }, [months, companyId, branchId, departmentId]);
  const { data, error, loading, reload } = useApi<BenchmarksResponse>(url);
  const d = data;

  return (
    <WfPage
      current="/workforce/benchmarks"
      icon={<BarChart3 size={24} />}
      title="المؤشرات الداخلية"
      subtitle="مؤشرات محسوبة من بيانات منشأتك في رديف فقط: الدوران، ومدة الخدمة، ومدة التوظيف، والإضافي، والغياب، ونهاية الخدمة المدفوعة، والرسوم الحكومية، وكلفة الموظف. لا أرقام مرجعية خارجية. تُعرض مجمّعة، وتُحجب أي مجموعة أقل من 5 أشخاص."
    >
      <div className="flex flex-col lg:flex-row lg:items-end gap-3 lg:gap-4">
        <Segmented label="الفترة" value={months} options={BENCHMARK_PERIODS.map((m) => ({ value: m as number, label: `${m} شهراً` }))} onChange={setMonths} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1">
          <SelectField label="الشركة (الكيان النظامي)" value={companyId} onChange={setCompanyId} placeholder="كل الشركات" options={(opts.data?.companies ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label="الفرع" value={branchId} onChange={setBranchId} placeholder="كل الفروع" options={(opts.data?.branches ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label="الإدارة" value={departmentId} onChange={setDepartmentId} placeholder="كل الإدارات" options={(opts.data?.departments ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        </div>
      </div>

      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !d && <LoadingBlock label="جارٍ حساب المؤشرات…" />}

      {d && (
        <div className={`space-y-6 ${loading ? 'opacity-60 transition-opacity' : ''}`} aria-busy={loading}>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] font-bold text-slate-600">
            <span>
              الفترة: من <span dir="ltr">{d.period.from}</span> إلى <span dir="ltr">{d.period.to}</span>
            </span>
            {!d.scopeSuppressed && (
              <span>
                متوسط عدد الموظفين: <span dir="ltr">{fmtNum(d.headcount.average)}</span> (البداية <span dir="ltr">{d.headcount.start}</span>، النهاية <span dir="ltr">{d.headcount.end}</span>)
              </span>
            )}
            <span className="text-slate-400">المصدر: {d.source}</span>
          </p>
          {d.scopeSuppressed && (
            <p role="note" className="flex items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] font-bold text-slate-700">
              <ShieldCheck size={18} className="shrink-0 mt-0.5" aria-hidden="true" /> {d.turnover.overall.reason}
            </p>
          )}
          {d.notes.length > 0 && (
            <ul className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[12px] font-bold text-slate-600 list-disc pr-8 space-y-1">
              {d.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          <section aria-labelledby="bm-people" className="space-y-3">
            <h2 id="bm-people" className="text-[15px] font-black text-slate-800">الدوران والخدمة والتوظيف</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <MetricCard
                metric={d.turnover.overall}
                onHow={setHow}
                sub={
                  d.turnover.overall.value !== null && (
                    <>
                      <span dir="ltr">{d.turnover.exits}</span> خروج · سنوياً <span dir="ltr">{fmtNum(d.turnover.overall.extra?.annualized ?? null)}%</span>
                    </>
                  )
                }
              />
              <MetricCard metric={d.turnover.voluntary} onHow={setHow} sub={d.turnover.involuntary.value !== null && <>غير طوعي <span dir="ltr">{fmtNum(d.turnover.involuntary.value)}%</span> · غير مصنّف <span dir="ltr">{fmtNum(d.turnover.unknownType.value)}%</span></>} />
              <MetricCard metric={d.tenure.active} onHow={setHow} sub={d.tenure.leavers.value !== null && <>عند الخروج: <span dir="ltr">{fmtNum(d.tenure.leavers.value)}</span> سنة</>} />
              <MetricCard metric={d.timeToHire} onHow={setHow} sub={d.timeToHire.value !== null && <>الوسيط <span dir="ltr">{fmtNum(d.timeToHire.extra?.median ?? null)}</span> يوم · <span dir="ltr">{d.timeToHire.denominator}</span> طلب</>} />
              <MetricCard metric={d.newHireAttrition.m3} onHow={setHow} sub={d.newHireAttrition.m3.value !== null && <><span dir="ltr">{d.newHireAttrition.m3.numerator}</span> من <span dir="ltr">{d.newHireAttrition.m3.denominator}</span> معيَّن</>} />
              <MetricCard metric={d.newHireAttrition.m6} onHow={setHow} sub={d.newHireAttrition.m6.value !== null && <><span dir="ltr">{d.newHireAttrition.m6.numerator}</span> من <span dir="ltr">{d.newHireAttrition.m6.denominator}</span> معيَّن</>} />
              <MetricCard metric={d.turnoverCost.total} onHow={setHow} />
              <MetricCard metric={d.turnoverCost.perExit} onHow={setHow} />
            </div>
          </section>

          <section aria-labelledby="bm-time" className="space-y-3">
            <h2 id="bm-time" className="text-[15px] font-black text-slate-800">الإضافي والغياب</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <MetricCard metric={d.overtime.cost} onHow={setHow} />
              <MetricCard metric={d.overtime.hoursPerEmployeePerMonth} onHow={setHow} sub={d.overtime.hours.value !== null && <>الإجمالي <span dir="ltr">{fmtNum(d.overtime.hours.value)}</span> ساعة</>} />
              <MetricCard metric={d.absence.rate} onHow={setHow} />
              <MetricCard metric={d.absence.sickDaysPerEmployee} onHow={setHow} sub={d.absence.sickDaysPerEmployee.value !== null && <>سنوياً <span dir="ltr">{fmtNum(d.absence.sickDaysPerEmployee.extra?.perYear ?? null)}</span> يوم</>} />
            </div>
          </section>

          <section aria-labelledby="bm-money" className="space-y-3">
            <h2 id="bm-money" className="text-[15px] font-black text-slate-800">الكلفة الفعلية</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <MetricCard metric={d.costPerEmployee.perMonth} onHow={setHow} />
              <MetricCard metric={d.endOfService.paidPerExit} onHow={setHow} sub={d.endOfService.paidPerExit.value !== null && <><span dir="ltr">{d.endOfService.paidPerExit.denominator}</span> تصفية مدفوعة</>} />
              <MetricCard metric={d.endOfService.paidVsAccrued} onHow={setHow} />
              <MetricCard metric={d.govFees.perExpatPerYear} onHow={setHow} />
            </div>
          </section>

          {!d.scopeSuppressed && (
            <>
              <Card title="الاتجاه الشهري" subtitle="الأشهر التي فيها أقل من 5 أشخاص تظهر فارغة (رمادية).">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <TrendChart title="الدوران الشهري (%)" unit="%" points={d.turnover.series} color="fill-rose-500" />
                  <TrendChart title="كلفة الإضافي المصروفة (ريال)" unit="ريال" points={d.overtime.series.map((p) => ({ month: p.month, value: p.cost, suppressed: p.suppressed }))} color="fill-amber-500" />
                  <TrendChart title="معدل الغياب (%)" unit="%" points={d.absence.series} color="fill-sky-500" />
                  <TrendChart title="كلفة الموظف شهرياً (ريال)" unit="ريال" points={d.costPerEmployee.series as SeriesPoint[]} color="fill-indigo-500" />
                </div>
              </Card>

              <Card title="الدوران حسب المجموعة" subtitle="المعدل = حالات خروج المجموعة ÷ متوسط عددها × 100. المجموعات الأقل من 5 محجوبة.">
                <div role="tablist" aria-label="تقسيم الدوران" className="mb-3 flex gap-2 border-b border-slate-200">
                  {([
                    ['dept', 'الإدارة'],
                    ['nat', 'الجنسية'],
                    ['tenure', 'مدة الخدمة عند الخروج'],
                  ] as const).map(([k, l]) => (
                    <button key={k} type="button" role="tab" aria-selected={turnoverTab === k} onClick={() => setTurnoverTab(k)} className={`whitespace-nowrap px-3 py-2 text-[12.5px] font-black border-b-2 -mb-px ${turnoverTab === k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                      {l}
                    </button>
                  ))}
                </div>
                <BreakdownTable
                  caption="الدوران حسب المجموعة"
                  groupLabel={turnoverTab === 'dept' ? 'الإدارة' : turnoverTab === 'nat' ? 'الجنسية' : 'مدة الخدمة'}
                  sizeLabel="متوسط العدد"
                  valueLabel="الدوران"
                  rows={turnoverTab === 'dept' ? d.turnover.byDepartment : turnoverTab === 'nat' ? d.turnover.byNationality : d.turnover.byTenure}
                  valueFmt={pctFmt}
                  extraCols={[{ key: 'exits', label: 'حالات الخروج', from: 'numerator', fmt: (v) => fmtNum(v, 0) }]}
                />
              </Card>

              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
                <Card title="الإضافي حسب الإدارة" subtitle="الكلفة من المسيرات، والساعات من طلبات الإضافي المعتمدة.">
                  <BreakdownTable
                    caption="الإضافي حسب الإدارة"
                    groupLabel="الإدارة"
                    sizeLabel="متوسط العدد"
                    valueLabel="الكلفة شهرياً"
                    rows={d.overtime.byDepartment}
                    valueFmt={sarFmt}
                    extraCols={[
                      { key: 'hoursPerMonth', label: 'ساعات شهرياً' },
                      { key: 'hoursPerEmployeePerMonth', label: 'لكل موظف' },
                    ]}
                  />
                </Card>
                <Card title="كلفة الموظف شهرياً حسب الإدارة" subtitle="من المسيرات المعتمدة والمصروفة (الإجمالي + حصة التأمينات).">
                  <BreakdownTable caption="كلفة الموظف حسب الإدارة" groupLabel="الإدارة" sizeLabel="الموظفون" valueLabel="لكل موظف شهرياً" rows={d.costPerEmployee.byDepartment} valueFmt={sarFmt} />
                </Card>
                <Card title="الغياب حسب الإدارة" subtitle="أيام الغياب ÷ أيام الحضور المسجّلة.">
                  <BreakdownTable caption="الغياب حسب الإدارة" groupLabel="الإدارة" sizeLabel="الموظفون" valueLabel="معدل الغياب" rows={d.absence.byDepartment} valueFmt={pctFmt} extraCols={[{ key: 'absent', label: 'أيام الغياب', from: 'numerator', fmt: (v) => fmtNum(v, 0) }]} />
                </Card>
                <Card title="الإجازة المرضية حسب الإدارة" subtitle="أيام الإجازة المرضية ÷ متوسط العدد.">
                  <BreakdownTable caption="الإجازة المرضية حسب الإدارة" groupLabel="الإدارة" sizeLabel="متوسط العدد" valueLabel="أيام لكل موظف" rows={d.absence.sickByDepartment} valueFmt={(v) => fmtNum(v)} />
                </Card>
              </div>
            </>
          )}

          <p className="flex items-start gap-2 text-[11.5px] font-bold text-slate-500">
            <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" /> الإدارة والفرع حسب ملف الموظف الحالي. «تقريبي» حيث لا يوجد في رديف تاريخ مخصص (مدة التوظيف) أو المبالغ مقطوعة (الرسوم الحكومية).
          </p>
        </div>
      )}
      <HowDialog metric={how} onClose={() => setHow(null)} />
    </WfPage>
  );
}

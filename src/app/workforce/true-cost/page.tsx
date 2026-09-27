"use client";

// «الكلفة الحقيقية» (tab «كلفة الموظفين»): filters first (scope and search; the scenario, sort and «with
// notes only» folded under «خيارات أكثر»), then the rounded totals, then the employee list. For one employee
// (?employeeId=): the month-by-month lines with «لماذا؟» (formula + every rule used with its status,
// effective date and source). Exports: one «تصدير» menu (Excel + PDF). Data: GET /api/workforce/true-cost.
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Calculator, ChevronDown, Info, Save, Search, SlidersHorizontal, UserMinus } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import type { CostLine, Scenario } from '@/lib/workforce/types';
import {
  FLAG_TITLES,
  HORIZONS,
  LEVY_TIER_LABELS,
  NATIONALITY_LABELS,
  SCENARIOS,
  SCENARIO_LABELS,
  evidenceForLine,
  windowField,
  type Horizon,
} from '@/app/api/workforce/_lib/shared';
import { callApi, useApi } from '../_components/api';
import type { EmployeeSummary, OptionsResponse, TrueCostDetail, TrueCostResponse } from '../_components/types';
import {
  Card,
  EmptyBlock,
  ErrorBlock,
  ExportMenu,
  LoadingBlock,
  Money,
  Num,
  SCENARIO_FIELD_HINT,
  SCENARIO_FIELD_LABEL,
  Segmented,
  SelectField,
  SeriesChart,
  StatusBadge,
  WfPage,
  WhyButton,
  WhyDialog,
  buttonClass,
  inputClass,
  type WhyContent,
} from '../_components/ui';

const PAGE = 50;

function FlagChips({ flags }: { flags: EmployeeSummary['flags'] }) {
  const shown = flags.filter((f) => f.severity !== 'INFO');
  if (!shown.length) return <span className="text-slate-300">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((f) => (
        <span key={f.code} title={f.message} className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-black ${f.severity === 'ERROR' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}>
          {FLAG_TITLES[f.code] ?? f.code}
        </span>
      ))}
    </span>
  );
}

function EmployeeDetail({ detail, horizon, scenario, onClose }: { detail: TrueCostDetail; horizon: Horizon; scenario: Scenario; onClose: () => void }) {
  const months = detail.months.slice(0, horizon);
  const firstActive = months.findIndex((m) => m.active);
  const [selected, setSelected] = useState(Math.max(0, firstActive));
  const [why, setWhy] = useState<WhyContent | null>(null);
  const [saving, setSaving] = useState(false);
  const month = months[Math.min(selected, months.length - 1)];
  const s = detail.summary;
  const wf = windowField(horizon);

  const openWhy = (line: CostLine) => {
    const ex = detail.explanations[line.key];
    setWhy({
      title: `${line.label} — ${month.month}`,
      amount: line.amount,
      basis: line.basis,
      formulaText: ex?.formulaText ?? null,
      note: line.note ?? (line.kind === 'MEMO' ? 'بند للعلم: لا يدخل في إجمالي الكلفة (الأجر يُدفع أثناء الإجازة).' : line.kind === 'SUBSIDY' ? 'سطر سالب مشروط بقبول طلب هدف.' : null),
      status: line.status,
      evidence: evidenceForLine(line, month.month, ex, detail.assumptionEvidence),
    });
  };

  const save = async () => {
    setSaving(true);
    const res = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'TRUE_COST', params: { employeeId: s.employeeId, months: horizon, scenario } } });
    setSaving(false);
    if (res.ok) toast.success('حُفظ الحساب. تجده في «الحسابات المحفوظة».');
    else toast.error(res.message);
  };

  return (
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div>
          <button type="button" onClick={onClose} className={buttonClass.link}>
            <ArrowRight size={14} aria-hidden="true" /> العودة إلى القائمة
          </button>
          <h2 className="mt-2 text-[20px] font-black text-slate-900">{s.name}</h2>
          <p className="mt-1 text-[12px] font-bold text-slate-500">
            {[s.employeeNo, NATIONALITY_LABELS[s.nationalityClass] ?? s.nationalityClass, s.companyName ?? 'بلا شركة قانونية', s.branchName, s.departmentName].filter(Boolean).join(' · ')}
            {s.exitDate && <> · ينتهي العمل <span dir="ltr">{s.exitDate}</span></>}
          </p>
          <div className="mt-2">
            <FlagChips flags={s.flags} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/workforce/exit-cost?employeeId=${s.employeeId}`} className={buttonClass.secondary}>
            <UserMinus size={16} aria-hidden="true" /> كلفة الإنهاء
          </Link>
          <ExportMenu excel={{ kind: 'true-cost', query: { employeeId: s.employeeId, months: horizon, scenario } }} pdf={{ kind: 'true-cost', query: { employeeId: s.employeeId, months: horizon, scenario } }} />
          <button type="button" onClick={save} disabled={saving} className={buttonClass.secondary} title="يحفظ الأرقام مع نسخ القواعد المستخدمة للرجوع إليها لاحقاً">
            <Save size={16} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ نسخة'}
          </button>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { t: 'الشهر الأول', v: s.month1 },
          { t: 'خلال 12 شهراً', v: s.next12 },
          { t: `خلال ${horizon} شهراً`, v: s[wf] },
          { t: 'نهاية الخدمة المستحقة الآن', v: null, x: s.eosbLiabilityEmployer },
        ].map((k) => (
          <div key={k.t} className="rounded-2xl bg-slate-50 p-3">
            <dt className="text-[11px] font-black text-slate-500">{k.t}</dt>
            <dd className="mt-1 text-[16px] font-black text-slate-900">{k.v ? <Money value={k.v.cost} round /> : <Money value={k.x ?? 0} round />}</dd>
            {k.v && (
              <dd className="text-[11px] font-bold text-green-700">
                بعد الدعم <Money value={k.v.net} round />
              </dd>
            )}
          </div>
        ))}
      </dl>

      <div className="mt-6">
        <h3 className="text-[14px] font-black text-slate-800 mb-2">الكلفة شهراً بشهر</h3>
        <SeriesChart series={months.map((m) => ({ month: m.month, cost: m.totals.cost, net: m.totals.net }))} title={`كلفة ${s.name} الشهرية`} />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-5 gap-6">
        <div className="xl:col-span-2">
          <h3 className="text-[14px] font-black text-slate-800 mb-2">الأشهر</h3>
          <div className="max-h-[520px] overflow-auto rounded-2xl border border-slate-100">
            <table className="w-full text-[12px]">
              <caption className="sr-only">الكلفة الشهرية للموظف؛ اختر شهراً لعرض بنوده</caption>
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200 text-slate-500">
                  <th scope="col" className="px-2 py-2 text-right font-black">الشهر</th>
                  <th scope="col" className="px-2 py-2 text-right font-black">الكلفة</th>
                  <th scope="col" className="px-2 py-2 text-right font-black">بعد الدعم</th>
                  <th scope="col" className="px-2 py-2"><span className="sr-only">البنود</span></th>
                </tr>
              </thead>
              <tbody>
                {months.map((m, i) => (
                  <tr key={m.month} className={`border-b border-slate-100 font-bold ${i === selected ? 'bg-indigo-50' : ''} ${m.active ? 'text-slate-700' : 'text-slate-300'}`}>
                    <th scope="row" className="px-2 py-1.5 text-right font-black" dir="ltr">{m.month}</th>
                    <td className="px-2 py-1.5"><Money value={m.totals.cost} unit={false} /></td>
                    <td className="px-2 py-1.5"><Money value={m.totals.net} unit={false} /></td>
                    <td className="px-2 py-1.5 text-left">
                      <button type="button" onClick={() => { setSelected(i); if (window.matchMedia("(max-width: 1279px)").matches) document.getElementById("wf-month-lines")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-pressed={i === selected} className="rounded-lg px-2 py-0.5 text-[11px] font-black text-indigo-700 hover:bg-indigo-100">
                        البنود
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="xl:col-span-3">
          <h3 id="wf-month-lines" className="text-[14px] font-black text-slate-800 mb-2 scroll-mt-4">
            {'بنود شهر '}
            <span dir="ltr">{month.month}</span>
            {month.levyTier && <span className="mr-2 text-[11px] font-bold text-slate-500">{`شريحة المقابل: ${LEVY_TIER_LABELS[month.levyTier] ?? month.levyTier}`}</span>}
          </h3>
          {!month.active ? (
            <EmptyBlock text="لا يعمل الموظف في هذا الشهر: لا كلفة." />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
              {month.lines.map((l) => (
                <li key={l.key} className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-black text-slate-800">
                      {l.label}
                      {l.kind === 'MEMO' && <span className="text-[11px] text-slate-400"> (للعلم)</span>}
                      {l.kind === 'SUBSIDY' && <span className="text-[11px] text-green-700"> (مشروط)</span>}
                    </p>
                    <p dir="auto" className="text-[11.5px] font-bold text-slate-500 break-words">{l.basis}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={l.status} />
                    <Money value={l.amount} className={`text-[13px] font-black ${l.amount < 0 ? 'text-green-700' : l.kind === 'MEMO' ? 'text-slate-400' : 'text-slate-900'}`} />
                    <WhyButton onClick={() => openWhy(l)} label={l.label} />
                  </div>
                </li>
              ))}
              <li className="flex justify-between px-3 py-2.5 text-[13px] font-black bg-slate-50">
                <span>المجموع قبل الدعم / بعده</span>
                <span>
                  <Money value={month.totals.cost} /> / <Money value={month.totals.net} />
                </span>
              </li>
            </ul>
          )}
        </div>
      </div>
      <WhyDialog content={why} onClose={() => setWhy(null)} />
    </Card>
  );
}

function TrueCostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const employeeId = params.get('employeeId') ?? '';
  const [companyId, setCompanyId] = useState(params.get('companyId') ?? '');
  const [branchId, setBranchId] = useState(params.get('branchId') ?? '');
  const [departmentId, setDepartmentId] = useState(params.get('departmentId') ?? '');
  const [horizon, setHorizon] = useState<Horizon>(36);
  const [scenario, setScenario] = useState<Scenario>('base');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'cost' | 'name' | 'flags'>('cost');
  const [flagged, setFlagged] = useState(params.get('flagged') === '1');
  const [skip, setSkip] = useState(0);
  // «خيارات أكثر» opens by itself when the page arrives filtered to employees with notes (?flagged=1 from the overview).
  const [moreOpen] = useState(params.get('flagged') === '1');

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setSkip(0);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const options = useApi<OptionsResponse>('/api/workforce/options');
  const baseQuery = useMemo(() => {
    const u = new URLSearchParams();
    if (companyId) u.set('companyId', companyId);
    if (branchId) u.set('branchId', branchId);
    if (departmentId) u.set('departmentId', departmentId);
    u.set('months', String(horizon));
    u.set('scenario', scenario);
    return u;
  }, [companyId, branchId, departmentId, horizon, scenario]);

  const listUrl = useMemo(() => {
    if (employeeId) return null;
    const u = new URLSearchParams(baseQuery);
    if (q) u.set('q', q);
    u.set('sort', sort);
    if (flagged) u.set('flagged', '1');
    u.set('take', String(PAGE));
    u.set('skip', String(skip));
    return `/api/workforce/true-cost?${u.toString()}`;
  }, [baseQuery, q, sort, flagged, skip, employeeId]);
  const detailUrl = employeeId ? `/api/workforce/true-cost?employeeId=${encodeURIComponent(employeeId)}&months=${horizon}&scenario=${scenario}&take=1` : null;

  const list = useApi<TrueCostResponse>(listUrl);
  const detail = useApi<TrueCostResponse>(detailUrl);

  const openEmployee = (id: string) => router.push(`/workforce/true-cost?employeeId=${encodeURIComponent(id)}`);
  const closeEmployee = () => router.push('/workforce/true-cost');

  const data = list.data;
  const wf = windowField(horizon);
  const opts = options.data;

  return (
    <WfPage
      current="/workforce/true-cost"
      icon={<Calculator size={24} />}
      title="كلفة الموظفين"
      subtitle="كم يكلفك كل موظف فعلاً هذا الشهر وخلال السنوات القادمة."
      help={
        <>
          <p>كلفة كل موظف على صاحب العمل شهراً بشهر لمدة 36 شهراً: الراتب والبدلات والتأمينات ونهاية الخدمة ورسوم الوافدين والتأمين الطبي.</p>
          <p>دعم هدف يظهر سطراً مستقلاً لأنه مشروط بقبول طلب الدعم، فالرقم الرئيسي قبل الدعم.</p>
          <p>اضغط اسم الموظف ثم «لماذا؟» بجانب أي بند لترى المعادلة ومصدر كل قيمة.</p>
        </>
      }
      actions={
        !employeeId && (
          <ExportMenu
            disabled={!data || list.loading}
            excel={data?.total ? { kind: 'true-cost', query: { companyId, branchId, departmentId, months: horizon, scenario, q, sort, flagged } } : undefined}
            pdf={{ kind: 'true-cost', query: { companyId, months: horizon, scenario } }}
          />
        )
      }
    >
      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <SelectField label="الشركة القانونية" value={companyId} onChange={(v) => { setCompanyId(v); setSkip(0); }} placeholder="كل الشركات" options={(opts?.companies ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label="الفرع" value={branchId} onChange={(v) => { setBranchId(v); setSkip(0); }} placeholder="كل الفروع" options={(opts?.branches ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label="الإدارة" value={departmentId} onChange={(v) => { setDepartmentId(v); setSkip(0); }} placeholder="كل الإدارات" options={(opts?.departments ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <div>
            <label htmlFor="wf-search" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">بحث بالاسم أو الرقم الوظيفي</label>
            <div className="relative">
              <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input id="wf-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputClass} pr-9`} placeholder="اسم الموظف…" disabled={!!employeeId} />
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <Segmented label="المدة" value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: h, label: `${h} شهراً` }))} />
        </div>
        <details open={moreOpen} className="group mt-4 rounded-2xl border border-slate-100 bg-slate-50/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12.5px] font-black text-slate-600 [&::-webkit-details-marker]:hidden">
            <SlidersHorizontal size={15} className="text-indigo-500" aria-hidden="true" />
            خيارات أكثر
            {(scenario !== 'base' || sort !== 'cost' || flagged) && <span className="rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10.5px] font-black text-indigo-700">مفعّلة</span>}
            <ChevronDown size={15} className="mr-auto text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 px-3 py-3">
            <div>
              <Segmented label={SCENARIO_FIELD_LABEL} value={scenario} onChange={setScenario} options={SCENARIOS.map((s) => ({ value: s, label: SCENARIO_LABELS[s] }))} />
              <p className="mt-1 flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
                <Info size={12} aria-hidden="true" /> {SCENARIO_FIELD_HINT}
              </p>
            </div>
            {!employeeId && (
              <>
                <SelectField
                  label="الترتيب"
                  value={sort}
                  onChange={(v) => { setSort(v as 'cost' | 'name' | 'flags'); setSkip(0); }}
                  options={[
                    { value: 'cost', label: 'الأعلى كلفة (12 شهراً)' },
                    { value: 'name', label: 'الاسم' },
                    { value: 'flags', label: 'الأكثر ملاحظات' },
                  ]}
                />
                <label className="inline-flex items-center gap-2 pb-2 text-[12px] font-black text-slate-700">
                  <input type="checkbox" checked={flagged} onChange={(e) => { setFlagged(e.target.checked); setSkip(0); }} className="h-4 w-4 rounded border-slate-300" />
                  من لديهم ملاحظات فقط
                </label>
              </>
            )}
          </div>
        </details>
        {options.error && <p role="alert" className="mt-3 text-[12px] font-bold text-rose-700">{`تعذر تحميل قوائم التصفية: ${options.error}`}</p>}
      </Card>

      {employeeId ? (
        <>
          {detail.error && <ErrorBlock message={detail.error} onRetry={detail.reload} />}
          {detail.loading && !detail.data && <LoadingBlock />}
          {detail.data?.detail && (
            <div className={detail.loading ? 'opacity-60 transition-opacity' : ''} aria-busy={detail.loading}>
              <EmployeeDetail key={`${employeeId}|${horizon}|${scenario}`} detail={detail.data.detail} horizon={horizon} scenario={scenario} onClose={closeEmployee} />
            </div>
          )}
        </>
      ) : (
        <>
          {list.error && <ErrorBlock message={list.error} onRetry={list.reload} />}
          {list.loading && !data && <LoadingBlock />}
          {data && (
            <div className={`space-y-4 ${list.loading ? 'opacity-60 transition-opacity' : ''}`} aria-busy={list.loading}>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { t: 'هذا الشهر', v: data.totals.month1 },
                  { t: 'خلال 12 شهراً', v: data.totals.next12 },
                  { t: `خلال ${horizon} شهراً`, v: data.totals[wf] },
                ].map((k, i) => (
                  <div key={i} className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
                    <h2 className="text-[13px] font-black text-slate-500">{k.t}</h2>
                    <p className="mt-2 text-[24px] font-black text-slate-900 leading-tight"><Money value={k.v.cost} round /></p>
                    <p className="mt-2 text-[12px] font-bold text-slate-500">
                      بعد دعم هدف المتوقع: <Money value={k.v.net} round className="text-slate-700" />
                    </p>
                    <p className="text-[11.5px] font-bold text-green-700">
                      الدعم <Money value={k.v.subsidy} round />
                    </p>
                  </div>
                ))}
              </div>

              <Card
                title="الموظفون"
                subtitle={`${data.total} موظف ضمن التصفية، من شهر ${data.startMonth.split("-").reverse().join("/")}. اضغط الاسم للتفاصيل.`}
              >
                {data.employees.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] text-[12.5px]">
                      <caption className="sr-only">كلفة الموظفين</caption>
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">الموظف</th>
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">الشركة</th>
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">هذا الشهر</th>
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">خلال 12 شهراً</th>
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">خلال 36 شهراً</th>
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">{`بعد دعم هدف (${horizon} شهراً)`}</th>
                          <th scope="col" className="px-3 py-2 text-right font-black whitespace-nowrap">ملاحظات</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.employees.map((e) => (
                          <tr key={e.employeeId} className="border-b border-slate-100 font-bold text-slate-700 align-top">
                            <th scope="row" className="px-3 py-2 text-right">
                              <button type="button" onClick={() => openEmployee(e.employeeId)} className="text-right font-black text-indigo-700 hover:underline">
                                {e.name}
                              </button>
                              <span className="block text-[11px] text-slate-400">
                                {[e.employeeNo, NATIONALITY_LABELS[e.nationalityClass] ?? e.nationalityClass].filter(Boolean).join(' · ')}
                                {e.exitDate && <> · حتى <span dir="ltr">{e.exitDate}</span></>}
                              </span>
                            </th>
                            <td className="px-3 py-2 text-[12px]">{e.companyName ?? <span className="text-amber-700">بلا شركة قانونية</span>}</td>
                            <td className="px-3 py-2"><Money value={e.month1.cost} round /></td>
                            <td className="px-3 py-2"><Money value={e.next12.cost} round /></td>
                            <td className="px-3 py-2"><Money value={e.next36.cost} round /></td>
                            <td className="px-3 py-2"><Money value={e[wf].net} round /></td>
                            <td className="px-3 py-2 max-w-[220px]"><FlagChips flags={e.flags} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyBlock text="لا يوجد موظفون مطابقون للتصفية." />
                )}
                {data.total > PAGE && (
                  <nav aria-label="صفحات الموظفين" className="mt-4 flex items-center justify-between gap-2 text-[12px] font-bold text-slate-600">
                    <button type="button" className={buttonClass.secondary} disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>السابق</button>
                    <span>
                      <Num value={skip + 1} />–<Num value={Math.min(skip + PAGE, data.total)} /> من <Num value={data.total} />
                    </span>
                    <button type="button" className={buttonClass.secondary} disabled={skip + PAGE >= data.total} onClick={() => setSkip(skip + PAGE)}>التالي</button>
                  </nav>
                )}
              </Card>
            </div>
          )}
        </>
      )}
    </WfPage>
  );
}

export default function TrueCostPage() {
  return (
    <Suspense fallback={<LoadingBlock label="جارٍ التحميل…" />}>
      <TrueCostInner />
    </Suspense>
  );
}

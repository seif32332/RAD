"use client";

// «لوحة القرار»: employer cost of the whole workforce (this month / 12 / 36 months, before and after the
// HRDF subsidy), composition, groups, legal companies (levy tiers), upcoming regulatory changes and data
// quality. Data: GET /api/workforce/overview (the engine; this page only displays).
import React, { useState } from 'react';
import Link from 'next/link';
import { Gauge, Save } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import type { OverviewResponse } from '@/app/api/workforce/_lib/views';
import { FLAG_TITLES, HORIZONS, SCENARIOS, SCENARIO_LABELS, SEVERITY_LABELS, formatRuleValue, type Horizon } from '@/app/api/workforce/_lib/shared';
import type { Scenario } from '@/lib/workforce/types';
import { companySettingsHref } from '@/lib/workforce/company-settings';
import { callApi, useApi } from './_components/api';
import { Card, CompositionBars, EmptyBlock, ErrorBlock, LoadingBlock, Money, Num, Segmented, SeriesChart, StatusBadge, WfPage, buttonClass } from './_components/ui';
import { BandBadge, RowStatusBadge } from './_components/nitaqat-ui';
import type { NitaqatBand } from '@/lib/workforce/nitaqat';

interface SaudizationSummary {
  date: string;
  companies: Array<{
    companyId: string;
    companyName: string;
    status: 'OK' | 'NO_ACTIVITY' | 'NO_EMPLOYEES';
    message: string | null;
    band: NitaqatBand | null;
    pct: number;
    x: number;
    activityName: string | null;
    activityStatus: string | null;
    undocumentedCount: number;
    alerts: number;
    settingsHref: string;
  }>;
}

/** «السعودة» summary per legal company (band + Qiwa documentation alert), linking to the planner. */
function SaudizationSummaryCard() {
  const { data, error, loading, reload } = useApi<SaudizationSummary>('/api/workforce/saudization?summary=1');
  return (
    <Card
      title="السعودة حسب الشركة القانونية"
      subtitle="تقدير نطاقات المطوّر بأوزان قوى وعقودها الموثّقة؛ التفاصيل والحل الأمثل في «مخطط السعودة». المرجع منصة قوى."
      actions={<Link href="/workforce/saudization" className={buttonClass.link}>مخطط السعودة ←</Link>}
    >
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock label="جارٍ التقدير…" />}
      {data && !data.companies.length && <EmptyBlock text="لا توجد شركات قانونية" />}
      {data && data.companies.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <caption className="sr-only">نطاق كل شركة قانونية</caption>
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th scope="col" className="py-2 text-right font-black">الشركة</th>
                <th scope="col" className="py-2 text-right font-black">النطاق</th>
                <th scope="col" className="py-2 text-right font-black">النسبة</th>
                <th scope="col" className="py-2 text-right font-black">X</th>
                <th scope="col" className="py-2 text-right font-black">عقود غير موثّقة</th>
                <th scope="col" className="py-2 text-right font-black">النشاط</th>
              </tr>
            </thead>
            <tbody>
              {data.companies.map((c) => (
                <tr key={c.companyId} className="border-b border-slate-100 font-bold text-slate-700">
                  <th scope="row" className="py-2 text-right font-black text-slate-800">
                    <Link href={`/workforce/saudization?companyId=${encodeURIComponent(c.companyId)}`} className="hover:underline">{c.companyName}</Link>
                  </th>
                  <td className="py-2">{c.status === 'OK' ? <BandBadge band={c.band} /> : <span className="text-[11.5px] text-slate-500">{c.status === 'NO_ACTIVITY' ? 'لا نشاط' : 'لا عاملين'}</span>}</td>
                  <td className="py-2">{c.status === 'OK' ? <span dir="ltr">{c.pct}%</span> : '—'}</td>
                  <td className="py-2"><Num value={c.x} /></td>
                  <td className="py-2">{c.undocumentedCount ? <span className="text-rose-700">{c.undocumentedCount}</span> : '0'}</td>
                  <td className="py-2">
                    {c.activityName ? (
                      <span className="inline-flex flex-wrap items-center gap-1">{c.activityName} <RowStatusBadge status={c.activityStatus} /></span>
                    ) : (
                      <Link href={c.settingsHref} className="text-amber-700 underline">اختر النشاط</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type GroupTab = 'company' | 'branch' | 'department';

function Kpi({ title, cost, net, subsidy, hint }: { title: string; cost: number; net: number; subsidy: number; hint?: string }) {
  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
      <h3 className="text-[13px] font-black text-slate-500">{title}</h3>
      <p className="mt-2 text-[22px] sm:text-[26px] font-black text-slate-900 leading-tight">
        <Money value={cost} />
      </p>
      <p className="text-[11px] font-bold text-slate-400">كلفة صاحب العمل قبل دعم هدف</p>
      <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-[12px] font-bold">
        <div className="flex justify-between gap-2">
          <dt className="text-green-700">دعم هدف (مشروط)</dt>
          <dd className="text-green-700">
            <Money value={subsidy} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-600">بعد الدعم</dt>
          <dd className="text-slate-900">
            <Money value={net} />
          </dd>
        </div>
      </dl>
      {hint && <p className="mt-2 text-[11px] font-bold text-slate-400">{hint}</p>}
    </div>
  );
}

function GroupTable({ rows: all, horizon, label }: { rows: OverviewResponse['byCompany']; horizon: Horizon; label: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!all.length) return <EmptyBlock text="لا توجد بيانات" />;
  const rows = expanded ? all : all.slice(0, 10);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[12.5px]">
        <caption className="sr-only">{`الكلفة حسب ${label}`}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th scope="col" className="py-2 text-right font-black">{label}</th>
            <th scope="col" className="py-2 text-right font-black">الموظفون</th>
            <th scope="col" className="py-2 text-right font-black">هذا الشهر</th>
            <th scope="col" className="py-2 text-right font-black">{`${horizon} شهراً قبل الدعم`}</th>
            <th scope="col" className="py-2 text-right font-black">{`${horizon} شهراً بعد الدعم`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id || 'none'} className="border-b border-slate-100 font-bold text-slate-700">
              <th scope="row" className="py-2 text-right font-black text-slate-800">{r.name}</th>
              <td className="py-2"><Num value={r.headcount} /></td>
              <td className="py-2"><Money value={r.month1.cost} /></td>
              <td className="py-2"><Money value={r.window.cost} /></td>
              <td className="py-2"><Money value={r.window.net} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {all.length > 10 && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="mt-3 text-[12px] font-black text-indigo-700 hover:underline">
          {expanded ? 'عرض أقل' : `عرض الكل (${all.length})`}
        </button>
      )}
    </div>
  );
}

export default function WorkforceOverviewPage() {
  const [horizon, setHorizon] = useState<Horizon>(36);
  const [scenario, setScenario] = useState<Scenario>('base');
  const [groupTab, setGroupTab] = useState<GroupTab>('company');
  const [compositionView, setCompositionView] = useState<'window' | 'month'>('window');
  const [saving, setSaving] = useState(false);
  const { data, error, loading, reload } = useApi<OverviewResponse>(`/api/workforce/overview?months=${horizon}&scenario=${scenario}`);

  const save = async () => {
    setSaving(true);
    const res = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'OVERVIEW', params: { months: horizon, scenario } } });
    setSaving(false);
    if (res.ok) toast.success('حُفظ الحساب مع نسخة المحرك ونسخ القواعد');
    else toast.error(res.message);
  };

  const groups = data ? (groupTab === 'company' ? data.byCompany : groupTab === 'branch' ? data.byBranch : data.byDepartment) : [];

  return (
    <WfPage
      current="/workforce"
      icon={<Gauge size={24} />}
      title="لوحة القرار"
      subtitle="الكلفة الكلية للمنشأة على صاحب العمل شهراً بشهر، وتركيبتها، وحسب الشركة والفرع والإدارة، مع التغييرات النظامية القادمة وجودة البيانات."
      actions={
        <button type="button" onClick={save} disabled={saving || !data} className={buttonClass.primary}>
          <Save size={16} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ الحساب'}
        </button>
      }
    >
      <div className="flex flex-wrap items-end gap-4">
        <Segmented label="أفق التوقع" value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: h, label: `${h} شهراً` }))} />
        <Segmented label="السيناريو (للافتراضات ذات النطاق)" value={scenario} onChange={setScenario} options={SCENARIOS.map((s) => ({ value: s, label: SCENARIO_LABELS[s] }))} />
        {data && (
          <p className="text-[12px] font-bold text-slate-500 pb-2">
            {"يبدأ التوقع من "}
            <span dir="ltr">{data.startMonth}</span>
            {" · نسخة المحرك "}
            <span dir="ltr">{data.engineVersion}</span>
          </p>
        )}
      </div>

      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock />}

      {data && (
        <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Kpi title="هذا الشهر" cost={data.kpis.thisMonth.cost} subsidy={data.kpis.thisMonth.subsidy} net={data.kpis.thisMonth.net} />
            <Kpi title="الأشهر الـ12 القادمة" cost={data.kpis.next12.cost} subsidy={data.kpis.next12.subsidy} net={data.kpis.next12.net} />
            <Kpi title="الأشهر الـ36 القادمة" cost={data.kpis.next36.cost} subsidy={data.kpis.next36.subsidy} net={data.kpis.next36.net} />
            <div className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
              <h3 className="text-[13px] font-black text-slate-500">القوى العاملة هذا الشهر</h3>
              <p className="mt-2 text-[26px] font-black text-slate-900">
                <Num value={data.kpis.headcount} /> <span className="text-[13px] text-slate-400">موظف</span>
              </p>
              <p className="text-[12px] font-bold text-slate-600">
                سعودي <Num value={data.kpis.saudi} /> · خليجي <Num value={data.kpis.gcc} /> · وافد <Num value={data.kpis.expat} />
              </p>
              <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-[12px] font-bold">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-600">نهاية الخدمة المستحقة (إنهاء صاحب العمل)</dt>
                  <dd><Money value={data.kpis.eosbLiabilityEmployer} /></dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-600">لو استقال الجميع (المادة 85)</dt>
                  <dd><Money value={data.kpis.eosbLiabilityResignation} /></dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            <Card
              className="lg:col-span-3"
              title="تركيبة الكلفة"
              subtitle={compositionView === 'window' ? `مجموع ${data.horizon} شهراً حسب البند` : 'الشهر الحالي حسب البند'}
              actions={
                <Segmented
                  label="الفترة"
                  value={compositionView}
                  onChange={setCompositionView}
                  options={[
                    { value: 'window', label: `${data.horizon} شهراً` },
                    { value: 'month', label: 'هذا الشهر' },
                  ]}
                />
              }
            >
              {data.composition.length ? (
                <CompositionBars items={data.composition.map((c) => ({ key: c.key, label: c.label, kind: c.kind, amount: compositionView === 'window' ? c.amount : c.month1 }))} />
              ) : (
                <EmptyBlock text="لا توجد بنود" />
              )}
            </Card>
            <Card className="lg:col-span-2" title="الكلفة الشهرية" subtitle="36 شهراً من الشهر الحالي">
              <SeriesChart series={data.series} title="الكلفة الشهرية للمنشأة" />
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card title="تغييرات نظامية قادمة" subtitle={`ضمن ${data.horizon} شهراً، بأثرها التقديري على الكلفة الشهرية لهذه القوى العاملة`}>
              {data.upcomingEvents.length ? (
                <ul className="space-y-3">
                  {data.upcomingEvents.map((e) => (
                    <li key={e.key} className="rounded-2xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-[13px] font-black text-slate-800 leading-relaxed">{e.label}</p>
                        <StatusBadge status={e.status} />
                      </div>
                      <p className="mt-1 text-[12px] font-bold text-slate-600">
                        {`يسري من ${formatDate(e.effectiveFrom)} · `}
                        {e.previousValue !== null && `${formatRuleValue(e.previousValue, e.unit)} ← `}
                        {formatRuleValue(e.value, e.unit)}
                      </p>
                      <p className="mt-1 text-[12px] font-bold text-slate-700">
                        الأثر الشهري التقديري:{' '}
                        {e.estimatedMonthlyImpact === null ? <span className="text-slate-400">غير مقدَّر آلياً</span> : <Money value={e.estimatedMonthlyImpact} className="text-rose-700" />}
                        {e.affected !== null && <span className="text-slate-500">{` · ${e.affected} موظف متأثر`}</span>}
                      </p>
                      <p className="mt-1 text-[11px] font-bold text-slate-400">{e.impactBasis}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyBlock text="لا توجد تغييرات مسجلة في سجل القواعد خلال هذا الأفق." />
              )}
            </Card>

            <Card title="جودة البيانات" subtitle="ما ينقص الحساب أو يُفترض فيه، ومكان إصلاحه">
              {data.dataQuality.length ? (
                <ul className="space-y-3">
                  {data.dataQuality.map((d) => (
                    <li key={d.code} className="rounded-2xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[13px] font-black text-slate-800">{FLAG_TITLES[d.code] ?? d.code}</p>
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-black ${d.severity === 'ERROR' ? 'bg-rose-100 text-rose-800' : d.severity === 'WARNING' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}
                        >
                          {SEVERITY_LABELS[d.severity]}
                          {d.employees > 0 ? ` · ${d.employees} موظف` : ` · ${d.count}`}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] font-bold text-slate-600 leading-relaxed">{d.message}</p>
                      {d.fix === 'EMPLOYEE' && d.sample.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {d.sample.slice(0, 6).map((s) => (
                            <Link key={s.id} href={`/employees/${s.id}/edit`} className="rounded-lg bg-indigo-50 px-2 py-1 text-[11px] font-black text-indigo-700 hover:bg-indigo-100">
                              {s.name}
                            </Link>
                          ))}
                          {d.employees > 6 && (
                            <Link href="/workforce/true-cost?flagged=1" className="rounded-lg px-2 py-1 text-[11px] font-black text-slate-500 hover:underline">
                              {`و${d.employees - 6} غيرهم ←`}
                            </Link>
                          )}
                        </div>
                      )}
                      {d.fix === 'COMPANY' && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {d.companies.length ? (
                            d.companies.map((c) => (
                              <Link key={c.id} href={companySettingsHref(c.id)} className="rounded-lg bg-indigo-50 px-2 py-1 text-[11px] font-black text-indigo-700 hover:bg-indigo-100">
                                {`إعدادات الكلفة: ${c.name} ←`}
                              </Link>
                            ))
                          ) : (
                            <Link href="/companies" className="text-[12px] font-black text-indigo-700 hover:underline">
                              أدخلها في إعدادات الشركة ←
                            </Link>
                          )}
                        </div>
                      )}
                      {d.fix === 'ASSUMPTIONS' && (
                        <Link href="/workforce/assumptions" className="mt-2 inline-block text-[12px] font-black text-indigo-700 hover:underline">
                          أدخل الافتراضات ←
                        </Link>
                      )}
                      {d.fix === 'RULES' && (
                        <Link href="/workforce/rules" className="mt-2 inline-block text-[12px] font-black text-indigo-700 hover:underline">
                          {`راجع سجل القواعد${d.ruleKeys.length ? ` (${d.ruleKeys.join('، ')})` : ''} ←`}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyBlock text="لا توجد ملاحظات على البيانات." />
              )}
            </Card>
          </div>

          <Card
            title="الكلفة حسب الهيكل"
            actions={
              <Segmented
                label="التجميع"
                value={groupTab}
                onChange={setGroupTab}
                options={[
                  { value: 'company', label: 'الشركة' },
                  { value: 'branch', label: 'الفرع' },
                  { value: 'department', label: 'الإدارة' },
                ]}
              />
            }
          >
            <GroupTable rows={groups} horizon={data.horizon} label={groupTab === 'company' ? 'الشركة القانونية' : groupTab === 'branch' ? 'الفرع' : 'الإدارة'} />
          </Card>

          <Card title="الشركات القانونية والمقابل المالي" subtitle="هذا الشهر. شريحة المقابل المالي حسب عدد السعوديين مقابل الوافدين في الكيان (وليس لون النطاق). النسبة الخام ليست نسبة نطاقات الموزونة؛ المرجع منصة قوى.">
            {data.legalCompanies.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-[12.5px]">
                  <caption className="sr-only">الشركات القانونية وشرائح المقابل المالي</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th scope="col" className="py-2 text-right font-black">الشركة</th>
                      <th scope="col" className="py-2 text-right font-black">الموظفون</th>
                      <th scope="col" className="py-2 text-right font-black">سعودي</th>
                      <th scope="col" className="py-2 text-right font-black">خليجي</th>
                      <th scope="col" className="py-2 text-right font-black">وافد</th>
                      <th scope="col" className="py-2 text-right font-black">شريحة 700</th>
                      <th scope="col" className="py-2 text-right font-black">شريحة 800</th>
                      <th scope="col" className="py-2 text-right font-black">معفى</th>
                      <th scope="col" className="py-2 text-right font-black">صناعي</th>
                      <th scope="col" className="py-2 text-right font-black">المقابل الشهري</th>
                      <th scope="col" className="py-2 text-right font-black">النسبة الخام</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.legalCompanies.map((c) => (
                      <tr key={c.companyId} className="border-b border-slate-100 font-bold text-slate-700">
                        <th scope="row" className="py-2 text-right font-black text-slate-800">{c.name}</th>
                        <td className="py-2"><Num value={c.headcount} /></td>
                        <td className="py-2"><Num value={c.saudi} /></td>
                        <td className="py-2"><Num value={c.gcc} /></td>
                        <td className="py-2"><Num value={c.expat} /></td>
                        <td className="py-2"><Num value={c.within} /></td>
                        <td className="py-2"><Num value={c.above} /></td>
                        <td className="py-2"><Num value={c.exempt} /></td>
                        <td className="py-2">{c.industrialZero ? 'معفى' : c.isIndustrialLicensed ? 'مرخّص' : '—'}</td>
                        <td className="py-2"><Money value={c.monthlyLevy} /></td>
                        <td className="py-2">{c.rawSaudiRatioPct === null ? '—' : <span dir="ltr">{c.rawSaudiRatioPct}%</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyBlock text="لا توجد شركات قانونية" />
            )}
          </Card>
          <SaudizationSummaryCard />
        </div>
      )}
    </WfPage>
  );
}

"use client";

// «نظرة عامة» of the decision engine. Answers three questions first, in plain words: how much the workforce
// costs, where each legal company stands in Nitaqat, and what needs attention (data to fix, contracts to
// document, regulatory changes coming). Then the decisions the engine helps with, and the cost details
// (composition, monthly series, by structure, expat levy) folded below.
// Data: GET /api/workforce/overview, /api/workforce/saudization?summary=1, /api/workforce/plans?summary=1.
import React, { useState } from 'react';
import Link from 'next/link';
import { Calculator, ChevronDown, ClipboardList, Gauge, Info, Save, ShieldCheck, UserMinus, UserPlus, type LucideIcon } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { OverviewResponse } from '@/app/api/workforce/_lib/views';
import { FLAG_TITLES, HORIZONS, SCENARIOS, SCENARIO_LABELS, formatRuleValue, type Horizon } from '@/app/api/workforce/_lib/shared';
import type { Scenario } from '@/lib/workforce/types';
import { companySettingsHref } from '@/lib/workforce/company-settings';
import type { NitaqatBand } from '@/lib/workforce/nitaqat';
import { callApi, useApi } from './_components/api';
import { Card, CompositionBars, EmptyBlock, ErrorBlock, ExportMenu, LoadingBlock, Money, Num, SCENARIO_FIELD_HINT, SCENARIO_FIELD_LABEL, Segmented, SeriesChart, WfPage, buttonClass } from './_components/ui';
import { BandBadge } from './_components/nitaqat-ui';

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

interface PlansSummary {
  counts: Record<string, number>;
  labels: Record<string, string>;
  latestApproved: { id: string; name: string; fromMonth: string; months: number; decidedAt: string | null } | null;
}

// ---------------------------------------------------------------------------
// Headline figures
// ---------------------------------------------------------------------------

function Headline({ title, children, foot }: { title: string; children: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-5 shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
      <h2 className="text-[13px] font-black text-slate-500">{title}</h2>
      <div className="mt-2 text-[24px] sm:text-[28px] font-black text-slate-900 leading-tight">{children}</div>
      {foot && <div className="mt-2 text-[12px] font-bold text-slate-500 leading-relaxed">{foot}</div>}
    </div>
  );
}

function NationalityBar({ saudi, gcc, expat }: { saudi: number; gcc: number; expat: number }) {
  const total = Math.max(1, saudi + gcc + expat);
  const parts = [
    { key: 'saudi', label: 'سعودي', n: saudi, cls: 'bg-emerald-500' },
    { key: 'gcc', label: 'خليجي', n: gcc, cls: 'bg-sky-400' },
    { key: 'expat', label: 'وافد', n: expat, cls: 'bg-amber-400' },
  ];
  return (
    <div className="mt-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        {parts.map((p) => (p.n ? <div key={p.key} className={p.cls} style={{ width: `${(p.n / total) * 100}%` }} /> : null))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] font-bold text-slate-600">
        {parts.map((p) => (
          <li key={p.key} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${p.cls}`} aria-hidden="true" />
            {p.label} <Num value={p.n} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// «يحتاج انتباهك»
// ---------------------------------------------------------------------------

type Tone = 'red' | 'amber' | 'slate';
interface Attention {
  key: string;
  tone: Tone;
  title: string;
  detail: string;
  href?: string;
  action?: string;
}

const TONE_DOT: Record<Tone, string> = { red: 'bg-rose-500', amber: 'bg-amber-400', slate: 'bg-slate-300' };
const TONE_RANK: Record<Tone, number> = { red: 0, amber: 1, slate: 2 };

function attentionItems(data: OverviewResponse | null, sz: SaudizationSummary | null): Attention[] {
  const out: Attention[] = [];
  for (const c of sz?.companies ?? []) {
    if (c.status === 'NO_ACTIVITY') {
      out.push({ key: `act:${c.companyId}`, tone: 'amber', title: `${c.companyName}: نشاط نطاقات غير محدد`, detail: 'لا يمكن تقدير النطاق قبل اختيار النشاط.', href: c.settingsHref, action: 'اختر النشاط' });
      continue;
    }
    if (c.status === 'OK' && c.band === 'RED') {
      out.push({ key: `red:${c.companyId}`, tone: 'red', title: `${c.companyName} في النطاق الأحمر`, detail: 'اعرف أقل عدد تعيينات للخروج منه وكلفته.', href: `/workforce/saudization?companyId=${encodeURIComponent(c.companyId)}`, action: 'خطة الخروج' });
    }
    if (c.undocumentedCount > 0) {
      out.push({
        key: `qiwa:${c.companyId}`,
        tone: 'red',
        title: `${c.companyName}: ${c.undocumentedCount} عقود غير موثّقة في قوى`,
        detail: 'السعودي أو الخليجي بعقد غير موثّق لا يُحتسب في نطاقات.',
        href: `/workforce/saudization?companyId=${encodeURIComponent(c.companyId)}`,
        action: 'عرض الأسماء',
      });
    }
  }
  for (const d of data?.dataQuality ?? []) {
    const who = d.employees > 0 ? `${d.employees} موظف` : `${d.count} حالة`;
    const fix =
      d.fix === 'EMPLOYEE'
        ? { href: '/workforce/true-cost?flagged=1', action: 'عرض الموظفين' }
        : d.fix === 'COMPANY'
          ? { href: d.companies.length ? companySettingsHref(d.companies[0].id) : '/companies', action: 'إعدادات الشركة' }
          : d.fix === 'ASSUMPTIONS'
            ? { href: '/workforce/assumptions', action: 'أدخل الافتراض' }
            : d.fix === 'RULES'
              ? { href: '/workforce/rules', action: 'راجع القاعدة' }
              : {};
    out.push({ key: `dq:${d.code}`, tone: d.severity === 'ERROR' ? 'red' : d.severity === 'WARNING' ? 'amber' : 'slate', title: `${FLAG_TITLES[d.code] ?? d.code} (${who})`, detail: d.message, ...fix });
  }
  for (const e of data?.upcomingEvents ?? []) {
    const change = `${e.previousValue !== null ? `${formatRuleValue(e.previousValue, e.unit)} ← ` : ''}${formatRuleValue(e.value, e.unit)}`;
    const impact = e.estimatedMonthlyImpact === null ? '' : ` · أثره على الكلفة الشهرية نحو ${formatMoney(Math.round(e.estimatedMonthlyImpact))} ر.س`;
    out.push({ key: `ev:${e.key}`, tone: 'slate', title: `تغيير نظامي من ${formatDate(e.effectiveFrom)}: ${e.label}`, detail: `${change}${impact}`, href: '/workforce/rules', action: 'المصدر' });
  }
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}

function AttentionCard({ items, loading }: { items: Attention[]; loading: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <Card title="يحتاج انتباهك" subtitle={items.length ? `${items.length} ملاحظة، الأهم أولاً` : undefined} className="lg:col-span-3">
      {loading && !items.length ? (
        <LoadingBlock label="جارٍ الفحص…" />
      ) : !items.length ? (
        <p className="rounded-2xl bg-emerald-50 px-4 py-6 text-center text-[13px] font-black text-emerald-800">لا شيء يحتاج انتباهك الآن.</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {shown.map((a) => (
              <li key={a.key} className="flex items-start gap-3 py-3">
                <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[a.tone]}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-black text-slate-800 leading-relaxed">{a.title}</p>
                  <p className="mt-0.5 text-[12px] font-bold text-slate-500 leading-relaxed">{a.detail}</p>
                </div>
                {a.href && (
                  <Link href={a.href} className="shrink-0 whitespace-nowrap rounded-lg bg-indigo-50 px-2.5 py-1 text-[11.5px] font-black text-indigo-700 hover:bg-indigo-100">
                    {a.action ?? 'عرض'}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {items.length > 5 && (
            <button type="button" onClick={() => setAll(!all)} className="mt-2 text-[12px] font-black text-indigo-700 hover:underline">
              {all ? 'عرض أقل' : `عرض الكل (${items.length})`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Nitaqat by legal company
// ---------------------------------------------------------------------------

function SaudizationCard({ data, error, reload }: { data: SaudizationSummary | null; error: string | null; reload: () => void }) {
  return (
    <Card title="نطاقات حسب الشركة" subtitle="تقدير بأوزان قوى" className="lg:col-span-2" actions={<Link href="/workforce/saudization" className={buttonClass.link}>التفاصيل ←</Link>}>
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {!data && !error && <LoadingBlock label="جارٍ التقدير…" />}
      {data && !data.companies.length && <EmptyBlock text="لا توجد شركات قانونية" />}
      {data && data.companies.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {data.companies.map((c) => (
            <li key={c.companyId}>
              <Link href={`/workforce/saudization?companyId=${encodeURIComponent(c.companyId)}`} className="flex items-center justify-between gap-3 py-3 hover:bg-slate-50 -mx-2 px-2 rounded-xl">
                <span className="min-w-0 truncate text-[13px] font-black text-slate-800">{c.companyName}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {c.status === 'OK' ? (
                    <>
                      <span dir="ltr" className="text-[12.5px] font-black text-slate-600 tabular-nums">
                        {c.pct}%
                      </span>
                      <BandBadge band={c.band} />
                    </>
                  ) : (
                    <span className="text-[11.5px] font-bold text-slate-500">{c.status === 'NO_ACTIVITY' ? 'النشاط غير محدد' : 'لا عاملين'}</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// «ماذا تريد أن تقرر؟»
// ---------------------------------------------------------------------------

const DECISIONS: ReadonlyArray<{ href: string; icon: LucideIcon; tint: string; q: string; a: string }> = [
  { href: '/workforce/true-cost', icon: Calculator, tint: 'bg-emerald-50 text-emerald-600', q: 'كم يكلفني كل موظف فعلاً؟', a: 'الراتب مع التأمينات والرسوم ونهاية الخدمة، شهراً بشهر.' },
  { href: '/workforce/hire-scenario', icon: UserPlus, tint: 'bg-sky-50 text-sky-600', q: 'أوظّف سعودياً أم وافداً؟', a: 'قارن الخيارات بالكلفة وأثرها على نطاقات قبل التعيين.' },
  { href: '/workforce/exit-cost', icon: UserMinus, tint: 'bg-rose-50 text-rose-600', q: 'كم يكلف إنهاء خدمة موظف؟', a: 'المستحقات حسب السبب، والمخاطر، وكلفة الإحلال.' },
  { href: '/workforce/saudization', icon: ShieldCheck, tint: 'bg-green-50 text-green-700', q: 'كيف أحافظ على نطاقي أو أرفعه؟', a: 'الهامش قبل الهبوط، وأقل عدد تعيينات للنطاق الأعلى.' },
  { href: '/workforce/plans', icon: ClipboardList, tint: 'bg-violet-50 text-violet-600', q: 'ما خطة القوى العاملة للسنة القادمة؟', a: 'التعيينات والخروج والزيادات، واعتماد الخطة ومقارنتها بالفعلي.' },
];

function DecisionTiles({ plans }: { plans: PlansSummary | null }) {
  return (
    <section aria-labelledby="wf-decisions">
      <h2 id="wf-decisions" className="mb-3 text-[16px] font-black text-slate-800">
        ماذا تريد أن تقرر؟
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        {DECISIONS.map((d) => (
          <Link key={d.href} href={d.href} className="group rounded-3xl border border-slate-100 bg-white p-4 shadow-[0_10px_30px_rgba(0,0,0,0.02)] transition hover:border-indigo-200 hover:shadow-md">
            <span className={`inline-flex rounded-xl p-2 ${d.tint}`} aria-hidden="true">
              <d.icon size={20} />
            </span>
            <p className="mt-3 text-[14px] font-black text-slate-800 leading-snug group-hover:text-indigo-700">{d.q}</p>
            <p className="mt-1 text-[12px] font-bold text-slate-500 leading-relaxed">{d.a}</p>
            {d.href === '/workforce/plans' && plans && (
              <p className="mt-2 text-[11.5px] font-black text-violet-700">{plans.latestApproved ? `المعتمدة: ${plans.latestApproved.name}` : 'لا توجد خطة معتمدة بعد'}</p>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cost details (folded)
// ---------------------------------------------------------------------------

type GroupTab = 'company' | 'branch' | 'department';

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
            <th scope="col" className="py-2 text-right font-black">{`خلال ${horizon} شهراً`}</th>
            <th scope="col" className="py-2 text-right font-black">بعد دعم هدف</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id || 'none'} className="border-b border-slate-100 font-bold text-slate-700">
              <th scope="row" className="py-2 text-right font-black text-slate-800">{r.name}</th>
              <td className="py-2"><Num value={r.headcount} /></td>
              <td className="py-2"><Money value={r.month1.cost} round /></td>
              <td className="py-2"><Money value={r.window.cost} round /></td>
              <td className="py-2"><Money value={r.window.net} round /></td>
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

function LevyTable({ rows }: { rows: OverviewResponse['legalCompanies'] }) {
  if (!rows.length) return <EmptyBlock text="لا توجد شركات قانونية" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-[12.5px]">
        <caption className="sr-only">المقابل المالي على الوافدين لكل شركة قانونية هذا الشهر</caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th scope="col" className="py-2 text-right font-black">الشركة</th>
            <th scope="col" className="py-2 text-right font-black">سعودي</th>
            <th scope="col" className="py-2 text-right font-black">خليجي</th>
            <th scope="col" className="py-2 text-right font-black">وافد</th>
            <th scope="col" className="py-2 text-right font-black">وافدون بمقابل 700 ر.س</th>
            <th scope="col" className="py-2 text-right font-black">وافدون بمقابل 800 ر.س</th>
            <th scope="col" className="py-2 text-right font-black">معفَون</th>
            <th scope="col" className="py-2 text-right font-black">المقابل المالي الشهري</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.companyId} className="border-b border-slate-100 font-bold text-slate-700">
              <th scope="row" className="py-2 text-right font-black text-slate-800">
                {c.name}
                {(c.industrialZero || c.isIndustrialLicensed) && <span className="mr-1.5 text-[11px] font-bold text-slate-400">(صناعي{c.industrialZero ? '، معفى' : ''})</span>}
              </th>
              <td className="py-2"><Num value={c.saudi} /></td>
              <td className="py-2"><Num value={c.gcc} /></td>
              <td className="py-2"><Num value={c.expat} /></td>
              <td className="py-2"><Num value={c.within} /></td>
              <td className="py-2"><Num value={c.above} /></td>
              <td className="py-2"><Num value={c.exempt} /></td>
              <td className="py-2"><Money value={c.monthlyLevy} round /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostDetails({ data, horizon, setHorizon, scenario, setScenario }: { data: OverviewResponse; horizon: Horizon; setHorizon: (h: Horizon) => void; scenario: Scenario; setScenario: (s: Scenario) => void }) {
  const [groupTab, setGroupTab] = useState<GroupTab>('company');
  const [compositionView, setCompositionView] = useState<'window' | 'month'>('window');
  const groups = groupTab === 'company' ? data.byCompany : groupTab === 'branch' ? data.byBranch : data.byDepartment;
  return (
    <details className="group rounded-3xl border border-slate-100 bg-white shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-5 sm:p-6 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-black text-slate-800">تفاصيل الكلفة</h2>
          <p className="mt-1 text-[12px] font-bold text-slate-500">مما تتكون الكلفة، وتطورها شهرياً، وتوزيعها على الشركات والفروع والإدارات، والمقابل المالي على الوافدين.</p>
        </div>
        <ChevronDown size={20} className="shrink-0 text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-6 border-t border-slate-100 p-4 sm:p-6">
        <div className="flex flex-wrap items-end gap-4">
          <Segmented label="المدة" value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: h, label: `${h} شهراً` }))} />
          <div>
            <Segmented label={SCENARIO_FIELD_LABEL} value={scenario} onChange={setScenario} options={SCENARIOS.map((s) => ({ value: s, label: SCENARIO_LABELS[s] }))} />
          </div>
          <p className="flex items-center gap-1.5 pb-2 text-[11.5px] font-bold text-slate-400">
            <Info size={13} aria-hidden="true" /> {SCENARIO_FIELD_HINT}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <h3 className="text-[14px] font-black text-slate-700">مما تتكون الكلفة</h3>
              <Segmented
                label="الفترة"
                value={compositionView}
                onChange={setCompositionView}
                options={[
                  { value: 'window', label: `${data.horizon} شهراً` },
                  { value: 'month', label: 'هذا الشهر' },
                ]}
              />
            </div>
            {data.composition.length ? (
              <CompositionBars items={data.composition.map((c) => ({ key: c.key, label: c.label, kind: c.kind, amount: compositionView === 'window' ? c.amount : c.month1 }))} />
            ) : (
              <EmptyBlock text="لا توجد بنود" />
            )}
          </div>
          <div className="lg:col-span-2">
            <h3 className="mb-3 text-[14px] font-black text-slate-700">الكلفة شهراً بشهر (36 شهراً)</h3>
            <SeriesChart series={data.series} title="الكلفة الشهرية للمنشأة" />
          </div>
        </div>

        <div>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h3 className="text-[14px] font-black text-slate-700">التوزيع</h3>
            <Segmented
              label="حسب"
              value={groupTab}
              onChange={setGroupTab}
              options={[
                { value: 'company', label: 'الشركة' },
                { value: 'branch', label: 'الفرع' },
                { value: 'department', label: 'الإدارة' },
              ]}
            />
          </div>
          <GroupTable rows={groups} horizon={data.horizon} label={groupTab === 'company' ? 'الشركة القانونية' : groupTab === 'branch' ? 'الفرع' : 'الإدارة'} />
        </div>

        <div>
          <h3 className="text-[14px] font-black text-slate-700">المقابل المالي على الوافدين هذا الشهر</h3>
          <p className="mb-3 mt-1 text-[12px] font-bold text-slate-500">يُحدَّد المبلغ لكل وافد بعدد السعوديين مقابل الوافدين في الشركة القانونية، وليس بلون النطاق.</p>
          <LevyTable rows={data.legalCompanies} />
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkforceOverviewPage() {
  const [horizon, setHorizon] = useState<Horizon>(36);
  const [scenario, setScenario] = useState<Scenario>('base');
  const [saving, setSaving] = useState(false);
  const { data, error, loading, reload } = useApi<OverviewResponse>(`/api/workforce/overview?months=${horizon}&scenario=${scenario}`);
  const sz = useApi<SaudizationSummary>('/api/workforce/saudization?summary=1');
  const plans = useApi<PlansSummary>('/api/workforce/plans?summary=1');

  const save = async () => {
    setSaving(true);
    const res = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'OVERVIEW', params: { months: horizon, scenario } } });
    setSaving(false);
    if (res.ok) toast.success('حُفظ الحساب مع نسخة المحرك ونسخ القواعد');
    else toast.error(res.message);
  };

  const k = data?.kpis;
  const items = attentionItems(data, sz.data);

  return (
    <WfPage
      current="/workforce"
      icon={<Gauge size={24} />}
      title="محرك القرارات"
      subtitle="كم تكلفك القوى العاملة، وأين تقف في نطاقات، وما يحتاج قراراً منك."
      help={
        <>
          <p>الكلفة هنا كلفة صاحب العمل: الراتب والبدلات، وحصة المنشأة في التأمينات، ومخصص نهاية الخدمة، ورسوم الوافدين والمقابل المالي، والتأمين الطبي.</p>
          <p>دعم هدف (صندوق تنمية الموارد البشرية) يظهر منفصلاً لأنه مشروط بقبول طلب الدعم، فالرقم الرئيسي قبل الدعم.</p>
          <p>كل رقم في الصفحات التفصيلية عليه زر «لماذا؟» يبيّن المعادلة ومصدر كل قيمة نظامية.</p>
        </>
      }
      actions={
        <>
          <ExportMenu disabled={!data || loading} excel={{ kind: 'overview', query: { months: horizon, scenario } }} pdf={{ kind: 'true-cost', query: { months: horizon, scenario } }} />
          <button type="button" onClick={save} disabled={saving || !data} className={buttonClass.secondary} title="يحفظ الأرقام مع نسخ القواعد المستخدمة للرجوع إليها لاحقاً">
            <Save size={16} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ نسخة'}
          </button>
        </>
      }
    >
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock />}

      {data && k && (
        <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Headline
              title="كلفة القوى العاملة هذا الشهر"
              foot={
                <>
                  بعد دعم هدف المتوقع: <Money value={k.thisMonth.net} round className="text-slate-700" />
                </>
              }
            >
              <Money value={k.thisMonth.cost} round />
            </Headline>
            <Headline
              title="خلال 12 شهراً"
              foot={
                <>
                  خلال 36 شهراً: <Money value={k.next36.cost} round className="text-slate-700" />
                </>
              }
            >
              <Money value={k.next12.cost} round />
            </Headline>
            <Headline title="الموظفون" foot={<NationalityBar saudi={k.saudi} gcc={k.gcc} expat={k.expat} />}>
              <Num value={k.headcount} /> <span className="text-[14px] text-slate-400">موظف</span>
            </Headline>
            <Headline
              title="مكافأة نهاية الخدمة المتراكمة"
              foot={
                <>
                  لو استقال الجميع اليوم: <Money value={k.eosbLiabilityResignation} round className="text-slate-700" />
                </>
              }
            >
              <Money value={k.eosbLiabilityEmployer} round />
            </Headline>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            <AttentionCard items={items} loading={sz.loading} />
            <SaudizationCard data={sz.data} error={sz.error} reload={sz.reload} />
          </div>

          <DecisionTiles plans={plans.data} />

          <CostDetails data={data} horizon={horizon} setHorizon={setHorizon} scenario={scenario} setScenario={setScenario} />

        </div>
      )}
    </WfPage>
  );
}

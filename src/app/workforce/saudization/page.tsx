"use client";

// «وضع النطاقات» (section «السعودة ونطاقات»): one compact filter row, then per legal company, in this order:
// the answer (band, %, gauge with the thresholds of 2026 / 2027 / 2028), the decision (margin before the drop,
// fewest hires to the next band), the alerts (incl. contracts not documented in Qiwa), then folded: the
// «الوصول إلى نطاق» solver with ranked actions and their monthly cost, the band consequences, the weights
// breakdown and occupation localization compliance.
// Data: GET /api/workforce/saudization, POST /api/workforce/saudization/solve. Display only.
import React, { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, ChevronDown, Save, Settings, ShieldCheck, Target } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import { todayKey } from '@/lib/dates';
import type { CompanySaudization, SaudizationAlert } from '@/app/api/workforce/_lib/saudization';
import type { NitaqatBand, NitaqatEstimate, RestrictedEstimate } from '@/lib/workforce/nitaqat';
import type { ComplianceItem, SolveResult, SolverAction } from '@/lib/workforce/saudization';
import { callApi, useApi } from '../_components/api';
import { BAND_TEXT, BandBadge, BandGauge, RowStatusBadge } from '../_components/nitaqat-ui';
import { Card, EmptyBlock, ErrorBlock, ExportMenu, LoadingBlock, Money, Num, Segmented, SelectField, StatusBadge, WfPage, WhyButton, WhyDialog, buttonClass, inputClass, type WhyContent } from '../_components/ui';

interface SaudizationResponse {
  date: string;
  disclaimer: string;
  canSeeNames: boolean;
  activitiesCount: number;
  decisionsCount: number;
  companies: CompanySaudization[];
}

interface SolveResponse {
  result: SolveResult;
  companyName: string;
  disclaimer: string;
  settingsHref: string;
}

const TARGETS: NitaqatBand[] = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'];
const SEVERITY_STYLE: Record<SaudizationAlert['severity'], string> = {
  ERROR: 'border-rose-200 bg-rose-50 text-rose-800',
  WARNING: 'border-amber-200 bg-amber-50 text-amber-900',
  INFO: 'border-sky-200 bg-sky-50 text-sky-900',
};
const ACTION_TEXT: Record<SolverAction['kind'], string> = { DOCUMENT: 'توثيق عقد في قوى', RAISE: 'رفع الأجر إلى 4,000', HIRE: 'توظيف سعودي', REPLACE: 'إحلال سعودي محل وافد' };

function isRestricted(e: NitaqatEstimate | RestrictedEstimate): e is RestrictedEstimate {
  return 'restricted' in e && e.restricted === true;
}

/** A folded detail block of a company card (closed by default). */
function Fold({ title, open, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-slate-100" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13.5px] font-black text-slate-800 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={15} className="mr-auto text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-slate-100 p-3 space-y-3">{children}</div>
    </details>
  );
}

/** One decision figure of a company: a big number and one plain line under it. */
function Decision({ title, figure, children }: { title: string; figure: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3">
      <p className="text-[12px] font-black text-slate-500">{title}</p>
      <p className="mt-1 text-[20px] font-black text-slate-900 leading-tight">{figure}</p>
      <p className="mt-1 text-[12.5px] font-bold text-slate-600 leading-relaxed">{children}</p>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <p className="text-[11px] font-black text-slate-500">{label}</p>
      <div className="mt-1 text-[16px] font-black text-slate-900">{children}</div>
    </div>
  );
}

function Alerts({ alerts }: { alerts: SaudizationAlert[] }) {
  if (!alerts.length) return null;
  return (
    <ul className="space-y-2" aria-label="تنبيهات">
      {alerts.map((a, i) => (
        <li key={`${a.code}-${i}`} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] font-bold ${SEVERITY_STYLE[a.severity]}`}>
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">{a.message}</span>
          {a.href && (
            <Link href={a.href} className="shrink-0 underline">
              إصلاح
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function ComplianceTable({ items, canSeeNames }: { items: ComplianceItem[]; canSeeNames: boolean }) {
  const relevant = items.filter((i) => i.total > 0);
  const others = items.length - relevant.length;
  if (!items.length) return <EmptyBlock text="لا توجد قرارات توطين سارية أو قادمة في السجل." />;
  return (
    <div className="space-y-3">
      {relevant.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12.5px]">
            <caption className="sr-only">التزام قرارات توطين المهن</caption>
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th scope="col" className="py-2 text-right font-black">القرار</th>
                <th scope="col" className="py-2 text-right font-black">العاملون في المهن</th>
                <th scope="col" className="py-2 text-right font-black">السعوديون المحتسبون</th>
                <th scope="col" className="py-2 text-right font-black">الحالي / المطلوب</th>
                <th scope="col" className="py-2 text-right font-black">النقص</th>
                <th scope="col" className="py-2 text-right font-black">المراحل القادمة</th>
              </tr>
            </thead>
            <tbody>
              {relevant.map((it) => (
                <tr key={it.decisionId} className="border-b border-slate-100 align-top font-bold text-slate-700">
                  <th scope="row" className="py-2 text-right">
                    <span className="block font-black text-slate-800">{it.groupNameAr}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <RowStatusBadge status={it.status} />
                      {it.minWage !== null ? <span className="text-[11px] text-slate-500">حد الأجر {it.minWage}</span> : <span className="text-[11px] text-amber-700">حد الأجر غير معروف</span>}
                    </span>
                    {!it.applies && it.appliesReason && <span className="mt-1 block text-[11px] text-slate-500">{it.appliesReason}</span>}
                    {it.variants.length > 0 && <span className="mt-1 block text-[11px] text-slate-500">{`نسب أخرى حسب النشاط: ${it.variants.map((v) => `${v.pct}% ${v.activity ?? ''}`).join('، ')}`}</span>}
                  </th>
                  <td className="py-2"><Num value={it.total} /></td>
                  <td className="py-2">
                    <Num value={it.saudisCounted} />
                    {(it.saudisBelowMinWage > 0 || it.saudisUndocumented > 0) && (
                      <span className="block text-[11px] text-slate-500">{`${it.saudisBelowMinWage} دون حد الأجر، ${it.saudisUndocumented} غير موثّق`}</span>
                    )}
                  </td>
                  <td className="py-2">
                    <span dir="ltr">{it.actualPct ?? 0}%</span> / <span dir="ltr">{it.requiredPct ?? '—'}%</span>
                    {it.compliant === true && <span className="mr-1 text-green-700">ملتزم</span>}
                    {it.compliant === false && <span className="mr-1 text-rose-700">غير ملتزم</span>}
                    {it.requiredText && <span className="block text-[11px] text-slate-500">{`${it.requiredText}؛ المحتسبون ${it.saudisCounted}`}</span>}
                  </td>
                  <td className="py-2">
                    {it.applies && it.compliant === false ? (
                      <span>{`${it.shortfallReplacements} إحلالاً${it.shortfallHires !== null ? ` أو ${it.shortfallHires} تعييناً` : ''}`}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 text-[11.5px]">{it.upcoming.length ? it.upcoming.map((u) => `${u.pct}% من ${u.effectiveFrom}`).join('، ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canSeeNames &&
            relevant.map((it) => (
              <details key={`d-${it.decisionId}`} className="mt-2 text-[12px] font-bold text-slate-600">
                <summary className="cursor-pointer text-indigo-700">{`الموظفون في ${it.groupNameAr} (${it.employees.length})`}</summary>
                <ul className="mt-1 space-y-0.5">
                  {it.employees.map((e) => (
                    <li key={e.id}>
                      {e.name} — {e.occupation} — {e.isSaudi ? (e.counted ? 'سعودي محتسب' : `سعودي غير محتسب: ${e.reason}`) : 'غير سعودي'}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
        </div>
      ) : (
        <p className="text-[12px] font-bold text-slate-500">لا يعمل في الشركة أحد في المهن المشمولة بقرارات التوطين المسجلة.</p>
      )}
      {others > 0 && <p className="text-[11.5px] font-bold text-slate-400">{`${others} قرار لا تنطبق مهنه على موظفي الشركة.`}</p>}
    </div>
  );
}

function SolverPanel({ c, date }: { c: CompanySaudization; date: string }) {
  const e = c.estimate;
  const defaultTarget: NitaqatBand = e.margin.up?.band ?? 'MEDIUM_GREEN';
  const [target, setTarget] = useState<NitaqatBand>(defaultTarget === 'RED' ? 'LOW_GREEN' : defaultTarget);
  const [byDate, setByDate] = useState(date);
  const [documentFirst, setDocumentFirst] = useState(true);
  const [raiseHalf, setRaiseHalf] = useState(true);
  const [replace, setReplace] = useState(false);
  const [hireBasic, setHireBasic] = useState('4000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<SolveResponse | null>(null);
  const [solveBody, setSolveBody] = useState<unknown>(null);

  const run = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const json = { companyId: c.companyId, targetBand: target, byDate, options: { documentFirst, raiseHalfWeight: raiseHalf, replaceExpats: replace, hireBasic } };
    setSolveBody(json);
    const r = await callApi<SolveResponse>('/api/workforce/saudization/solve', { json });
    setBusy(false);
    if (r.ok) setRes(r.data);
    else {
      setRes(null);
      setError(r.message);
    }
  };
  const r = res?.result;
  return (
    <div className="space-y-3">
      <form onSubmit={run} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <SelectField label="النطاق المستهدف" value={target} onChange={(v) => setTarget(v as NitaqatBand)} options={TARGETS.map((b) => ({ value: b, label: BAND_TEXT[b] }))} />
        <div>
          <label htmlFor={`by-${c.companyId}`} className="block text-[12px] font-extrabold text-slate-600 mb-1.5">بحلول تاريخ</label>
          <input id={`by-${c.companyId}`} type="date" className={inputClass} value={byDate} onChange={(ev) => setByDate(ev.target.value)} />
        </div>
        <div>
          <label htmlFor={`hb-${c.companyId}`} className="block text-[12px] font-extrabold text-slate-600 mb-1.5">أجر التعيين المفترض (أساسي)</label>
          <input id={`hb-${c.companyId}`} inputMode="decimal" className={inputClass} value={hireBasic} onChange={(ev) => setHireBasic(ev.target.value)} />
        </div>
        <button type="submit" disabled={busy} className={buttonClass.primary}>
          <Target size={15} aria-hidden="true" /> {busy ? 'جارٍ الحساب…' : 'احسب أقل عدد تعيينات'}
        </button>
        <fieldset className="sm:col-span-2 lg:col-span-4 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] font-bold text-slate-700">
          <legend className="sr-only">خيارات الحل</legend>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={documentFirst} onChange={(ev) => setDocumentFirst(ev.target.checked)} /> توثيق العقود غير الموثّقة أولاً (دون كلفة)</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={raiseHalf} onChange={(ev) => setRaiseHalf(ev.target.checked)} /> رفع أجور 3,000–3,999 إلى 4,000</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={replace} onChange={(ev) => setReplace(ev.target.checked)} /> بديل: إحلال سعوديين محل وافدين</label>
        </fieldset>
      </form>
      {error && <ErrorBlock message={error} />}
      {r && (
        <div className="space-y-3 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-3">
          <div className="flex justify-end">
            <ExportMenu
              disabled={busy}
              label="تصدير الحل"
              excel={{ kind: 'saudization', query: { date }, body: solveBody, label: 'ملف Excel مع الحل' }}
              pdf={{ kind: 'saudization', query: { date }, body: solveBody, label: 'تقرير PDF مع الحل' }}
            />
          </div>
          {r.status === 'ALREADY_REACHED' || r.status === 'NO_ACTIVITY' || r.status === 'NO_EMPLOYEES' || r.status === 'UNREACHABLE' ? (
            <p className="text-[13px] font-black text-slate-800">{r.message}</p>
          ) : (
            <p className="text-[13px] font-black text-slate-800">
              {`من ${BAND_TEXT[r.before!.band]} (${r.before!.pct}%) إلى ${BAND_TEXT[r.after!.band]} (${r.after!.pct}%) في ${r.byDate}: `}
              {`${r.hires} تعيين سعودي`}
              {r.documentations ? `، ${r.documentations} توثيق` : ''}
              {r.raises ? `، ${r.raises} رفع أجر` : ''}
            </p>
          )}
          {r.actions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[12.5px]">
                <caption className="sr-only">الإجراءات مرتبة</caption>
                <thead>
                  <tr className="border-b border-indigo-100 text-slate-500">
                    <th scope="col" className="py-2 text-right font-black">#</th>
                    <th scope="col" className="py-2 text-right font-black">الإجراء</th>
                    <th scope="col" className="py-2 text-right font-black">الأثر</th>
                    <th scope="col" className="py-2 text-right font-black">بعده</th>
                    <th scope="col" className="py-2 text-right font-black">كلفة الشهر الأول</th>
                    <th scope="col" className="py-2 text-right font-black">متوسط شهري بعد الدعم</th>
                  </tr>
                </thead>
                <tbody>
                  {r.actions.map((a) => (
                    <tr key={`${a.kind}-${a.rank}`} className="border-b border-indigo-50 font-bold text-slate-700 align-top">
                      <td className="py-2"><Num value={a.rank} /></td>
                      <td className="py-2">
                        <span className="block font-black text-slate-800">{a.count > 1 ? `${ACTION_TEXT[a.kind]} × ${a.count}` : ACTION_TEXT[a.kind]}</span>
                        {a.name && <span className="block text-[11.5px] text-slate-500">{a.name}</span>}
                        {a.note && <span className="block text-[11px] text-slate-400">{a.note}</span>}
                      </td>
                      <td className="py-2" dir="ltr">{a.weightGain === null ? '—' : `+${a.weightGain}`}</td>
                      <td className="py-2">{a.bandAfter === null || a.pctAfter === null ? '—' : <><BandBadge band={a.bandAfter} /> <span dir="ltr">{a.pctAfter}%</span></>}</td>
                      <td className="py-2">{a.monthlyCost === null ? '—' : <Money value={a.monthlyCost} />}</td>
                      <td className="py-2">{a.monthlyNetAvg === null ? '—' : <Money value={a.monthlyNetAvg} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[12px] font-black text-slate-800">
                المجموع: <Money value={r.totals.monthlyCost} /> في الشهر الأول، و<Money value={r.totals.monthlyNetAvg} /> شهرياً في المتوسط خلال {r.costHorizonMonths} شهراً بعد دعم هدف.
              </p>
              {r.raises > 0 && <p className="mt-1 text-[11px] font-bold text-slate-500">رفع الأجر: فرق الكلفة فقط، دون أي تغيير في دعم هدف (أهلية الدعم تُقرَّر بأجر فترة التقديم، الشهر 4–6 من المباشرة).</p>}
            </div>
          )}
          {r.alternative && (
            <div className="rounded-xl bg-white p-3 text-[12.5px] font-bold text-slate-700">
              <p className="font-black text-slate-800">
                {r.alternative.replacements === null ? 'الإحلال وحده لا يكفي' : `البديل: إحلال ${r.alternative.replacements} سعودي محل وافد`}
              </p>
              {r.alternative.replacements !== null && (
                <p className="mt-1">
                  الفرق الشهري بعد الدعم <Money value={r.alternative.totals.monthlyNetAvg} />، ومكافآت نهاية خدمة لمرة واحدة <Money value={r.alternative.totals.oneOffCost} />.
                </p>
              )}
              <ul className="mt-1 text-[11.5px] text-slate-500">
                {r.alternative.actions.map((a) => (
                  <li key={a.rank}>{a.bandAfter === null || a.pctAfter === null ? `${a.rank}. ${a.name ?? 'وافد'}` : `${a.rank}. ${a.name ?? 'وافد'} → ${BAND_TEXT[a.bandAfter]} (${a.pctAfter}%)`}</li>
                ))}
              </ul>
            </div>
          )}
          <ul className="text-[11px] font-bold text-slate-500 list-disc pr-5 space-y-0.5">
            {r.assumptions.slice(-4).map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CompanyCard({ c, year, date }: { c: CompanySaudization; year: number; date: string }) {
  const e = c.estimate;
  const [why, setWhy] = useState<WhyContent | null>(null);
  const [saving, setSaving] = useState(false);
  const restricted = isRestricted(e);
  const yearRow = e.thresholdsByYear.find((y) => y.year === year) ?? null;
  const gaugeThresholds = yearRow ? yearRow.thresholds : e.thresholds.map((t) => ({ band: t.band, y: t.y }));
  const yearBand = yearRow?.band ?? e.band;

  const save = async () => {
    setSaving(true);
    const r = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'SAUDIZATION', params: { companyId: c.companyId, date } } });
    setSaving(false);
    if (r.ok) toast.success('حُفظ الحساب. تجده في «الحسابات المحفوظة».');
    else toast.error(r.message);
  };

  const openWhy = () =>
    setWhy({
      title: `نطاق ${c.companyName}`,
      basis: `نسبة التوطين = ${e.counts.saudiWeighted} ÷ (${e.counts.saudiWeighted} + ${e.counts.expats}) × 100 = ${e.pct}%، وX = ${e.counts.x}. ${e.thresholds.map((t) => `${BAND_TEXT[t.band]}: ${t.m} × ln(${e.counts.x}) + ${t.c} = ${t.y}%`).join('؛ ')}`,
      formulaText: 'Y = m·ln(X) + c لكل نطاق بثوابت النشاط والسنة؛ الكيان بخمسة عمال فأقل: سعودي واحد يكفي للأخضر المنخفض (موثّق: الحاسبة وقوى)، واشتراط أن يُحتسب بوزن 1 (أجر 4,000 فأكثر) تفسير مؤقت.',
      note: e.assumptions.join(' · '),
      status: e.overallStatus,
      evidence: e.evidence,
    });

  const undocumentedShown = e.counts.undocumented > 0 || (!restricted && e.undocumented.length > 0);
  const complianceCount = c.compliance.items.filter((i) => i.total > 0).length;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-black text-slate-900">{c.companyName}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] font-bold text-slate-500">
            {e.activity ? (
              <>
                <span>{`النشاط: ${e.activity.nameAr}${e.activity.code ? ` (${e.activity.code})` : ''}`}</span>
                <RowStatusBadge status={e.activity.status} />
              </>
            ) : (
              <span className="text-amber-700">لم يُحدَّد نشاط نطاقات</span>
            )}
            {c.activityText && !e.activity && <span className="text-slate-400">{`(النص السابق: ${c.activityText})`}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={c.settingsHref} className={buttonClass.secondary}>
            <Settings size={14} aria-hidden="true" /> النشاط
          </Link>
          <button type="button" onClick={save} disabled={saving || e.status !== 'OK'} className={buttonClass.secondary} title="يحفظ التقدير مع نسخ القواعد المستخدمة للرجوع إليه لاحقاً">
            <Save size={14} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ نسخة'}
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {/* 1. The answer: band, %, gauge. */}
        {e.status !== 'OK' ? (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-[12.5px] font-bold text-slate-600">
            {e.message}{' '}
            {e.status === 'NO_ACTIVITY' && (
              <Link href={c.settingsHref} className="text-indigo-700 underline">
                اختر النشاط من إعدادات الشركة
              </Link>
            )}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <BandBadge band={yearBand} className="text-[14px] px-3 py-1" />
              <span className="text-[26px] font-black text-slate-900" dir="ltr">{e.pct}%</span>
              <WhyButton onClick={openWhy} label={`نطاق ${c.companyName}`} />
              <StatusBadge status={e.overallStatus} />
              {e.average26w && (
                <span className="text-[12px] font-bold text-slate-500">
                  {'متوسط 26 أسبوعاً (تعتمده قوى): '}
                  <span dir="ltr">{e.average26w.pct}%</span>
                </span>
              )}
              {year !== e.year && <span className="text-[11.5px] font-bold text-slate-500">{`بثوابت ${year} وبالعمالة الحالية (التقدير الأساسي ${e.year}: ${e.band ? BAND_TEXT[e.band] : '—'})`}</span>}
            </div>
            {!e.smallEntity && <BandGauge pct={e.pct} thresholds={gaugeThresholds} label={`نسبة التوطين وحدود النطاقات ${year}`} />}
            {e.smallEntity && <p className="text-[12px] font-bold text-slate-500">الكيان بخمسة عمال فأقل: أخضر منخفض بسعودي واحد محتسب، وإلا أحمر.</p>}

            {/* 2. The decision: how far from dropping, how many hires to go up. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Decision
                title="الهامش قبل الهبوط"
                figure={e.margin.down ? (e.margin.down.pctCushion !== null ? <><span dir="ltr">{e.margin.down.pctCushion}</span> نقطة</> : `خروج ${e.margin.down.saudiExitsBeforeDrop} سعودي`) : 'لا يوجد'}
              >
                {e.margin.down
                  ? `قبل الهبوط إلى ${BAND_TEXT[e.margin.down.band]}: يتحمل ${e.margin.down.expatsBeforeDrop ?? 'أكثر من 5000'} وافداً إضافياً أو خروج ${e.margin.down.saudiExitsBeforeDrop} سعودي.`
                  : 'في النطاق الأحمر.'}
              </Decision>
              <Decision
                title="أقل عدد تعيينات للنطاق الأعلى"
                figure={e.margin.up ? (e.margin.up.saudiHires !== null ? <><Num value={e.margin.up.saudiHires} /> تعيين سعودي</> : 'غير ممكن ضمن حد البحث') : '—'}
              >
                {e.margin.up
                  ? `للوصول إلى ${BAND_TEXT[e.margin.up.band]}${e.margin.up.pctGap !== null ? ` (ينقص ${e.margin.up.pctGap} نقطة)` : ''}، بتعيين سعوديين بوزن كامل (أجر 4,000 فأكثر). الخطة وكلفتها في «الوصول إلى نطاق» أدناه.`
                  : 'في أعلى نطاق متاح.'}
              </Decision>
            </div>
          </>
        )}

        {/* 3. Alerts. */}
        <Alerts alerts={c.alerts} />
        {undocumentedShown && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-[12.5px] font-bold text-rose-900">
            <p className="font-black">{`عقود غير موثّقة في قوى: ${e.counts.undocumented}`}</p>
            <p className="mt-1">لا تُحتسب في نطاقات منذ 15 أبريل 2026. توثيقها إجراء دون كلفة.</p>
            {!restricted && e.undocumented.length > 0 && (
              <details className="group mt-2">
                <summary className="cursor-pointer list-none text-[12px] font-black text-rose-800 underline [&::-webkit-details-marker]:hidden">
                  <span className="group-open:hidden">{`عرض الأسماء (${e.undocumented.length})`}</span>
                  <span className="hidden group-open:inline">إخفاء الأسماء</span>
                </summary>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {e.undocumented.map((u) => (
                    <li key={u.id}>
                      <Link href={`/employees/${u.id}`} className="inline-block rounded-lg border border-rose-200 bg-white px-2 py-1 text-[11.5px] font-black text-rose-800 hover:bg-rose-100">
                        {u.name} <span className="font-bold text-rose-500">{`+${u.potentialWeight}`}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {restricted && <p className="mt-1 text-[11.5px]">الأسماء متاحة لمدير الموارد البشرية وصاحب العمل.</p>}
          </div>
        )}

        {/* 4. Detail, folded. */}
        {e.status === 'OK' && (
          <Fold title="الوصول إلى نطاق: الإجراءات وكلفتها" open={e.band === 'RED'}>
            <SolverPanel c={c} date={date} />
          </Fold>
        )}

        {e.consequences && (
          <Fold title={`ماذا يعني ${e.band ? BAND_TEXT[e.band] : 'النطاق'}؟`}>
            <ul className="list-disc pr-5 space-y-0.5 text-[12.5px] font-bold text-slate-700">
              {e.consequences.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            {e.consequences.conflict && <p className="rounded-lg bg-rose-50 px-2 py-1 text-[12.5px] font-bold text-rose-800">{e.consequences.conflict}</p>}
          </Fold>
        )}

        {(e.status === 'OK' || e.breakdown.length > 0 || e.flags.length > 0) && (
          <Fold title="تفاصيل الاحتساب">
            {e.status === 'OK' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Stat label="العاملون المحتسبون"><Num value={e.counts.x} /></Stat>
                <Stat label="السعوديون الموزونون"><Num value={e.counts.saudiWeighted} /></Stat>
                <Stat label="الوافدون"><Num value={e.counts.expats} /></Stat>
              </div>
            )}
            {e.breakdown.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-[12.5px]">
                  <caption className="text-right text-[13px] font-black text-slate-800 mb-2">فئات الاحتساب</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th scope="col" className="py-2 text-right font-black">الفئة</th>
                      <th scope="col" className="py-2 text-right font-black">العدد</th>
                      <th scope="col" className="py-2 text-right font-black">المحتسب</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.breakdown.map((b) => (
                      <tr key={b.weightClass} className="border-b border-slate-100 font-bold text-slate-700">
                        <th scope="row" className="py-1.5 text-right font-bold">{b.label}</th>
                        <td className="py-1.5"><Num value={b.persons} /></td>
                        <td className="py-1.5"><Num value={b.weight} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {restricted && <p className="mt-1 text-[11.5px] font-bold text-slate-500">السعوديون والخليجيون في سطر واحد؛ تفصيل الفئات (ومنها الفئات المرجّحة الخاصة) لمدير الموارد البشرية وصاحب العمل.</p>}
              </div>
            )}
            {e.flags.length > 0 && (
              <div className="text-[12px] font-bold text-slate-600">
                <p className="font-black text-slate-700">{`ملاحظات الحساب (${e.flags.length})`}</p>
                <ul className="mt-1 space-y-1">
                  {e.flags.map((f, i) => (
                    <li key={`${f.code}-${i}`}>{`• ${f.message}`}</li>
                  ))}
                </ul>
              </div>
            )}
          </Fold>
        )}

        <Fold title={`قرارات توطين المهن (${complianceCount})`}>
          {c.compliance.unknownOccupation.count > 0 && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-900">{`${c.compliance.unknownOccupation.count} موظف بمهنة غير محددة: لا يمكن فحصهم مقابل قرارات التوطين.`}</p>
          )}
          <ComplianceTable items={c.compliance.items} canSeeNames={!restricted} />
        </Fold>
      </div>
      <WhyDialog content={why} onClose={() => setWhy(null)} />
    </Card>
  );
}

export default function SaudizationPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SaudizationInner />
    </Suspense>
  );
}

function SaudizationInner() {
  const params = useSearchParams();
  const [date, setDate] = useState(todayKey());
  const [companyId, setCompanyId] = useState(params.get('companyId') ?? '');
  const [year, setYear] = useState<number>(Number(todayKey().slice(0, 4)));
  const url = useMemo(() => `/api/workforce/saudization?date=${encodeURIComponent(date)}${companyId ? `&companyId=${encodeURIComponent(companyId)}` : ''}`, [date, companyId]);
  const { data, error, loading, reload } = useApi<SaudizationResponse>(url);
  const all = useApi<SaudizationResponse>('/api/workforce/saudization?summary=1');
  const companyOptions = ((all.data?.companies ?? []) as Array<{ companyId: string; companyName: string }>).map((c) => ({ value: c.companyId, label: c.companyName }));
  const years = [2026, 2027, 2028];

  return (
    <WfPage
      icon={<ShieldCheck size={24} />}
      title="وضع النطاقات"
      subtitle="أين تقف كل شركة قانونية في نطاقات، وكم يبقى قبل الهبوط، وأقل عدد تعيينات للنطاق الأعلى."
      current="/workforce/saudization"
      help={
        <>
          <p>نطاق كل شركة قانونية تقديري، بأوزان قوى وسقوفها: يُحتسب السعودي بحسب أجره المسجّل في التأمينات، ولا تُحتسب إلا عقود قوى الموثّقة منذ 15 أبريل 2026.</p>
          <p>التقدير لحظي في التاريخ المختار، وقوى تعتمد متوسط 26 أسبوعاً، ويظهر بجانب النسبة للمقارنة.</p>
          <p>«الوصول إلى نطاق» يحسب أقل عدد تعيينات للوصول إلى النطاق المستهدف، وكلفتها الشهرية بعد دعم هدف. ويظهر لكل شركة التزامها بقرارات توطين المهن.</p>
        </>
      }
      actions={<ExportMenu disabled={!data || loading} excel={{ kind: 'saudization', query: { date, companyId } }} pdf={{ kind: 'saudization', query: { date, companyId } }} />}
    >
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-44">
            <label htmlFor="sz-date" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">تاريخ التقدير</label>
            <input id="sz-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value || todayKey())} />
          </div>
          <SelectField label="الشركة القانونية" value={companyId} onChange={setCompanyId} placeholder="كل الشركات" options={companyOptions} className="w-full sm:w-64" />
          <Segmented label="حدود النطاقات لسنة" value={year} options={years.map((y) => ({ value: y, label: String(y) }))} onChange={setYear} />
        </div>
      </Card>
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock />}
      {data && !data.companies.length && <EmptyBlock text="لا توجد شركات قانونية لها موظفون أو نشاط نطاقات." />}
      {data && data.activitiesCount === 0 && <ErrorBlock message="سجل نطاقات فارغ: لا توجد أنشطة وثوابت. شغّل بذرة السجل أو أضفها من تبويب «الأنشطة وقرارات التوطين»." />}
      <div className="space-y-5">
        {data?.companies.map((c) => (
          <CompanyCard key={`${c.companyId}-${data.date}`} c={c} year={year} date={data.date} />
        ))}
      </div>
    </WfPage>
  );
}

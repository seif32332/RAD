"use client";

// «كلفة الإنهاء والإحلال»: what an exit costs before the decision, by reason: payable (EOSB, notice, leave),
// offsets (loans, notice owed by the employee), legal risk (art. 77, never in the total), sunk prepaid fees,
// replacement cost and the levy-tier effect on the rest of the legal company. POST /api/workforce/exit-cost.
import React, { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, Calculator, Save, Scale, UserMinus } from 'lucide-react';
import SearchableSelect from '@/components/SearchableSelect';
import { toast } from '@/components/ui/feedback';
import { todayKey } from '@/lib/dates';
import { TERMINATION_REASONS, TERMINATION_REASON_LABELS, type TerminationReasonValue } from '@/lib/settlement';
import { EMPLOYEE_EXIT_REASONS, EXIT_REASON_TO_TERMINATION, type EmployeeExitReason } from '@/lib/workforce/reasons';
import { EXIT_REASON_LABELS } from '@/app/api/employees/_workforce-fields';
import type { ExitLine, ExitLineKind, Scenario } from '@/lib/workforce/types';
import { SCENARIOS, SCENARIO_LABELS, evidenceForLine } from '@/app/api/workforce/_lib/shared';
import { callApi, useApi } from '../_components/api';
import type { ExitCostResponse, OptionsResponse } from '../_components/types';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Money, Num, Segmented, SelectField, StatusBadge, WfPage, WhyButton, WhyDialog, buttonClass, inputClass, type WhyContent } from '../_components/ui';

const COUNSEL_BADGE = 'مؤقت — بانتظار تأكيد المستشار';

function isCounselPending(l: ExitLine, r: ExitCostResponse): boolean {
  return l.status === 'PROVISIONAL' && (l.ruleKeys.includes('LAW:ART87') || r.flags.some((f) => f.code === 'COUNSEL_PENDING' && f.lineKey === l.key));
}

function LineList({ lines, result, onWhy, emptyText }: { lines: ExitLine[]; result: ExitCostResponse; onWhy: (l: ExitLine) => void; emptyText: string }) {
  if (!lines.length) return <p className="text-[12px] font-bold text-slate-500">{emptyText}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {lines.map((l) => (
        <li key={l.key} className="flex flex-col sm:flex-row sm:items-center gap-2 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-black text-slate-800">{l.label}</p>
            <p dir="auto" className="text-[11.5px] font-bold text-slate-500 break-words">{l.basis}</p>
            {l.note && <p className="text-[11.5px] font-bold text-slate-400">{l.note}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {isCounselPending(l, result) ? (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-black text-amber-800">{COUNSEL_BADGE}</span>
            ) : (
              <StatusBadge status={l.status} />
            )}
            <Money value={l.amount} className={`text-[13px] font-black ${l.amount < 0 ? 'text-green-700' : 'text-slate-900'}`} />
            <WhyButton onClick={() => onWhy(l)} label={l.label} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ExitCostInner() {
  const params = useSearchParams();
  const options = useApi<OptionsResponse>('/api/workforce/options');
  const [employeeId, setEmployeeId] = useState(params.get('employeeId') ?? '');
  const [exitReason, setExitReason] = useState<EmployeeExitReason>('EMPLOYER_TERMINATION');
  const [settlementReason, setSettlementReason] = useState<TerminationReasonValue | ''>('');
  const [lastWorkingDate, setLastWorkingDate] = useState(todayKey());
  const [noticeServed, setNoticeServed] = useState(false);
  const [replacement, setReplacement] = useState<'' | 'true' | 'false'>('');
  const [recruitment, setRecruitment] = useState('');
  const [vacancy, setVacancy] = useState('');
  const [scenario, setScenario] = useState<Scenario>('base');
  const [result, setResult] = useState<ExitCostResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [why, setWhy] = useState<WhyContent | null>(null);

  const mapping = EXIT_REASON_TO_TERMINATION[exitReason];
  const needsBasis = !mapping.terminationReason;
  const employeeOptions = useMemo(
    () => (options.data?.employees ?? []).map((e) => ({ value: e.id, label: e.employeeNo ? `${e.name} (${e.employeeNo})` : e.name })),
    [options.data],
  );

  const body = () => {
    const override: Record<string, number> = {};
    if (recruitment.trim() !== '') {
      if (replacement === 'false') override.recruitmentCostExpat = Number(recruitment);
      else if (replacement === 'true') override.recruitmentCostSaudi = Number(recruitment);
      else {
        override.recruitmentCostSaudi = Number(recruitment);
        override.recruitmentCostExpat = Number(recruitment);
      }
    }
    if (vacancy.trim() !== '') override.vacancyMonths = Number(vacancy);
    return {
      employeeId,
      exitReason,
      settlementReason: settlementReason || undefined,
      lastWorkingDate,
      noticeServed,
      replacementIsSaudi: replacement === '' ? undefined : replacement === 'true',
      scenario,
      ...(Object.keys(override).length ? { assumptionsOverride: override } : {}),
    };
  };

  const compute = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!employeeId) {
      setError('اختر الموظف أولاً');
      return;
    }
    if (needsBasis && !settlementReason) {
      setError('اختر أساس التسوية لهذا السبب');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await callApi<ExitCostResponse>('/api/workforce/exit-cost', { json: body() });
    setBusy(false);
    if (res.ok) setResult(res.data);
    else {
      setResult(null);
      setError(res.message);
    }
  };

  const save = async () => {
    setSaving(true);
    const res = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'EXIT_COST', params: body() } });
    setSaving(false);
    if (res.ok) toast.success('حُفظ الحساب. تجده في «الحسابات المحفوظة».');
    else toast.error(res.message);
  };

  const openWhy = (l: ExitLine) => {
    if (!result) return;
    const ex = result.explanations[l.key];
    setWhy({
      title: l.label,
      amount: l.amount,
      basis: l.basis,
      formulaText: ex?.formulaText ?? null,
      note: [isCounselPending(l, result) ? COUNSEL_BADGE : null, l.note ?? null].filter(Boolean).join(' · ') || null,
      status: l.status,
      evidence: evidenceForLine(l, result.lastWorkingDate.slice(0, 7), ex, result.assumptionEvidence),
    });
  };

  const by = (kind: ExitLineKind) => (result ? result.lines.filter((l) => l.kind === kind) : []);

  return (
    <WfPage
      current="/workforce/exit-cost"
      icon={<UserMinus size={24} />}
      title="كلفة الإنهاء والإحلال"
      subtitle="كلفة خروج الموظف قبل اتخاذ القرار حسب السبب: المستحقات والمقاصّة، والمخاطر النظامية منفصلة عن الإجمالي، والرسوم المدفوعة مقدماً، وكلفة البديل، وأثر الخروج على المقابل المالي لبقية الوافدين. لا يُحفظ شيء في ملف الموظف."
    >
      <Card>
        <form onSubmit={compute} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              {options.loading && !options.data ? (
                <LoadingBlock label="جارٍ تحميل الموظفين…" />
              ) : (
                <SearchableSelect name="employeeId" label="الموظف" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} options={employeeOptions} required placeholder="— اختر الموظف —" />
              )}
              {options.error && <p role="alert" className="mt-1 text-[12px] font-bold text-rose-700">{options.error}</p>}
            </div>
            <SelectField
              label="سبب الخروج"
              value={exitReason}
              onChange={(v) => {
                setExitReason(v as EmployeeExitReason);
                setSettlementReason('');
              }}
              options={EMPLOYEE_EXIT_REASONS.map((r) => ({ value: r, label: EXIT_REASON_LABELS[r] }))}
            />
            <div>
              <label htmlFor="wf-lwd" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">آخر يوم عمل</label>
              <input id="wf-lwd" type="date" value={lastWorkingDate} onChange={(e) => setLastWorkingDate(e.target.value)} className={inputClass} required />
            </div>
          </div>

          <p className={`rounded-xl px-3 py-2 text-[12px] font-bold leading-relaxed ${mapping.certain ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-900'}`}>
            {mapping.terminationReason ? `يُحسب بأساس «${TERMINATION_REASON_LABELS[mapping.terminationReason]}». ` : ''}
            {mapping.note}
          </p>

          {(needsBasis || !mapping.certain) && (
            <SelectField
              className="max-w-md"
              label={needsBasis ? 'أساس التسوية (مطلوب لهذا السبب)' : 'أساس التسوية (اختياري: لتغيير القراءة المؤقتة)'}
              value={settlementReason}
              onChange={(v) => setSettlementReason(v as TerminationReasonValue | '')}
              placeholder={needsBasis ? '— اختر —' : 'حسب السبب'}
              options={TERMINATION_REASONS.map((r) => ({ value: r, label: TERMINATION_REASON_LABELS[r] }))}
            />
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[13px] font-black text-slate-700">
              <input type="checkbox" checked={noticeServed} onChange={(e) => setNoticeServed(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
              مدة الإشعار يُعمل بها
            </label>
            <SelectField
              label="جنسية البديل"
              value={replacement}
              onChange={(v) => setReplacement(v as '' | 'true' | 'false')}
              options={[
                { value: '', label: 'نفس فئة الموظف' },
                { value: 'true', label: 'سعودي' },
                { value: 'false', label: 'وافد' },
              ]}
            />
            <div>
              <label htmlFor="wf-rec" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">كلفة توظيف البديل (اختياري)</label>
              <input id="wf-rec" type="number" inputMode="decimal" min={0} value={recruitment} onChange={(e) => setRecruitment(e.target.value)} className={inputClass} placeholder="من الافتراضات" />
            </div>
            <div>
              <label htmlFor="wf-vac" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">أشهر الشغور (اختياري)</label>
              <input id="wf-vac" type="number" inputMode="decimal" min={0} max={36} value={vacancy} onChange={(e) => setVacancy(e.target.value)} className={inputClass} placeholder="من الافتراضات" />
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <Segmented label="السيناريو" value={scenario} onChange={setScenario} options={SCENARIOS.map((s) => ({ value: s, label: SCENARIO_LABELS[s] }))} />
            <div className="flex flex-wrap gap-2">
              {result && (
                <button type="button" onClick={save} disabled={saving || busy} className={buttonClass.secondary}>
                  <Save size={16} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ الحساب'}
                </button>
              )}
              <button type="submit" disabled={busy} className={buttonClass.primary}>
                <Calculator size={16} aria-hidden="true" /> {busy ? 'جارٍ الحساب…' : 'احسب كلفة الإنهاء'}
              </button>
            </div>
          </div>
        </form>
      </Card>

      {error && <ErrorBlock message={error} />}
      {busy && !result && <LoadingBlock />}
      {!result && !busy && !error && <EmptyBlock text="اختر الموظف والسبب ثم اضغط «احسب كلفة الإنهاء»." />}

      {result && (
        <div className={`space-y-5 ${busy ? 'opacity-60' : ''}`} aria-busy={busy} aria-live="polite">
          {result.warnings.length > 0 && (
            <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-1.5">
              {result.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 text-[12.5px] font-bold text-rose-800">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> {w}
                </p>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="rounded-3xl bg-gradient-to-l from-indigo-700 to-indigo-900 p-5 text-white">
              <p className="text-[12px] font-black text-indigo-200">صافي ما يُدفع للموظف</p>
              <p className="mt-2 text-[26px] font-black"><Money value={result.totals.netToEmployee} className="[&_span]:text-white" /></p>
              <p className="text-[11px] font-bold text-indigo-200">
                {`${result.employee.name} · ${TERMINATION_REASON_LABELS[result.reason as TerminationReasonValue] ?? result.reason} · آخر يوم `}
                <span dir="ltr">{result.lastWorkingDate}</span>
              </p>
            </div>
            <div className="rounded-3xl border border-slate-100 bg-white p-5">
              <p className="text-[12px] font-black text-slate-500">المستحقات</p>
              <p className="mt-2 text-[20px] font-black text-slate-900"><Money value={result.totals.payable} /></p>
              <p className="text-[11px] font-bold text-slate-500">
                المقاصّة <Money value={result.totals.offsets} />
              </p>
            </div>
            <div className="rounded-3xl border-2 border-rose-200 bg-rose-50/40 p-5">
              <p className="text-[12px] font-black text-rose-700">خطر نظامي محتمل (المادة 77)</p>
              <p className="mt-2 text-[20px] font-black text-rose-800"><Money value={result.totals.risk} /></p>
              <p className="text-[11px] font-bold text-rose-700">خارج الإجمالي</p>
            </div>
            <div className="rounded-3xl border border-slate-100 bg-white p-5">
              <p className="text-[12px] font-black text-slate-500">كلفة الإحلال</p>
              <p className="mt-2 text-[20px] font-black text-slate-900"><Money value={result.totals.replacement} /></p>
              <p className="text-[11px] font-bold text-slate-500">
                {'سنوات الخدمة '}
                <Num value={result.yearsOfService} />
                {' · الأجر المستخدم '}
                <Money value={result.wageUsed} />
              </p>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-bold text-slate-600 space-y-1">
            <p>
              {'المستحق عند التصفية (دون راتب الشهر الأخير): '}
              <Money value={result.settlementScreenTotal} className="font-black text-slate-800" />
              {' — مكافأة نهاية الخدمة وبدل الإجازة ناقص السلف.'}
            </p>
            {result.lastMonth && result.lastMonth.salary > 0 && (
              <p>
                {'إن لم يُصرف راتب الشهر الأخير: + '}
                <Money value={result.lastMonth.salary} className="font-black text-slate-800" />
                {` (${result.lastMonth.workingDays} يوماً) = `}
                <Money value={result.lastMonth.settlementTotalIfUnpaid} className="font-black text-slate-800" />
                {result.lastMonth.paidByPayroll === true
                  ? ' — مسير ذلك الشهر معتمد أو مصروف، فشاشة التصفية لا تضيفه.'
                  : result.lastMonth.paidByPayroll === false
                    ? ' — لا يوجد مسير معتمد لذلك الشهر، فشاشة التصفية تضيفه.'
                    : ''}
              </p>
            )}
            <p>
              {'لا تشمل الأرقام الإضافي غير المصروف ولا البنود اليدوية التي تضيفها شاشة التصفية. '}
              <Link href={`/settlements/new?employeeId=${result.employeeId}&type=END_OF_SERVICE&lwd=${result.lastWorkingDate}`} className="text-indigo-700 hover:underline">فتح شاشة التصفية</Link>
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="المستحقات" subtitle="تدفعها المنشأة بسبب الخروج">
              <LineList lines={by('PAYABLE')} result={result} onWhy={openWhy} emptyText="لا مستحقات" />
            </Card>
            <Card title="المقاصّة" subtitle="تُنقص ما يُدفع (السلف، وبدل الإشعار المستحق على الموظف)">
              <LineList lines={by('OFFSET')} result={result} onWhy={openWhy} emptyText="لا مقاصّة" />
            </Card>
          </div>

          <section aria-labelledby="wf-risk" className="rounded-3xl border-2 border-dashed border-rose-300 bg-rose-50/40 p-4 sm:p-6">
            <h2 id="wf-risk" className="flex items-center gap-2 text-[16px] font-black text-rose-800">
              <Scale size={18} aria-hidden="true" /> مخاطر نظامية
            </h2>
            <p className="mt-1 mb-3 text-[12px] font-bold text-rose-800 leading-relaxed">
              التعويض عن الإنهاء غير المشروع (المادة 77) لا يُستحق إلا إذا نُوزع في الإنهاء وحُكم بأنه لسبب غير مشروع: 15 يوماً عن كل سنة في العقد غير محدد المدة أو باقي مدة العقد المحدد، وبحد أدنى أجر شهرين. يُعرض للتقدير فقط ولا يُضاف إلى المستحقات.
            </p>
            <LineList lines={by('RISK')} result={result} onWhy={openWhy} emptyText="لا خطر من هذا النوع لهذا السبب." />
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title="رسوم مدفوعة مقدماً" subtitle="للعلم: رسوم حكومية مدفوعة لا تُسترد، ولا تدخل في المستحقات">
              <LineList lines={by('SUNK')} result={result} onWhy={openWhy} emptyText="لا رسوم مدفوعة مقدماً غير مستهلكة." />
            </Card>
            <Card title="كلفة الإحلال" subtitle="من افتراضات المنشأة أو من إدخالك لهذا الحساب">
              <LineList lines={by('REPLACEMENT')} result={result} onWhy={openWhy} emptyText="لا بيانات" />
              <Link href="/workforce/assumptions" className="mt-2 inline-block text-[12px] font-black text-indigo-700 hover:underline">تعديل افتراضات التوظيف والشغور ←</Link>
            </Card>
          </div>

          <Card title="أثر الخروج على المقابل المالي والتركيبة" subtitle="الكيان القانوني في الشهر التالي لآخر يوم عمل، قبل الخروج وبعده (شهرياً)">
            <LineList lines={by('ONGOING')} result={result} onWhy={openWhy} emptyText="لا يمكن حساب الأثر (لا توجد شركة قانونية)." />
            {result.levyImpact && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] text-[12.5px]">
                  <caption className="sr-only">تركيبة الكيان قبل الخروج وبعده</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th scope="col" className="py-2 text-right font-black"><span dir="ltr">{result.levyImpact.month}</span></th>
                      <th scope="col" className="py-2 text-right font-black">سعودي</th>
                      <th scope="col" className="py-2 text-right font-black">وافد</th>
                      <th scope="col" className="py-2 text-right font-black">شريحة 700</th>
                      <th scope="col" className="py-2 text-right font-black">شريحة 800</th>
                      <th scope="col" className="py-2 text-right font-black">معفى</th>
                      <th scope="col" className="py-2 text-right font-black">المقابل الشهري</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { t: 'قبل الخروج', v: result.levyImpact.before },
                      { t: 'بعد الخروج', v: result.levyImpact.after },
                    ].map((r) => (
                      <tr key={r.t} className="border-b border-slate-100 font-bold text-slate-700">
                        <th scope="row" className="py-2 text-right font-black">{r.t}</th>
                        <td className="py-2"><Num value={r.v.saudi} /></td>
                        <td className="py-2"><Num value={r.v.expat} /></td>
                        <td className="py-2"><Num value={r.v.within} /></td>
                        <td className="py-2"><Num value={r.v.above} /></td>
                        <td className="py-2"><Num value={r.v.exempt} /></td>
                        <td className="py-2"><Money value={r.v.monthlyLevy} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {result.flags.length > 0 && (
            <Card title="ملاحظات الحساب">
              <ul className="space-y-1.5">
                {result.flags.map((f, i) => (
                  <li key={`${f.code}-${i}`} className="text-[12px] font-bold text-slate-700">
                    <span className={`ml-2 rounded-md px-1.5 py-0.5 text-[10.5px] font-black ${f.severity === 'ERROR' ? 'bg-rose-100 text-rose-800' : f.severity === 'WARNING' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                      {f.code === 'COUNSEL_PENDING' ? COUNSEL_BADGE : f.severity === 'ERROR' ? 'خطأ' : f.severity === 'WARNING' ? 'تنبيه' : 'معلومة'}
                    </span>
                    {f.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
      <WhyDialog content={why} onClose={() => setWhy(null)} />
    </WfPage>
  );
}

export default function ExitCostPage() {
  return (
    <Suspense fallback={<LoadingBlock label="جارٍ التحميل…" />}>
      <ExitCostInner />
    </Suspense>
  );
}

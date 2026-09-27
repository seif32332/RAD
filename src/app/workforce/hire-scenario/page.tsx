"use client";

// «سيناريوهات التوظيف»: 1–4 alternatives side by side — Saudi hire, expat hire, overtime, outsourcing —
// over 12 / 24 / 36 months: employer cost, HRDF subsidy, levy tier effect on the other expats, Nitaqat
// before / after, localization effect of the occupation and overtime capacity. «لماذا؟» per line.
// Layout: the inputs, then a one-glance ranking of the options by the comparison cost (the cheapest marked),
// then one column per option; the assumptions used are folded last. Header: one «تصدير» menu,
// «حساسية القرار», «حفظ نسخة». POST /api/workforce/hire-scenario (hypothetical: nothing is written). Display only.
import React, { useMemo, useState } from 'react';
import { ChevronDown, Plus, Save, Trash2, TrendingDown, UserPlus } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import { todayKey } from '@/lib/dates';
import { MEDICAL_INSURANCE_CLASSES } from '@/lib/workforce/reasons';
import type { CandidateKind, CandidateLine, CandidateResult, HireScenarioResult } from '@/lib/workforce/hiring';
import type { RuleEvidence, WfStatus } from '@/lib/workforce/types';
import { HORIZONS, evidenceForLine, type Horizon } from '@/app/api/workforce/_lib/shared';
import { callApi, useApi } from '../_components/api';
import type { OptionsResponse } from '../_components/types';
import { BAND_TEXT, BandBadge } from '../_components/nitaqat-ui';
import { Card, ErrorBlock, ExportMenu, HelpNote, Money, Segmented, SelectField, SensitivityButton, StatusBadge, WfPage, WhyButton, WhyDialog, buttonClass, inputClass, type WhyContent } from '../_components/ui';

interface HireResponse {
  result: HireScenarioResult;
  assumptionEvidence: Record<string, RuleEvidence>;
  horizon: number;
}

interface CandidateForm {
  kind: CandidateKind;
  label: string;
  basicSalary: string;
  housingAllowance: string;
  otherAllowances: string;
  gender: 'MALE' | 'FEMALE';
  isDisabled: boolean;
  partTime: boolean;
  city: string;
  occupationName: string;
  occupationCode: string;
  medicalClass: string;
  nationality: string;
  dependentsCount: string;
  dependentsFeePaidBy: '' | 'COMPANY' | 'EMPLOYEE';
  overtimeHoursPerMonth: string;
  overtimeEmployeeId: string;
  monthlyQuote: string;
}

const KIND_OPTIONS: Array<{ value: CandidateKind; label: string }> = [
  { value: 'SAUDI', label: 'توظيف سعودي' },
  { value: 'EXPAT', label: 'توظيف وافد' },
  { value: 'OVERTIME', label: 'عمل إضافي' },
  { value: 'OUTSOURCING', label: 'إسناد' },
];

const blank = (kind: CandidateKind): CandidateForm => ({
  kind,
  label: '',
  basicSalary: kind === 'SAUDI' ? '6000' : kind === 'EXPAT' ? '4000' : '',
  housingAllowance: '',
  otherAllowances: '',
  gender: 'MALE',
  isDisabled: false,
  partTime: false,
  city: '',
  occupationName: '',
  occupationCode: '',
  medicalClass: '',
  nationality: '',
  dependentsCount: '0',
  dependentsFeePaidBy: '',
  overtimeHoursPerMonth: kind === 'OVERTIME' ? '20' : '',
  overtimeEmployeeId: '',
  monthlyQuote: '',
});

function toPayload(c: CandidateForm) {
  const base = { kind: c.kind, label: c.label || undefined };
  if (c.kind === 'OUTSOURCING') return { ...base, monthlyQuote: c.monthlyQuote };
  if (c.kind === 'OVERTIME') return { ...base, overtimeHoursPerMonth: c.overtimeHoursPerMonth, overtimeEmployeeId: c.overtimeEmployeeId || undefined, basicSalary: c.overtimeEmployeeId ? undefined : c.basicSalary, housingAllowance: c.overtimeEmployeeId ? undefined : c.housingAllowance, otherAllowances: c.overtimeEmployeeId ? undefined : c.otherAllowances };
  const common = { ...base, basicSalary: c.basicSalary, housingAllowance: c.housingAllowance, otherAllowances: c.otherAllowances, gender: c.gender, city: c.city, occupationName: c.occupationName, occupationCode: c.occupationCode, medicalClass: c.medicalClass };
  if (c.kind === 'SAUDI') return { ...common, isDisabled: c.isDisabled, partTime: c.partTime };
  return { ...common, nationality: c.nationality, dependentsCount: c.dependentsCount, dependentsFeePaidBy: c.dependentsFeePaidBy };
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11.5px] font-extrabold text-slate-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

function CandidateEditor({ i, c, set, remove, employees }: { i: number; c: CandidateForm; set: (c: CandidateForm) => void; remove: (() => void) | null; employees: Array<{ value: string; label: string }> }) {
  const id = (k: string) => `cand-${i}-${k}`;
  const up = <K extends keyof CandidateForm>(k: K, v: CandidateForm[K]) => set({ ...c, [k]: v });
  const money = (k: 'basicSalary' | 'housingAllowance' | 'otherAllowances' | 'monthlyQuote', label: string) => (
    <Field id={id(k)} label={label}>
      <input id={id(k)} inputMode="decimal" className={inputClass} value={c[k]} onChange={(e) => up(k, e.target.value)} />
    </Field>
  );
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-black text-slate-800">{`البديل ${i + 1}`}</p>
        {remove && (
          <button type="button" onClick={remove} aria-label={`حذف البديل ${i + 1}`} className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
            <Trash2 size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <SelectField label="النوع" value={c.kind} onChange={(v) => set({ ...blank(v as CandidateKind), label: c.label })} options={KIND_OPTIONS} />
      <Field id={id('label')} label="اسم البديل (اختياري)">
        <input id={id('label')} className={inputClass} value={c.label} maxLength={80} onChange={(e) => up('label', e.target.value)} />
      </Field>
      {(c.kind === 'SAUDI' || c.kind === 'EXPAT') && (
        <>
          {money('basicSalary', 'الراتب الأساسي الشهري')}
          {money('housingAllowance', 'بدل السكن (يدخل في التأمينات)')}
          {money('otherAllowances', 'بدلات أخرى')}
        </>
      )}
      {(c.kind === 'SAUDI' || c.kind === 'EXPAT') && (
        <details className="group rounded-xl border border-slate-100 bg-slate-50/60">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[12px] font-black text-slate-600 [&::-webkit-details-marker]:hidden">
            بيانات إضافية (اختيارية)
            <ChevronDown size={14} className="text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="space-y-2.5 border-t border-slate-100 p-3">
            <SelectField label="الجنس" value={c.gender} onChange={(v) => up('gender', v as 'MALE' | 'FEMALE')} options={[{ value: 'MALE', label: 'ذكر' }, { value: 'FEMALE', label: 'أنثى' }]} />
            <Field id={id('city')} label="المدينة (دعم هدف خارج المدن الكبرى)">
              <input id={id('city')} className={inputClass} value={c.city} onChange={(e) => up('city', e.target.value)} />
            </Field>
            <Field id={id('occ')} label="المهنة (لقرارات التوطين)">
              <input id={id('occ')} className={inputClass} value={c.occupationName} onChange={(e) => up('occupationName', e.target.value)} />
            </Field>
            <Field id={id('occc')} label="رمز المهنة (اختياري)">
              <input id={id('occc')} inputMode="numeric" className={inputClass} value={c.occupationCode} onChange={(e) => up('occupationCode', e.target.value.replace(/[^\d]/g, ''))} />
            </Field>
            <SelectField label="فئة التأمين الطبي" value={c.medicalClass} onChange={(v) => up('medicalClass', v)} placeholder="غير محددة" options={MEDICAL_INSURANCE_CLASSES.map((m) => ({ value: m, label: m }))} />
          {c.kind === 'SAUDI' && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-bold text-slate-700">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={c.isDisabled} onChange={(e) => up('isDisabled', e.target.checked)} /> ذو إعاقة (مرشح افتراضي)</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={c.partTime} onChange={(e) => up('partTime', e.target.checked)} /> دوام جزئي</label>
            </div>
          )}
          {c.kind === 'EXPAT' && (
            <>
              <Field id={id('nat')} label="الجنسية (اختياري)">
                <input id={id('nat')} className={inputClass} value={c.nationality} onChange={(e) => up('nationality', e.target.value)} />
              </Field>
              <Field id={id('deps')} label="عدد المرافقين">
                <input id={id('deps')} inputMode="numeric" className={inputClass} value={c.dependentsCount} onChange={(e) => up('dependentsCount', e.target.value.replace(/[^\d]/g, ''))} />
              </Field>
              <SelectField label="رسوم المرافقين يدفعها" value={c.dependentsFeePaidBy} onChange={(v) => up('dependentsFeePaidBy', v as CandidateForm['dependentsFeePaidBy'])} placeholder="حسب افتراض الشركة" options={[{ value: 'COMPANY', label: 'الشركة' }, { value: 'EMPLOYEE', label: 'الموظف' }]} />
            </>
          )}
          </div>
        </details>
      )}
      {c.kind === 'OVERTIME' && (
        <>
          <Field id={id('oth')} label="ساعات إضافية شهرياً">
            <input id={id('oth')} inputMode="decimal" className={inputClass} value={c.overtimeHoursPerMonth} onChange={(e) => up('overtimeHoursPerMonth', e.target.value)} />
          </Field>
          <SelectField label="بأجر ساعة الموظف" value={c.overtimeEmployeeId} onChange={(v) => up('overtimeEmployeeId', v)} placeholder="أدخل الأجر يدوياً" options={employees} />
          {!c.overtimeEmployeeId && (
            <>
              {money('basicSalary', 'الراتب الأساسي')}
              {money('otherAllowances', 'بدلات أخرى')}
            </>
          )}
        </>
      )}
      {c.kind === 'OUTSOURCING' && money('monthlyQuote', 'عرض الإسناد الشهري (من المورد)')}
    </div>
  );
}

const STATUS_OF = (s: string): WfStatus => (['VERIFIED_PRIMARY', 'CORROBORATED_SECONDARY', 'PROVISIONAL', 'CONFLICTING', 'USER_INPUT', 'MISSING', 'DERIVED'].includes(s) ? (s as WfStatus) : 'DERIVED');

const KIND_LABEL = (k: CandidateKind) => KIND_OPTIONS.find((o) => o.value === k)?.label;

function CheapestBadge() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10.5px] font-black text-emerald-800">
      <TrendingDown size={12} aria-hidden="true" /> الأقل كلفة
    </span>
  );
}

/** One line per option, ordered by the comparison cost of the chosen period (the value the API returned). */
function Ranking({ candidates, horizon, cheapest }: { candidates: CandidateResult[]; horizon: Horizon; cheapest: number | null }) {
  const sorted = [...candidates].sort((a, b) => a.windows[horizon].total - b.windows[horizon].total);
  return (
    <ol className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
      {sorted.map((c) => {
        const low = cheapest !== null && c.windows[horizon].total === cheapest;
        return (
          <li key={c.index} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 ${low ? 'bg-emerald-50/60' : ''}`}>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-[13px] font-black text-slate-800">{c.label}</span>
              <span className="text-[11px] font-bold text-slate-500">{KIND_LABEL(c.kind)}</span>
              {low && <CheapestBadge />}
            </span>
            <span className="flex items-center gap-3">
              {c.nitaqat.status === 'OK' && (
                <span className="flex items-center gap-1 text-[11.5px] font-bold text-slate-500">
                  النطاق بعده <BandBadge band={c.nitaqat.after.band} />
                </span>
              )}
              <Money value={c.windows[horizon].total} round className={`text-[15px] font-black ${low ? 'text-emerald-800' : 'text-slate-900'}`} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ResultColumn({ c, horizon, onWhy, cheapest }: { c: CandidateResult; horizon: Horizon; onWhy: (c: CandidateResult, l: CandidateLine) => void; cheapest: boolean }) {
  const w = c.windows[horizon];
  const lineVal = (l: CandidateLine) => (horizon === 12 ? l.w12 : horizon === 24 ? l.w24 : l.w36);
  return (
    <div className={`rounded-2xl border bg-white p-3 space-y-3 min-w-0 ${cheapest ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-black text-slate-800">{c.label}</p>
          <p className="text-[11px] font-bold text-slate-500">{KIND_LABEL(c.kind)}</p>
        </div>
        {cheapest && <CheapestBadge />}
      </div>
      <div className={`rounded-xl p-3 ${cheapest ? 'bg-emerald-50' : 'bg-indigo-50'}`}>
        <p className={`text-[11px] font-black ${cheapest ? 'text-emerald-800' : 'text-indigo-700'}`}>{`الكلفة للمقارنة خلال ${horizon} شهراً`}</p>
        <p className="mt-1 text-[22px] font-black text-slate-900"><Money value={w.total} round /></p>
        <dl className="mt-2 space-y-0.5 text-[11.5px] font-bold text-slate-600">
          <div className="flex justify-between gap-2"><dt>كلفة صاحب العمل</dt><dd><Money value={w.cost} /></dd></div>
          <div className="flex justify-between gap-2 text-green-700"><dt>دعم هدف المتوقع</dt><dd><Money value={w.subsidy} /></dd></div>
          <div className="flex justify-between gap-2"><dt>بعد الدعم</dt><dd><Money value={w.net} /></dd></div>
          <div className="flex justify-between gap-2"><dt>أثر المقابل المالي على بقية الوافدين</dt><dd><Money value={w.levyOthers} /></dd></div>
        </dl>
      </div>
      <div className="text-[12px] font-bold text-slate-700 space-y-1">
        <p className="font-black text-slate-800">نطاقات</p>
        {c.nitaqat.status === 'OK' ? (
          <p className="flex flex-wrap items-center gap-1.5">
            <BandBadge band={c.nitaqat.before.band} /> <span dir="ltr">{c.nitaqat.before.pct}%</span> ←
            <BandBadge band={c.nitaqat.after.band} /> <span dir="ltr">{c.nitaqat.after.pct}%</span>
            <span className="text-slate-500">{`(وزن المرشح ${c.nitaqat.candidateWeight})`}</span>
          </p>
        ) : (
          <p className="text-slate-500">{c.nitaqat.message}</p>
        )}
        {c.levy.tierNote && <p className="text-amber-800">{c.levy.tierNote}</p>}
      </div>
      <div className="text-[12px] font-bold text-slate-700 space-y-1">
        <p className="font-black text-slate-800">قرارات التوطين</p>
        {c.localization.length ? (
          c.localization.map((l) => (
            <p key={l.decisionId}>
              {`${l.groupNameAr}: ${l.before.pct ?? 0}% ← ${l.after.pct ?? 0}% (المطلوب ${l.requiredPct ?? '—'}%) `}
              {l.after.compliant === true ? <span className="text-green-700">ملتزم</span> : l.after.compliant === false ? <span className="text-rose-700">غير ملتزم</span> : null}
              {l.note && <span className="block text-[11px] text-slate-500">{l.note}</span>}
            </p>
          ))
        ) : (
          <p className="text-slate-500">{c.localizationNote ?? '—'}</p>
        )}
      </div>
      {c.capacity && <p className={`rounded-lg px-2 py-1 text-[11.5px] font-bold ${c.capacity.overCap ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-slate-600'}`}>{c.capacity.note}</p>}
      <ul className="divide-y divide-slate-100">
        {c.lines.map((l) => (
          <li key={l.key} className="flex items-center justify-between gap-2 py-1.5 text-[12px] font-bold">
            <span className="min-w-0 text-slate-700">{l.label}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              <Money value={lineVal(l)} className={lineVal(l) < 0 ? 'text-green-700' : 'text-slate-900'} />
              <WhyButton onClick={() => onWhy(c, l)} label={`${c.label}: ${l.label}`} />
            </span>
          </li>
        ))}
      </ul>
      {c.notes.map((n) => (
        <p key={n} className="text-[11px] font-bold text-slate-400">{n}</p>
      ))}
    </div>
  );
}

export default function HireScenarioPage() {
  const options = useApi<OptionsResponse>('/api/workforce/options');
  const [companyId, setCompanyId] = useState('');
  const [startMonth, setStartMonth] = useState(todayKey().slice(0, 7));
  const [horizon, setHorizon] = useState<Horizon>(12);
  const [cands, setCands] = useState<CandidateForm[]>([blank('SAUDI'), blank('EXPAT')]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<HireResponse | null>(null);
  const [why, setWhy] = useState<WhyContent | null>(null);

  const employees = useMemo(
    () => (options.data?.employees ?? []).filter((e) => !companyId || e.companyId === companyId).map((e) => ({ value: e.id, label: e.employeeNo ? `${e.name} (${e.employeeNo})` : e.name })),
    [options.data, companyId],
  );
  const body = () => ({ companyId, startMonth, months: horizon, candidates: cands.map(toPayload) });
  // The cheapest option: the lowest comparison cost returned for the chosen period (none with a single option).
  const cheapest = res && res.result.candidates.length > 1 ? Math.min(...res.result.candidates.map((c) => c.windows[horizon].total)) : null;

  const run = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!companyId) {
      setError('اختر الشركة القانونية');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await callApi<HireResponse>('/api/workforce/hire-scenario', { json: body() });
    setBusy(false);
    if (r.ok) setRes(r.data);
    else {
      setRes(null);
      setError(r.message);
    }
  };
  const save = async () => {
    setSaving(true);
    const r = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'HIRE_SCENARIO', params: body() } });
    setSaving(false);
    if (r.ok) toast.success('حُفظ السيناريو. تجده في «الحسابات المحفوظة».');
    else toast.error(r.message);
  };
  const openWhy = (c: CandidateResult, l: CandidateLine) => {
    if (!res) return;
    const val = horizon === 12 ? l.w12 : horizon === 24 ? l.w24 : l.w36;
    const month = res.result.startMonth;
    const ex = l.key in c.explanations ? c.explanations[l.key as keyof typeof c.explanations] : null;
    setWhy({
      title: `${c.label}: ${l.label}`,
      amount: val,
      basis: `${l.basis} (الشهر الأول) — مجموع ${horizon} شهراً`,
      formulaText: ex?.formulaText ?? null,
      note: l.note ?? null,
      status: STATUS_OF(l.status),
      evidence: evidenceForLine(l, month, ex, res.assumptionEvidence),
    });
  };

  return (
    <WfPage
      icon={<UserPlus size={24} />}
      title="مقارنة خيارات التوظيف"
      subtitle="أيهما أوفر لسد الحاجة: توظيف سعودي أو وافد، أو عمل إضافي، أو إسناد؟"
      help={
        <>
          <p>قارن حتى أربعة بدائل: توظيف سعودي أو وافد أو العمل الإضافي أو الإسناد، لمدة 12 أو 24 أو 36 شهراً.</p>
          <p>لكل بديل: كلفة صاحب العمل، ودعم هدف المتوقع، والكلفة بعد الدعم، وأثر المقابل المالي على بقية الوافدين.</p>
          <p>ويظهر النطاق قبل التعيين وبعده، وأثر المهنة على قرارات التوطين. لا يُحفظ شيء في ملفات الموظفين.</p>
        </>
      }
      current="/workforce/hire-scenario"
      actions={
        res ? (
          <>
            <ExportMenu disabled={busy} excel={{ kind: 'hire-scenario', body: body() }} pdf={{ kind: 'hire-scenario', body: body() }} />
            <SensitivityButton decision="hire" body={body()} disabled={busy} />
            <button type="button" onClick={save} disabled={saving} className={buttonClass.secondary} title="يحفظ الأرقام مع نسخ القواعد المستخدمة للرجوع إليها لاحقاً">
              <Save size={15} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ نسخة'}
            </button>
          </>
        ) : undefined
      }
    >
      <form onSubmit={run} className="space-y-4">
        <Card>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <SelectField label="الشركة القانونية" value={companyId} onChange={setCompanyId} placeholder="اختر الشركة" options={(options.data?.companies ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            <div>
              <label htmlFor="hs-start" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">شهر المباشرة</label>
              <input id="hs-start" type="month" className={inputClass} value={startMonth} onChange={(e) => setStartMonth(e.target.value || todayKey().slice(0, 7))} />
            </div>
            <Segmented label="المدة" value={horizon} options={HORIZONS.map((h) => ({ value: h, label: `${h} شهراً` }))} onChange={setHorizon} />
          </div>
        </Card>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {cands.map((c, i) => (
            <CandidateEditor
              key={i}
              i={i}
              c={c}
              employees={employees}
              set={(n) => setCands(cands.map((x, j) => (j === i ? n : x)))}
              remove={cands.length > 1 ? () => setCands(cands.filter((_, j) => j !== i)) : null}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {cands.length < 4 && (
            <button type="button" onClick={() => setCands([...cands, blank(cands.length === 2 ? 'OVERTIME' : 'OUTSOURCING')])} className={buttonClass.secondary}>
              <Plus size={15} aria-hidden="true" /> إضافة بديل
            </button>
          )}
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? 'جارٍ الحساب…' : 'قارن البدائل'}
          </button>
        </div>
      </form>
      {error && <ErrorBlock message={error} />}
      {res && (
        <div className="space-y-4" aria-live="polite">
          <Card title="النتيجة" subtitle={`من ${res.result.startMonth}. النطاق الحالي: ${res.result.nitaqatBefore.band ? BAND_TEXT[res.result.nitaqatBefore.band] : (res.result.nitaqatBefore.message ?? '—')}`}>
            <Ranking candidates={res.result.candidates} horizon={horizon} cheapest={cheapest} />
          </Card>
          <Card title="التفاصيل لكل بديل">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {res.result.candidates.map((c) => (
                <ResultColumn key={c.index} c={c} horizon={horizon} onWhy={openWhy} cheapest={cheapest !== null && c.windows[horizon].total === cheapest} />
              ))}
            </div>
            <p className="mt-3 text-[11px] font-bold text-slate-400">
              <StatusBadge status="USER_INPUT" /> عروض الإسناد وساعات العمل الإضافي إدخالك.
            </p>
          </Card>
          {res.result.assumptions.length > 0 && (
            <HelpNote title="الافتراضات المستخدمة">
              <ul className="list-disc pr-5 space-y-0.5">
                {res.result.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </HelpNote>
          )}
        </div>
      )}
      <WhyDialog content={why} onClose={() => setWhy(null)} />
    </WfPage>
  );
}

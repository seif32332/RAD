"use client";

// «الافتراضات»: values no authority publishes (recruitment cost, fee policies...), for all companies or
// overridden per company. Numbers may carry low / base / high bounds (scenarios).
// The overtime basis, the medical premiums and the iqama fee are NOT assumptions: they are the company's
// «إعدادات الكلفة» (set once in the company form, used by payroll and the engine); this page shows them
// read-only per company with a link to the company edit page.
// GET/PUT /api/workforce/assumptions; read-only for HR_MANAGER (the API enforces it).
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { Building2, Lock, Save, SlidersHorizontal } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import {
  MEDICAL_PREMIUM_LABELS,
  OVERTIME_BASIS_SHORT,
  companySettingsHref,
  type MedicalPremiumKey,
  type MedicalPremiums,
  type OvertimeHourlyBasis,
} from '@/lib/workforce/company-settings';
import { callApi, useApi } from '../_components/api';
import { Card, ErrorBlock, LoadingBlock, SelectField, WfPage, buttonClass, inputClass } from '../_components/ui';

interface CompanySettingsRow {
  id: string;
  name: string;
  overtimeHourlyBasis: OvertimeHourlyBasis;
  medicalPremiums: MedicalPremiums;
  iqamaFeeYear: number | null;
  legacyHints: Array<{ key: string; label: string; value: string; scope: 'COMPANY' | 'GLOBAL' }>;
}

interface Def {
  key: string;
  kind: 'number' | 'boolean' | 'enum';
  label: string;
  unit: string | null;
  defaultValue: number | boolean | string | null;
  options: string[] | null;
  note: string | null;
  allowsRange: boolean;
  bounds: { min: number; max: number } | null;
}
interface Stored {
  value: unknown;
  note: string | null;
  updatedAt: string;
}
interface AssumptionsResponse {
  canEdit: boolean;
  canEditCompanySettings: boolean;
  companyId: string;
  companies: Array<{ id: string; name: string; hasOverrides: boolean }>;
  defs: Def[];
  global: Record<string, Stored>;
  company: Record<string, Stored> | null;
  resolved: Record<string, { value: unknown; origin: 'COMPANY' | 'GLOBAL' | 'DEFAULT'; range: { low: number; base: number; high: number } | null }>;
  iqamaRule: { value: number | null; status: string; effectiveFrom: string | null };
  medicalPremiumKeys: MedicalPremiumKey[];
  companySettings: CompanySettingsRow[];
}

type NumField = { base: string; low: string; high: string; ranged: boolean };
type FieldValue = NumField | string;

const UNIT: Record<string, string> = { SAR_YEAR: 'ريال سنوياً', SAR: 'ريال', MONTHS: 'شهر', PERCENT: '%', COUNT_YEAR: 'مرة سنوياً' };

const ENUM_LABELS: Record<string, Record<string, string>> = {
  DEPENDENTS_FEE_PAID_BY_DEFAULT: { COMPANY: 'الشركة تدفع رسوم المرافقين', EMPLOYEE: 'الموظف يدفع رسوم المرافقين' },
};

const SECTIONS: Array<{ title: string; subtitle?: string; keys: string[] }> = [
  { title: 'رسوم الوافدين والسفر', keys: ['DEPENDENTS_FEE_PAID_BY_DEFAULT', 'ANNUAL_TICKET_COST', 'EXIT_REENTRY_VISAS_PER_YEAR'] },
  { title: 'التوظيف والإحلال', keys: ['RECRUITMENT_COST_SAUDI', 'RECRUITMENT_COST_EXPAT', 'VACANCY_MONTHS'] },
  { title: 'الرواتب', keys: ['ANNUAL_RAISE_PCT'] },
  { title: 'المنشأة ودعم هدف', keys: ['COMPANY_IS_SME', 'OWNER_FULL_TIME', 'INCLUDE_HRDF'] },
];

const RULE_STATUS: Record<string, string> = { VERIFIED_PRIMARY: 'موثّق', CORROBORATED_SECONDARY: 'مؤكَّد ثانوياً', PROVISIONAL: 'مؤقت', CONFLICTING: 'متعارض', MISSING: 'غير متوفر' };

const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Read-only «إعدادات الكلفة» of every company (edited in the company form). */
function CompanySettingsPanel({ data }: { data: AssumptionsResponse }) {
  const rows = data.companyId ? data.companySettings.filter((c) => c.id === data.companyId) : data.companySettings;
  const rule = data.iqamaRule;
  const ruleText = rule.value !== null ? `${fmtNum(rule.value)} (${RULE_STATUS[rule.status] ?? rule.status})` : 'غير متوفر';
  return (
    <Card
      title="إعدادات الكلفة لكل شركة"
      subtitle="طريقة حساب العمل الإضافي، وأقساط التأمين الطبي، ورسوم الإقامة ليست افتراضات: تُضبط مرة واحدة في إعدادات الشركة، ويستخدمها المسير ومحرك القرارات. قيم مفردة بلا نطاق منخفض/مرتفع."
    >
      {rows.length === 0 ? (
        <p className="text-[12.5px] font-bold text-slate-500">لا توجد شركات.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {rows.map((c) => (
            <div key={c.id} className="rounded-2xl border border-slate-100 p-4 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-[13px] font-black text-slate-800 min-w-0">
                  <Building2 size={15} className="text-slate-400 shrink-0" aria-hidden="true" />
                  <span className="truncate">{c.name}</span>
                </p>
                <Link href={companySettingsHref(c.id)} className="text-[12px] font-black text-indigo-700 hover:underline">
                  {data.canEditCompanySettings ? 'تعديل من إعدادات الشركة ←' : 'عرض في إعدادات الشركة ←'}
                </Link>
              </div>
              <dl className="mt-3 space-y-2 text-[12px] font-bold text-slate-600">
                <div className="flex flex-wrap gap-1.5">
                  <dt className="text-slate-400">العمل الإضافي:</dt>
                  <dd>{OVERTIME_BASIS_SHORT[c.overtimeHourlyBasis]}</dd>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <dt className="text-slate-400">التأمين الطبي (ريال سنوياً):</dt>
                  <dd className="flex flex-wrap gap-x-3 gap-y-1">
                    {data.medicalPremiumKeys.map((k) => (
                      <span key={k} className={typeof c.medicalPremiums[k] === 'number' ? 'text-slate-700' : 'text-slate-400'}>
                        <span dir={k === 'DEPENDENT' ? undefined : 'ltr'}>{MEDICAL_PREMIUM_LABELS[k]}</span>
                        {`: ${typeof c.medicalPremiums[k] === 'number' ? fmtNum(c.medicalPremiums[k] as number) : 'غير مدخل'}`}
                      </span>
                    ))}
                  </dd>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <dt className="text-slate-400">رسوم الإقامة:</dt>
                  <dd>{c.iqamaFeeYear !== null ? `${fmtNum(c.iqamaFeeYear)} ريال سنوياً (إعداد الشركة)` : `سجل القواعد: ${ruleText} ريال سنوياً`}</dd>
                </div>
              </dl>
              {c.legacyHints.length > 0 && (
                <p role="note" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] font-bold text-amber-800 leading-relaxed">
                  {`قيمة قديمة في الافتراضات لا تُستخدم بعد الآن: ${c.legacyHints.map((h) => `${h.label} (${h.value}${h.scope === 'GLOBAL' ? '، لكل الشركات' : ''})`).join('؛ ')}. أدخلها في إعدادات الشركة إن كانت صحيحة.`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const emptyNum = (): NumField => ({ base: '', low: '', high: '', ranged: false });

function toNumField(v: unknown): NumField {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === 'number' ? String(x) : '');
    const f = { base: s(o.base), low: s(o.low), high: s(o.high), ranged: true };
    return { ...f, ranged: f.low !== f.base || f.high !== f.base };
  }
  return { ...emptyNum(), base: typeof v === 'number' ? String(v) : '' };
}

function initial(def: Def, stored: Stored | undefined): FieldValue {
  const v = stored?.value;
  if (def.kind === 'number') return toNumField(v);
  if (def.kind === 'boolean') return typeof v === 'boolean' ? String(v) : '';
  return typeof v === 'string' ? v : '';
}

function numOut(f: NumField): unknown {
  if (f.base.trim() === '') return null;
  const base = Number(f.base);
  if (!f.ranged) return base;
  return { low: f.low.trim() === '' ? base : Number(f.low), base, high: f.high.trim() === '' ? base : Number(f.high) };
}

/** Form value -> API value (null = remove the row). */
function output(def: Def, v: FieldValue): unknown {
  if (def.kind === 'number') return numOut(v as NumField);
  if (def.kind === 'boolean') return v === '' ? null : v === 'true';
  return v === '' ? null : v;
}

function describe(def: Def, value: unknown): string {
  if (value === null || value === undefined) return 'غير مدخل';
  if (def.kind === 'boolean') return value ? 'نعم' : 'لا';
  if (def.kind === 'enum') return ENUM_LABELS[def.key]?.[String(value)] ?? String(value);
  return `${typeof value === 'number' ? value.toLocaleString('en-US') : String(value)}${def.unit && UNIT[def.unit] ? ` ${UNIT[def.unit]}` : ''}`;
}

const ORIGIN: Record<string, string> = { COMPANY: 'من إدخال هذه الشركة', GLOBAL: 'من الافتراضات العامة', DEFAULT: 'القيمة الافتراضية للنظام' };

function NumInputs({ id, f, onChange, disabled, allowsRange, bounds }: { id: string; f: NumField; onChange: (f: NumField) => void; disabled: boolean; allowsRange: boolean; bounds: Def['bounds'] }) {
  return (
    <div className="space-y-2">
      <div className={`grid gap-2 ${f.ranged ? 'grid-cols-3' : 'grid-cols-1'}`}>
        {f.ranged && (
          <div>
            <label htmlFor={`${id}-low`} className="block text-[11px] font-bold text-slate-500 mb-1">منخفض</label>
            <input id={`${id}-low`} type="number" inputMode="decimal" min={bounds?.min} max={bounds?.max} value={f.low} disabled={disabled} onChange={(e) => onChange({ ...f, low: e.target.value })} className={inputClass} />
          </div>
        )}
        <div>
          <label htmlFor={`${id}-base`} className={f.ranged ? 'block text-[11px] font-bold text-slate-500 mb-1' : 'sr-only'}>أساسي</label>
          <input id={`${id}-base`} type="number" inputMode="decimal" min={bounds?.min} max={bounds?.max} value={f.base} disabled={disabled} onChange={(e) => onChange({ ...f, base: e.target.value })} className={inputClass} placeholder="غير مدخل" />
        </div>
        {f.ranged && (
          <div>
            <label htmlFor={`${id}-high`} className="block text-[11px] font-bold text-slate-500 mb-1">مرتفع</label>
            <input id={`${id}-high`} type="number" inputMode="decimal" min={bounds?.min} max={bounds?.max} value={f.high} disabled={disabled} onChange={(e) => onChange({ ...f, high: e.target.value })} className={inputClass} />
          </div>
        )}
      </div>
      {allowsRange && !disabled && (
        <label className="inline-flex items-center gap-2 text-[11.5px] font-bold text-slate-600">
          <input type="checkbox" checked={f.ranged} onChange={(e) => onChange({ ...f, ranged: e.target.checked, low: e.target.checked ? f.low || f.base : '', high: e.target.checked ? f.high || f.base : '' })} className="h-3.5 w-3.5 rounded border-slate-300" />
          نطاق منخفض / أساسي / مرتفع
        </label>
      )}
    </div>
  );
}

function AssumptionsForm({ data, onSaved }: { data: AssumptionsResponse; onSaved: () => void }) {
  const defs = useMemo(() => new Map(data.defs.map((d) => [d.key, d])), [data.defs]);
  const start = useMemo(() => {
    const rows = data.companyId ? (data.company ?? {}) : data.global;
    return Object.fromEntries(data.defs.map((d) => [d.key, initial(d, rows[d.key])])) as Record<string, FieldValue>;
  }, [data]);
  const [form, setForm] = useState<Record<string, FieldValue>>(start);
  const [saving, setSaving] = useState(false);
  const readOnly = !data.canEdit;

  const changed = data.defs.filter((d) => JSON.stringify(output(d, form[d.key])) !== JSON.stringify(output(d, start[d.key])));
  const set = (key: string, v: FieldValue) => setForm((f) => ({ ...f, [key]: v }));

  const save = async () => {
    if (!changed.length) return;
    setSaving(true);
    const res = await callApi<{ changed: string[] }>('/api/workforce/assumptions', {
      method: 'PUT',
      json: { companyId: data.companyId, items: changed.map((d) => ({ key: d.key, value: output(d, form[d.key]) })) },
    });
    setSaving(false);
    if (res.ok) {
      toast.success(res.data.changed.length ? `حُفظت ${res.data.changed.length} قيمة` : 'لا تغييرات');
      onSaved();
    } else toast.error(res.message);
  };

  const field = (key: string) => {
    const def = defs.get(key);
    if (!def) return null;
    const id = `wf-a-${key}`;
    const r = data.resolved[key];
    const v = form[key];
    return (
      <div key={key} className="rounded-2xl border border-slate-100 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <label htmlFor={def.kind === 'number' ? `${id}-base` : id} className="text-[13px] font-black text-slate-800">
            {def.label}
            {def.unit && UNIT[def.unit] && <span className="text-[11px] text-slate-400">{` (${UNIT[def.unit]})`}</span>}
          </label>
          {r && (
            <span className="text-[11px] font-bold text-slate-500">
              {`المستخدم الآن: ${describe(def, r.value)} · ${ORIGIN[r.origin]}`}
            </span>
          )}
        </div>
        <div className="mt-3">
          {def.kind === 'number' && <NumInputs id={id} f={v as NumField} onChange={(f) => set(key, f)} disabled={readOnly} allowsRange={def.allowsRange} bounds={def.bounds} />}
          {def.kind === 'boolean' && (
            <select id={id} value={v as string} disabled={readOnly} onChange={(e) => set(key, e.target.value)} className={inputClass}>
              <option value="">{`غير محدد${def.defaultValue !== null ? ` (الافتراضي: ${def.defaultValue ? 'نعم' : 'لا'})` : ''}`}</option>
              <option value="true">نعم</option>
              <option value="false">لا</option>
            </select>
          )}
          {def.kind === 'enum' && (
            <select id={id} value={v as string} disabled={readOnly} onChange={(e) => set(key, e.target.value)} className={inputClass}>
              <option value="">{`غير محدد${def.defaultValue ? ` (الافتراضي: ${ENUM_LABELS[key]?.[String(def.defaultValue)] ?? def.defaultValue})` : ''}`}</option>
              {(def.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {ENUM_LABELS[key]?.[o] ?? o}
                </option>
              ))}
            </select>
          )}
        </div>
        {key === 'ANNUAL_RAISE_PCT' && <p className="mt-2 text-[11.5px] font-bold text-slate-500">تُطبَّق في يناير من كل سنة على الأساسي، مركّبة، إلا في سنة فيها تغيير راتب مؤرخ للموظف.</p>}
        {key === 'INCLUDE_HRDF' && <p className="mt-2 text-[11.5px] font-bold text-slate-500">يظهر الدعم سطراً سالباً مستقلاً ومشروطاً بقبول هدف؛ الإجماليات تُعرض قبله وبعده دائماً.</p>}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {SECTIONS.map((s) => (
        <Card key={s.title} title={s.title} subtitle={s.subtitle}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{s.keys.map(field)}</div>
        </Card>
      ))}
      {!readOnly && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <p className="text-[12px] font-bold text-slate-600">{changed.length ? `${changed.length} تغيير غير محفوظ` : 'لا تغييرات'}</p>
          <div className="flex gap-2">
            <button type="button" className={buttonClass.secondary} disabled={!changed.length || saving} onClick={() => setForm(start)}>
              تراجع
            </button>
            <button type="button" className={buttonClass.primary} disabled={!changed.length || saving} onClick={save}>
              <Save size={16} aria-hidden="true" /> {saving ? 'جارٍ الحفظ…' : 'حفظ'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AssumptionsPage() {
  const [tab, setTab] = useState<'global' | 'company'>('global');
  const [companyId, setCompanyId] = useState('');
  const effectiveCompany = tab === 'company' ? companyId : '';
  const { data, error, loading, reload } = useApi<AssumptionsResponse>(tab === 'company' && !companyId ? '/api/workforce/assumptions' : `/api/workforce/assumptions?companyId=${encodeURIComponent(effectiveCompany)}`);
  const [version, setVersion] = useState(0);

  return (
    <WfPage
      current="/workforce/assumptions"
      icon={<SlidersHorizontal size={24} />}
      title="الافتراضات"
      subtitle="قيم لا تنشرها جهة رسمية وتحتاجها الحسابات: كلفة التوظيف، ومن يدفع رسوم المرافقين، وغيرها. الافتراضات العامة تسري على كل الشركات، وإدخال الشركة يتقدم عليها. أقساط التأمين الطبي وطريقة حساب العمل الإضافي ورسوم الإقامة تُضبط في إعدادات الشركة."
    >
      <div role="tablist" aria-label="نطاق الافتراضات" className="flex gap-2 border-b border-slate-200">
        {[
          { k: 'global' as const, l: 'الافتراضات العامة (كل الشركات)' },
          { k: 'company' as const, l: 'افتراضات شركة' },
        ].map((t) => (
          <button
            key={t.k}
            type="button"
            role="tab"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            className={`whitespace-nowrap px-4 py-2.5 text-[13px] font-black border-b-2 -mb-px ${tab === t.k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {t.l}
          </button>
        ))}
      </div>

      {tab === 'company' && (
        <SelectField
          className="max-w-md"
          label="الشركة"
          value={companyId}
          onChange={setCompanyId}
          placeholder="— اختر الشركة —"
          options={(data?.companies ?? []).map((c) => ({ value: c.id, label: c.hasOverrides ? `${c.name} (لها افتراضات خاصة)` : c.name }))}
        />
      )}

      {data && !data.canEdit && (
        <p className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12.5px] font-bold text-slate-600">
          <Lock size={16} aria-hidden="true" /> عرض فقط: تعديل الافتراضات للمالك وصاحب العمل والمالية.
        </p>
      )}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock label="جارٍ التحميل…" />}
      {data && tab === 'company' && !companyId && <p className="text-[13px] font-bold text-slate-500">اختر شركة لعرض افتراضاتها الخاصة وما يُستخدم لها.</p>}
      {data && !loading && (tab === 'global' || (companyId && data.companyId === companyId)) && (
        <>
          <AssumptionsForm
            key={`${data.companyId}|${version}`}
            data={data}
            onSaved={() => {
              setVersion((v) => v + 1);
              reload();
            }}
          />
          <CompanySettingsPanel data={data} />
        </>
      )}
    </WfPage>
  );
}

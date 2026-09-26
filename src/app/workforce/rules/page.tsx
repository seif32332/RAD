"use client";

// «سجل القواعد والأدلة»: every regulatory value with its versions, effective dates, evidence status, source
// link and quote, grouped by domain. SUPER_ADMIN adds a NEW version (history is never edited).
// GET/POST /api/workforce/rules.
import React, { useMemo, useState } from 'react';
import { BookOpenCheck, ExternalLink, Plus } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { confirmDialog, toast } from '@/components/ui/feedback';
import { formatDate, todayKey } from '@/lib/dates';
import type { WfStatus } from '@/lib/workforce/types';
import type { RuleDomainView, RuleKeyView, RuleVersionView } from '@/app/api/workforce/_lib/views';
import { RULE_INPUT_STATUSES, STATUS_LABELS, UNIT_LABELS, domainLabel, formatRuleValue } from '@/app/api/workforce/_lib/shared';
import { callApi, useApi } from '../_components/api';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, SelectField, StatusBadge, WfPage, buttonClass, inputClass } from '../_components/ui';

interface RulesResponse {
  today: string;
  canAddVersion: boolean;
  domains: RuleDomainView[];
}

const STATE_LABELS: Record<RuleVersionView['state'], { label: string; cls: string }> = {
  CURRENT: { label: 'ساري', cls: 'bg-emerald-100 text-emerald-800' },
  FUTURE: { label: 'قادم', cls: 'bg-blue-100 text-blue-800' },
  SUPERSEDED: { label: 'سابق', cls: 'bg-slate-100 text-slate-500' },
};

const ALL_STATUSES: WfStatus[] = ['VERIFIED_PRIMARY', 'CORROBORATED_SECONDARY', 'PROVISIONAL', 'CONFLICTING', 'USER_INPUT', 'MISSING', 'DERIVED'];

interface Draft {
  key: string;
  isNew: boolean;
  domain: string;
  label: string;
  value: string;
  valueJson: string;
  unit: string;
  effectiveFrom: string;
  status: (typeof RULE_INPUT_STATUSES)[number];
  sourceUrl: string;
  sourceQuote: string;
  notes: string;
}

const emptyDraft = (k?: RuleKeyView): Draft => ({
  key: k?.key ?? '',
  isNew: !k,
  domain: k?.domain ?? 'EXPAT_FEES',
  label: k?.label ?? '',
  value: '',
  valueJson: '',
  unit: k?.unit ?? '',
  effectiveFrom: todayKey(),
  status: 'VERIFIED_PRIMARY',
  sourceUrl: '',
  sourceQuote: '',
  notes: '',
});

function VersionRow({ v }: { v: RuleVersionView }) {
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-black ${STATE_LABELS[v.state].cls}`}>{STATE_LABELS[v.state].label}</span>
        <span className="text-[13px] font-black text-slate-800" dir="auto">
          {formatRuleValue(v.value, v.unit)}
        </span>
        <StatusBadge status={v.status} />
        <span className="text-[11.5px] font-bold text-slate-500">{`من ${formatDate(v.effectiveFrom)}`}</span>
      </div>
      {v.sourceQuote && <blockquote className="mt-1.5 border-r-4 border-slate-200 pr-3 text-[12px] font-bold text-slate-600 leading-relaxed">«{v.sourceQuote}»</blockquote>}
      {v.notes && <p className="mt-1 text-[11.5px] font-bold text-slate-500 leading-relaxed">{v.notes}</p>}
      {v.valueJson && v.origin === 'RULE_PARAMETER' && (
        <pre dir="ltr" className="mt-1 max-h-32 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600 whitespace-pre-wrap break-all">
          {v.valueJson}
        </pre>
      )}
      {v.sourceUrl && (
        <a href={v.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] font-black text-indigo-700 hover:underline">
          <ExternalLink size={13} aria-hidden="true" /> المصدر
        </a>
      )}
    </li>
  );
}

export default function RulesPage() {
  const { data, error, loading, reload } = useApi<RulesResponse>('/api/workforce/rules');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const domains = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.domains
      .map((d) => ({
        ...d,
        keys: d.keys.filter((k) => {
          if (statusFilter && !k.versions.some((v) => v.status === statusFilter)) return false;
          if (q && !k.key.toLowerCase().includes(q) && !k.label.toLowerCase().includes(q)) return false;
          return true;
        }),
      }))
      .filter((d) => d.keys.length);
  }, [data, statusFilter, search]);

  const counts = useMemo(() => {
    const c: Partial<Record<WfStatus, number>> = {};
    for (const d of data?.domains ?? []) for (const k of d.keys) for (const v of k.versions) c[v.status] = (c[v.status] ?? 0) + 1;
    return c;
  }, [data]);

  const existingKeys = useMemo(() => (data?.domains ?? []).flatMap((d) => d.keys.filter((k) => k.origin === 'RULE_PARAMETER')), [data]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const ok = await confirmDialog(
      `سيُضاف إصدار جديد للمفتاح ${draft.key} يسري من ${draft.effectiveFrom}. لا يُعدَّل أي إصدار سابق ولا يُحذف: السجل التاريخي ثابت لتبقى الحسابات المحفوظة قابلة للتفسير. تُستخدم القيمة الجديدة في كل الحسابات من تاريخ سريانها.`,
      { title: 'إضافة إصدار جديد', confirmText: 'إضافة الإصدار' },
    );
    if (!ok) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      key: draft.key.trim(),
      effectiveFrom: draft.effectiveFrom,
      status: draft.status,
      ...(draft.value.trim() !== '' ? { value: Number(draft.value) } : {}),
      ...(draft.valueJson.trim() !== '' ? { valueJson: draft.valueJson.trim() } : {}),
      ...(draft.unit.trim() ? { unit: draft.unit.trim() } : {}),
      ...(draft.sourceUrl.trim() ? { sourceUrl: draft.sourceUrl.trim() } : {}),
      ...(draft.sourceQuote.trim() ? { sourceQuote: draft.sourceQuote.trim() } : {}),
      ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
      ...(draft.isNew ? { domain: draft.domain, label: draft.label.trim() } : {}),
    };
    const res = await callApi<{ id: string }>('/api/workforce/rules', { json: body });
    setSaving(false);
    if (res.ok) {
      toast.success('أُضيف الإصدار الجديد');
      setDraft(null);
      reload();
    } else toast.error(res.message);
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <WfPage
      current="/workforce/rules"
      icon={<BookOpenCheck size={24} />}
      title="سجل القواعد والأدلة"
      subtitle="كل قيمة نظامية يستخدمها المحرك بإصداراتها وتواريخ سريانها ومصدرها وحالتها. يُضاف إصدار جديد ولا يُعدَّل التاريخ."
      actions={
        data?.canAddVersion ? (
          <button type="button" className={buttonClass.primary} onClick={() => setDraft(emptyDraft())}>
            <Plus size={16} aria-hidden="true" /> إضافة إصدار جديد
          </button>
        ) : undefined
      }
    >
      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SelectField
            label="الحالة"
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder="كل الحالات"
            options={ALL_STATUSES.filter((s) => counts[s]).map((s) => ({ value: s, label: `${STATUS_LABELS[s]} (${counts[s]})` }))}
          />
          <div>
            <label htmlFor="wf-rule-q" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">بحث بالاسم أو المفتاح</label>
            <input id="wf-rule-q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} className={inputClass} placeholder="مثال: الإقامة" />
          </div>
        </div>
      </Card>

      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock label="جارٍ التحميل…" />}
      {data && !domains.length && <EmptyBlock text="لا توجد قواعد مطابقة." />}

      {domains.map((d) => (
        <Card key={d.domain} title={domainLabel(d.domain)} subtitle={`${d.keys.length} قاعدة`}>
          <ul className="space-y-3">
            {d.keys.map((k) => {
              const shown = k.current ?? k.versions[k.versions.length - 1];
              const future = k.versions.filter((v) => v.state === 'FUTURE');
              return (
                <li key={k.key} className="rounded-2xl border border-slate-200 p-3 sm:p-4">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[14px] font-black text-slate-800 leading-relaxed">{k.label}</h3>
                      <p dir="ltr" className="text-right font-mono text-[11px] text-slate-400 break-all">{k.key}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <span className="text-[15px] font-black text-slate-900" dir="auto">
                        {formatRuleValue(shown.value, shown.unit)}
                      </span>
                      <StatusBadge status={shown.status} />
                      {data?.canAddVersion && k.origin === 'RULE_PARAMETER' && (
                        <button type="button" className="rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-black text-indigo-700 hover:bg-indigo-100" onClick={() => setDraft(emptyDraft(k))} aria-label={`إضافة إصدار جديد: ${k.label}`}>
                          إصدار جديد
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-[11.5px] font-bold text-slate-500">
                    {k.current ? `ساري من ${formatDate(k.current.effectiveFrom)}` : 'لا إصدار ساري اليوم'}
                    {future.length > 0 && ` · ${future.length} إصدار قادم (${future.map((f) => `${formatRuleValue(f.value, f.unit)} من ${formatDate(f.effectiveFrom)}`).join('، ')})`}
                    {k.origin === 'GOSI_RATE' && ' · من جدول نسب التأمينات (يُحدَّث بترحيل قاعدة البيانات، لا من هذه الشاشة)'}
                  </p>
                  {shown.sourceQuote && <blockquote className="mt-2 border-r-4 border-slate-200 pr-3 text-[12px] font-bold text-slate-600 leading-relaxed">«{shown.sourceQuote}»</blockquote>}
                  {shown.sourceUrl && (
                    <a href={shown.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-black text-indigo-700 hover:underline">
                      <ExternalLink size={13} aria-hidden="true" /> المصدر
                    </a>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[12px] font-black text-slate-600">{`كل الإصدارات (${k.versions.length})`}</summary>
                    <ul className="mt-1 divide-y divide-slate-100">
                      {[...k.versions].reverse().map((v) => (
                        <VersionRow key={`${v.key}@${v.effectiveFrom}`} v={v} />
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      <Modal open={!!draft} onClose={() => setDraft(null)} busy={saving} title="إضافة إصدار جديد" description="لا يُعدَّل إصدار سابق: يُضاف إصدار بتاريخ سريانه." tone="indigo" size="lg">
        {draft && (
          <form onSubmit={submit} className="space-y-3 p-5 sm:p-6" noValidate>
            {draft.isNew ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SelectField
                  label="المفتاح"
                  value={existingKeys.some((k) => k.key === draft.key) ? draft.key : ''}
                  onChange={(v) => {
                    const k = existingKeys.find((x) => x.key === v);
                    setDraft(k ? emptyDraft(k) : { ...draft, key: '', isNew: true });
                  }}
                  placeholder="مفتاح جديد…"
                  options={existingKeys.map((k) => ({ value: k.key, label: `${k.label} (${k.key})` }))}
                />
                <div>
                  <label htmlFor="wf-r-key" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">مفتاح جديد (إنجليزي كبير)</label>
                  <input id="wf-r-key" dir="ltr" value={draft.key} onChange={(e) => set('key', e.target.value.toUpperCase())} className={inputClass} placeholder="NEW_RULE_KEY" required />
                </div>
                <SelectField label="المجال" value={draft.domain} onChange={(v) => set('domain', v)} options={['GOSI', 'LABOR_LAW', 'EXPAT_FEES', 'HRDF', 'NITAQAT'].map((x) => ({ value: x, label: domainLabel(x) }))} />
                <div>
                  <label htmlFor="wf-r-label" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">الاسم العربي</label>
                  <input id="wf-r-label" value={draft.label} onChange={(e) => set('label', e.target.value)} className={inputClass} required />
                </div>
              </div>
            ) : (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-[13px] font-black text-slate-800">
                {draft.label} <span dir="ltr" className="font-mono text-[11px] text-slate-400">{draft.key}</span>
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="wf-r-value" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">القيمة</label>
                <input id="wf-r-value" type="number" inputMode="decimal" value={draft.value} onChange={(e) => set('value', e.target.value)} className={inputClass} />
              </div>
              <SelectField label="الوحدة" value={draft.unit} onChange={(v) => set('unit', v)} placeholder="—" options={Object.keys(UNIT_LABELS).map((u) => ({ value: u, label: `${UNIT_LABELS[u] || 'علامة'} (${u})` }))} />
              <div>
                <label htmlFor="wf-r-from" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">يسري من</label>
                <input id="wf-r-from" type="date" value={draft.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} className={inputClass} required />
              </div>
            </div>
            <SelectField label="حالة الدليل" value={draft.status} onChange={(v) => set('status', v as Draft['status'])} options={RULE_INPUT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
            <div>
              <label htmlFor="wf-r-url" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">{draft.status === 'USER_INPUT' ? 'رابط المصدر (اختياري)' : 'رابط المصدر (مطلوب)'}</label>
              <input id="wf-r-url" type="url" dir="ltr" value={draft.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} className={inputClass} placeholder="https://" />
            </div>
            <div>
              <label htmlFor="wf-r-quote" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">الاقتباس من المصدر</label>
              <textarea id="wf-r-quote" rows={2} value={draft.sourceQuote} onChange={(e) => set('sourceQuote', e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="wf-r-notes" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">ملاحظات</label>
              <textarea id="wf-r-notes" rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} className={inputClass} />
            </div>
            <details>
              <summary className="cursor-pointer text-[12px] font-black text-slate-600">قيمة مركّبة (JSON، متقدم)</summary>
              <textarea dir="ltr" aria-label="قيمة مركّبة JSON" rows={3} value={draft.valueJson} onChange={(e) => set('valueJson', e.target.value)} className={`${inputClass} mt-2 font-mono`} />
            </details>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={buttonClass.secondary} onClick={() => setDraft(null)} disabled={saving}>
                إلغاء
              </button>
              <button type="submit" className={buttonClass.primary} disabled={saving}>
                {saving ? 'جارٍ الإضافة…' : 'إضافة الإصدار'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </WfPage>
  );
}

"use client";

// «سجل نطاقات وقرارات التوطين»: the Nitaqat activities with their curve constants (m, c per year) and
// evidence status (AMBIGUOUS rows marked «يحتاج مطابقة مع ملحق الدليل»), and the occupation localization
// decisions with their phases. SUPER_ADMIN adds rows (history immutable: no edit / delete; a correction is
// a new row). GET/POST /api/workforce/nitaqat and /api/workforce/localization-decisions.
import React, { useMemo, useState } from 'react';
import { ExternalLink, Landmark, Plus } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { toast } from '@/components/ui/feedback';
import type { CurveBand } from '@/lib/workforce/nitaqat';
import type { ParsedDecision } from '@/lib/workforce/saudization';
import { callApi, useApi } from '../_components/api';
import { BAND_TEXT, RowStatusBadge } from '../_components/nitaqat-ui';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Segmented, SelectField, WfPage, buttonClass, inputClass } from '../_components/ui';

interface CurveView {
  id: string;
  band: CurveBand;
  year: number;
  m: number;
  c: number;
  status: string;
  page: number | null;
  sourceUrl: string | null;
  note: string | null;
  createdAt: string;
}
interface ActivityView {
  key: string;
  nameAr: string;
  code: string | null;
  sizeSegment: string | null;
  status: string;
  sourceUrl: string | null;
  page: number | null;
  notes: string | null;
  companies: number;
  curves: CurveView[];
}
interface NitaqatResponse {
  canAdd: boolean;
  ambiguousLabel: string;
  bands: CurveBand[];
  years: number[];
  activities: ActivityView[];
}
interface DecisionsResponse {
  canAdd: boolean;
  statusLabels: Record<string, string>;
  decisions: Array<ParsedDecision & { current: boolean; createdAt: string }>;
}

const STATUS_OPTIONS = [
  { value: 'VERIFIED_PRIMARY', label: 'موثّق من المصدر الرسمي' },
  { value: 'AMBIGUOUS', label: 'يحتاج مطابقة مع ملحق الدليل' },
  { value: 'PROVISIONAL', label: 'مؤقت' },
  { value: 'USER_INPUT', label: 'إدخال المنشأة' },
];
const DECISION_STATUS_OPTIONS = [
  { value: 'VERIFIED_PRIMARY', label: 'موثّق' },
  { value: 'PARTIAL', label: 'موثّق جزئياً' },
  { value: 'PROVISIONAL', label: 'مؤقت' },
  { value: 'USER_INPUT', label: 'إدخال المنشأة' },
];
const BANDS: CurveBand[] = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'];

function Input({ id, label, value, onChange, dir, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; dir?: 'ltr'; placeholder?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-extrabold text-slate-600 mb-1.5">{label}</label>
      <input id={id} dir={dir} placeholder={placeholder} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function CurveMatrix({ a, years }: { a: ActivityView; years: number[] }) {
  const cell = (band: CurveBand, year: number) => a.curves.find((c) => c.band === band && c.year === year);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-[12px]">
        <caption className="sr-only">{`ثوابت ${a.nameAr}`}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th scope="col" className="py-1.5 text-right font-black">النطاق</th>
            <th scope="col" className="py-1.5 text-right font-black">m</th>
            {years.map((y) => (
              <th key={y} scope="col" className="py-1.5 text-right font-black">{`c ${y}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BANDS.map((b) => {
            const any = a.curves.find((c) => c.band === b);
            return (
              <tr key={b} className="border-b border-slate-100 font-bold text-slate-700">
                <th scope="row" className="py-1.5 text-right">{BAND_TEXT[b]}</th>
                <td className="py-1.5" dir="ltr">{any ? any.m : '—'}</td>
                {years.map((y) => {
                  const c = cell(b, y);
                  return (
                    <td key={y} className="py-1.5">
                      {c ? <span dir="ltr">{c.c}</span> : '—'}
                      {c && c.status !== 'VERIFIED_PRIMARY' && <span className="mr-1"><RowStatusBadge status={c.status} /></span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AddActivityDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ nameAr: '', code: '', sizeSegment: '', status: 'VERIFIED_PRIMARY', sourceUrl: '', page: '', notes: '', key: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await callApi<{ key: string }>('/api/workforce/nitaqat', { json: { type: 'ACTIVITY', ...f } });
    setBusy(false);
    if (r.ok) {
      toast.success(`أُضيف النشاط (${r.data.key})`);
      onDone();
      onClose();
    } else setErr(r.message);
  };
  return (
    <Modal open={open} onClose={onClose} title="إضافة نشاط نطاقات" tone="emerald" size="lg">
      <form onSubmit={submit} className="space-y-3 p-5">
        <Input id="a-name" label="اسم النشاط كما في ملحق الدليل" value={f.nameAr} onChange={(v) => setF({ ...f, nameAr: v })} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input id="a-code" label="رمز النشاط (الحاسبة)" value={f.code} dir="ltr" onChange={(v) => setF({ ...f, code: v })} />
          <Input id="a-seg" label="شريحة الحجم (إن وُجدت)" value={f.sizeSegment} onChange={(v) => setF({ ...f, sizeSegment: v })} />
          <SelectField label="الحالة" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={STATUS_OPTIONS} />
          <Input id="a-page" label="الصفحة في الدليل" value={f.page} dir="ltr" onChange={(v) => setF({ ...f, page: v })} />
        </div>
        <Input id="a-src" label="رابط المصدر" value={f.sourceUrl} dir="ltr" placeholder="https://" onChange={(v) => setF({ ...f, sourceUrl: v })} />
        <Input id="a-key" label="المفتاح (اختياري، يُولَّد من الاسم)" value={f.key} dir="ltr" onChange={(v) => setF({ ...f, key: v })} />
        <Input id="a-notes" label="ملاحظات (سبب التصحيح إن كان تصحيحاً)" value={f.notes} onChange={(v) => setF({ ...f, notes: v })} />
        {err && <p role="alert" className="text-[12.5px] font-bold text-rose-700">{err}</p>}
        <p className="text-[11.5px] font-bold text-slate-500">السجل لا يُعدَّل ولا يُحذف: التصحيح نشاط جديد بمفتاح جديد.</p>
        <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الحفظ…' : 'إضافة'}</button>
      </form>
    </Modal>
  );
}

function AddCurveDialog({ open, onClose, onDone, activities }: { open: boolean; onClose: () => void; onDone: () => void; activities: ActivityView[] }) {
  const [f, setF] = useState({ activityKey: '', band: 'LOW_GREEN', year: '2026', m: '', c: '', status: 'VERIFIED_PRIMARY', sourceUrl: '', page: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await callApi<{ id: string }>('/api/workforce/nitaqat', { json: { type: 'CURVE', ...f } });
    setBusy(false);
    if (r.ok) {
      toast.success('أُضيفت الثوابت');
      onDone();
      onClose();
    } else setErr(r.message);
  };
  return (
    <Modal open={open} onClose={onClose} title="إضافة ثوابت منحنى" tone="emerald" size="lg">
      <form onSubmit={submit} className="space-y-3 p-5">
        <SelectField label="النشاط" value={f.activityKey} onChange={(v) => setF({ ...f, activityKey: v })} placeholder="اختر" options={activities.map((a) => ({ value: a.key, label: `${a.nameAr}${a.code ? ` (${a.code})` : ''}` }))} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SelectField label="النطاق" value={f.band} onChange={(v) => setF({ ...f, band: v })} options={BANDS.map((b) => ({ value: b, label: BAND_TEXT[b] }))} />
          <Input id="c-year" label="السنة" value={f.year} dir="ltr" onChange={(v) => setF({ ...f, year: v })} />
          <Input id="c-m" label="m" value={f.m} dir="ltr" onChange={(v) => setF({ ...f, m: v })} />
          <Input id="c-c" label="c" value={f.c} dir="ltr" onChange={(v) => setF({ ...f, c: v })} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SelectField label="الحالة" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={STATUS_OPTIONS} />
          <Input id="c-page" label="الصفحة" value={f.page} dir="ltr" onChange={(v) => setF({ ...f, page: v })} />
        </div>
        <Input id="c-src" label="رابط المصدر" value={f.sourceUrl} dir="ltr" placeholder="https://" onChange={(v) => setF({ ...f, sourceUrl: v })} />
        <Input id="c-note" label="ملاحظة" value={f.note} onChange={(v) => setF({ ...f, note: v })} />
        {err && <p role="alert" className="text-[12.5px] font-bold text-rose-700">{err}</p>}
        <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الحفظ…' : 'إضافة'}</button>
      </form>
    </Modal>
  );
}

function AddDecisionDialog({ open, onClose, onDone, correcting }: { open: boolean; onClose: () => void; onDone: () => void; correcting: ParsedDecision | null }) {
  const init = () => ({
    groupNameAr: correcting?.groupNameAr ?? '',
    occupations: correcting?.occupations.join('\n') ?? '',
    phases: correcting ? correcting.phases.map((p) => `${p.pct}@${p.effectiveFrom}${p.minWorkers || p.maxWorkers ? `@${p.minWorkers ?? ''}-${p.maxWorkers ?? ''}` : ''}`).join('\n') : '',
    minEstablishmentSize: correcting?.minEstablishmentSize != null ? String(correcting.minEstablishmentSize) : '',
    minWage: correcting?.minWage != null ? String(correcting.minWage) : '',
    decisionNo: correcting?.decisionNo ?? '',
    decisionDate: correcting?.decisionDate ?? '',
    status: correcting?.status ?? 'VERIFIED_PRIMARY',
    sourceUrl: correcting?.sourceUrl ?? '',
    notes: '',
  });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const phases = f.phases
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [pct, from, size] = l.split('@').map((x) => x.trim());
        const [min, max] = (size ?? '').split('-').map((x) => x.trim());
        return { pct, effectiveFrom: from, ...(min ? { minWorkers: min } : {}), ...(max ? { maxWorkers: max } : {}) };
      });
    setBusy(true);
    setErr(null);
    const r = await callApi<{ id: string }>('/api/workforce/localization-decisions', {
      json: {
        groupNameAr: f.groupNameAr,
        occupations: f.occupations.split(/\n+/).map((x) => x.trim()).filter(Boolean),
        phases,
        minEstablishmentSize: f.minEstablishmentSize,
        minWage: f.minWage,
        decisionNo: f.decisionNo,
        decisionDate: f.decisionDate,
        status: f.status,
        sourceUrl: f.sourceUrl,
        notes: f.notes,
        correctsId: correcting?.id,
      },
    });
    setBusy(false);
    if (r.ok) {
      toast.success('أُضيف القرار');
      onDone();
      onClose();
    } else setErr(r.message);
  };
  return (
    <Modal open={open} onClose={onClose} title={correcting ? `تصحيح: ${correcting.groupNameAr}` : 'إضافة قرار توطين'} tone="emerald" size="lg">
      <form onSubmit={submit} className="space-y-3 p-5">
        <Input id="d-group" label="مجموعة المهن" value={f.groupNameAr} onChange={(v) => setF({ ...f, groupNameAr: v })} />
        <div>
          <label htmlFor="d-occ" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">المهن (سطر لكل مهنة: اسم عربي أو إنجليزي أو رمز)</label>
          <textarea id="d-occ" rows={4} className={inputClass} value={f.occupations} onChange={(e) => setF({ ...f, occupations: e.target.value })} />
        </div>
        <div>
          <label htmlFor="d-ph" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">المراحل (سطر لكل مرحلة: النسبة@تاريخ السريان[@أدنى-أعلى عدد عاملين]، مثل 40@2025-10-27 أو 30@2029-10-27@3-4)</label>
          <textarea id="d-ph" rows={3} dir="ltr" className={inputClass} value={f.phases} onChange={(e) => setF({ ...f, phases: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input id="d-min" label="الحد الأدنى للعاملين في المهن" value={f.minEstablishmentSize} dir="ltr" onChange={(v) => setF({ ...f, minEstablishmentSize: v })} />
          <Input id="d-wage" label="الحد الأدنى للأجر" value={f.minWage} dir="ltr" onChange={(v) => setF({ ...f, minWage: v })} />
          <Input id="d-no" label="رقم القرار" value={f.decisionNo} dir="ltr" onChange={(v) => setF({ ...f, decisionNo: v })} />
          <Input id="d-date" label="تاريخ القرار (YYYY-MM-DD)" value={f.decisionDate} dir="ltr" onChange={(v) => setF({ ...f, decisionDate: v })} />
        </div>
        <SelectField label="الحالة" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={DECISION_STATUS_OPTIONS} />
        <Input id="d-src" label="رابط المصدر" value={f.sourceUrl} dir="ltr" placeholder="https://" onChange={(v) => setF({ ...f, sourceUrl: v })} />
        <Input id="d-notes" label={correcting ? 'ما الذي صُحّح؟ (مطلوب)' : 'ملاحظات'} value={f.notes} onChange={(v) => setF({ ...f, notes: v })} />
        {err && <p role="alert" className="text-[12.5px] font-bold text-rose-700">{err}</p>}
        <p className="text-[11.5px] font-bold text-slate-500">السجل لا يُعدَّل ولا يُحذف: التصحيح سجل جديد يحل محل السابق في الحسابات ويبقى السابق في السجل.</p>
        <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الحفظ…' : 'إضافة'}</button>
      </form>
    </Modal>
  );
}

export default function NitaqatRegisterPage() {
  const [tab, setTab] = useState<'activities' | 'decisions'>('activities');
  const [q, setQ] = useState('');
  const reg = useApi<NitaqatResponse>('/api/workforce/nitaqat');
  const dec = useApi<DecisionsResponse>('/api/workforce/localization-decisions');
  const [dialog, setDialog] = useState<'activity' | 'curve' | 'decision' | null>(null);
  const [correcting, setCorrecting] = useState<ParsedDecision | null>(null);
  const activities = useMemo(() => {
    const k = q.trim();
    return (reg.data?.activities ?? []).filter((a) => !k || a.nameAr.includes(k) || (a.code ?? '').includes(k));
  }, [reg.data, q]);
  const canAdd = !!reg.data?.canAdd;

  return (
    <WfPage
      icon={<Landmark size={24} />}
      title="سجل نطاقات وقرارات التوطين"
      subtitle="ثوابت منحنيات نطاقات المطوّر لكل نشاط وسنة من ملحق الدليل بمرجع الصفحة، وقرارات توطين المهن بمراحلها. السجل لا يُعدَّل: يُضاف إصدار جديد."
      current="/workforce/nitaqat-register"
      actions={
        canAdd ? (
          <>
            <button type="button" className={buttonClass.secondary} onClick={() => setDialog('activity')}><Plus size={14} aria-hidden="true" /> نشاط</button>
            <button type="button" className={buttonClass.secondary} onClick={() => setDialog('curve')}><Plus size={14} aria-hidden="true" /> ثوابت</button>
            <button type="button" className={buttonClass.secondary} onClick={() => { setCorrecting(null); setDialog('decision'); }}><Plus size={14} aria-hidden="true" /> قرار توطين</button>
          </>
        ) : undefined
      }
    >
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Segmented label="العرض" value={tab} onChange={setTab} options={[{ value: 'activities', label: `أنشطة نطاقات (${reg.data?.activities.length ?? 0})` }, { value: 'decisions', label: `قرارات التوطين (${dec.data?.decisions.length ?? 0})` }]} />
          {tab === 'activities' && (
            <div className="min-w-[220px] flex-1">
              <label htmlFor="reg-q" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">بحث بالاسم أو الرمز</label>
              <input id="reg-q" className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
        </div>
      </Card>

      {tab === 'activities' && (
        <>
          {reg.error && <ErrorBlock message={reg.error} onRetry={reg.reload} />}
          {reg.loading && !reg.data && <LoadingBlock label="جارٍ التحميل…" />}
          {reg.data && !activities.length && <EmptyBlock text="لا توجد أنشطة في السجل." />}
          <div className="space-y-3">
            {activities.map((a) => (
              <Card key={a.key}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-black text-slate-900">{a.nameAr}{a.sizeSegment ? ` — ${a.sizeSegment}` : ''}</h2>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] font-bold text-slate-500">
                      {a.code && <span>{`الرمز ${a.code}`}</span>}
                      {a.page && <span>{`صفحة ${a.page}`}</span>}
                      <span>{`${a.companies} شركة`}</span>
                      <span dir="ltr" className="font-mono text-[10.5px] break-all">{a.key}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <RowStatusBadge status={a.status} />
                    {a.sourceUrl && (
                      <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer" className={buttonClass.link}>
                        <ExternalLink size={12} aria-hidden="true" /> المصدر
                      </a>
                    )}
                  </div>
                </div>
                {a.status === 'AMBIGUOUS' && <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-[12px] font-bold text-amber-900">{reg.data?.ambiguousLabel}: لا تُعتمد النتيجة قبل المطابقة.</p>}
                <div className="mt-3">
                  <CurveMatrix a={a} years={reg.data?.years.length ? reg.data.years : [2026, 2027, 2028]} />
                </div>
                {a.notes && <p className="mt-2 text-[11px] font-bold text-slate-400">{a.notes}</p>}
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === 'decisions' && (
        <>
          {dec.error && <ErrorBlock message={dec.error} onRetry={dec.reload} />}
          {dec.loading && !dec.data && <LoadingBlock label="جارٍ التحميل…" />}
          {dec.data && !dec.data.decisions.length && <EmptyBlock text="لا توجد قرارات توطين في السجل." />}
          <div className="space-y-3">
            {dec.data?.decisions.map((d) => (
              <Card key={d.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-black text-slate-900">{d.groupNameAr}</h2>
                    <p className="mt-1 flex flex-wrap gap-2 text-[11.5px] font-bold text-slate-500">
                      {d.decisionNo && <span>{`قرار ${d.decisionNo}`}</span>}
                      {d.decisionDate && <span dir="ltr">{d.decisionDate}</span>}
                      <span>{`الحد الأدنى للعاملين: ${d.minEstablishmentSize ?? 'غير معروف'}`}</span>
                      <span>{`الحد الأدنى للأجر: ${d.minWage ?? 'غير معروف'}`}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <RowStatusBadge status={d.status} />
                    {d.current ? <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10.5px] font-black text-indigo-700">المعتمد في الحساب</span> : <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-black text-slate-500">سابق (حل محله تصحيح)</span>}
                    {canAdd && d.current && (
                      <button type="button" className={buttonClass.link} onClick={() => { setCorrecting(d); setDialog('decision'); }}>
                        تصحيح
                      </button>
                    )}
                  </div>
                </div>
                <ul className="mt-2 space-y-0.5 text-[12.5px] font-bold text-slate-700">
                  {d.phases.map((p, i) => (
                    <li key={i}>
                      <span dir="ltr">{p.pct}%</span>{` من ${p.effectiveFrom}`}
                      {(p.minWorkers || p.maxWorkers) && ` — للمنشآت ${p.minWorkers ?? 1}${p.maxWorkers ? ` إلى ${p.maxWorkers}` : ' فأكثر'} عاملين في المهن`}
                      {p.activity && ` — ${p.activity}`}
                    </li>
                  ))}
                </ul>
                <details className="mt-2 text-[12px] font-bold text-slate-600">
                  <summary className="cursor-pointer text-indigo-700">{`المهن (${d.occupations.length})`}</summary>
                  <p className="mt-1 leading-relaxed">{d.occupations.join('، ')}</p>
                </details>
                {d.parseError && <p className="mt-2 text-[12px] font-bold text-rose-700">{d.parseError}</p>}
                {d.notes && (
                  <details className="mt-1 text-[11.5px] font-bold text-slate-500">
                    <summary className="cursor-pointer">ملاحظات المصدر</summary>
                    <p className="mt-1 whitespace-pre-line">{d.notes}</p>
                  </details>
                )}
                {(d.page || d.sourceUrl) && (
                  <p className="mt-1 text-[11px] font-bold text-slate-400">
                    {d.page ? `صفحة ${d.page}` : ''}
                    {d.sourceUrl && <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer" className="mr-2 text-indigo-700">المصدر</a>}
                  </p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {dialog === 'activity' && <AddActivityDialog open onClose={() => setDialog(null)} onDone={reg.reload} />}
      {dialog === 'curve' && <AddCurveDialog open onClose={() => setDialog(null)} onDone={reg.reload} activities={reg.data?.activities ?? []} />}
      {dialog === 'decision' && <AddDecisionDialog open onClose={() => setDialog(null)} onDone={dec.reload} correcting={correcting} />}
    </WfPage>
  );
}

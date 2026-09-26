"use client";

// «خطة القوى العاملة»: the plans (versions) with their status, a new plan, and the side-by-side comparison
// of 2–3 versions (?compare=a,b[,c]). GET /api/workforce/plans, POST /api/workforce/plans,
// GET /api/workforce/plans/compare. A plan is scenario data: nothing is written to the employee file or payroll.
import React, { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ClipboardList, GitCompare, Plus } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { toast } from '@/components/ui/feedback';
import { formatDate, todayKey } from '@/lib/dates';
import { PLAN_MONTHS, PLAN_STATUSES, PLAN_STATUS_LABELS, POSITION_KIND_LABELS, type PlanCompareColumn, type PlanStatus, type PositionKind } from '@/lib/workforce/planning';
import { callApi, useApi } from '../_components/api';
import type { OptionsResponse } from '../_components/types';
import { BandBadge } from '../_components/nitaqat-ui';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Money, Num, Segmented, SelectField, WfPage, buttonClass, inputClass } from '../_components/ui';
import { PlanStatusBadge } from './_components/plan-ui';

interface PlanListItem {
  id: string;
  name: string;
  status: PlanStatus;
  statusLabel: string;
  companyId: string | null;
  companyName: string | null;
  fromMonth: string;
  months: number;
  attritionPct: number | null;
  basedOnId: string | null;
  basedOnName: string | null;
  createdByName: string | null;
  createdAt: string;
  submittedAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** «اعتمدها» / «رفضها» of decidedBy (an archived plan keeps its decision). */
  decisionLabel: string | null;
  archivedByName: string | null;
  archivedAt: string | null;
  positionsCount: number;
  raisesCount: number;
}

interface ListResponse {
  total: number;
  items: PlanListItem[];
}

function NewPlanDialog({ open, onClose, companies }: { open: boolean; onClose: () => void; companies: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [fromMonth, setFromMonth] = useState(() => {
    const [y, m] = todayKey().slice(0, 7).split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  });
  const [months, setMonths] = useState<number>(12);
  const [attrition, setAttrition] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await callApi<{ id: string }>('/api/workforce/plans', { json: { name, companyId: companyId || null, fromMonth, months, attritionPct: attrition === '' ? null : attrition, notes } });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    toast.success('أُنشئت الخطة مسودةً');
    router.push(`/workforce/plans/${encodeURIComponent(r.data.id)}`);
  };
  return (
    <Modal open={open} onClose={onClose} title="خطة جديدة" tone="indigo" size="md" busy={busy}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <div>
          <label htmlFor="np-name" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">اسم الخطة</label>
          <input id="np-name" className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
        </div>
        <SelectField label="الشركة القانونية (نطاق الخطة)" value={companyId} onChange={setCompanyId} placeholder="كل الشركات" options={companies.map((c) => ({ value: c.id, label: c.name }))} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <div>
            <label htmlFor="np-from" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">أول شهر</label>
            <input id="np-from" type="month" className={inputClass} value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} required />
          </div>
          <Segmented label="المدة" value={months} options={PLAN_MONTHS.map((m) => ({ value: m, label: `${m} شهراً` }))} onChange={setMonths} />
        </div>
        <div>
          <label htmlFor="np-attr" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">الدوران السنوي المفترض %</label>
          <input id="np-attr" inputMode="decimal" className={inputClass} value={attrition} placeholder="فارغ = الدوران الفعلي للمنشأة آخر 12 شهراً" onChange={(e) => setAttrition(e.target.value)} />
        </div>
        <div>
          <label htmlFor="np-notes" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">ملاحظات</label>
          <textarea id="np-notes" rows={2} className={inputClass} value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-[12.5px] font-bold text-rose-800">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء المسودة'}</button>
          <button type="button" onClick={onClose} className={buttonClass.secondary}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

const WINDOW_LABELS: Record<string, string> = { '12': '12 شهراً', '24': '24 شهراً', '36': '36 شهراً' };

function CompareView({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<{ columns: PlanCompareColumn[] }>(`/api/workforce/plans/compare?ids=${ids.map(encodeURIComponent).join(',')}`);
  const cols = useMemo(() => data?.columns ?? [], [data]);
  const windows = ['12', '24', '36'].filter((w) => cols.some((c) => c.totals[w as '12']));
  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cols) for (const n of c.nitaqat) m.set(n.companyId, n.name);
    return [...m.entries()];
  }, [cols]);
  return (
    <Card title="مقارنة النسخ" subtitle="العمود الأول هو المرجع. الإجمالي بعد دعم هدف ومع تكاليف الخروج والدوران المتوقع. الخطط المعتمدة بتوقعها المجمّد عند الاعتماد." actions={<button type="button" onClick={onClose} className={buttonClass.link}>إغلاق المقارنة</button>}>
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock />}
      {cols.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[12.5px]">
            <caption className="sr-only">مقارنة خطط القوى العاملة</caption>
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th scope="col" className="py-2 px-2 text-right font-black">البند</th>
                {cols.map((c) => (
                  <th key={c.planId} scope="col" className="py-2 px-2 text-right font-black">
                    <Link href={`/workforce/plans/${encodeURIComponent(c.planId)}`} className="text-indigo-700 hover:underline">{c.name}</Link>
                    <div className="mt-1"><PlanStatusBadge status={c.status} /></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
              <tr>
                <th scope="row" className="py-2 px-2 text-right text-slate-500">الفترة</th>
                {cols.map((c) => <td key={c.planId} className="py-2 px-2" dir="ltr">{`${c.fromMonth} · ${c.months}`}</td>)}
              </tr>
              {windows.map((w) => (
                <React.Fragment key={w}>
                  <tr>
                    <th scope="row" className="py-2 px-2 text-right text-slate-500">{`الإجمالي بعد الدعم — ${WINDOW_LABELS[w]}`}</th>
                    {cols.map((c) => <td key={c.planId} className="py-2 px-2 text-slate-900">{c.totals[w as '12'] ? <Money value={c.totals[w as '12']!.totalAfterHrdf} /> : '—'}</td>)}
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 px-2 text-right text-slate-500">{`ما تضيفه الخطة — ${WINDOW_LABELS[w]}`}</th>
                    {cols.map((c) => <td key={c.planId} className="py-2 px-2">{c.totals[w as '12'] ? <Money value={c.totals[w as '12']!.deltaAfterHrdf} /> : '—'}</td>)}
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 px-2 text-right text-slate-500">{`الفرق عن الأولى — ${WINDOW_LABELS[w]}`}</th>
                    {cols.map((c) => <td key={c.planId} className={`py-2 px-2 ${(c.vsFirst[w as '12'] ?? 0) > 0 ? 'text-rose-700' : (c.vsFirst[w as '12'] ?? 0) < 0 ? 'text-green-700' : ''}`}>{c.vsFirst[w as '12'] !== undefined ? <Money value={c.vsFirst[w as '12']} /> : '—'}</td>)}
                  </tr>
                </React.Fragment>
              ))}
              <tr>
                <th scope="row" className="py-2 px-2 text-right text-slate-500">العدد في البداية ← النهاية</th>
                {cols.map((c) => <td key={c.planId} className="py-2 px-2"><Num value={c.headcount.start?.total} /> ← <Num value={c.headcount.end?.total} /> <span className="text-[11px] text-slate-500">{`(سعودي ${c.headcount.end?.saudi ?? 0}، وافد ${c.headcount.end?.expat ?? 0})`}</span></td>)}
              </tr>
              <tr>
                <th scope="row" className="py-2 px-2 text-right text-slate-500">البنود</th>
                {cols.map((c) => <td key={c.planId} className="py-2 px-2 text-[11.5px]">{(Object.keys(c.positions) as PositionKind[]).map((k) => `${POSITION_KIND_LABELS[k]} ${c.positions[k]}`).join('، ')}{`، زيادات ${c.raises}`}</td>)}
              </tr>
              {companies.map(([cid, cname]) => (
                <tr key={cid}>
                  <th scope="row" className="py-2 px-2 text-right text-slate-500">{`نطاقات ${cname} نهاية كل سنة`}</th>
                  {cols.map((c) => {
                    const n = c.nitaqat.find((x) => x.companyId === cid);
                    return (
                      <td key={c.planId} className="py-2 px-2">
                        {n ? n.years.map((y) => <span key={y.yearIndex} className="me-2 inline-flex items-center gap-1 whitespace-nowrap">{`س${y.yearIndex}`} <BandBadge band={y.band} /> {y.pct !== null && <span dir="ltr">{y.pct}%</span>}</span>) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PlansContent() {
  const router = useRouter();
  const params = useSearchParams();
  const compare = (params.get('compare') ?? '').split(',').filter(Boolean).slice(0, 3);
  const [status, setStatus] = useState<'' | PlanStatus>('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const options = useApi<OptionsResponse>('/api/workforce/options');
  const list = useApi<ListResponse>(`/api/workforce/plans?take=200${status ? `&status=${status}` : ''}`);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 3 ? p : [...p, id]));
  return (
    <WfPage
      icon={<ClipboardList size={24} />}
      title="خطة القوى العاملة"
      subtitle="نسخ الخطة: التعيينات والإحلال والخروج المخطط والزيادات المؤرخة، وتوقع الكلفة والعدد ونطاقات شهراً بشهر، ثم الاعتماد بمبدأ الفصل بين المُعِدّ والمعتمِد، والمخطط مقابل الفعلي من الرواتب. الخطة سيناريو: لا تُكتب في ملف الموظف ولا المسير."
      current="/workforce/plans"
      actions={
        <button type="button" onClick={() => setOpen(true)} className={buttonClass.primary}>
          <Plus size={15} aria-hidden="true" /> خطة جديدة
        </button>
      }
    >
      {compare.length >= 2 && <CompareView ids={compare} onClose={() => router.push('/workforce/plans')} />}
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Segmented label="الحالة" value={status} options={[{ value: '' as const, label: 'الكل' }, ...PLAN_STATUSES.map((s) => ({ value: s, label: PLAN_STATUS_LABELS[s] }))]} onChange={setStatus} />
          <button type="button" disabled={picked.length < 2} onClick={() => router.push(`/workforce/plans?compare=${picked.map(encodeURIComponent).join(',')}`)} className={buttonClass.secondary}>
            <GitCompare size={15} aria-hidden="true" /> {`قارن المحدد (${picked.length})`}
          </button>
        </div>
        <p className="mt-2 text-[11.5px] font-bold text-slate-500">حدّد خطتين أو ثلاثاً للمقارنة جنباً إلى جنب.</p>
      </Card>
      {list.error && <ErrorBlock message={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <LoadingBlock label="جارٍ التحميل…" />}
      {list.data && !list.data.items.length && <EmptyBlock text="لا توجد خطط بعد. أنشئ خطة جديدة ثم أضف التعيينات والخروج والزيادات." />}
      {list.data && list.data.items.length > 0 && (
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {list.data.items.map((p) => (
            <li key={p.id} className="rounded-3xl border border-slate-100 bg-white p-4 shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/workforce/plans/${encodeURIComponent(p.id)}`} className="text-[15px] font-black text-slate-900 hover:text-indigo-700 break-words">{p.name}</Link>
                  <p className="mt-1 text-[12px] font-bold text-slate-500">
                    {p.companyName ?? 'كل الشركات'} · <span dir="ltr">{p.fromMonth}</span> · {`${p.months} شهراً`}
                  </p>
                </div>
                <PlanStatusBadge status={p.status} />
              </div>
              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px] font-bold">
                <div><dt className="text-slate-400">البنود</dt><dd className="text-slate-800"><Num value={p.positionsCount} /></dd></div>
                <div><dt className="text-slate-400">الزيادات</dt><dd className="text-slate-800"><Num value={p.raisesCount} /></dd></div>
                <div><dt className="text-slate-400">الدوران</dt><dd className="text-slate-800">{p.attritionPct === null ? 'الفعلي' : <span dir="ltr">{p.attritionPct}%</span>}</dd></div>
                <div><dt className="text-slate-400">أنشأها</dt><dd className="text-slate-800 truncate">{p.createdByName ?? '—'}</dd></div>
              </dl>
              {p.basedOnName && <p className="mt-2 text-[11.5px] font-bold text-slate-500">{`نسخة من «${p.basedOnName}»`}</p>}
              {p.decidedAt && <p className="mt-1 text-[11.5px] font-bold text-slate-500">{`${p.decisionLabel ?? 'قرّر فيها'} ${p.decidedByName ?? '—'} في ${formatDate(p.decidedAt)}`}{p.decisionNote ? `: ${p.decisionNote}` : ''}</p>}
              {p.archivedAt && <p className="mt-1 text-[11.5px] font-bold text-slate-500">{`أرشفها ${p.archivedByName ?? '—'} في ${formatDate(p.archivedAt)}`}</p>}
              <label className="mt-3 inline-flex items-center gap-2 text-[12px] font-bold text-slate-600">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} disabled={!picked.includes(p.id) && picked.length >= 3} /> للمقارنة
              </label>
            </li>
          ))}
        </ul>
      )}
      <NewPlanDialog open={open} onClose={() => setOpen(false)} companies={options.data?.companies ?? []} />
    </WfPage>
  );
}

export default function PlansPage() {
  return (
    <Suspense fallback={<LoadingBlock label="جارٍ التحميل…" />}>
      <PlansContent />
    </Suspense>
  );
}

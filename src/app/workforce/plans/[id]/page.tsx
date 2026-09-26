"use client";

// One workforce plan («خطة القوى العاملة»): status bar (submit / approve / reject with maker-checker, archive,
// copy, snapshot, compare), the projection (totals 12 / 24 / 36 before and after HRDF, monthly series, head
// count by nationality, composition with «لماذا؟», Nitaqat and levy tiers per company at every plan year
// end, flags), the plan items (positions and raises with their dialogs) and plan vs actual from payroll.
// Data: /api/workforce/plans/[id] (+ /actual). Display only: every number comes from the engine.
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Archive, CheckCircle2, ClipboardList, Copy, GitCompare, Pencil, Plus, Save, Send, Trash2, XCircle } from 'lucide-react';
import { confirmDialog, promptDialog, toast } from '@/components/ui/feedback';
import { formatDateTime, todayKey } from '@/lib/dates';
import {
  PLAN_EXIT_REASON_LABELS,
  PLAN_NATIONALITY_LABELS,
  PVA_DRIVER_LABELS,
  arabicMonths,
  type PlanItemResult,
  type PlanNationalityClass,
  type PlanRaiseResult,
  type PlanVsActualResult,
  type PlanWindowKey,
  type PositionKind,
} from '@/lib/workforce/planning';
import type { EmployeeExitReason } from '@/lib/workforce/reasons';
import { FLAG_TITLES } from '@/app/api/workforce/_lib/shared';
import { callApi, useApi } from '../../_components/api';
import type { OptionsResponse } from '../../_components/types';
import { BandBadge } from '../../_components/nitaqat-ui';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Money, Num, Segmented, SelectField, SeriesChart, WfPage, WhyButton, WhyDialog, buttonClass, inputClass, type WhyContent } from '../../_components/ui';
import { HeaderDialog, ItemWhyDialog, PlanStatusBadge, PositionDialog, RaiseDialog, SEVERITY_CLASS, type Lookups, type PlanDetailResponse, type PositionRow, type RaiseRow } from '../_components/plan-ui';

type Tab = 'projection' | 'items' | 'actual';
type Projection = PlanDetailResponse['projection'];

const WINDOW_TEXT: Record<PlanWindowKey, string> = { '12': '12 شهراً', '24': '24 شهراً', '36': '36 شهراً', horizon: 'مدة الخطة' };

function windowKeys(p: Projection): PlanWindowKey[] {
  const ks = (['12', '24', '36'] as const).filter((k) => p.totals[k]);
  return ks.length ? ks : ['horizon'];
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function StatusBar({ d, onChanged, lookups }: { d: PlanDetailResponse; onChanged: () => void; lookups: Array<{ id: string; name: string; status: string }> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const p = d.plan;
  const perms = d.permissions;
  const run = async (action: 'submit' | 'approve' | 'reject' | 'archive', note?: string) => {
    setBusy(action);
    const r = await callApi<{ statusLabel: string }>(`/api/workforce/plans/${encodeURIComponent(p.id)}/${action}`, { json: note ? { note } : {} });
    setBusy(null);
    if (!r.ok) return toast.error(r.message);
    toast.success(`الخطة الآن: ${r.data.statusLabel}`);
    onChanged();
  };
  const submit = async () => {
    if (await confirmDialog('تُقدَّم الخطة للاعتماد ولا تُعدَّل حتى يُتخذ القرار. يعتمدها المالك أو صاحب العمل (غير من أعدّها أو قدّمها).', { title: 'تقديم للاعتماد', confirmText: 'تقديم' })) await run('submit');
  };
  const approve = async () => {
    if (await confirmDialog('يُحفظ توقع الخطة كما هو الآن مرجعاً للمخطط مقابل الفعلي، وتصبح الخطة للقراءة فقط. لا يُكتب شيء في الرواتب.', { title: 'اعتماد الخطة', confirmText: 'اعتماد' })) await run('approve');
  };
  const reject = async () => {
    const note = await promptDialog('سبب الرفض (يظهر لمن أعدّ الخطة):', { title: 'رفض الخطة', confirmText: 'رفض', danger: true, placeholder: 'مثلاً: خفّض تعيينات الربع الأول' });
    if (note !== null) {
      if (!note.trim()) return toast.error('اكتب سبب الرفض');
      await run('reject', note.trim());
    }
  };
  const archive = async () => {
    if (await confirmDialog('تُؤرشف الخطة وتبقى للقراءة.', { title: 'أرشفة', confirmText: 'أرشفة' })) await run('archive');
  };
  const copy = async () => {
    setBusy('copy');
    const r = await callApi<{ id: string }>(`/api/workforce/plans/${encodeURIComponent(p.id)}/copy`, { json: {} });
    setBusy(null);
    if (!r.ok) return toast.error(r.message);
    toast.success('أُنشئت نسخة جديدة (مسودة)');
    router.push(`/workforce/plans/${encodeURIComponent(r.data.id)}`);
  };
  const snapshot = async () => {
    setBusy('snap');
    const r = await callApi<{ id: string }>('/api/workforce/calculations', { json: { kind: 'WORKFORCE_PLAN', params: { planId: p.id } } });
    setBusy(null);
    if (r.ok) toast.success('حُفظت لقطة من الخطة في «الحسابات المحفوظة».');
    else toast.error(r.message);
  };
  const steps = [
    { label: 'أنشأها', who: p.createdByName, at: p.createdAt },
    ...(p.submittedAt ? [{ label: 'قدّمها', who: p.submittedByName, at: p.submittedAt }] : []),
    ...(p.decidedAt ? [{ label: p.decisionLabel ?? 'قرّر فيها', who: p.decidedByName, at: p.decidedAt }] : []),
    ...(p.archivedAt ? [{ label: 'أرشفها', who: p.archivedByName, at: p.archivedAt }] : []),
  ];
  return (
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-black text-slate-800">
            <PlanStatusBadge status={p.status} />
            {p.basedOn && (
              <span className="text-[12px] font-bold text-slate-500">
                نسخة من <Link href={`/workforce/plans/${encodeURIComponent(p.basedOn.id)}`} className="text-indigo-700 hover:underline">{p.basedOn.name}</Link>
              </span>
            )}
          </p>
          <ol className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-bold text-slate-500">
            {steps.map((s) => (
              <li key={s.label}>{`${s.label}: ${s.who ?? '—'} (${formatDateTime(s.at)})`}</li>
            ))}
          </ol>
          {p.decisionNote && <p className={`rounded-xl px-3 py-1.5 text-[12px] font-bold ${p.status === 'REJECTED' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>{`ملاحظة القرار: ${p.decisionNote}`}</p>}
          {perms.decideReason && <p className="text-[11.5px] font-bold text-amber-800">{perms.decideReason}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {perms.submit && <button type="button" disabled={!!busy} onClick={submit} className={buttonClass.primary}><Send size={15} aria-hidden="true" /> تقديم للاعتماد</button>}
          {perms.approve && <button type="button" disabled={!!busy} onClick={approve} className={buttonClass.primary}><CheckCircle2 size={15} aria-hidden="true" /> اعتماد</button>}
          {perms.reject && <button type="button" disabled={!!busy} onClick={reject} className={buttonClass.secondary}><XCircle size={15} aria-hidden="true" /> رفض</button>}
          {perms.copy && <button type="button" disabled={!!busy} onClick={copy} className={buttonClass.secondary}><Copy size={15} aria-hidden="true" /> نسخة جديدة</button>}
          <button type="button" disabled={!!busy} onClick={snapshot} className={buttonClass.secondary}><Save size={15} aria-hidden="true" /> حفظ لقطة</button>
          {perms.archive && <button type="button" disabled={!!busy} onClick={archive} className={buttonClass.secondary}><Archive size={15} aria-hidden="true" /> أرشفة</button>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
        <SelectField className="min-w-[220px]" label="قارن مع نسخة أخرى" value={other} onChange={setOther} placeholder="اختر خطة" options={lookups.filter((x) => x.id !== p.id).map((x) => ({ value: x.id, label: `${x.name} (${x.status})` }))} />
        <button type="button" disabled={!other} onClick={() => router.push(`/workforce/plans?compare=${encodeURIComponent(p.id)},${encodeURIComponent(other)}`)} className={buttonClass.secondary}>
          <GitCompare size={15} aria-hidden="true" /> قارن
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function ProjectionTab({ p, onWhy }: { p: Projection; onWhy: (w: WhyContent) => void }) {
  const keys = windowKeys(p);
  const explain = (key: string, amount: number, title?: string) => {
    const ex = p.explanations[key];
    onWhy({ title: title ?? ex?.label ?? key, amount, basis: ex?.basis ?? null, formulaText: ex?.formulaText ?? null, evidence: ex?.rules ?? [] });
  };
  const yearRows = useMemo(() => {
    const idx = new Set<number>([0]);
    for (let i = 11; i < p.series.length; i += 12) idx.add(i);
    idx.add(p.series.length - 1);
    return [...idx].sort((a, b) => a - b).map((i) => p.series[i]);
  }, [p.series]);
  return (
    <div className="space-y-5">
      <div className={`grid grid-cols-1 ${keys.length === 3 ? 'md:grid-cols-3' : keys.length === 2 ? 'md:grid-cols-2' : ''} gap-3`}>
        {keys.map((k) => {
          const w = p.totals[k]!;
          const row = (label: string, v: number, key?: string, cls = '') => (
            <div className={`flex items-center justify-between gap-2 ${cls}`}>
              <dt className="flex items-center gap-1.5">{label}{key && v !== 0 && <WhyButton label={label} onClick={() => explain(key, v)} />}</dt>
              <dd><Money value={v} /></dd>
            </div>
          );
          return (
            <section key={k} className="rounded-3xl border border-slate-100 bg-white p-4 shadow-[0_10px_30px_rgba(0,0,0,0.02)]">
              <p className="text-[12px] font-black text-indigo-700">{`${WINDOW_TEXT[k]}: الإجمالي بعد دعم هدف`}</p>
              <p className="mt-1 text-[24px] font-black text-slate-900"><Money value={w.totalAfterHrdf} /></p>
              <dl className="mt-3 space-y-1 text-[12px] font-bold text-slate-600">
                {row('كلفة صاحب العمل', w.cost)}
                {row('دعم هدف (مشروط)', w.subsidy, 'HRDF_SUBSIDY', 'text-green-700')}
                {row('تكاليف الخروج لمرة واحدة', w.exitOneOff, 'EXIT_ONE_OFF')}
                {row('استرداد مخصص نهاية الخدمة', w.exitAccrualRelease, 'EXIT_ACCRUAL_RELEASE')}
                {row('الدوران المتوقع (إحصائي)', w.attrition.net, 'ATTRITION')}
                {row('الإجمالي قبل الدعم', w.totalBeforeHrdf, undefined, 'border-t border-slate-100 pt-1 text-slate-800')}
                {row('دون الخطة (القوى الحالية)', w.baseline.net)}
                {row('ما تضيفه الخطة', w.deltaAfterHrdf, undefined, w.deltaAfterHrdf > 0 ? 'text-rose-700' : 'text-green-700')}
              </dl>
            </section>
          );
        })}
      </div>

      <Card title="الكلفة شهراً بشهر" subtitle="قبل الدعم وبعده، مع تكاليف الخروج والدوران المتوقع.">
        <SeriesChart title="إجمالي الخطة" series={p.series.map((m) => ({ month: m.month, cost: m.totalBeforeHrdf, net: m.totalAfterHrdf }))} />
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] font-black text-indigo-700">جدول الأشهر</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12px]">
              <caption className="sr-only">الأشهر</caption>
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  {['الشهر', 'العدد', 'الكلفة', 'بعد الدعم', 'لمرة واحدة', 'استرداد المخصص', 'الدوران', 'الإجمالي بعد الدعم', 'دون الخطة'].map((h) => <th key={h} scope="col" className="py-2 px-2 text-right font-black">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                {p.series.map((m) => (
                  <tr key={m.month}>
                    <td className="py-1.5 px-2" dir="ltr">{m.month}</td>
                    <td className="py-1.5 px-2"><Num value={m.headcount.total} /></td>
                    <td className="py-1.5 px-2"><Money value={m.cost} unit={false} /></td>
                    <td className="py-1.5 px-2"><Money value={m.net} unit={false} /></td>
                    <td className="py-1.5 px-2"><Money value={m.exitOneOff} unit={false} /></td>
                    <td className="py-1.5 px-2"><Money value={m.exitAccrualRelease} unit={false} /></td>
                    <td className="py-1.5 px-2"><Money value={m.attrition.net} unit={false} /></td>
                    <td className="py-1.5 px-2 text-slate-900"><Money value={m.totalAfterHrdf} unit={false} /></td>
                    <td className="py-1.5 px-2 text-slate-500"><Money value={m.baseline.net} unit={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <Card title="العدد حسب الجنسية" subtitle="العدد المسمّى (الموظفون الحاليون + تعيينات الخطة − الخروج المخطط). الدوران المتوقع عدد إحصائي لا يُحذف من العدد.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <caption className="sr-only">العدد في بداية الخطة ونهاية كل سنة</caption>
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                {['الشهر', 'العدد', 'سعودي', 'خليجي', 'وافد', 'تعيينات الخطة', 'خروج مخطط', 'مغادرون متوقعون', 'دون الخطة'].map((h) => <th key={h} scope="col" className="py-2 px-2 text-right font-black">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
              {yearRows.map((m) => (
                <tr key={m.month}>
                  <td className="py-2 px-2" dir="ltr">{m.month}</td>
                  <td className="py-2 px-2 text-slate-900"><Num value={m.headcount.total} /></td>
                  <td className="py-2 px-2"><Num value={m.headcount.saudi} /></td>
                  <td className="py-2 px-2"><Num value={m.headcount.gcc} /></td>
                  <td className="py-2 px-2"><Num value={m.headcount.expat} /></td>
                  <td className="py-2 px-2"><Num value={m.headcount.hires} /></td>
                  <td className="py-2 px-2"><Num value={m.headcount.plannedExits} /></td>
                  <td className="py-2 px-2"><Num value={m.expectedLeavers} /></td>
                  <td className="py-2 px-2 text-slate-500"><Num value={m.baseline.headcount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="تركيبة الكلفة طوال الخطة" subtitle="كل بند بمعادلته ومصدره في «لماذا؟».">
        <ul className="divide-y divide-slate-100">
          {p.composition.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px] font-bold">
              <span className="text-slate-700">
                {c.label}
                {c.kind === 'MEMO' && <span className="text-slate-400"> (للعلم، غير محسوب)</span>}
                {c.kind === 'SUBSIDY' && <span className="text-green-700"> (مشروط بقبول هدف)</span>}
                {c.kind === 'PLAN' && <span className="text-indigo-600"> (بند الخطة)</span>}
              </span>
              <span className="flex items-center gap-2">
                <Money value={c.horizon} className={c.horizon < 0 ? 'text-green-700' : 'text-slate-900'} />
                <WhyButton label={c.label} onClick={() => explain(c.key, c.horizon, c.label)} />
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="نطاقات والمقابل المالي نهاية كل سنة" subtitle="تقدير لحظي بالعمالة والأجور المخططة، بجانب القوى الحالية دون الخطة. المرجع الرسمي منصة قوى.">
        {!p.companies.length && <EmptyBlock text="لا شركات قانونية في نطاق الخطة" />}
        <div className="space-y-4">
          {p.companies.map((c) => (
            <div key={c.companyId}>
              <h3 className="text-[13px] font-black text-slate-800">{c.name}</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[640px] text-[12.5px]">
                  <caption className="sr-only">{`نطاقات ${c.name}`}</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      {['السنة', 'بالخطة', 'دون الخطة', 'المقابل المالي الشهري بالخطة', 'دونها', 'شرائح الوافدين بالخطة (700 / 800 / معفى)'].map((h) => <th key={h} scope="col" className="py-2 px-2 text-right font-black">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {c.years.map((y) => (
                      <tr key={y.yearIndex}>
                        <td className="py-2 px-2">{`${y.yearIndex} (`}<span dir="ltr">{y.month}</span>)</td>
                        <td className="py-2 px-2">
                          {y.nitaqat ? (y.nitaqat.plan.band ? <span className="inline-flex items-center gap-1.5"><BandBadge band={y.nitaqat.plan.band} /> <span dir="ltr">{y.nitaqat.plan.pct}%</span> <span className="text-slate-400">{`X=${y.nitaqat.plan.x}`}</span></span> : <span className="text-slate-500">{y.nitaqat.plan.message ?? '—'}</span>) : '—'}
                          {y.nitaqat?.change === 'DOWN' && <span className="mr-1 text-rose-700">هبوط</span>}
                          {y.nitaqat?.change === 'UP' && <span className="mr-1 text-green-700">صعود</span>}
                        </td>
                        <td className="py-2 px-2">{y.nitaqat?.baseline.band ? <span className="inline-flex items-center gap-1.5"><BandBadge band={y.nitaqat.baseline.band} /> <span dir="ltr">{y.nitaqat.baseline.pct}%</span></span> : '—'}</td>
                        <td className="py-2 px-2"><Money value={y.levy.plan.levyTotal} /></td>
                        <td className="py-2 px-2 text-slate-500"><Money value={y.levy.baseline.levyTotal} /></td>
                        <td className="py-2 px-2" dir="ltr">{`${y.levy.plan.within} / ${y.levy.plan.above} / ${y.levy.plan.exempt}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11.5px] font-bold text-slate-500">
                {'أثر الخطة على المقابل المالي للكيان: '}
                {(['12', '24', '36', 'horizon'] as const).filter((k) => c.levyDelta[k] !== undefined && (k !== 'horizon' || !keys.includes(String(p.months) as PlanWindowKey))).map((k) => (
                  <span key={k} className="me-3 inline-block">{`${WINDOW_TEXT[k]}: `}<Money value={c.levyDelta[k]} /></span>
                ))}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {(p.flags.length > 0 || p.engineFlags.length > 0) && (
        <Card title="تنبيهات الخطة">
          <ul className="space-y-1.5">
            {p.flags.map((f, i) => <li key={`${f.code}-${i}`} className={`rounded-xl border px-3 py-2 text-[12px] font-bold ${SEVERITY_CLASS[f.severity]}`}>{f.message}</li>)}
            {p.engineFlags.map((f) => (
              <li key={f.code} className={`rounded-xl border px-3 py-2 text-[12px] font-bold ${SEVERITY_CLASS[f.severity]}`}>
                {`${FLAG_TITLES[f.code as keyof typeof FLAG_TITLES] ?? f.code} (${f.count})`}
                {f.message && <span className="block text-[11px] opacity-80">{f.message}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="الافتراضات">
        <ul className="list-disc space-y-1 pr-5 text-[12px] font-bold text-slate-600">
          {p.assumptions.map((a) => <li key={a}>{a}</li>)}
          <li>{`الدوران: ${p.attrition.basis || 'لا دوران'}`}</li>
        </ul>
        <p className="mt-2 text-[11px] font-bold text-slate-400" dir="ltr">{`${p.engineVersion} · ${p.planEngineVersion}`}</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items (positions and raises)
// ---------------------------------------------------------------------------

function ItemsTab({ d, onReload, lookups, onWhy }: { d: PlanDetailResponse; onReload: () => void; lookups: Lookups; onWhy: (w: WhyContent) => void }) {
  const [posDlg, setPosDlg] = useState<{ kind: PositionKind; editing: PositionRow | null; prefill: Partial<PositionRow> | null; key: number } | null>(null);
  const [raiseDlg, setRaiseDlg] = useState<{ editing: RaiseRow | null; key: number } | null>(null);
  const [itemWhy, setItemWhy] = useState<PlanItemResult | null>(null);
  const edit = d.permissions.edit;
  const p = d.projection;
  const items = new Map(p.items.map((i) => [i.positionId, i]));
  const raiseRes = new Map(p.raises.map((r) => [r.raiseId, r]));
  const firstWindow = windowKeys(p)[0];
  const del = async (url: string, what: string) => {
    if (!(await confirmDialog(`حذف ${what} من الخطة؟`, { title: 'حذف', confirmText: 'حذف', danger: true }))) return;
    const r = await callApi(url, { method: 'DELETE' });
    if (!r.ok) return toast.error(r.message);
    toast.success('حُذف');
    onReload();
  };
  const scopeName = (r: RaiseRow) => (r.scope === 'ALL' ? 'كل موظفي الخطة' : r.scope === 'COMPANY' ? d.names.companies[r.scopeId ?? ''] : r.scope === 'DEPARTMENT' ? d.names.departments[r.scopeId ?? ''] : d.names.employees[r.scopeId ?? '']) ?? r.scopeId ?? '—';
  const raiseWhy = (r: RaiseRow, res: PlanRaiseResult | undefined) =>
    onWhy({ title: `زيادة ${scopeName(r)}`, amount: res?.basicDeltaTotal ?? 0, basis: res?.why.join(' ') ?? null, formulaText: r.pct !== null ? 'النسبة × الأساسي في شهر السريان، وتبقى الزيادة فوق تغييرات الراتب المؤرخة اللاحقة' : 'المبلغ يُضاف إلى الأساسي من شهر السريان', note: res?.flags.map((f) => f.message).join(' ') || null, status: 'USER_INPUT', evidence: [] });
  return (
    <div className="space-y-5">
      <Card
        title="الوظائف المخططة والخروج"
        subtitle="التعيين والإحلال موظفون افتراضيون، والخروج يوقف كلفة الموظف بعد شهره مع تكاليف خروجه لمرة واحدة."
        actions={
          edit ? (
            <div className="flex flex-wrap gap-2">
              {(['NEW_HIRE', 'BACKFILL', 'EXIT'] as const).map((k) => (
                <button key={k} type="button" onClick={() => setPosDlg({ kind: k, editing: null, prefill: null, key: Date.now() })} className={buttonClass.secondary}>
                  <Plus size={14} aria-hidden="true" /> {k === 'NEW_HIRE' ? 'تعيين جديد' : k === 'BACKFILL' ? 'إحلال' : 'خروج مخطط'}
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        {!d.positions.length ? (
          <EmptyBlock text="لا وظائف مخططة بعد." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <caption className="sr-only">الوظائف المخططة</caption>
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  {['النوع', 'المسمى', 'الموظف / الجنسية', 'الراتب', 'البداية / الخروج', `${WINDOW_TEXT[firstWindow]} (بعد الدعم)`, ''].map((h, i) => <th key={i} scope="col" className="py-2 px-2 text-right font-black">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                {d.positions.map((pos) => {
                  const it = items.get(pos.id);
                  const w = it?.windows[firstWindow];
                  return (
                    <tr key={pos.id} className="align-top">
                      <td className="py-2 px-2 whitespace-nowrap">{pos.kindLabel}</td>
                      <td className="py-2 px-2">
                        {pos.title}
                        {!!it?.flags.length && <span className="block text-[11px] text-amber-700">{`${it.flags.length} تنبيه`}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {pos.exitEmployeeId && <span className="block">{d.names.employees[pos.exitEmployeeId] ?? pos.exitEmployeeId}</span>}
                        {pos.nationalityClass && <span className="text-slate-500">{PLAN_NATIONALITY_LABELS[pos.nationalityClass as PlanNationalityClass] ?? pos.nationalityClass}</span>}
                      </td>
                      <td className="py-2 px-2">{pos.basicSalary !== null ? <Money value={(pos.basicSalary ?? 0) + (pos.housingAllowance ?? 0) + (pos.otherAllowances ?? 0)} /> : '—'}</td>
                      <td className="py-2 px-2 whitespace-nowrap" dir="ltr">
                        {pos.kind === 'EXIT' ? `${pos.exitMonth ?? '—'}` : `${it?.start ?? pos.startMonth ?? '—'}`}
                        {pos.kind === 'EXIT' && pos.exitReason && <span className="block text-[11px] text-slate-500" dir="rtl">{PLAN_EXIT_REASON_LABELS[pos.exitReason as EmployeeExitReason] ?? pos.exitReason}</span>}
                      </td>
                      <td className="py-2 px-2">
                        {w ? <Money value={w.net} className={w.net < 0 ? 'text-green-700' : 'text-slate-900'} /> : '—'}
                        {it?.exitCost && <span className="block text-[11px] text-slate-500">لمرة واحدة <Money value={it.exitCost.payable} /></span>}
                      </td>
                      <td className="py-2 px-2">
                        <span className="flex flex-wrap gap-1.5">
                          {it && <WhyButton label={pos.title} onClick={() => setItemWhy(it)} />}
                          {edit && (
                            <>
                              <button type="button" aria-label={`تعديل ${pos.title}`} onClick={() => setPosDlg({ kind: pos.kind, editing: pos, prefill: null, key: Date.now() })} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"><Pencil size={14} aria-hidden="true" /></button>
                              <button type="button" aria-label={`حذف ${pos.title}`} onClick={() => del(`/api/workforce/plans/${encodeURIComponent(d.plan.id)}/positions/${encodeURIComponent(pos.id)}`, `«${pos.title}»`)} className="rounded-lg p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={14} aria-hidden="true" /></button>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="الزيادات المخططة"
        subtitle="تحل محل افتراض «نسبة الزيادة السنوية»، وتنطبق على من باشر قبل شهر السريان. لا تُكتب في ملف الموظف."
        actions={edit ? <button type="button" onClick={() => setRaiseDlg({ editing: null, key: Date.now() })} className={buttonClass.secondary}><Plus size={14} aria-hidden="true" /> زيادة</button> : undefined}
      >
        {!d.raises.length ? (
          <EmptyBlock text="لا زيادات مخططة." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[12.5px]">
              <caption className="sr-only">الزيادات المخططة</caption>
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  {['النطاق', 'الزيادة', 'من', 'الموظفون', 'زيادة الأساسي شهرياً', 'طوال الخطة', ''].map((h, i) => <th key={i} scope="col" className="py-2 px-2 text-right font-black">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                {d.raises.map((r) => {
                  const res = raiseRes.get(r.id);
                  return (
                    <tr key={r.id}>
                      <td className="py-2 px-2">{`${r.scopeLabel}: ${scopeName(r)}`}{!!res?.flags.length && <span className="block text-[11px] text-amber-700">{res.flags[0].message}</span>}</td>
                      <td className="py-2 px-2" dir="ltr">{r.pct !== null ? `${r.pct}%` : <Money value={r.amount} />}</td>
                      <td className="py-2 px-2" dir="ltr">{r.effectiveMonth}</td>
                      <td className="py-2 px-2"><Num value={res?.employees ?? 0} /></td>
                      <td className="py-2 px-2"><Money value={res?.basicDeltaMonthly ?? 0} /></td>
                      <td className="py-2 px-2"><Money value={res?.basicDeltaTotal ?? 0} /></td>
                      <td className="py-2 px-2">
                        <span className="flex flex-wrap gap-1.5">
                          <WhyButton label={`زيادة ${scopeName(r)}`} onClick={() => raiseWhy(r, res)} />
                          {edit && (
                            <>
                              <button type="button" aria-label="تعديل الزيادة" onClick={() => setRaiseDlg({ editing: r, key: Date.now() })} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"><Pencil size={14} aria-hidden="true" /></button>
                              <button type="button" aria-label="حذف الزيادة" onClick={() => del(`/api/workforce/plans/${encodeURIComponent(d.plan.id)}/raises/${encodeURIComponent(r.id)}`, 'الزيادة')} className="rounded-lg p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={14} aria-hidden="true" /></button>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {windowKeys(p).some((k) => p.raisesEffect[k]) && (
          <p className="mt-3 text-[12px] font-bold text-slate-600">
            {'أثر الزيادات على كلفة صاحب العمل (الأساسي والتأمينات ونهاية الخدمة ودعم هدف): '}
            {windowKeys(p).filter((k) => p.raisesEffect[k]).map((k) => <span key={k} className="me-3 inline-block">{`${WINDOW_TEXT[k]}: `}<Money value={p.raisesEffect[k]!.net} /></span>)}
          </p>
        )}
      </Card>

      {posDlg && (
        <PositionDialog
          key={posDlg.key}
          open
          planId={d.plan.id}
          kind={posDlg.kind}
          editing={posDlg.editing}
          prefill={posDlg.prefill}
          plan={d.plan}
          lookups={lookups}
          names={d.names}
          onClose={() => setPosDlg(null)}
          onSaved={(r) => {
            toast.success('حُفظ البند');
            onReload();
            if (r.addBackfill && r.exitEmployeeId) {
              const name = lookups.employees.find((e) => e.id === r.exitEmployeeId)?.name ?? d.names.employees[r.exitEmployeeId] ?? '';
              setPosDlg({ kind: 'BACKFILL', editing: null, prefill: { exitEmployeeId: r.exitEmployeeId, title: `بديل ${name}`.trim() }, key: Date.now() });
            } else setPosDlg(null);
          }}
        />
      )}
      {raiseDlg && (
        <RaiseDialog
          key={raiseDlg.key}
          open
          planId={d.plan.id}
          editing={raiseDlg.editing}
          plan={d.plan}
          lookups={lookups}
          names={d.names}
          onClose={() => setRaiseDlg(null)}
          onSaved={() => {
            toast.success('حُفظت الزيادة');
            setRaiseDlg(null);
            onReload();
          }}
        />
      )}
      <ItemWhyDialog item={itemWhy} onClose={() => setItemWhy(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan vs actual
// ---------------------------------------------------------------------------

interface ActualResponse {
  planId: string;
  status: string;
  frozen: { snapshotId: string; createdAt: string } | null;
  warning: string | null;
  result: PlanVsActualResult;
}

function ActualTab({ planId }: { planId: string }) {
  const [asOf, setAsOf] = useState(todayKey());
  const { data, error, loading, reload } = useApi<ActualResponse>(`/api/workforce/plans/${encodeURIComponent(planId)}/actual?asOf=${encodeURIComponent(asOf)}`);
  const r = data?.result;
  return (
    <div className="space-y-5">
      <Card title="المخطط مقابل الفعلي" subtitle="المخطط: الرواتب والبدلات وحصة صاحب العمل في التأمينات لكل من في الخطة. الفعلي: إجمالي المسير المعتمد أو المصروف (الأساسي والبدلات والإضافي) + حصة صاحب العمل. التكاليف لمرة واحدة والدوران خارج المقارنة.">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="pva-asof" className="block text-[12px] font-extrabold text-slate-600 mb-1.5">حتى تاريخ</label>
            <input id="pva-asof" type="date" className={inputClass} value={asOf} onChange={(e) => setAsOf(e.target.value || todayKey())} />
          </div>
          {data?.frozen && <p className="text-[12px] font-bold text-emerald-700">{`المقارنة بالتوقع المجمّد عند الاعتماد (${formatDateTime(data.frozen.createdAt)})`}</p>}
        </div>
        {data?.warning && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-900">{data.warning}</p>}
      </Card>
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {loading && !data && <LoadingBlock />}
      {r && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              ['المخطط', r.cumulative.planned],
              ['الفعلي', r.cumulative.actual],
              ['الفرق', r.cumulative.variance],
            ].map(([l, v]) => (
              <div key={String(l)} className="rounded-2xl border border-slate-100 bg-white p-3">
                <p className="text-[11.5px] font-black text-slate-500">{l}</p>
                <p className="mt-1 text-[17px] font-black text-slate-900"><Money value={v as number} /></p>
              </div>
            ))}
            <div className="rounded-2xl border border-slate-100 bg-white p-3">
              <p className="text-[11.5px] font-black text-slate-500">نسبة الفرق</p>
              <p className="mt-1 text-[17px] font-black text-slate-900" dir="ltr">{r.cumulative.variancePct === null ? '—' : `${r.cumulative.variancePct}%`}</p>
              <p className="text-[11px] font-bold text-slate-400">{`${arabicMonths(r.cumulative.months)}${r.cumulative.partial ? '، بعضها جزئي' : ''}`}</p>
            </div>
          </div>
          {r.explanations.length > 0 && (
            <Card title="لماذا الفرق؟">
              <ul className="list-disc space-y-1 pr-5 text-[12.5px] font-bold text-slate-700">{r.explanations.map((x) => <li key={x}>{x}</li>)}</ul>
            </Card>
          )}
          {r.months.length > 0 ? (
            <Card title="شهراً بشهر">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-[12.5px]">
                  <caption className="sr-only">المخطط مقابل الفعلي لكل شهر</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      {['الشهر', 'المخطط', 'الفعلي', 'الفرق', '%', 'العدد المخطط', 'العدد الفعلي', 'ملاحظة'].map((h) => <th key={h} scope="col" className="py-2 px-2 text-right font-black">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {r.months.map((m) => (
                      <tr key={m.month}>
                        <td className="py-2 px-2" dir="ltr">{m.month}</td>
                        <td className="py-2 px-2"><Money value={m.planned} /></td>
                        <td className="py-2 px-2"><Money value={m.actual} /></td>
                        <td className={`py-2 px-2 ${m.variance > 0 ? 'text-rose-700' : m.variance < 0 ? 'text-green-700' : ''}`}><Money value={m.variance} /></td>
                        <td className="py-2 px-2" dir="ltr">{m.variancePct === null ? '—' : `${m.variancePct}%`}</td>
                        <td className="py-2 px-2"><Num value={m.plannedHeadcount} /></td>
                        <td className="py-2 px-2"><Num value={m.actualHeadcount} /></td>
                        <td className="py-2 px-2 text-[11.5px]">{m.partial ? <span className="text-amber-800">{`جزئي: ${m.partialRows} سطر بلا حصة التأمينات (استُبعدت من الطرفين)`}</span> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {r.monthsWithoutPayroll.length > 0 && <p className="mt-2 text-[11.5px] font-bold text-slate-500">{`أشهر بلا مسير معتمد (لم تُقارن): ${r.monthsWithoutPayroll.join('، ')}`}</p>}
            </Card>
          ) : (
            <EmptyBlock text="لا أشهر في الخطة حتى هذا التاريخ لها مسير معتمد أو مصروف." />
          )}
          {r.drivers.length > 0 && (
            <Card title="أسباب الفرق" subtitle="مجموع الأسباب يساوي الفرق تماماً.">
              <ul className="space-y-3">
                {r.drivers.map((dr) => (
                  <li key={dr.key} className="rounded-2xl border border-slate-100 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] font-black">
                      <span className="text-slate-800">{PVA_DRIVER_LABELS[dr.key]}</span>
                      <Money value={dr.amount} className={dr.amount > 0 ? 'text-rose-700' : 'text-green-700'} />
                    </div>
                    {dr.people.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-bold text-slate-500">
                        {dr.people.map((x) => <li key={x.id}>{x.name}: <Money value={x.amount} /></li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PlanDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? '');
  const [live, setLive] = useState(false);
  const [tab, setTab] = useState<Tab>('projection');
  const [why, setWhy] = useState<WhyContent | null>(null);
  const [headerOpen, setHeaderOpen] = useState(false);
  const detail = useApi<PlanDetailResponse>(id ? `/api/workforce/plans/${encodeURIComponent(id)}${live ? '?live=1' : ''}` : null);
  const options = useApi<OptionsResponse>('/api/workforce/options');
  const plans = useApi<{ items: Array<{ id: string; name: string; statusLabel: string }> }>('/api/workforce/plans?take=200');
  const d = detail.data;
  const lookups: Lookups = {
    companies: options.data?.companies ?? [],
    branches: options.data?.branches ?? [],
    departments: options.data?.departments ?? [],
    employees: (options.data?.employees ?? []).map((e) => ({ id: e.id, name: e.name, employeeNo: e.employeeNo, companyId: e.companyId })),
  };
  return (
    <WfPage
      icon={<ClipboardList size={24} />}
      title={d ? d.plan.name : 'خطة القوى العاملة'}
      subtitle={d ? `${d.plan.companyName ?? 'كل الشركات'} · من ${d.plan.fromMonth} · ${d.plan.months} شهراً · الدوران ${d.plan.attritionPct === null ? 'الفعلي للمنشأة' : `${d.plan.attritionPct}%`}. سيناريو: لا يُكتب شيء في ملف الموظف ولا المسير.` : 'جارٍ التحميل…'}
      current="/workforce/plans"
      actions={
        <>
          <Link href="/workforce/plans" className={buttonClass.secondary}>كل الخطط</Link>
          {d?.permissions.edit && <button type="button" onClick={() => setHeaderOpen(true)} className={buttonClass.secondary}><Pencil size={15} aria-hidden="true" /> بيانات الخطة</button>}
        </>
      }
    >
      {detail.error && <ErrorBlock message={detail.error} onRetry={detail.reload} />}
      {detail.loading && !d && <LoadingBlock />}
      {d && (
        <>
          <StatusBar d={d} onChanged={detail.reload} lookups={(plans.data?.items ?? []).map((x) => ({ id: x.id, name: x.name, status: x.statusLabel }))} />
          {(d.frozen || (live && (d.plan.status === 'APPROVED' || d.plan.status === 'ARCHIVED'))) && (
            <div role="note" className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12.5px] font-bold text-emerald-900">
              <span>{d.frozen ? `التوقع المعروض مجمّد عند اعتماد الخطة (${formatDateTime(d.frozen.createdAt)}) وهو مرجع المخطط مقابل الفعلي.` : 'التوقع المعروض معاد حسابه بالبيانات الحالية.'}</span>
              <button type="button" onClick={() => setLive(!live)} className={buttonClass.link}>{d.frozen ? 'إعادة الحساب بالبيانات الحالية' : 'عرض التوقع المجمّد'}</button>
            </div>
          )}
          <Segmented label="العرض" value={tab} options={[{ value: 'projection', label: 'التوقع' }, { value: 'items', label: `البنود (${d.positions.length + d.raises.length})` }, { value: 'actual', label: 'المخطط مقابل الفعلي' }]} onChange={setTab} />
          {tab === 'projection' && <ProjectionTab p={d.projection} onWhy={setWhy} />}
          {tab === 'items' && <ItemsTab d={d} onReload={detail.reload} lookups={lookups} onWhy={setWhy} />}
          {tab === 'actual' && <ActualTab planId={d.plan.id} />}
          {headerOpen && (
            <HeaderDialog
              open
              plan={d.plan}
              hasItems={d.positions.length + d.raises.length > 0}
              companies={lookups.companies}
              onClose={() => setHeaderOpen(false)}
              onSaved={() => {
                toast.success('حُفظت بيانات الخطة');
                setHeaderOpen(false);
                detail.reload();
              }}
            />
          )}
        </>
      )}
      <WhyDialog content={why} onClose={() => setWhy(null)} />
    </WfPage>
  );
}

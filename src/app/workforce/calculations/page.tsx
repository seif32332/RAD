"use client";

// «الحسابات المحفوظة»: saved snapshots (engine version, exact rule versions, inputs and outputs), newest
// first, and the detail of one snapshot (?id=). GET /api/workforce/calculations[/id]. Snapshots are immutable.
import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Archive, ArrowRight } from 'lucide-react';
import { formatDateTime } from '@/lib/dates';
import type { MoneyTriple, WfStatus } from '@/lib/workforce/types';
import { useApi } from '../_components/api';
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, Money, Num, SelectField, StatusBadge, WfPage, buttonClass } from '../_components/ui';

const KIND_LABELS: Record<string, string> = { TRUE_COST: 'الكلفة الحقيقية', EXIT_COST: 'كلفة الإنهاء', OVERVIEW: 'لوحة القرار', SAUDIZATION: 'مخطط السعودة', HIRE_SCENARIO: 'سيناريو توظيف' };
const BAND_TEXT: Record<string, string> = { RED: 'أحمر', LOW_GREEN: 'أخضر منخفض', MEDIUM_GREEN: 'أخضر متوسط', HIGH_GREEN: 'أخضر مرتفع', PLATINUM: 'بلاتيني' };
const SUBJECT_LABELS: Record<string, string> = { EMPLOYEE: 'موظف', COMPANY: 'شركة', BRANCH: 'فرع', DEPARTMENT: 'إدارة', ALL: 'كل الموظفين' };
const PAGE = 25;

interface ListItem {
  id: string;
  kind: string;
  subjectType: string | null;
  subjectId: string | null;
  title: string | null;
  engineVersion: string;
  createdAt: string;
  createdByName: string | null;
}
interface ListResponse {
  total: number;
  items: ListItem[];
}
interface DetailResponse extends ListItem {
  ruleVersions: Array<{ key: string; effectiveFrom: string | null; status: WfStatus; value: number | null }> | null;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
}

function Triple({ label, t }: { label: string; t: MoneyTriple | undefined }) {
  if (!t) return null;
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <p className="text-[11px] font-black text-slate-500">{label}</p>
      <p className="mt-1 text-[15px] font-black text-slate-900"><Money value={t.cost} /></p>
      <p className="text-[11px] font-bold text-green-700">
        بعد الدعم <Money value={t.net} />
      </p>
    </div>
  );
}

function OutputsSummary({ d }: { d: DetailResponse }) {
  const o = (d.outputs ?? {}) as Record<string, unknown>;
  if (d.kind === 'EXIT_COST') {
    const t = (o.totals ?? {}) as Record<string, number>;
    const lines = (o.lines ?? []) as Array<{ key: string; label: string; amount: number; kind: string; status: WfStatus }>;
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            ['المستحقات', t.payable],
            ['المقاصّة', t.offsets],
            ['صافي ما يُدفع', t.netToEmployee],
            ['خطر المادة 77 (خارج الإجمالي)', t.risk],
            ['كلفة الإحلال', t.replacement],
          ].map(([l, v]) => (
            <div key={String(l)} className="rounded-2xl bg-slate-50 p-3">
              <p className="text-[11px] font-black text-slate-500">{l}</p>
              <p className="mt-1 text-[15px] font-black text-slate-900"><Money value={v as number} /></p>
            </div>
          ))}
        </div>
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
          {lines.map((l) => (
            <li key={l.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12.5px] font-bold">
              <span className="text-slate-700">{l.label}</span>
              <span className="flex items-center gap-2">
                <StatusBadge status={l.status} />
                <Money value={l.amount} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (d.kind === 'SAUDIZATION') {
    const e = (o.estimate ?? {}) as { band?: string | null; pct?: number; status?: string; counts?: { x: number; saudiWeighted: number; expats: number } };
    const solve = o.solve as { targetBand?: string; hires?: number | null; totals?: { monthlyNetAvg: number | null } } | null;
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[12.5px] font-bold">
        <div className="rounded-2xl bg-slate-50 p-3"><p className="text-slate-500">النطاق التقديري</p><p className="mt-1 text-[15px] font-black text-slate-900">{e.band ? BAND_TEXT[e.band] : e.status}</p></div>
        <div className="rounded-2xl bg-slate-50 p-3"><p className="text-slate-500">نسبة التوطين</p><p className="mt-1 text-[15px] font-black text-slate-900" dir="ltr">{e.pct ?? 0}%</p></div>
        <div className="rounded-2xl bg-slate-50 p-3"><p className="text-slate-500">العاملون المحتسبون (X)</p><p className="mt-1 text-[15px] font-black text-slate-900"><Num value={e.counts?.x} /></p></div>
        {solve && (
          <div className="sm:col-span-3 rounded-2xl bg-indigo-50 p-3 text-indigo-900">
            {`الوصول إلى ${BAND_TEXT[solve.targetBand ?? ''] ?? solve.targetBand}: ${solve.hires ?? '—'} تعيين`}
            {solve.totals?.monthlyNetAvg != null && <> — <Money value={solve.totals.monthlyNetAvg} /> شهرياً في المتوسط</>}
          </div>
        )}
      </div>
    );
  }
  if (d.kind === 'HIRE_SCENARIO') {
    const cands = (o.candidates ?? []) as Array<{ label: string; windows: Record<string, { total: number }> }>;
    return (
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cands.map((c) => (
          <li key={c.label} className="rounded-2xl bg-slate-50 p-3 text-[12.5px] font-bold">
            <p className="text-slate-500">{c.label}</p>
            <p className="mt-1 text-[15px] font-black text-slate-900"><Money value={c.windows?.['12']?.total} /></p>
            <p className="text-[11px] text-slate-500">12 شهراً بعد الدعم وأثر المقابل المالي</p>
          </li>
        ))}
      </ul>
    );
  }
  if (d.kind === 'OVERVIEW') {
    const k = (o.kpis ?? {}) as Record<string, MoneyTriple | number>;
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Triple label="هذا الشهر" t={k.thisMonth as MoneyTriple} />
        <Triple label="12 شهراً" t={k.next12 as MoneyTriple} />
        <Triple label="36 شهراً" t={k.next36 as MoneyTriple} />
      </div>
    );
  }
  const totals = (o.totals ?? {}) as Record<string, MoneyTriple>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Triple label="الشهر الأول" t={totals.month1} />
        <Triple label="12 شهراً" t={totals.next12} />
        <Triple label="36 شهراً" t={totals.next36} />
      </div>
      {Array.isArray(o.employees) && <p className="text-[12px] font-bold text-slate-500">{`نتائج ${o.employees.length} موظف محفوظة.`}</p>}
      {Array.isArray(o.months) && <p className="text-[12px] font-bold text-slate-500">{`${o.months.length} شهراً بكل بنودها محفوظة.`}</p>}
    </div>
  );
}

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error, loading, reload } = useApi<DetailResponse>(`/api/workforce/calculations/${encodeURIComponent(id)}`);
  if (error) return <ErrorBlock message={error} onRetry={reload} />;
  if (loading || !data) return <LoadingBlock label="جارٍ التحميل…" />;
  const params = ((data.inputs ?? {}) as { params?: Record<string, unknown> }).params ?? {};
  return (
    <div className="space-y-5">
      <Card>
        <button type="button" onClick={onBack} className={buttonClass.link}>
          <ArrowRight size={14} aria-hidden="true" /> العودة إلى القائمة
        </button>
        <h2 className="mt-2 text-[20px] font-black text-slate-900">{data.title ?? KIND_LABELS[data.kind]}</h2>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-[12.5px] font-bold">
          <div><dt className="text-slate-400">النوع</dt><dd className="text-slate-800">{KIND_LABELS[data.kind] ?? data.kind}</dd></div>
          <div><dt className="text-slate-400">التاريخ</dt><dd className="text-slate-800">{formatDateTime(data.createdAt)}</dd></div>
          <div><dt className="text-slate-400">بواسطة</dt><dd className="text-slate-800">{data.createdByName ?? '—'}</dd></div>
          <div><dt className="text-slate-400">نسخة المحرك</dt><dd className="text-slate-800" dir="ltr">{data.engineVersion}</dd></div>
        </dl>
        {data.kind === 'TRUE_COST' && data.subjectType === 'EMPLOYEE' && data.subjectId && (
          <Link href={`/workforce/true-cost?employeeId=${data.subjectId}`} className={`${buttonClass.link} mt-3`}>عرض الحساب الحالي لهذا الموظف ←</Link>
        )}
      </Card>

      <Card title="المدخلات">
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-[12.5px] font-bold">
          {Object.entries(params).map(([k, v]) => (
            <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
              <dt className="text-slate-400 font-mono text-[11px]" dir="ltr">{k}</dt>
              <dd className="text-slate-800 break-all" dir="auto">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] font-black text-slate-600">كل المدخلات (JSON)</summary>
          <pre dir="ltr" className="mt-2 max-h-96 overflow-auto rounded-xl bg-slate-900 p-3 text-[11px] text-slate-100 whitespace-pre-wrap break-all">{JSON.stringify(data.inputs, null, 2).slice(0, 200_000)}</pre>
        </details>
      </Card>

      <Card title="ملخص النتائج">
        <OutputsSummary d={data} />
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] font-black text-slate-600">كل النتائج (JSON)</summary>
          <pre dir="ltr" className="mt-2 max-h-96 overflow-auto rounded-xl bg-slate-900 p-3 text-[11px] text-slate-100 whitespace-pre-wrap break-all">{JSON.stringify(data.outputs, null, 2).slice(0, 200_000)}</pre>
        </details>
      </Card>

      <Card title="نسخ القواعد المستخدمة" subtitle="القيمة وتاريخ السريان والحالة لكل قاعدة كما كانت وقت الحساب">
        {data.ruleVersions?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[12.5px]">
              <caption className="sr-only">نسخ القواعد المستخدمة</caption>
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th scope="col" className="py-2 text-right font-black">المفتاح</th>
                  <th scope="col" className="py-2 text-right font-black">القيمة</th>
                  <th scope="col" className="py-2 text-right font-black">يسري من</th>
                  <th scope="col" className="py-2 text-right font-black">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {data.ruleVersions.map((r) => (
                  <tr key={`${r.key}@${r.effectiveFrom}`} className="border-b border-slate-100 font-bold text-slate-700">
                    <th scope="row" className="py-1.5 text-right font-mono text-[11px] font-normal" dir="ltr">{r.key}</th>
                    <td className="py-1.5">{r.value === null ? '—' : <Num value={r.value} />}</td>
                    <td className="py-1.5" dir="ltr">{r.effectiveFrom ?? '—'}</td>
                    <td className="py-1.5"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyBlock text="لا توجد قواعد مسجلة" />
        )}
      </Card>
    </div>
  );
}

function CalculationsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const [kind, setKind] = useState('');
  const [skip, setSkip] = useState(0);
  const list = useApi<ListResponse>(id ? null : `/api/workforce/calculations?take=${PAGE}&skip=${skip}${kind ? `&kind=${kind}` : ''}`);

  return (
    <WfPage
      current="/workforce/calculations"
      icon={<Archive size={24} />}
      title="الحسابات المحفوظة"
      subtitle="كل حساب محفوظ بنسخة المحرك ونسخ القواعد ومدخلاته ونتيجته، ليُعرف بعد سنة لماذا ظهر الرقم. الحسابات المحفوظة لا تُعدَّل."
    >
      {id ? (
        <Detail id={id} onBack={() => router.push('/workforce/calculations')} />
      ) : (
        <>
          <SelectField
            className="max-w-xs"
            label="النوع"
            value={kind}
            onChange={(v) => {
              setKind(v);
              setSkip(0);
            }}
            placeholder="كل الأنواع"
            options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {list.error && <ErrorBlock message={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <LoadingBlock label="جارٍ التحميل…" />}
          {list.data && (
            <Card>
              {list.data.items.length ? (
                <ul className="divide-y divide-slate-100">
                  {list.data.items.map((c) => (
                    <li key={c.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3">
                      <div className="min-w-0">
                        <Link href={`/workforce/calculations?id=${c.id}`} className="text-[14px] font-black text-indigo-700 hover:underline">
                          {c.title ?? KIND_LABELS[c.kind] ?? c.kind}
                        </Link>
                        <p className="text-[11.5px] font-bold text-slate-500">
                          {[KIND_LABELS[c.kind] ?? c.kind, c.subjectType ? SUBJECT_LABELS[c.subjectType] ?? c.subjectType : null, formatDateTime(c.createdAt), c.createdByName].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <span className="text-[11px] font-bold text-slate-400" dir="ltr">{c.engineVersion}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyBlock text="لا توجد حسابات محفوظة بعد. استخدم «حفظ الحساب» في لوحة القرار أو الكلفة الحقيقية أو كلفة الإنهاء." />
              )}
              {list.data.total > PAGE && (
                <nav aria-label="صفحات الحسابات" className="mt-4 flex items-center justify-between gap-2 text-[12px] font-bold text-slate-600">
                  <button type="button" className={buttonClass.secondary} disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>السابق</button>
                  <span>
                    <Num value={skip + 1} />–<Num value={Math.min(skip + PAGE, list.data.total)} /> من <Num value={list.data.total} />
                  </span>
                  <button type="button" className={buttonClass.secondary} disabled={skip + PAGE >= list.data.total} onClick={() => setSkip(skip + PAGE)}>التالي</button>
                </nav>
              )}
            </Card>
          )}
        </>
      )}
    </WfPage>
  );
}

export default function CalculationsPage() {
  return (
    <Suspense fallback={<LoadingBlock label="جارٍ التحميل…" />}>
      <CalculationsInner />
    </Suspense>
  );
}

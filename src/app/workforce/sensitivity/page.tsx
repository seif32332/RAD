"use client";

// «حساسية القرار» (SPEC §11): how much a decision's figure moves with the assumptions — the three scenarios
// low / base / high and a tornado of one-factor-at-a-time sensitivities. Opened from the hire-scenario, exit
// and plan pages («حساسية القرار» button): a plan by id (?decision=plan&planId=), a hire scenario or an exit
// with its request body handed through sessionStorage. Data: /api/workforce/sensitivity (display only).
import React, { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Scale } from 'lucide-react';
import { formatMoney } from '@/lib/money';
import type { SensitivityOutcome, SensitivityResult } from '@/lib/workforce/sensitivity';
import { callApi, useApi } from '../_components/api';
import { Card, EmptyBlock, ErrorBlock, ExportButton, LoadingBlock, Money, SelectField, SENSITIVITY_STORAGE_PREFIX, Segmented, WfPage, buttonClass } from '../_components/ui';
import PdfReportButton from '../_components/PdfReportButton';

type Decision = 'hire' | 'exit' | 'plan';
interface SensitivityResponse {
  result: SensitivityResult;
}

/** sessionStorage has no change event for the same tab: read once per render (useSyncExternalStore). */
const noSubscribe = () => () => {};

const BACK: Record<Decision, { href: string; label: string }> = {
  hire: { href: '/workforce/hire-scenario', label: 'سيناريوهات التوظيف' },
  exit: { href: '/workforce/exit-cost', label: 'كلفة الإنهاء' },
  plan: { href: '/workforce/plans', label: 'خطة القوى العاملة' },
};

/** Tornado: one row per factor, the low-value and high-value results as bars around the base figure. */
function Tornado({ o }: { o: SensitivityOutcome }) {
  if (!o.factors.length) return <EmptyBlock text="لا عوامل قابلة للتحريك لهذا القرار (انظر «عوامل لم تُحرَّك»)." />;
  const max = Math.max(1, ...o.factors.flatMap((f) => [Math.abs(f.lowDelta), Math.abs(f.highDelta)]));
  const W = 400;
  const mid = W / 2;
  const x = (d: number) => mid + (d / max) * (mid - 8);
  const bar = (d: number, y: number, cls: string, title: string) => {
    const xe = x(d);
    return (
      <rect x={Math.min(mid, xe)} y={y} width={Math.max(Math.abs(xe - mid), d === 0 ? 0 : 1.5)} height={9} className={cls}>
        <title>{title}</title>
      </rect>
    );
  };
  const top = o.factors[0];
  const summary = `مخطط الحساسية لـ ${o.label}: الرقم الأساسي ${formatMoney(o.base)} ريال. أكبر أثر: ${top.label} بفرق ${formatMoney(top.swing)} ريال بين طرفيه.`;
  return (
    <figure>
      <div role="img" aria-label={summary} className="space-y-2.5">
        {o.factors.map((f) => (
          <div key={f.key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,17rem)_1fr] items-center gap-1 sm:gap-3">
            <p className="text-[12px] font-black leading-snug text-slate-700">{f.label}</p>
            <svg viewBox={`0 0 ${W} 22`} preserveAspectRatio="none" aria-hidden="true" className="h-6 w-full rounded bg-slate-50">
              <line x1={mid} x2={mid} y1={0} y2={22} className="stroke-slate-400" strokeWidth={1} />
              {bar(f.lowDelta, 1.5, 'fill-sky-500', `${f.lowText}: ${formatMoney(f.low)}`)}
              {bar(f.highDelta, 11.5, 'fill-amber-500', `${f.highText}: ${formatMoney(f.high)}`)}
            </svg>
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-1 sm:grid-cols-[minmax(0,17rem)_1fr] gap-3" aria-hidden="true">
        <span className="hidden sm:block" />
        <div dir="ltr" className="flex justify-between text-[11px] font-bold text-slate-500">
          <span>أقل</span>
          <span>{`الأساس ${formatMoney(o.base)}`}</span>
          <span>أعلى</span>
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-4 text-[11px] font-bold text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" aria-hidden="true" /> القيمة المنخفضة للعامل</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" aria-hidden="true" /> القيمة المرتفعة للعامل</span>
      </figcaption>
    </figure>
  );
}

function Result({ r, exportProps }: { r: SensitivityResult; exportProps: { query?: Record<string, string>; body?: unknown } }) {
  const [sel, setSel] = useState(r.outcomes[0]?.id ?? '');
  const o = r.outcomes.find((x) => x.id === sel) ?? r.outcomes[0];
  if (!o) return <EmptyBlock text="لا نتائج" />;
  return (
    <div className="space-y-5">
      <Card
        title={r.title}
        subtitle={`الرقم المقيس: ${r.metricLabel}. كل عامل يُحرَّك وحده وبقية المدخلات على قيمتها الأساسية.`}
        actions={<><ExportButton kind="sensitivity" query={exportProps.query} body={exportProps.body} /><PdfReportButton kind="sensitivity" query={exportProps.query} body={exportProps.body} /></>}
      >
        {r.outcomes.length > 1 && <Segmented label="النتيجة" value={o.id} options={r.outcomes.map((x) => ({ value: x.id, label: x.label }))} onChange={setSel} />}
        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(['low', 'base', 'high'] as const).map((s) => (
            <div key={s} className={`rounded-2xl p-3 ${s === 'base' ? 'bg-indigo-50' : 'bg-slate-50'}`}>
              <dt className="text-[11px] font-black text-slate-500">{s === 'low' ? 'السيناريو المنخفض' : s === 'base' ? 'السيناريو الأساسي' : 'السيناريو المرتفع'}</dt>
              <dd className="mt-1 text-[17px] font-black text-slate-900"><Money value={o.scenarios[s]} /></dd>
            </div>
          ))}
        </dl>
        {r.reference && r.reference.values[o.id] != null && (
          <div role="note" className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12.5px] font-bold text-emerald-900">
            <span>
              {`${r.reference.label} (${r.reference.createdAt.slice(0, 10)}): `}
              <Money value={r.reference.values[o.id]} />
            </span>
            <span>
              {'الحساب الحي (الأساس هنا): '}
              <Money value={o.base} />
            </span>
            <span>
              {'الفرق: '}
              <Money value={r.reference.diffs?.[o.id] ?? null} />
            </span>
          </div>
        )}
      </Card>

      <Card title="مخطط الحساسية" subtitle="طول العمود = تغيّر الرقم عن الأساس عند القيمة المنخفضة (أزرق) أو المرتفعة (برتقالي) للعامل، مرتبة حسب الأثر.">
        <Tornado o={o} />
      </Card>

      <Card title="جدول الحساسية">
        {o.factors.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <caption className="sr-only">حساسية {o.label}</caption>
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th scope="col" className="py-2 text-right font-black">العامل</th>
                  <th scope="col" className="py-2 text-right font-black">القيمة المنخفضة ← النتيجة</th>
                  <th scope="col" className="py-2 text-right font-black">القيمة الأساسية</th>
                  <th scope="col" className="py-2 text-right font-black">القيمة المرتفعة ← النتيجة</th>
                  <th scope="col" className="py-2 text-right font-black">الأثر</th>
                </tr>
              </thead>
              <tbody>
                {o.factors.map((f) => (
                  <tr key={f.key} className="border-b border-slate-100 font-bold text-slate-700 align-top">
                    <th scope="row" className="py-2 text-right font-black text-slate-800">{f.label}</th>
                    <td className="py-2">{f.lowText}<br /><Money value={f.low} /></td>
                    <td className="py-2">{f.baseText}<br /><Money value={o.base} /></td>
                    <td className="py-2">{f.highText}<br /><Money value={f.high} /></td>
                    <td className="py-2"><Money value={f.swing} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyBlock text="لا عوامل قابلة للتحريك." />
        )}
      </Card>

      {r.skipped.length > 0 && (
        <Card title="عوامل لم تُحرَّك" subtitle="لا تُخترع قيمة: العامل بلا نطاق مُدخل أو غير متعلق بهذا القرار يُذكر هنا بسببه.">
          <ul className="space-y-1.5 text-[12.5px] font-bold text-slate-600">
            {r.skipped.map((s) => (
              <li key={s.key}><span className="text-slate-800">{s.label}:</span> {s.reason}</li>
            ))}
          </ul>
          <Link href="/workforce/assumptions" className={`${buttonClass.link} mt-3`}>الافتراضات (أدخل نطاق منخفض/مرتفع) ←</Link>
        </Card>
      )}
      {r.notes.length > 0 && (
        <ul className="space-y-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[12px] font-bold text-slate-600">
          {r.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

function PlanPicker() {
  const router = useRouter();
  const plans = useApi<{ items: Array<{ id: string; name: string; statusLabel: string }> }>('/api/workforce/plans?take=200');
  return (
    <Card title="اختر القرار" subtitle="تُفتح الحساسية من صفحة القرار: «سيناريوهات التوظيف» و«كلفة الإنهاء» بعد الحساب، أو خطة من القائمة.">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField className="min-w-[260px]" label="خطة القوى العاملة" value="" onChange={(v) => v && router.push(`/workforce/sensitivity?decision=plan&planId=${encodeURIComponent(v)}`)} placeholder="اختر خطة" options={(plans.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.statusLabel})` }))} />
        <Link href="/workforce/hire-scenario" className={buttonClass.secondary}>سيناريوهات التوظيف</Link>
        <Link href="/workforce/exit-cost" className={buttonClass.secondary}>كلفة الإنهاء</Link>
      </div>
    </Card>
  );
}

function SensitivityInner() {
  const params = useSearchParams();
  const raw = params.get('decision');
  const decision: Decision | null = raw === 'hire' || raw === 'exit' || raw === 'plan' ? raw : null;
  const planId = params.get('planId') ?? '';
  // The handed-over body (sessionStorage): undefined on the server / before hydration, null = nothing.
  const storageKey = decision === 'hire' || decision === 'exit' ? `${SENSITIVITY_STORAGE_PREFIX}${decision}` : null;
  const storedText = useSyncExternalStore(
    noSubscribe,
    () => {
      if (!storageKey) return null;
      try {
        return window.sessionStorage.getItem(storageKey);
      } catch {
        return null;
      }
    },
    () => undefined,
  );
  const stored = useMemo<unknown>(() => {
    if (storedText === undefined) return undefined;
    try {
      return storedText ? JSON.parse(storedText) : null;
    } catch {
      return null;
    }
  }, [storedText]);

  const postBody = useMemo(() => (decision && decision !== 'plan' && stored ? { decision, params: stored } : null), [decision, stored]);
  const postKey = postBody ? JSON.stringify(postBody) : null;
  /** Result of the last finished POST (keyed by its body): loading = the current body has not finished yet. */
  const [post, setPost] = useState<{ key: string; data: SensitivityResponse | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!postBody || !postKey) return;
    let active = true;
    void callApi<SensitivityResponse>('/api/workforce/sensitivity', { json: postBody }).then((r) => {
      if (!active) return;
      setPost(r.ok ? { key: postKey, data: r.data, error: null } : { key: postKey, data: null, error: r.message });
    });
    return () => {
      active = false;
    };
  }, [postBody, postKey]);
  const postDone = post && post.key === postKey ? post : null;
  const planUrl = decision === 'plan' && planId ? `/api/workforce/sensitivity?decision=plan&planId=${encodeURIComponent(planId)}` : null;
  const plan = useApi<SensitivityResponse>(planUrl);

  const data = decision === 'plan' ? plan.data : (postDone?.data ?? null);
  const error = decision === 'plan' ? plan.error : (postDone?.error ?? null);
  const loading = decision === 'plan' ? plan.loading : !!postKey && !postDone;
  const exportProps = decision === 'plan' ? { query: { decision: 'plan', planId } } : { body: postBody ?? undefined };
  const back = decision ? (decision === 'plan' && planId ? { href: `/workforce/plans/${encodeURIComponent(planId)}`, label: 'الخطة' } : BACK[decision]) : null;

  return (
    <WfPage
      current="/workforce/sensitivity"
      icon={<Scale size={24} />}
      title="حساسية القرار"
      subtitle="كم يتغيّر رقم القرار إذا تغيّرت الافتراضات: السيناريوهات المنخفض والأساسي والمرتفع، وأثر كل عامل وحده (نطاقات الافتراضات، وفئة التأمين الطبي، وطريقة العمل الإضافي، ودعم هدف)."
      actions={back ? <Link href={back.href} className={buttonClass.secondary}>{`العودة إلى ${back.label}`}</Link> : undefined}
    >
      {!decision && <PlanPicker />}
      {decision === 'plan' && !planId && <PlanPicker />}
      {(decision === 'hire' || decision === 'exit') && stored === null && (
        <EmptyBlock text={`لا يوجد ${decision === 'hire' ? 'سيناريو توظيف' : 'حساب إنهاء'} محسوب في هذه الجلسة: احسبه ثم اضغط «حساسية القرار».`} />
      )}
      {error && <ErrorBlock message={error} />}
      {loading && !data && <LoadingBlock label="جارٍ تشغيل المحرك لكل سيناريو وعامل…" />}
      {data && <Result key={data.result.title} r={data.result} exportProps={exportProps} />}
    </WfPage>
  );
}

export default function SensitivityPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SensitivityInner />
    </Suspense>
  );
}

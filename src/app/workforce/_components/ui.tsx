"use client";

// Shared building blocks of the workforce pages («محرك القرارات»): page frame with the disclaimer,
// status badges, money, selectors, composition bars, a monthly series chart and the «لماذا؟» dialog.
import React, { useId } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Modal from '@/components/ui/Modal';
import { formatMoney } from '@/lib/money';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import type { RuleEvidence, WfStatus } from '@/lib/workforce/types';
import { LINE_COLORS, QIWA_NOTE, STATUS_LABELS, STATUS_STYLES, formatRuleValue } from '@/app/api/workforce/_lib/shared';

// ---------------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------------

export const WF_NAV = [
  { href: '/workforce', label: 'لوحة القرار' },
  { href: '/workforce/true-cost', label: 'الكلفة الحقيقية' },
  { href: '/workforce/exit-cost', label: 'كلفة الإنهاء' },
  { href: '/workforce/saudization', label: 'مخطط السعودة' },
  { href: '/workforce/hire-scenario', label: 'سيناريوهات التوظيف' },
  { href: '/workforce/nitaqat-register', label: 'سجل نطاقات والتوطين' },
  { href: '/workforce/assumptions', label: 'الافتراضات' },
  { href: '/workforce/rules', label: 'سجل القواعد' },
  { href: '/workforce/calculations', label: 'الحسابات المحفوظة' },
] as const;

export function WfPage({
  icon,
  title,
  subtitle,
  actions,
  current,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  current: string;
  children: React.ReactNode;
}) {
  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 md:py-10 mb-32 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-5 border-b border-indigo-100">
          <div className="min-w-0">
            <p className="text-[12px] font-black text-indigo-600 mb-2">محرك القرارات</p>
            <h1 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-700 p-2.5 rounded-2xl shrink-0" aria-hidden="true">
                {icon}
              </span>
              {title}
            </h1>
            <p className="text-slate-500 font-bold mt-3 text-[13px] md:text-[14px] leading-relaxed max-w-3xl">{subtitle}</p>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        <nav aria-label="أقسام محرك القرارات" className="-mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {WF_NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={current === n.href ? 'page' : undefined}
              className={`whitespace-nowrap rounded-xl px-3.5 py-2 text-[12px] font-black transition ${
                current === n.href ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <Disclaimer />
        {children}
      </div>
    </DashboardLayout>
  );
}

export function Disclaimer({ extra }: { extra?: string }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] font-bold text-amber-900 leading-relaxed">
      <Info size={18} className="shrink-0 mt-0.5 text-amber-600" aria-hidden="true" />
      <p>
        {ESTIMATE_DISCLAIMER} {QIWA_NOTE}
        {extra ? ` ${extra}` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function LoadingBlock({ label = 'جارٍ الحساب…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 py-16 text-slate-500 font-bold text-[13px]">
      <Loader2 size={24} className="animate-spin text-indigo-500" aria-hidden="true" /> {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
      <p className="flex items-start gap-2 text-[13px] font-bold text-rose-800">
        <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" /> {message}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-[12px] font-black text-white hover:bg-slate-800">
          <RefreshCw size={14} aria-hidden="true" /> إعادة المحاولة
        </button>
      )}
    </div>
  );
}

export function EmptyBlock({ text }: { text: string }) {
  return <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-[13px] font-bold text-slate-500">{text}</p>;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** SAR amount with Latin digits (the number is isolated left-to-right so a minus sign stays in place). */
export function Money({ value, className = '', unit = true }: { value: number | null | undefined; className?: string; unit?: boolean }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <span dir="ltr" className="tabular-nums">
        {formatMoney(value ?? 0)}
      </span>
      {unit && <span className="text-[0.8em] font-bold text-slate-400"> ر.س</span>}
    </span>
  );
}

export function Num({ value, className = '' }: { value: number | null | undefined; className?: string }) {
  return (
    <span dir="ltr" className={`tabular-nums ${className}`}>
      {value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}
    </span>
  );
}

export function StatusBadge({ status, className = '' }: { status: WfStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10.5px] font-black ${STATUS_STYLES[status] ?? STATUS_STYLES.PROVISIONAL} ${className}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div>
      <span id={id} className="block text-[12px] font-extrabold text-slate-600 mb-1.5">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={id} className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-black transition ${value === o.value ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[12px] font-extrabold text-slate-600 mb-1.5">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[16px] sm:text-[13px] font-bold text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const inputClass =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[16px] sm:text-[13px] font-bold text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-500';

export const buttonClass = {
  primary: 'inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-[13px] font-black text-white hover:bg-indigo-700 disabled:opacity-50',
  secondary: 'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50',
  link: 'inline-flex items-center gap-1 text-[12px] font-black text-indigo-700 hover:underline',
};

export function Card({ title, subtitle, children, className = '', actions }: { title?: string; subtitle?: string; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={`rounded-3xl border border-slate-100 bg-white p-4 sm:p-6 shadow-[0_10px_30px_rgba(0,0,0,0.02)] ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-[16px] font-black text-slate-800">{title}</h2>}
            {subtitle && <p className="mt-1 text-[12px] font-bold text-slate-500 leading-relaxed">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Composition bars
// ---------------------------------------------------------------------------

export interface BarItem {
  key: string;
  label: string;
  amount: number;
  kind: 'COST' | 'SUBSIDY' | 'MEMO';
}

/** Horizontal bars, share of the employer cost before subsidy; the subsidy and memo lines are shown apart. */
export function CompositionBars({ items }: { items: ReadonlyArray<BarItem> }) {
  const costTotal = items.filter((i) => i.kind === 'COST').reduce((s, i) => s + Math.max(0, i.amount), 0);
  const max = Math.max(1, ...items.map((i) => Math.abs(i.amount)));
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? Math.abs(b.amount) - Math.abs(a.amount) : a.kind === 'COST' ? -1 : b.kind === 'COST' ? 1 : a.kind === 'SUBSIDY' ? -1 : 1));
  return (
    <ul className="space-y-2.5">
      {sorted.map((i) => {
        const share = i.kind === 'COST' && costTotal > 0 ? (i.amount / costTotal) * 100 : null;
        const width = `${Math.max(0.5, (Math.abs(i.amount) / max) * 100)}%`;
        const color = i.kind === 'SUBSIDY' ? 'bg-green-600' : i.kind === 'MEMO' ? 'bg-slate-300' : (LINE_COLORS[i.key as keyof typeof LINE_COLORS] ?? 'bg-indigo-500');
        return (
          <li key={i.key}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12px] font-bold">
              <span className="text-slate-700">
                {i.label}
                {i.kind === 'MEMO' && <span className="text-slate-400"> (للعلم، غير محسوب في الإجمالي)</span>}
                {i.kind === 'SUBSIDY' && <span className="text-green-700"> (سطر سالب مشروط بقبول هدف)</span>}
              </span>
              <span className="text-slate-800">
                <Money value={i.amount} />
                {share !== null && (
                  <span dir="ltr" className="mr-2 text-slate-400 tabular-nums">
                    {share.toFixed(1)}%
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-2.5 rounded-full bg-slate-100 overflow-hidden" aria-hidden="true">
              <div className={`h-full rounded-full ${color}`} style={{ width }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Monthly series chart (SVG, accessible)
// ---------------------------------------------------------------------------

export function SeriesChart({
  series,
  title,
}: {
  series: ReadonlyArray<{ month: string; cost: number; net: number }>;
  title: string;
}) {
  if (!series.length) return null;
  const bw = 10;
  const W = series.length * bw;
  const H = 100;
  const max = Math.max(1, ...series.map((s) => s.cost));
  const first = series[0];
  const last = series[series.length - 1];
  const step = Math.max(1, Math.ceil(series.length / 4));
  const ticks = series.filter((_, i) => i % step === 0 || i === series.length - 1);
  const summary = `${title}: من ${first.month} إلى ${last.month}. أعلى شهر ${formatMoney(max)} ريال. الشهر الأول ${formatMoney(first.cost)} ريال، والأخير ${formatMoney(last.cost)} ريال.`;
  return (
    <figure className="w-full">
      {/* Bars only (stretched to the width); the month labels are HTML so they never scale. RTL: first month on the right. */}
      <svg viewBox={`0 0 ${W} ${H}`}preserveAspectRatio="none" role="img" aria-label={summary} className="w-full h-32 sm:h-40 border-b border-slate-300">
        {series.map((s, i) => {
          const x = W - (i + 1) * bw;
          const hc = (s.cost / max) * H;
          const hn = (Math.max(0, s.net) / max) * H;
          return (
            <g key={s.month}>
              <title>{`${s.month}: الكلفة ${formatMoney(s.cost)} ر.س، بعد الدعم ${formatMoney(s.net)} ر.س`}</title>
              <rect x={x + bw * 0.1} y={H - hc} width={bw * 0.8} height={hc} className="fill-indigo-200" />
              <rect x={x + bw * 0.3} y={H - hn} width={bw * 0.4} height={hn} className="fill-indigo-600" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] font-bold text-slate-500" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.month} dir="ltr">
            {t.month}
          </span>
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-[11px] font-bold text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-indigo-200" aria-hidden="true" /> الكلفة قبل الدعم
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-indigo-600" aria-hidden="true" /> بعد دعم هدف
        </span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// «لماذا؟» dialog
// ---------------------------------------------------------------------------

export interface WhyContent {
  title: string;
  amount?: number | null;
  basis?: string | null;
  formulaText?: string | null;
  note?: string | null;
  status?: WfStatus | null;
  evidence: ReadonlyArray<RuleEvidence>;
}

export function EvidenceList({ evidence }: { evidence: ReadonlyArray<RuleEvidence> }) {
  if (!evidence.length) return <p className="text-[12px] font-bold text-slate-500">محسوب من بيانات الموظف في رديف (الراتب والبدلات والتواريخ) دون قيمة نظامية.</p>;
  return (
    <ul className="space-y-3">
      {evidence.map((r) => (
        <li key={`${r.key}@${r.effectiveFrom ?? ''}`} className="rounded-2xl border border-slate-200 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-[13px] font-black text-slate-800 leading-relaxed">{r.label}</p>
            <StatusBadge status={r.status} />
          </div>
          <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[12px] font-bold text-slate-600">
            <div className="flex gap-1.5">
              <dt className="text-slate-400">القيمة:</dt>
              <dd dir="auto">{formatRuleValue(r.value, r.unit)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-slate-400">السريان من:</dt>
              <dd dir="ltr">{r.effectiveFrom ?? '—'}</dd>
            </div>
            <div className="flex gap-1.5 sm:col-span-2 min-w-0">
              <dt className="text-slate-400 shrink-0">المفتاح:</dt>
              <dd dir="ltr" className="font-mono text-[11px] break-all">
                {r.key}
              </dd>
            </div>
          </dl>
          {r.sourceQuote && <blockquote className="mt-2 border-r-4 border-slate-200 pr-3 text-[12px] font-bold text-slate-600 leading-relaxed">«{r.sourceQuote}»</blockquote>}
          {r.sourceUrl ? (
            <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] font-black text-indigo-700 hover:underline break-all">
              <ExternalLink size={13} aria-hidden="true" /> المصدر
            </a>
          ) : (
            r.status !== 'USER_INPUT' && r.status !== 'DERIVED' && r.status !== 'MISSING' && <p className="mt-2 text-[11px] font-bold text-slate-400">لا يوجد رابط مصدر مسجّل</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function WhyDialog({ content, onClose }: { content: WhyContent | null; onClose: () => void }) {
  return (
    <Modal open={!!content} onClose={onClose} title={content ? `لماذا هذا الرقم؟ ${content.title}` : ''} tone="indigo" size="lg">
      {content && (
        <div className="space-y-4 p-5 sm:p-6">
          {content.amount !== undefined && content.amount !== null && (
            <p className="text-[20px] font-black text-slate-900">
              <Money value={content.amount} />
              {content.status && <StatusBadge status={content.status} className="mr-2 align-middle" />}
            </p>
          )}
          {content.basis && (
            <div>
              <h3 className="text-[12px] font-black text-slate-500 mb-1">الحساب بالأرقام</h3>
              <p dir="auto" className="rounded-xl bg-slate-50 px-3 py-2 text-[13px] font-bold text-slate-800 leading-relaxed">
                {content.basis}
              </p>
            </div>
          )}
          {content.formulaText && (
            <div>
              <h3 className="text-[12px] font-black text-slate-500 mb-1">المعادلة</h3>
              <p className="text-[13px] font-bold text-slate-700 leading-relaxed">{content.formulaText}</p>
            </div>
          )}
          {content.note && <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-900">{content.note}</p>}
          <div>
            <h3 className="text-[12px] font-black text-slate-500 mb-2">القواعد والافتراضات المستخدمة</h3>
            <EvidenceList evidence={content.evidence} />
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Small "لماذا؟" button. */
export function WhyButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={`لماذا؟ ${label}`} className="rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-black text-indigo-700 hover:bg-indigo-100">
      لماذا؟
    </button>
  );
}

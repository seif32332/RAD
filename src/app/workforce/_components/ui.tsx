"use client";

// Shared building blocks of the workforce pages («محرك القرارات»): page frame with the section tabs,
// status badges, money, selectors, composition bars, a monthly series chart and the «لماذا؟» dialog.
import React, { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ChevronDown, ChevronLeft, Download, ExternalLink, FileSpreadsheet, HelpCircle, Info, Loader2, RefreshCw, Scale } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Modal from '@/components/ui/Modal';
import { readApiError, toast } from '@/components/ui/feedback';
import { formatMoney } from '@/lib/money';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import type { RuleEvidence, WfStatus } from '@/lib/workforce/types';
import PdfReportButton from './PdfReportButton';
import { LINE_COLORS, QIWA_NOTE, STATUS_LABELS, STATUS_STYLES, formatRuleValue } from '@/app/api/workforce/_lib/shared';

// ---------------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------------

/**
 * The engine in six sections, one per question the owner asks (mirrors the sidebar in src/lib/menu.ts).
 * A section with several pages shows them as tabs under the title.
 */
export const WF_SECTIONS = [
  { key: 'overview', label: 'نظرة عامة', pages: [{ href: '/workforce', label: 'نظرة عامة' }] },
  {
    key: 'cost',
    label: 'الكلفة',
    pages: [
      { href: '/workforce/true-cost', label: 'كلفة الموظفين' },
      { href: '/workforce/exit-cost', label: 'كلفة إنهاء الخدمة' },
    ],
  },
  {
    key: 'saudization',
    label: 'السعودة ونطاقات',
    pages: [
      { href: '/workforce/saudization', label: 'وضع النطاقات' },
      { href: '/workforce/nitaqat-register', label: 'الأنشطة وقرارات التوطين' },
    ],
  },
  {
    key: 'planning',
    label: 'التوظيف والتخطيط',
    pages: [
      { href: '/workforce/hire-scenario', label: 'مقارنة خيارات التوظيف' },
      { href: '/workforce/plans', label: 'خطط القوى العاملة' },
      { href: '/workforce/sensitivity', label: 'اختبار القرار' },
    ],
  },
  { key: 'benchmarks', label: 'مؤشرات المنشأة', pages: [{ href: '/workforce/benchmarks', label: 'مؤشرات المنشأة' }] },
  {
    key: 'settings',
    label: 'الإعدادات والمصادر',
    pages: [
      { href: '/workforce/assumptions', label: 'الافتراضات' },
      { href: '/workforce/rules', label: 'القواعد النظامية ومصادرها' },
      { href: '/workforce/calculations', label: 'الحسابات المحفوظة' },
    ],
  },
] as const;

function sectionOf(current: string) {
  return WF_SECTIONS.find((s) => s.pages.some((p) => p.href === current)) ?? WF_SECTIONS[0];
}

/**
 * Page frame: breadcrumb, title with one short sentence, actions, the section tabs, the content, and the
 * estimate disclaimer as a quiet footer. `help` is the longer explanation, folded under «كيف يُحسب هذا؟».
 */
export function WfPage({
  icon,
  title,
  subtitle,
  actions,
  current,
  help,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  current: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  const section = sectionOf(current);
  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 md:py-10 mb-32 space-y-6">
        <header className="space-y-4">
          {/* The overview's own title is «محرك القرارات», so the path only shows on the other sections. */}
          {section.key !== 'overview' && (
            <nav aria-label="مسار الصفحة" className="flex items-center gap-1.5 text-[12px] font-black text-slate-400">
              <Link href="/workforce" className="text-indigo-600 hover:underline">
                محرك القرارات
              </Link>
              <ChevronLeft size={14} aria-hidden="true" />
              <span className="text-slate-500">{section.label}</span>
            </nav>
          )}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl md:text-[28px] font-black text-slate-900 tracking-tight flex items-center gap-3">
                <span className="bg-indigo-50 text-indigo-600 p-2 rounded-xl shrink-0" aria-hidden="true">
                  {icon}
                </span>
                {title}
              </h1>
              <p className="text-slate-500 font-bold mt-2 text-[13.5px] leading-relaxed max-w-3xl">{subtitle}</p>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
          {section.pages.length > 1 && (
            <nav aria-label={`صفحات ${section.label}`} className="flex gap-1 overflow-x-auto border-b border-slate-200">
              {section.pages.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  aria-current={current === p.href ? 'page' : undefined}
                  className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-[13px] font-black transition ${
                    current === p.href ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {p.label}
                </Link>
              ))}
            </nav>
          )}
          {help && <HelpNote>{help}</HelpNote>}
        </header>
        {children}
        <Disclaimer />
      </div>
    </DashboardLayout>
  );
}

/** «كيف يُحسب هذا؟»: the longer explanation of a page, closed by default. */
export function HelpNote({ title = 'كيف يُحسب هذا؟', children }: { title?: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[12.5px] font-black text-slate-600 [&::-webkit-details-marker]:hidden">
        <HelpCircle size={16} className="text-indigo-500" aria-hidden="true" />
        {title}
        <ChevronDown size={15} className="mr-auto text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-slate-100 px-4 py-3 text-[12.5px] font-bold leading-relaxed text-slate-600 space-y-2">{children}</div>
    </details>
  );
}

/** Estimate disclaimer (SPEC principle 6): once per page, as a quiet footer. */
export function Disclaimer({ extra }: { extra?: string }) {
  return (
    <p role="note" className="flex items-start gap-2 border-t border-slate-100 pt-4 text-[11.5px] font-bold text-slate-400 leading-relaxed">
      <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        {ESTIMATE_DISCLAIMER} {QIWA_NOTE}
        {extra ? ` ${extra}` : ''}
      </span>
    </p>
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

/**
 * SAR amount with Latin digits (the number is isolated left-to-right so a minus sign stays in place).
 * `round`: whole riyals, for headline figures (the exact amount stays in the tables and «لماذا؟»).
 */
export function Money({ value, className = '', unit = true, round = false }: { value: number | null | undefined; className?: string; unit?: boolean; round?: boolean }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <span dir="ltr" className="tabular-nums">
        {formatMoney(round ? Math.round(value ?? 0) : (value ?? 0))}
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

// ---------------------------------------------------------------------------
// Excel export and decision sensitivity buttons (SPEC §11)
// ---------------------------------------------------------------------------

type QueryValue = string | number | boolean | null | undefined;

/** File name from Content-Disposition (RFC 5987 filename* first). */
function dispositionName(h: string | null): string | null {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall back to the ASCII name */
    }
  }
  return /filename="([^"]+)"/i.exec(h)?.[1] ?? null;
}

/**
 * «تصدير Excel»: GET /api/workforce/export?kind=…&query (or POST with `body`, the page's own request body),
 * then downloads the .xlsx. Disabled while loading; errors as a toast.
 */
export function ExportButton({
  kind,
  query,
  body,
  disabled,
  label = 'تصدير Excel',
  className = buttonClass.secondary,
}: {
  kind: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const u = new URLSearchParams({ kind });
      for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined && v !== '' && v !== false) u.set(k, v === true ? '1' : String(v));
      const res = await fetch(`/api/workforce/export?${u.toString()}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر التصدير'));
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = dispositionName(res.headers.get('Content-Disposition')) ?? `radeef-${kind}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      toast.error('تعذر التصدير: تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={run} disabled={disabled || busy} aria-busy={busy} className={className}>
      {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet size={16} aria-hidden="true" />} {busy ? 'جارٍ التصدير…' : label}
    </button>
  );
}

/** sessionStorage key of the decision handed to «حساسية القرار» (the request body stays out of the URL). */
export const SENSITIVITY_STORAGE_PREFIX = 'wf-sensitivity:';

/**
 * «حساسية القرار»: opens /workforce/sensitivity for this decision. A plan goes by id in the URL; a hire
 * scenario or an exit hands its request body through sessionStorage (no amounts or ids in the URL).
 */
export function SensitivityButton({ decision, body, planId, disabled }: { decision: 'hire' | 'exit' | 'plan'; body?: unknown; planId?: string; disabled?: boolean }) {
  const router = useRouter();
  const open = () => {
    if (decision === 'plan') {
      router.push(`/workforce/sensitivity?decision=plan&planId=${encodeURIComponent(planId ?? '')}`);
      return;
    }
    try {
      window.sessionStorage.setItem(`${SENSITIVITY_STORAGE_PREFIX}${decision}`, JSON.stringify(body ?? null));
    } catch {
      toast.error('تعذر فتح حساسية القرار: التخزين المؤقت للمتصفح غير متاح');
      return;
    }
    router.push(`/workforce/sensitivity?decision=${decision}`);
  };
  return (
    <button type="button" onClick={open} disabled={disabled} className={buttonClass.secondary}>
      <Scale size={16} aria-hidden="true" /> حساسية القرار
    </button>
  );
}

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-right text-[13px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50';

type ExportTarget = { kind: string; query?: Record<string, QueryValue>; body?: unknown; label?: string };

/**
 * «تصدير»: one button that opens the Excel file and the PDF report of the view on screen (they were two
 * buttons on every page). The menu stays open while a file is being prepared; Escape or a click outside closes it.
 */
export function ExportMenu({ excel, pdf, disabled, label = 'تصدير' }: { excel?: ExportTarget; pdf?: ExportTarget; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-controls={menuId} disabled={disabled} onClick={() => setOpen((o) => !o)} className={buttonClass.secondary}>
        <Download size={16} aria-hidden="true" /> {label} <ChevronDown size={14} className={`transition ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="absolute left-0 z-30 mt-2 w-60 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl">
          {excel && <ExportButton kind={excel.kind} query={excel.query} body={excel.body} label={excel.label ?? 'ملف Excel بالتفاصيل'} className={MENU_ITEM_CLASS} />}
          {pdf && <PdfReportButton kind={pdf.kind} query={pdf.query} body={pdf.body} label={pdf.label ?? 'تقرير PDF للطباعة'} className={MENU_ITEM_CLASS} />}
        </div>
      )}
    </div>
  );
}

/** Label and hint of the scenario selector, the same on every page. */
export const SCENARIO_FIELD_LABEL = 'التقدير';
export const SCENARIO_FIELD_HINT = 'يغيّر الافتراضات التي لها مدى فقط، مثل نسبة الزيادة السنوية.';

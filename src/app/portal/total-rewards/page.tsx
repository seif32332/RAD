"use client";

// «بيان المكافآت الشاملة» in the employee portal (SPEC §9): the employee's OWN statement for a year
// (GET /api/portal/total-rewards?year=; the employee comes from the session). Mobile-first and printable.
// Shown only when the owner enabled it; otherwise an explanatory message.
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Gift, Info, Printer, RefreshCw } from 'lucide-react';
import { readApiError } from '@/components/ui/feedback';
import { formatMoney } from '@/lib/money';
import { useRole } from '@/context/RoleContext';
import type { TotalRewardsLine, TotalRewardsLineKind, TotalRewardsStatement } from '@/lib/workforce/total-rewards';
import { redirectToLogin } from '../_components/redirect-to-login';
import UnlinkedAccountCard from '../_components/UnlinkedAccountCard';
import type { PortalTotalRewardsResponse } from '../_components/TotalRewardsCard';
import { isUnlinkedAccount } from '../_lib';
import PdfReportButton from '@/app/workforce/_components/PdfReportButton';

const GROUPS: ReadonlyArray<{ kind: TotalRewardsLineKind; title: string; hint: string; tone: string }> = [
  { kind: 'CASH', title: 'ما صُرف لك', hint: 'من مسيرات الرواتب المعتمدة', tone: 'text-emerald-700' },
  { kind: 'EMPLOYER', title: 'ما تدفعه المنشأة عنك', hint: 'فوق راتبك، ولا يُخصم منك', tone: 'text-indigo-700' },
  { kind: 'ACCRUAL', title: 'ما يتراكم لك', hint: 'يُصرف عند انتهاء الخدمة', tone: 'text-amber-700' },
  { kind: 'MEMO', title: 'للعلم (لا يدخل في الإجمالي)', hint: '', tone: 'text-slate-500' },
];

const SOURCE_STYLE: Record<string, string> = {
  PAYROLL: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  ENGINE: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  COMPANY_SETTING: 'border-sky-200 bg-sky-50 text-sky-800',
  ESTIMATE_ART84: 'border-amber-200 bg-amber-50 text-amber-800',
  MISSING: 'border-slate-200 bg-slate-50 text-slate-500',
};

function Amount({ value, className = '' }: { value: number; className?: string }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <span dir="ltr" className="tabular-nums">{formatMoney(value)}</span>
      <span className="text-[0.75em] font-bold text-slate-400"> ر.س</span>
    </span>
  );
}

function LineItem({ line }: { line: TotalRewardsLine }) {
  return (
    <li className="py-3 border-b border-slate-100 last:border-0 break-inside-avoid">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-black text-slate-800">{line.label}</p>
          <span className={`mt-1 inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-black ${SOURCE_STYLE[line.source] ?? SOURCE_STYLE.MISSING}`}>{line.sourceLabel}</span>
        </div>
        <p className="text-[15px] font-black text-slate-900 shrink-0">{line.available ? <Amount value={line.amount} /> : <span className="text-[12.5px] text-slate-400">غير متوفر</span>}</p>
      </div>
      <p className="mt-1.5 text-[12.5px] font-bold text-slate-600 leading-relaxed">{line.explanation}</p>
      {line.items && line.items.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-xl bg-slate-50 px-3 py-2">
          {line.items.map((it, i) => (
            <li key={`${it.label}-${i}`} className="flex justify-between gap-2 text-[12px] font-bold text-slate-600">
              <span>
                {it.label}
                {it.note && <span className="text-slate-400"> · {it.note}</span>}
              </span>
              <Amount value={it.amount} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] font-bold text-slate-400" dir="auto">{line.basis}</p>
    </li>
  );
}

function Statement({ s }: { s: TotalRewardsStatement }) {
  return (
    <div className="space-y-4">
      <section aria-label="الإجمالي" className="rounded-[1.75rem] bg-gradient-to-br from-emerald-600 to-teal-700 p-5 md:p-6 text-white shadow-lg break-inside-avoid">
        <p className="text-[13px] font-bold text-emerald-50">كلفة المنشأة عليك في {s.year}</p>
        <p className="mt-1 text-[30px] md:text-[36px] font-black leading-tight">
          <span dir="ltr" className="tabular-nums">{formatMoney(s.totals.total)}</span> <span className="text-[16px] font-bold">ر.س</span>
        </p>
        <dl className="mt-4 grid grid-cols-3 gap-2 text-[11.5px] font-bold">
          <div className="rounded-xl bg-white/10 p-2">
            <dt className="text-emerald-50">صُرف لك</dt>
            <dd className="mt-0.5 text-[13px] font-black" dir="ltr">{formatMoney(s.totals.cash)}</dd>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <dt className="text-emerald-50">دفعته المنشأة عنك</dt>
            <dd className="mt-0.5 text-[13px] font-black" dir="ltr">{formatMoney(s.totals.employerPaid)}</dd>
          </div>
          <div className="rounded-xl bg-white/10 p-2">
            <dt className="text-emerald-50">تراكم لك</dt>
            <dd className="mt-0.5 text-[13px] font-black" dir="ltr">{formatMoney(s.totals.accrued)}</dd>
          </div>
        </dl>
      </section>

      {GROUPS.map((g) => {
        const lines = s.lines.filter((l) => l.kind === g.kind);
        if (!lines.length) return null;
        return (
          <section key={g.kind} aria-labelledby={`tr-${g.kind}`} className="rounded-[1.75rem] border border-slate-100 bg-white p-4 md:p-5 shadow-sm break-inside-avoid">
            <h2 id={`tr-${g.kind}`} className={`text-[15px] font-black ${g.tone}`}>{g.title}</h2>
            {g.hint && <p className="text-[11.5px] font-bold text-slate-400">{g.hint}</p>}
            <ul className="mt-1">
              {lines.map((l) => (
                <LineItem key={l.key} line={l} />
              ))}
            </ul>
          </section>
        );
      })}

      {s.notes.length > 0 && (
        <ul className="space-y-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] font-bold text-slate-600">
          {s.notes.map((n) => (
            <li key={n} className="flex items-start gap-2">
              <Info size={14} className="shrink-0 mt-0.5 text-slate-400" aria-hidden="true" /> {n}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
        بيان للاطلاع مبني على بيانات رديف. مكافأة نهاية الخدمة تقدير حسب المادة 84 بأجرك الحالي، والمبلغ الفعلي يُحسب عند انتهاء الخدمة حسب سببها. لأي استفسار راجع الموارد البشرية.
      </p>
    </div>
  );
}

export default function TotalRewardsPage() {
  const { user: me, loading: meLoading } = useRole();
  const unlinked = isUnlinkedAccount(me, meLoading);
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<PortalTotalRewardsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (y: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/total-rewards${y ? `?year=${y}` : ''}`, { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setError(await readApiError(res, 'تعذر تحميل البيان'));
        return;
      }
      setData((await res.json()) as PortalTotalRewardsResponse);
    } catch {
      setError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (meLoading || unlinked) return;
    void load(year);
  }, [load, year, meLoading, unlinked]);

  if (unlinked) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 pb-32">
        <UnlinkedAccountCard />
      </div>
    );
  }

  const enabled = data && data.enabled ? data : null;
  const yearOptions: number[] = [];
  if (enabled) for (let y = enabled.years.last; y >= enabled.years.first && yearOptions.length < 30; y--) yearOptions.push(y);
  const shownYear = enabled?.statement.year ?? year;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-2 pb-28 md:py-8 space-y-5 print:max-w-none print:p-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/portal" aria-label="العودة إلى البوابة" className="w-10 h-10 rounded-full flex items-center justify-center bg-slate-100 text-slate-600 hover:bg-slate-200 transition shrink-0 print:hidden">
            <ArrowRight size={20} />
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl md:text-2xl font-black text-slate-800">
              <Gift size={22} className="text-emerald-600 shrink-0" aria-hidden="true" /> بيان المكافآت الشاملة
            </h1>
            {enabled && (
              <p className="text-[12px] font-bold text-slate-500 truncate">
                {enabled.statement.employee.name}
                {enabled.statement.employee.employeeNo && <span dir="ltr"> #{enabled.statement.employee.employeeNo}</span>}
                {enabled.statement.employee.companyName && ` · ${enabled.statement.employee.companyName}`}
              </p>
            )}
          </div>
        </div>
        {enabled && (
          <div className="flex items-center gap-2 sm:shrink-0 print:hidden">
            <label htmlFor="tr-year" className="sr-only">السنة</label>
            <select
              id="tr-year"
              value={shownYear ?? ''}
              onChange={(e) => setYear(Number(e.target.value))}
              className="flex-1 sm:flex-none min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-base sm:text-[13px] font-bold text-slate-800"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                  {enabled.payrollYears.includes(y) ? '' : ' (بلا مسيرات)'}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-black text-slate-700 hover:bg-slate-50" aria-label="طباعة البيان">
              <Printer size={16} aria-hidden="true" /> <span className="hidden sm:inline">طباعة</span>
            </button>
            <PdfReportButton endpoint="/api/portal/total-rewards/pdf" query={{ year: shownYear }} label="تنزيل PDF" className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50" />
          </div>
        )}
      </div>

      {loading && !data && (
        <p role="status" className="py-12 text-center text-[13px] font-bold text-slate-500">
          جارٍ تحميل البيان…
        </p>
      )}
      {error && (
        <div role="alert" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-[13px] font-bold text-rose-800">{error}</p>
          <button type="button" onClick={() => void load(year)} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-[12px] font-black text-white">
            <RefreshCw size={14} aria-hidden="true" /> إعادة المحاولة
          </button>
        </div>
      )}
      {data && !data.enabled && <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-[13px] font-bold text-slate-500">{data.message}</p>}
      {enabled && (
        <div className={loading ? 'opacity-60 transition-opacity' : ''} aria-busy={loading}>
          {enabled.statement.available ? (
            <Statement s={enabled.statement} />
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-[13px] font-bold text-slate-500">{enabled.statement.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}

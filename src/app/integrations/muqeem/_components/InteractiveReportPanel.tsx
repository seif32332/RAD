"use client";

import React, { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { todayKey } from '@/lib/dates';
import { callApi, type MuqeemStatusCompany } from './shared';

interface ReportRow {
  date: string;
  type: string;
  description: string;
  iqamaNumber: string;
  requestNumber: string;
  errorMessage: string;
  user: string;
  company: string;
}

const daysAgoKey = (n: number) => new Date(Date.parse(`${todayKey()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Read-only view of Muqeem's interactive services report, to help reconcile undetermined transactions. */
export default function InteractiveReportPanel({ companies, usable }: { companies: MuqeemStatusCompany[]; usable: boolean }) {
  const linked = companies.filter((c) => c.linked);
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState(linked[0]?.id ?? '');
  const [fromDate, setFromDate] = useState(daysAgoKey(7));
  const [toDate, setToDate] = useState(todayKey());
  const [operatorId, setOperatorId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [filter, setFilter] = useState('');

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || !companyId) return;
    setLoading(true);
    setError(null);
    const res = await callApi<{ rows: ReportRow[] }>('/api/integrations/muqeem/transactions/interactive-report', {
      json: { companyId, fromDate, toDate, operatorId: operatorId.trim() },
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      setRows(null);
      return;
    }
    setRows(res.data.rows);
  };

  const shown = rows?.filter((r) => !filter.trim() || `${r.iqamaNumber} ${r.requestNumber} ${r.description} ${r.type}`.includes(filter.trim())) ?? null;

  return (
    <section className="rounded-2xl border border-slate-100 bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 p-4 text-right"
      >
        <span>
          <span className="block text-[15px] font-black text-slate-800">تقرير الخدمات التفاعلية من مقيم (للتسوية)</span>
          <span className="block text-[12px] font-bold text-slate-500">قراءة فقط: يعرض كل الطلبات التي نُفّذت على مقيم للمنشأة خلال فترة (حتى 31 يوماً).</span>
        </span>
        <span className="text-[12px] font-black text-blue-600">{open ? 'إخفاء' : 'عرض'}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4 space-y-4">
          {!linked.length ? (
            <p className="text-[13px] font-bold text-slate-500">لا توجد شركة مربوطة بمقيم.</p>
          ) : (
            <form onSubmit={run} className="grid gap-3 md:grid-cols-5 md:items-end">
              <label className="space-y-1 md:col-span-2">
                <span className="text-[12px] font-black text-slate-500">الشركة</span>
                <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full h-11 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-bold">
                  {linked.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[12px] font-black text-slate-500">من</span>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full h-11 rounded-xl border border-slate-200 px-3 text-[13px] font-bold" />
              </label>
              <label className="space-y-1">
                <span className="text-[12px] font-black text-slate-500">إلى</span>
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full h-11 rounded-xl border border-slate-200 px-3 text-[13px] font-bold" />
              </label>
              <label className="space-y-1">
                <span className="text-[12px] font-black text-slate-500">رقم هوية المشغل في مقيم</span>
                <input
                  value={operatorId}
                  onChange={(e) => setOperatorId(e.target.value)}
                  inputMode="numeric"
                  maxLength={10}
                  dir="ltr"
                  placeholder="1xxxxxxxxx"
                  className="w-full h-11 rounded-xl border border-slate-200 px-3 font-mono text-[13px]"
                />
              </label>
              <div className="md:col-span-5 flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={loading || !usable}
                  className="inline-flex h-11 items-center gap-2 rounded-xl bg-slate-800 px-5 text-[13px] font-black text-white hover:bg-slate-900 disabled:opacity-50"
                >
                  {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} عرض التقرير
                </button>
                <span className="text-[12px] font-bold text-slate-400">
                  «رقم هوية المشغل» هو هوية مستخدم مقيم الذي نفّذ الطلبات (10 أرقام تبدأ بـ 1 أو 2)، حسب مواصفة مقيم.
                </span>
              </div>
            </form>
          )}
          {error && (
            <p role="alert" className="rounded-xl bg-rose-50 p-3 text-[13px] font-bold text-rose-800">
              {error}
            </p>
          )}
          {shown && (
            <>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="تصفية نتائج التقرير"
                placeholder="تصفية برقم الإقامة أو رقم الطلب..."
                className="w-full md:w-80 h-10 rounded-xl border border-slate-200 px-3 text-[13px] font-bold"
              />
              <div className="overflow-x-auto">
                <table className="w-full text-right text-[12px]">
                  <thead className="bg-slate-50 font-black text-slate-500">
                    <tr>
                      <th className="px-3 py-2">التاريخ</th>
                      <th className="px-3 py-2">الخدمة</th>
                      <th className="px-3 py-2">الوصف</th>
                      <th className="px-3 py-2">رقم الإقامة</th>
                      <th className="px-3 py-2">رقم الطلب</th>
                      <th className="px-3 py-2">الخطأ</th>
                      <th className="px-3 py-2">المستخدم</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                          لا توجد طلبات في هذه الفترة
                        </td>
                      </tr>
                    )}
                    {shown.map((r, i) => (
                      <tr key={`${r.requestNumber}-${i}`}>
                        <td className="px-3 py-2 whitespace-nowrap" dir="ltr">{r.date.replace('T', ' ').slice(0, 16)}</td>
                        <td className="px-3 py-2">{r.type || '—'}</td>
                        <td className="px-3 py-2">{r.description || '—'}</td>
                        <td className="px-3 py-2 font-mono" dir="ltr">{r.iqamaNumber || '—'}</td>
                        <td className="px-3 py-2 font-mono" dir="ltr">{r.requestNumber || '—'}</td>
                        <td className="px-3 py-2 text-rose-700">{r.errorMessage || '—'}</td>
                        <td className="px-3 py-2">{r.user || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

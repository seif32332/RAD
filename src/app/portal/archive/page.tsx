"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle, XCircle, Clock, Search, ShieldAlert, History, AlertCircle, RefreshCw, X } from 'lucide-react';
import Link from 'next/link';
import { readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { redirectToLogin } from '../_components/redirect-to-login';
import UnlinkedAccountCard from '../_components/UnlinkedAccountCard';
import { isUnlinkedAccount } from '../_lib';
import { useRole } from '@/context/RoleContext';

interface HistoryItem {
  id: string;
  type: string;
  details?: string | null;
  status: string;
  date: string;
  attachment?: string | null;
}

type Filter = 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED';

const REQUEST_TAG = /\[طلب:\s*(.+?)\]/;

function matchesFilter(h: HistoryItem, filter: Filter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'APPROVED') return h.status === 'APPROVED' || h.status === 'COMPLETED';
  if (filter === 'REJECTED') return h.status === 'REJECTED' || h.status === 'CANCELLED';
  return h.status !== 'APPROVED' && h.status !== 'COMPLETED' && h.status !== 'REJECTED' && h.status !== 'CANCELLED';
}

export default function EmployeeArchivePage() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  // Accounts without an employee file (admins, finance...) have no request archive.
  const [notLinked, setNotLinked] = useState(false);
  const { user: me, loading: meLoading } = useRole();
  const unlinked = isUnlinkedAccount(me, meLoading);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/portal', { cache: 'no-store' });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 404) {
        setNotLinked(true);
        return;
      }
      if (!res.ok) {
        setError(await readApiError(res, 'تعذر تحميل أرشيف الطلبات'));
        return;
      }
      const data = (await res.json()) as { history?: HistoryItem[] };
      setHistory(Array.isArray(data.history) ? data.history : []);
    } catch {
      setError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (meLoading || unlinked) return;
    void load();
  }, [load, meLoading, unlinked]);

  const filteredHistory = history.filter((h) => matchesFilter(h, filter));

  if (unlinked || notLinked) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 pb-32">
        <UnlinkedAccountCard />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 pb-32">
      {/* Header (the page renders inside the app shell: no full-screen / sticky header) */}
      <div className="flex items-center justify-between gap-4 pb-6 mb-6 border-b border-slate-200">
        <div className="flex items-center gap-4">
          <Link href="/portal" aria-label="العودة إلى البوابة" className="w-10 h-10 rounded-full flex items-center justify-center bg-slate-100 text-slate-600 hover:bg-slate-200 transition">
            <ArrowRight size={20} />
          </Link>
          <div>
            <h1 className="text-xl font-black text-slate-800">أرشيف الطلبات</h1>
            <p className="text-[12px] font-bold text-slate-500 mt-0.5">سجل كامل بجميع طلباتك المرفوعة مسبقاً</p>
          </div>
        </div>
        <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center border border-blue-100">
          <History size={24} />
        </div>
      </div>

      <div>
        {/* Filters */}
        <div className="flex gap-2 overflow-x-auto pb-4 hide-scrollbar mb-4">
          <button type="button" onClick={() => setFilter('ALL')} className={`px-5 py-2.5 rounded-xl text-[13px] font-black shrink-0 transition ${filter === 'ALL' ? 'bg-slate-800 text-white shadow-md' : 'bg-white text-slate-500 border border-slate-200'}`}>الكل</button>
          <button type="button" onClick={() => setFilter('PENDING')} className={`px-5 py-2.5 rounded-xl text-[13px] font-black shrink-0 transition flex items-center gap-2 ${filter === 'PENDING' ? 'bg-amber-500 text-white shadow-md shadow-amber-500/20' : 'bg-white text-slate-500 border border-slate-200'}`}><Clock size={16} /> قيد المراجعة</button>
          <button type="button" onClick={() => setFilter('APPROVED')} className={`px-5 py-2.5 rounded-xl text-[13px] font-black shrink-0 transition flex items-center gap-2 ${filter === 'APPROVED' ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20' : 'bg-white text-slate-500 border border-slate-200'}`}><CheckCircle size={16} /> مكتملة</button>
          <button type="button" onClick={() => setFilter('REJECTED')} className={`px-5 py-2.5 rounded-xl text-[13px] font-black shrink-0 transition flex items-center gap-2 ${filter === 'REJECTED' ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20' : 'bg-white text-slate-500 border border-slate-200'}`}><XCircle size={16} /> مرفوضة / ملغاة</button>
        </div>

        {/* List */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center">
              <div className="w-10 h-10 border-4 border-slate-100 border-t-blue-500 rounded-full animate-spin mb-4" />
              <p className="text-slate-500 font-bold">جاري تحميل الأرشيف...</p>
            </div>
          ) : error ? (
            <div className="py-24 flex flex-col items-center justify-center text-center px-4 gap-4">
              <AlertCircle size={40} className="text-rose-400" />
              <p className="text-slate-600 font-bold">{error}</p>
              <button type="button" onClick={() => void load()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-black text-[13px] transition">
                <RefreshCw size={16} /> إعادة المحاولة
              </button>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="py-32 flex flex-col items-center justify-center text-center px-4">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6 text-slate-300">
                <Search size={40} />
              </div>
              <h2 className="text-xl font-black text-slate-800 mb-2">لا توجد طلبات</h2>
              <p className="text-slate-500 font-bold text-[14px]">لم تقم برفع أي طلبات تتطابق مع التصفية الحالية.</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filteredHistory.map((h) => (
                <li key={h.id} className="p-6 hover:bg-slate-50 transition flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="w-2 h-2 rounded-full bg-slate-300"></span>
                      <h3 className="font-extrabold text-[15px] text-slate-800">
                        {h.type === 'تصحيح بصمة' && h.details?.includes('[طلب:') ? h.details.match(REQUEST_TAG)?.[1] || h.type : h.type}
                      </h3>
                      <span className="text-[11px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-lg font-mono">{formatDateShort(h.date)}</span>
                    </div>
                    <p className="font-semibold text-[13px] text-slate-500 leading-relaxed max-w-xl whitespace-pre-line">
                      {h.details?.replace(/\[طلب:.*?\]\s*/, '')}
                    </p>
                  </div>
                  <div className="shrink-0 pt-2 sm:pt-0">
                    {h.status === 'APPROVED' || h.status === 'COMPLETED' ? (
                      <span className="bg-emerald-50 text-emerald-600 text-[12px] font-black px-4 py-2 rounded-xl border border-emerald-100 flex items-center gap-2 w-fit"><CheckCircle size={16} /> معتمدة</span>
                    ) : h.status === 'REJECTED' ? (
                      <span className="bg-rose-50 text-rose-600 text-[12px] font-black px-4 py-2 rounded-xl border border-rose-100 flex items-center gap-2 w-fit"><ShieldAlert size={16} /> مرفوضة</span>
                    ) : h.status === 'CANCELLED' ? (
                      <span className="bg-slate-100 text-slate-500 text-[12px] font-black px-4 py-2 rounded-xl border border-slate-200 flex items-center gap-2 w-fit"><X size={16} /> ملغاة</span>
                    ) : (
                      <span className="bg-amber-50 text-amber-600 text-[12px] font-black px-4 py-2 rounded-xl border border-amber-100 flex items-center gap-2 w-fit"><Clock size={16} /> قيد المراجعة</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

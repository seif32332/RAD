"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowRight, CheckCircle, XCircle, Search, AlertCircle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import { redirectToLogin } from '@/app/portal/_components/redirect-to-login';
import { formatDate } from '@/lib/dates';

interface ArchiveItem {
  id: string;
  type: string;
  title?: string | null;
  status: string;
  employeeName?: string | null;
  employeeId?: string | null;
  department?: string | null;
  updatedAt: string;
  details?: string | null;
}

export default function IncomingRequestsArchivePage() {
  const [archive, setArchive] = useState<ArchiveItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/incoming-requests/archive', { cache: 'no-store' });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل الأرشيف'));
        return;
      }
      const data = (await res.json()) as { archive?: ArchiveItem[] };
      setArchive(Array.isArray(data.archive) ? data.archive : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const term = searchTerm.trim().toLowerCase();
  const filteredArchive = term
    ? archive.filter((item) =>
        (item.employeeName ?? '').toLowerCase().includes(term) ||
        (item.employeeId ?? '').toLowerCase().includes(term) ||
        (item.title ?? '').toLowerCase().includes(term),
      )
    : archive;

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
          <div className="flex items-center gap-4">
            <Link href="/incoming-requests" aria-label="العودة إلى الطلبات الواردة" className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-200 transition">
              <ArrowRight size={24} />
            </Link>
            <div>
              <h1 className="text-2xl font-black text-slate-800 flex items-center gap-2">
                <Archive className="text-blue-600" size={28} /> الأرشيف الشامل للطلبات
              </h1>
              <p className="text-slate-500 font-bold mt-1 text-[13px]">
                سجل بجميع الطلبات الواردة التي تمت معالجتها (تم الاعتماد / تم الرفض).
              </p>
            </div>
          </div>

          <div className="relative w-full md:w-auto">
            <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-slate-400">
              <Search size={18} />
            </div>
            <input
              type="text"
              aria-label="البحث في الأرشيف"
              placeholder="البحث بالاسم، الرقم الوظيفي..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full md:w-80 bg-slate-50 border border-slate-200 text-slate-800 font-bold px-10 py-3 rounded-xl focus:outline-none focus:border-blue-400"
            />
          </div>
        </div>

        {/* List */}
        <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden">
          {isLoading ? (
            <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري تحميل الأرشيف...</div>
          ) : loadError ? (
            <div className="py-24 flex flex-col items-center justify-center text-center px-4 gap-4">
              <AlertCircle size={40} className="text-rose-400" />
              <p className="text-slate-600 font-bold">{loadError}</p>
              <button type="button" onClick={() => void load()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-black text-[13px] transition">
                <RefreshCw size={16} /> إعادة المحاولة
              </button>
            </div>
          ) : filteredArchive.length === 0 ? (
            <div className="py-32 flex flex-col items-center justify-center text-center px-4">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6 text-slate-300">
                <Archive size={40} />
              </div>
              <h2 className="text-xl font-black text-slate-800 mb-2">الأرشيف فارغ</h2>
              <p className="text-slate-500 font-bold text-[14px]">لا توجد طلبات معالجة تتطابق مع بحثك.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse min-w-[800px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="p-5 text-[13px] font-black text-slate-500">مقدم الطلب</th>
                    <th className="p-5 text-[13px] font-black text-slate-500">نوع الطلب</th>
                    <th className="p-5 text-[13px] font-black text-slate-500">التفاصيل</th>
                    <th className="p-5 text-[13px] font-black text-slate-500">التاريخ</th>
                    <th className="p-5 text-[13px] font-black text-slate-500">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredArchive.map((req) => (
                    <tr key={req.id} className="hover:bg-slate-50 transition">
                      <td className="p-5">
                        <p className="font-extrabold text-[14px] text-slate-800">{req.employeeName}</p>
                        <p className="font-bold text-[11px] text-slate-400 mt-0.5">#{req.employeeId} | {req.department || 'عام'}</p>
                      </td>
                      <td className="p-5">
                        <span className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg text-[12px] font-black inline-block">{req.title}</span>
                      </td>
                      <td className="p-5">
                        <p className="font-bold text-[12px] text-slate-600 max-w-xs">{req.details}</p>
                      </td>
                      <td className="p-5 font-bold text-[13px] text-slate-500">
                        {formatDate(req.updatedAt)}
                      </td>
                      <td className="p-5">
                        {req.status === 'APPROVED' || req.status === 'COMPLETED' ? (
                          <span className="bg-emerald-50 text-emerald-600 px-3 py-1.5 rounded-lg text-[12px] font-black flex items-center gap-1.5 w-fit">
                            <CheckCircle size={14} /> تمت الموافقة
                          </span>
                        ) : req.status === 'CANCELLED' ? (
                          <span className="bg-slate-100 text-slate-500 px-3 py-1.5 rounded-lg text-[12px] font-black flex items-center gap-1.5 w-fit">
                            <XCircle size={14} /> ملغى
                          </span>
                        ) : (
                          <span className="bg-rose-50 text-rose-600 px-3 py-1.5 rounded-lg text-[12px] font-black flex items-center gap-1.5 w-fit">
                            <XCircle size={14} /> مرفوض
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </DashboardLayout>
  );
}

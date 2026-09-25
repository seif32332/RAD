"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Zap, Plus, MoreVertical, Search, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';

interface UtilityMeter {
  id: string;
  meterNumber?: string | null;
  meterCode?: string | null;
  accountNumber?: string | null;
  branch?: { nameArabic?: string | null } | null;
  legalCompany?: { nameArabic?: string | null } | null;
  actualCompany?: { nameArabic?: string | null } | null;
}

export default function UtilityMetersPage() {
  const [meters, setMeters] = useState<UtilityMeter[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');

  const fetchMeters = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/services/utilities');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل العدادات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setMeters(Array.isArray(data) ? (data as UtilityMeter[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchMeters(); }, [fetchMeters]);

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('هل أنت متأكد من رغبتك في حذف هذا العداد؟', { danger: true }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/services/utilities/${id}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'حدث خطأ أثناء الحذف')); return; }
      setMeters(prev => prev.filter(m => m.id !== id));
      toast.success('تم حذف العداد');
    } catch {
      toast.error('حدث خطأ أثناء الحذف');
    } finally {
      setDeletingId(null);
    }
  };

  const query = searchText.trim().toLowerCase();
  const filteredMeters = query
    ? meters.filter((m) =>
        [m.meterNumber, m.meterCode, m.accountNumber, m.branch?.nameArabic, m.legalCompany?.nameArabic, m.actualCompany?.nameArabic]
          .some((v) => String(v || '').toLowerCase().includes(query)))
    : meters;

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Zap className="text-amber-600" />
              عدادات الكهرباء والمياه
            </h1>
            <p className="text-slate-500 text-sm mt-1">إدارة عدادات المرافق وتوزيعها حسب الشركة والفرع</p>
          </div>

          <Link
            href="/services/utilities/new"
            className="bg-amber-600 hover:bg-amber-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-amber-500/30 font-medium"
          >
            <Plus size={20} />
            إضافة عداد جديد
          </Link>
        </div>

        {/* Search */}
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              aria-label="بحث في العدادات"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="ابحث برقم العداد أو كود الحساب..."
              className="w-full pl-4 pr-10 py-2.5 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-amber-100 text-sm font-semibold"
            />
          </div>
        </div>

        {/* States Handling */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-20 gap-4">
             <div className="w-8 h-8 rounded-full border-4 border-amber-100 border-t-amber-600 animate-spin" />
             <p className="text-slate-500 font-bold">جاري جلب العدادات...</p>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center mt-10">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchMeters} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : meters.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <Zap size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد أي عدادات حتى الآن</h2>
            <p className="text-slate-500 max-w-sm mb-8">قم بتسجيل أول عداد للكهرباء أو المياه واربطه بالفرع المستفيد.</p>
            <Link href="/services/utilities/new" className="px-6 py-3 bg-amber-600 text-white font-bold rounded-xl hover:bg-amber-700 transition">
              + إنشاء عداد
            </Link>
          </div>
        ) : filteredMeters.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center flex flex-col items-center justify-center mt-10">
            <Search size={48} className="text-slate-200 mb-4" />
            <h2 className="text-lg font-bold text-slate-700 mb-4">لا توجد نتائج مطابقة للبحث</h2>
            <button type="button" onClick={() => setSearchText('')} className="px-6 py-3 bg-amber-50 text-amber-700 font-bold rounded-xl hover:bg-amber-100 transition">مسح البحث</button>
          </div>
        ) : (
          /* Grid Style view just for variety and since they might want photos */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-4">
            {filteredMeters.map((meter) => (
               <div key={meter.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 hover:border-amber-200 hover:shadow-md transition">
                  <div className="p-6 border-b border-slate-50 flex justify-between items-start">
                     <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shadow-inner">
                           <Zap size={24} />
                        </div>
                        <div>
                           <h3 className="font-bold text-slate-800 text-lg">العداد: {meter.meterNumber}</h3>
                           <p className="text-[11px] font-bold text-slate-400 bg-slate-50 px-2 py-0.5 rounded-lg mt-1 inline-block border border-slate-100">سداد: {meter.accountNumber || '-'}</p>
                        </div>
                     </div>
                     <div className="relative">
                       <button
                         type="button"
                         aria-label="خيارات العداد"
                         aria-haspopup="menu"
                         aria-expanded={activeMenuId === meter.id}
                         onClick={() => setActiveMenuId(activeMenuId === meter.id ? null : meter.id)}
                         className="text-slate-400 hover:text-amber-600 p-2 rounded-lg transition hover:bg-amber-50 bg-white shadow-sm border border-slate-100"
                       >
                          <MoreVertical size={18} />
                       </button>

                       {activeMenuId === meter.id && (
                         <>
                           <button type="button" aria-label="إغلاق القائمة" className="fixed inset-0 z-10 cursor-default" onClick={() => setActiveMenuId(null)}></button>
                           <div role="menu" className="absolute left-0 mt-2 w-36 bg-white rounded-xl shadow-xl border border-slate-100 py-2 z-20 flex flex-col items-start overflow-hidden">
                             <Link role="menuitem" href={`/services/utilities/${meter.id}/edit`} className="w-full text-right px-4 py-2 hover:bg-slate-50 text-slate-700 font-bold text-sm transition-colors">
                               تعديل العداد
                             </Link>
                             <button type="button" role="menuitem" disabled={deletingId === meter.id} onClick={() => { setActiveMenuId(null); handleDelete(meter.id); }} className="w-full text-right px-4 py-2 hover:bg-red-50 text-red-600 font-bold text-sm transition-colors disabled:opacity-50">
                               حذف العداد
                             </button>
                           </div>
                         </>
                       )}
                     </div>
                  </div>

                  <div className="p-6 space-y-4">
                     <div className="flex justify-between items-center text-sm">
                        <span className="text-slate-500 font-semibold">موقع العداد (الفرع):</span>
                        <span className="font-bold text-slate-800">{meter.branch?.nameArabic || 'غير محدد'}</span>
                     </div>
                     <div className="flex justify-between items-center text-sm pt-3 border-t border-slate-50">
                        <span className="text-slate-500 font-semibold">مالك قانوني:</span>
                        <span className="font-bold text-amber-700 truncate max-w-[150px]">{meter.legalCompany?.nameArabic || '-'}</span>
                     </div>
                     <div className="flex justify-between items-center text-sm pt-3 border-t border-slate-50">
                        <span className="text-slate-500 font-semibold">مستفيد فعلي:</span>
                        <span className="font-bold text-emerald-700 truncate max-w-[150px]">{meter.actualCompany?.nameArabic || '-'}</span>
                     </div>
                  </div>
               </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

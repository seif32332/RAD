"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Smartphone, Plus, Search, Edit3, Trash2, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';

interface NamedEntity { nameArabic?: string | null }

interface TelecomSim {
  id: string;
  simNumber: string;
  accountNumber?: string | null;
  provider?: string | null;
  plan?: string | null;
  serviceType?: string | null;
  employee?: {
    firstNameArabic?: string;
    lastNameArabic?: string;
    employeeId?: string;
    legalCompany?: NamedEntity | null;
    branch?: NamedEntity | null;
    department?: NamedEntity | null;
  } | null;
  branch?: NamedEntity | null;
  company?: NamedEntity | null;
}

const FILTER_BUTTON = 'px-4 py-2 rounded-xl text-sm font-bold transition-all';
const FILTER_ACTIVE = 'bg-blue-600 text-white shadow-md';
const FILTER_IDLE = 'bg-slate-100 text-slate-600 hover:bg-slate-200';

export default function TelecomSimsPage() {
  const [sims, setSims] = useState<TelecomSim[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [searchText, setSearchText] = useState("");
  const [filterType, setFilterType] = useState("ALL");

  const fetchSims = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/services/telecom');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل الشرائح');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setSims(Array.isArray(data) ? (data as TelecomSim[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSims();
  }, [fetchSims]);

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('هل أنت متأكد من حذف هذه الشريحة نهائياً؟ لا يمكن التراجع عن ذلك.', { danger: true }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/services/telecom/${id}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حذف الشريحة')); return; }
      toast.success('تم حذف الشريحة بنجاح');
      fetchSims();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setDeletingId(null);
    }
  };

  const filteredSims = sims.filter(sim => {
    // 1. Filter by Type First
    const typeValue = sim.serviceType || '';
    const matchType = filterType === 'ALL'
                      || (filterType === 'أرضي' && ['أرضي', 'ارضي'].includes(typeValue))
                      || typeValue === filterType;

    if (!matchType) return false;

    // 2. Filter by Search Text
    if (!searchText.trim()) return true;

    const searchStr = searchText.toLowerCase().trim();
    const employeeName = `${sim.employee?.firstNameArabic || ''} ${sim.employee?.lastNameArabic || ''}`.toLowerCase();
    const providerStr = String(sim.provider || '').toLowerCase();
    const simNumberStr = String(sim.simNumber || '').toLowerCase();
    const accountNumberStr = String(sim.accountNumber || '').toLowerCase();

    return simNumberStr.includes(searchStr) ||
           accountNumberStr.includes(searchStr) ||
           providerStr.includes(searchStr) ||
           employeeName.includes(searchStr);
  });

  return (
    <DashboardLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Smartphone className="text-blue-600" />
              شرائح الجوال والانترنت
            </h1>
            <p className="text-slate-500 text-sm mt-1">إدارة الاشتراكات والخطوط المخصصة للموظفين والشركات</p>
          </div>

          <Link
            href="/services/telecom/new"
            className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 transition shadow-lg shadow-blue-500/30 font-medium"
          >
            <Plus size={20} />
            إضافة شريحة جديدة
          </Link>
        </div>

        {/* Search & Tabs */}
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
             {[
               { value: 'ALL', label: 'الكل' },
               { value: 'جوال', label: 'جوال (إتصال)' },
               { value: 'نت', label: 'شريحة بيانات (نت)' },
               { value: 'ارضي', label: 'هاتف أرضي' },
               { value: 'الياف', label: 'ألياف بصرية' },
             ].map((f) => (
               <button key={f.value} type="button" aria-pressed={filterType === f.value} onClick={() => setFilterType(f.value)} className={`${FILTER_BUTTON} ${filterType === f.value ? FILTER_ACTIVE : FILTER_IDLE}`}>{f.label}</button>
             ))}
          </div>

          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              aria-label="بحث في الشرائح"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="ابحث برقم الشريحة أو اسم الموظف..."
              className="w-full pl-4 pr-10 py-3 bg-slate-50 border border-slate-100 rounded-xl focus:ring-2 focus:ring-blue-100 focus:bg-white text-slate-800 text-sm font-bold outline-none transition-all"
            />
          </div>
        </div>

        {/* States Handling */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-20 gap-4">
             <div className="w-8 h-8 rounded-full border-4 border-slate-200 border-t-blue-600 animate-spin" />
             <p className="text-slate-500 font-bold">جاري جلب الاشتراكات...</p>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center mt-10">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchSims} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : sims.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <Smartphone size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد أي شرائح حتى الآن</h2>
            <p className="text-slate-500 max-w-sm mb-8">قم بإضافة الشريحة الأولى وربطها بالموظف المختص أو الفرع.</p>
            <Link href="/services/telecom/new" className="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition">
              + إضافة شريحة
            </Link>
          </div>
        ) : filteredSims.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10">
            <Search size={64} className="text-slate-200 mb-6" />
            <h2 className="text-xl font-bold text-slate-700 mb-2">لا توجد نتائج مطابقة</h2>
            <p className="text-slate-500 max-w-sm mb-8">لم يعثر البحث أو التصفية الحالية على أي شريحة. جرب تغيير عوامل التصفية.</p>
            <button type="button" onClick={() => {setSearchText(''); setFilterType('ALL');}} className="px-6 py-3 bg-blue-50 text-blue-600 font-bold rounded-xl hover:bg-blue-100 transition">
              مسح الفلترة وعرض الكل
            </button>
          </div>
        ) : (
          /* Table Style view */
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-visible mb-32">
             <div className="overflow-visible min-h-[200px]">
                <table className="w-full text-right text-sm">
                   <thead className="bg-slate-50 text-slate-500 font-extrabold uppercase tracking-wider text-[11px]">
                      <tr>
                         <th className="px-6 py-4">رقم الشريحة</th>
                         <th className="px-6 py-4">الموظف / المستفيد</th>
                         <th className="px-6 py-4">موقع العمل والارتباط</th>
                         <th className="px-6 py-4">مزود الخدمة والنوع</th>
                         <th className="px-6 py-4">باقة الاشتراك</th>
                         <th className="px-6 py-4 text-center">الإجراءات</th>
                      </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                      {filteredSims.map((sim) => (
                         <tr key={sim.id} className="hover:bg-slate-50/80 transition group">
                            <td className="px-6 py-5">
                               <div className="font-bold text-slate-800 text-sm flex items-center gap-2">
                                  {sim.simNumber}
                                  {sim.accountNumber && <span className="text-[10px] bg-slate-100 text-slate-400 px-2 py-0.5 rounded-lg border border-slate-200">سداد: {sim.accountNumber}</span>}
                               </div>
                            </td>
                            <td className="px-6 py-5">
                               {sim.employee ? (
                                  <div>
                                     <p className="font-bold text-slate-700 pointer-events-none select-all">{sim.employee.firstNameArabic} {sim.employee.lastNameArabic}</p>
                                     <p className="text-[11px] font-bold text-slate-400 select-all">#{sim.employee.employeeId}</p>
                                  </div>
                               ) : (
                                  <span className="text-[11px] font-bold text-amber-600 bg-amber-50 px-3 py-1 rounded-lg">غير مخصص لموظف</span>
                               )}
                            </td>
                            <td className="px-6 py-5">
                               {sim.employee ? (
                                  <div className="flex flex-col gap-1">
                                     <p className="text-[11px] font-black text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md inline-flex w-fit">{sim.employee.legalCompany?.nameArabic || 'شركة غير محددة'}</p>
                                     <p className="text-[10px] font-bold text-slate-500 pr-1">{sim.employee.branch?.nameArabic || 'فرع غير محدد'} • {sim.employee.department?.nameArabic || 'قسم غير محدد'}</p>
                                  </div>
                               ) : sim.branch ? (
                                  <div className="flex flex-col gap-1">
                                     <p className="text-[11px] font-black text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md inline-flex w-fit">مخصص لفرع</p>
                                     <p className="text-[10px] font-bold text-slate-500 pr-1">{sim.branch.nameArabic}</p>
                                  </div>
                               ) : sim.company ? (
                                  <div className="flex flex-col gap-1">
                                     <p className="text-[11px] font-black text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md inline-flex w-fit">مخصص لشركة</p>
                                     <p className="text-[10px] font-bold text-slate-500 pr-1">{sim.company.nameArabic}</p>
                                  </div>
                               ) : (
                                  <span className="text-[11px] font-bold text-slate-400">-</span>
                               )}
                            </td>
                            <td className="px-6 py-5">
                               <div className="font-bold text-slate-800">{sim.provider || 'غير محدد'}</div>
                               <div className="text-[11px] font-bold text-blue-500 uppercase tracking-wider mt-0.5">{sim.serviceType || '-'}</div>
                            </td>
                            <td className="px-6 py-5 font-bold text-slate-600">
                               {sim.plan || 'بدون باقة محددة'}
                            </td>
                            <td className="px-6 py-5 text-center">
                               <div className="flex items-center justify-center gap-2">
                                  <Link
                                     href={`/services/telecom/${sim.id}/edit`}
                                     title="تعديل الشريحة"
                                     aria-label="تعديل الشريحة"
                                     className="w-8 h-8 flex items-center justify-center bg-white border border-slate-200 shadow-sm rounded-lg text-slate-400 hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50 transition-all">
                                     <Edit3 size={15} />
                                  </Link>
                                  <button
                                     type="button"
                                     onClick={() => handleDelete(sim.id)}
                                     disabled={deletingId === sim.id}
                                     title="حذف نهائياً"
                                     aria-label="حذف الشريحة نهائياً"
                                     className="w-8 h-8 flex items-center justify-center bg-white border border-slate-200 shadow-sm rounded-lg text-slate-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-all disabled:opacity-50">
                                     <Trash2 size={15} />
                                  </button>
                               </div>
                            </td>
                         </tr>
                      ))}
                   </tbody>
                </table>
             </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

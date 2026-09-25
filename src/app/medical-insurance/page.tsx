"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Plus, Search, ShieldPlus, Trash2, Edit, Building2, Calendar, DollarSign, AlertTriangle, RefreshCw, FileText } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { daysUntil, formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { isStoredFileUrl } from './_components/stored-file';

interface MedicalInsurance {
  id: string;
  insuranceIssuer: string;
  policyNumber: string;
  policyCost?: number | null;
  expiryDate: string;
  benefitsUrl?: string | null;
  coverageUrl?: string | null;
  company?: { nameArabic?: string } | null;
}

export default function MedicalInsurancePage() {
  const [insurances, setInsurances] = useState<MedicalInsurance[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchInsurances = useCallback(async () => {
    setIsFetching(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/medical-insurance');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل وثائق التأمين');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setInsurances(Array.isArray(data) ? (data as MedicalInsurance[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsFetching(false);
    }
  }, []);

  useEffect(() => { fetchInsurances(); }, [fetchInsurances]);

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirmDialog(`هل أنت متأكد من حذف وثيقة التأمين: ${name}؟`, { danger: true }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/medical-insurance/${id}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'حدث خطأ أثناء الحذف')); return; }
      setInsurances(prev => prev.filter(i => i.id !== id));
      toast.success('تم حذف وثيقة التأمين');
    } catch {
      toast.error('حدث خطأ أثناء الحذف');
    } finally {
      setDeletingId(null);
    }
  };

  const filteredInsurances = insurances.filter(ins =>
    ins.insuranceIssuer?.includes(searchTerm) ||
    ins.policyNumber?.includes(searchTerm) ||
    ins.company?.nameArabic?.includes(searchTerm)
  );

  return (
    <DashboardLayout>
      <div className="p-8">

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
          <div>
            <h1 className="text-4xl font-black text-slate-800 tracking-tight flex items-center gap-3">
              <ShieldPlus className="text-blue-600" size={38} />
              إدارة التأمين الطبي
            </h1>
            <p className="text-slate-500 font-bold mt-2">تتبع وثائق التأمين الطبي، المستفيدين، وتواريخ الانتهاء</p>
          </div>

          <Link
            href="/medical-insurance/new"
            className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-2xl font-black text-[15px] flex items-center gap-3 transition-all hover:shadow-[0_10px_25px_rgba(37,99,235,0.3)] hover:-translate-y-1">
            <Plus size={20} />
            إصدار وثيقة أو عقد تأمين جديد
          </Link>
        </div>

        <div className="bg-white rounded-[2rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100 p-8 mb-8">
          <div className="relative max-w-xl">
             <div className="absolute inset-y-0 right-5 flex items-center pointer-events-none">
                <Search size={20} className="text-slate-400" />
             </div>
             <input
               type="text"
               aria-label="بحث في وثائق التأمين"
               placeholder="ابحث برقم الوثيقة، اسم الشركة، أو مسودة التنظيم..."
               value={searchTerm}
               onChange={(e) => setSearchTerm(e.target.value)}
               className="w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl pr-14 pl-5 py-4 font-bold text-slate-800 focus:outline-none focus:ring-4 focus:ring-blue-50 transition-all placeholder:font-semibold placeholder:text-slate-400"
             />
          </div>
        </div>

        {isFetching ? (
          <div className="flex justify-center items-center py-20">
            <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-[2rem] border border-rose-200 p-16 flex flex-col items-center justify-center text-center">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchInsurances} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : filteredInsurances.length === 0 ? (
          <div className="bg-white rounded-[2rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100 p-20 flex flex-col items-center justify-center text-center">
            <div className="w-24 h-24 bg-blue-50 rounded-full flex items-center justify-center mb-6">
               <ShieldPlus size={40} className="text-blue-500 opacity-80" />
            </div>
            <h3 className="text-2xl font-black text-slate-800 mb-2">لا توجد وثائق تأمين طبي</h3>
            <p className="text-slate-500 font-bold mb-8">{searchTerm ? 'لا توجد نتائج مطابقة للبحث.' : 'لم يتم إضافة أي بيانات بخصوص وثائق التأمين الطبي التابعة للمنشآت.'}</p>
            <Link
              href="/medical-insurance/new"
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-colors">
              <Plus size={18} />
              شروع في إضافة وثيقة
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
             {filteredInsurances.map((ins) => {
               // Check if expiring within 30 days
               const daysLeft = daysUntil(ins.expiryDate);
               const isExpired = daysLeft !== null && daysLeft < 0;
               const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;

               return (
                 <div key={ins.id} className={`bg-white rounded-3xl p-6 border-2 transition-all relative overflow-hidden group ${isExpired ? 'border-red-200 bg-red-50/10' : isExpiringSoon ? 'border-amber-200 bg-amber-50/10' : 'border-slate-100 hover:border-blue-200 hover:shadow-[0_20px_40px_rgba(0,0,0,0.04)]'} `}>

                    {(isExpiringSoon || isExpired) && (
                      <div className={`absolute top-0 right-0 left-0 h-1.5 ${isExpired ? 'bg-red-500' : 'bg-amber-400'}`} />
                    )}

                    <div className="flex justify-between items-start mb-6">
                       <div className="flex gap-4">
                         <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isExpired ? 'bg-red-100 text-red-600' : isExpiringSoon ? 'bg-amber-100 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                           <ShieldPlus size={24} />
                         </div>
                         <div>
                           <h3 className="font-black text-lg text-slate-800">{ins.insuranceIssuer}</h3>
                           <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-500 mt-1">
                             <Building2 size={12} /> {ins.company?.nameArabic}
                           </div>
                         </div>
                       </div>
                    </div>

                    <div className="space-y-4 mb-6 relative z-10">
                       <div className="bg-slate-50 p-4 rounded-2xl flex items-center justify-between border border-slate-100/50">
                          <span className="text-[12px] font-bold text-slate-500">رقم الوثيقة</span>
                          <span className="font-extrabold text-[14px] text-slate-800 tracking-wider">#{ins.policyNumber}</span>
                       </div>

                       <div className="grid grid-cols-2 gap-4">
                          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100/50">
                            <span className="text-[11px] font-bold text-slate-500 block mb-1">تكلفة الوثيقة</span>
                            <div className="flex items-center gap-1">
                              <DollarSign size={14} className="text-emerald-500" />
                              <span className="font-black text-[14px] text-slate-800">{formatMoney(ins.policyCost)} ر.س</span>
                            </div>
                          </div>
                          <div className={`p-4 rounded-2xl border ${isExpired ? 'bg-red-50 border-red-100' : isExpiringSoon ? 'bg-amber-50 border-amber-100' : 'bg-slate-50 border-slate-100/50'}`}>
                            <span className={`text-[11px] font-bold block mb-1 ${isExpired ? 'text-red-500' : isExpiringSoon ? 'text-amber-500' : 'text-slate-500'}`}>
                              تاريخ الانتهاء
                            </span>
                            <div className="flex items-center gap-1.5">
                              {isExpired ? <AlertTriangle size={14} className="text-red-500" /> : <Calendar size={14} className={isExpiringSoon ? 'text-amber-500' : 'text-slate-600'} />}
                              <span className={`font-black text-[13px] ${isExpired ? 'text-red-600' : isExpiringSoon ? 'text-amber-600' : 'text-slate-800'}`}>
                                {formatDate(ins.expiryDate)}
                              </span>
                            </div>
                            {(isExpiringSoon || isExpired) && (
                               <p className={`text-[10px] font-bold mt-1.5 ${isExpired ? 'text-red-500' : 'text-amber-500'}`}>
                                 {isExpired ? 'منتهية الصلاحية!' : daysLeft === 0 ? 'تنبيه: تنتهي اليوم' : `تنبيه: تنتهي بعد ${daysLeft} يوم`}
                               </p>
                            )}
                          </div>
                       </div>
                    </div>

                    {(ins.benefitsUrl || ins.coverageUrl) && (
                      <div className="flex flex-wrap gap-2 relative z-10">
                        {([['المنافع', ins.benefitsUrl], ['التغطية', ins.coverageUrl]] as const).map(([label, url]) => {
                          if (!url) return null;
                          if (isStoredFileUrl(url)) {
                            return (
                              <a key={label} href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[11px] font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-100 px-3 py-1.5 rounded-xl transition">
                                <FileText size={13} /> {label}
                              </a>
                            );
                          }
                          // Legacy record: only the file name was saved, the file itself was never uploaded.
                          return (
                            <Link key={label} href={`/medical-insurance/edit/${ins.id}`} title={url} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-xl transition">
                              <AlertTriangle size={13} /> {label}: الملف غير موجود، يرجى إعادة الرفع
                            </Link>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex gap-2 mt-4">
                       <Link href={`/medical-insurance/edit/${ins.id}`} className="flex-1 h-12 bg-blue-50 hover:bg-blue-600 text-blue-600 hover:text-white rounded-xl flex items-center justify-center gap-2 font-bold transition-colors">
                         <Edit size={18} />
                         تعديل الوثيقة
                       </Link>
                       <button type="button" aria-label="حذف الوثيقة" title="حذف الوثيقة" disabled={deletingId === ins.id} onClick={() => handleDelete(ins.id, ins.policyNumber)} className="h-12 w-12 rounded-xl flex items-center justify-center bg-slate-50 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-50">
                         <Trash2 size={20} />
                       </button>
                    </div>

                 </div>
               )
             })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

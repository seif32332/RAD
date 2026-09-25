"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { CreditCard, CheckCircle, XCircle, Clock, Banknote, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface ApprovalItem {
  id: string;
  type: 'LOAN' | 'PAYMENT' | 'SETTLEMENT' | string;
  title: string;
  amount: number;
  createdAt: string;
  status?: string;
  /** PAYMENT only: who filed the request (maker-checker). */
  requestedByName?: string | null;
  isOwnRequest?: boolean;
}

const TYPE_BADGE: Record<string, string> = {
  LOAN: 'bg-amber-100 text-amber-700',
  SETTLEMENT: 'bg-purple-100 text-purple-700',
};

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

export default function OwnerPaymentsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/owner-portal/payments');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل التعميدات المالية'));
        return;
      }
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAction = async (id: string, type: string, action: 'APPROVE' | 'REJECT') => {
    const ok = await confirmDialog(
      action === 'APPROVE' ? 'هل أنت متأكد من تعميد واعتماد الصرف؟' : 'تأكيد الرفض والإلغاء؟',
      { danger: action === 'REJECT' }
    );
    if (!ok) return;
    const key = `${type}-${id}`;
    setBusyKey(key);
    try {
      const res = await fetch('/api/owner-portal/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type, action })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res));
        return;
      }
      const data = await res.json().catch(() => null);
      toast.success(typeof data?.message === 'string' ? data.message : action === 'APPROVE' ? 'تم اعتماد الصرف' : 'تم الرفض');
      await fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-rose-200">
          <div>
            <h1 className="text-3xl font-black text-rose-900 tracking-tight flex items-center gap-3">
              <span className="bg-rose-100 text-rose-700 p-3 rounded-2xl"><CreditCard size={26} /></span>
              الموافقات والتعميدات المالية
            </h1>
            <p className="text-rose-700 font-bold mt-3 text-[14px]">
              اعتماد أو رفض صرف مسيرات الرواتب والسلف والفواتير المحولة من قسم المالية.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold">جاري تحميل التعميدات المتاحة...</div>
        ) : loadError ? (
          <div role="alert" className="bg-white rounded-3xl border border-rose-200 p-16 text-center flex flex-col items-center justify-center gap-4 shadow-sm">
            <AlertTriangle size={40} className="text-rose-400" />
            <p className="text-slate-700 font-bold">{loadError}</p>
            <button type="button" onClick={() => { setIsLoading(true); fetchData(); }} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-black text-[13px] rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-20 text-center flex flex-col items-center justify-center mt-10 shadow-sm">
            <div className="bg-slate-50 w-24 h-24 rounded-full flex items-center justify-center mb-6 text-slate-300 shadow-inner">
               <CheckCircle size={40} />
            </div>
            <h2 className="text-xl font-black text-slate-700 mb-2">لا توجد تعميدات مالية معلقة</h2>
            <p className="text-slate-500 font-bold">كل شيء مكتمل، لا يوجد ما يتطلب مراجعتك للصرف في الوقت الحالي.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
             {items.map(item => {
                const key = `${item.type}-${item.id}`;
                const isBusy = busyKey === key;
                return (
                <div key={key} className="bg-white rounded-[2rem] p-6 border-2 border-rose-100 shadow-sm hover:shadow-xl hover:border-rose-300 transition-all flex flex-col justify-between group">
                   <div>
                     <div className="flex justify-between items-start mb-4">
                        <span className={`px-3 py-1.5 rounded-xl text-[11px] font-black ${TYPE_BADGE[item.type] ?? 'bg-emerald-100 text-emerald-700'}`}>
                           {item.type === 'LOAN' ? 'طلب سلفة مبكرة' : item.type === 'SETTLEMENT' ? 'تصفية مستحقات موظف' : 'أمر صرف مالي استحقاقي'}
                        </span>
                        <div className="flex items-center gap-1.5 text-slate-400 font-bold text-[11px]"><Clock size={12}/> {formatDate(item.createdAt)}</div>
                     </div>
                     <h3 className="font-extrabold text-[16px] text-slate-800 mb-2">{item.title}</h3>
                     {item.type === 'PAYMENT' && item.requestedByName && (
                       <p className="text-[12px] font-bold text-slate-500 mb-2">مقدم الطلب: {item.requestedByName}</p>
                     )}
                     {item.isOwnRequest && (
                       <p className="text-[12px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-3">
                         هذا الطلب مقدم منك؛ يجب أن يعتمده مستخدم آخر (فصل الصلاحيات) ما لم يسمح إعداد النظام بغير ذلك.
                       </p>
                     )}
                     <div className="bg-rose-50 text-rose-700 w-fit px-5 py-3 rounded-[1rem] font-black text-[18px] flex items-center gap-2 mb-6 border border-rose-100">
                        <Banknote size={20} /> {formatMoney(item.amount)} <span className="text-[12px] font-bold">ريال سعودي</span>
                     </div>
                   </div>

                   <div className="flex items-center gap-3 pt-4 border-t border-slate-100 mt-auto">
                      <button type="button" disabled={isBusy} onClick={() => handleAction(item.id, item.type, 'APPROVE')} className="flex-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white py-3 rounded-xl font-black text-[13px] flex items-center justify-center gap-2 transition border border-emerald-100 hover:border-transparent disabled:opacity-50">
                         <CheckCircle size={16}/> اعتماد الصرف
                      </button>
                      <button type="button" disabled={isBusy} onClick={() => handleAction(item.id, item.type, 'REJECT')} className="bg-rose-50 text-rose-700 hover:bg-rose-600 hover:text-white py-3 px-6 rounded-xl font-black text-[13px] flex items-center justify-center transition border border-rose-100 hover:border-transparent disabled:opacity-50">
                         <XCircle size={16}/> رفض
                      </button>
                   </div>
                </div>
                );
             })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

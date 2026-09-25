"use client";

import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { BriefcaseBusiness, CheckCircle, Flag, Clock, AlertTriangle, RefreshCw } from 'lucide-react';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';

interface OwnerRequest {
  id: string;
  title: string;
  details: string;
  assignedTo?: string | null;
  attachmentUrl?: string | null;
  status: string;
  createdAt: string;
}

const EMPTY_FORM = {
  title: '',
  details: '',
  assignedTo: '',
  attachmentUrl: ''
};

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

export default function OwnerRequestsPage() {
  const [requests, setRequests] = useState<OwnerRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);

  const [activeTab, setActiveTab] = useState('CREATE');

  const fetchRequests = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/owner-portal/requests');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل الطلبات'));
        return;
      }
      const data = await res.json();
      setRequests(Array.isArray(data) ? data : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/owner-portal/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر إرسال التوجيه'));
        return;
      }
      const data = await res.json().catch(() => null);
      toast.success(typeof data?.message === 'string' ? data.message : 'تم إطلاق التوجيه بنجاح');
      setForm(EMPTY_FORM);
      await fetchRequests();
      setActiveTab('LIST');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-violet-200">
          <div>
            <h1 className="text-3xl font-black text-violet-900 flex items-center gap-3">
               <span className="bg-violet-100 text-violet-700 p-3 rounded-2xl"><BriefcaseBusiness size={26} /></span>
               طلبات وتوجيهات الإدارة
            </h1>
            <p className="text-violet-700 font-bold mt-3 text-[14px]">
               رفع طلبات مباشرة (إضافة طلب جديد، توجيه أمر، استعلام) وتتبع حالتها وإسنادها للإدارات.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <button type="button" onClick={() => setActiveTab('CREATE')} className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all ${activeTab === 'CREATE' ? 'bg-violet-900 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>إضافة توجيه / طلب جديد</button>
          <button type="button" onClick={() => setActiveTab('LIST')} className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all ${activeTab === 'LIST' ? 'bg-violet-900 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>متابعة الطلبات السابقة</button>
        </div>

        {isLoading && activeTab === 'LIST' ? (
          <div className="py-20 text-center text-slate-400 font-bold">جاري تحميل البيانات...</div>
        ) : (
          <div>
            {activeTab === 'CREATE' && (
              <form onSubmit={handleSubmit} className="bg-white border border-violet-100 rounded-[2rem] p-8 shadow-xl">
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div>
                        <label htmlFor="req-title" className="text-[12px] font-extrabold text-slate-700 mb-2 block">عنوان الطلب أو التوجيه</label>
                        <input id="req-title" type="text" required placeholder="ما هو الموضوع الأساسي؟" value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-violet-500 rounded-2xl font-bold text-[14px] outline-none transition-all focus:bg-white" />
                    </div>
                    <div>
                        <label htmlFor="req-assigned" className="text-[12px] font-extrabold text-slate-700 mb-2 block">الجهة المعنية بالتنفيذ (حسب الحاجة)</label>
                        <input id="req-assigned" type="text" placeholder="مثال: قسم الموارد أو محاسب الشركة" value={form.assignedTo} onChange={(e) => setForm({...form, assignedTo: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-violet-500 rounded-2xl font-bold text-[14px] outline-none transition-all focus:bg-white" />
                    </div>
                 </div>

                 <div className="mb-6">
                    <label htmlFor="req-details" className="text-[12px] font-extrabold text-slate-700 mb-2 block">شرح وتفاصيل التوجيه المرفوع</label>
                    <textarea id="req-details" rows={6} required placeholder="اشرح تفاصيل المطلوب بوضوح لتسهيل المهمة على القسم المعني..." value={form.details} onChange={(e) => setForm({...form, details: e.target.value})} className="w-full p-5 bg-slate-50 border border-slate-200 focus:border-violet-500 rounded-2xl font-bold text-[14px] outline-none transition-all focus:bg-white"></textarea>
                 </div>

                 <div className="mb-8 p-6 bg-slate-50 rounded-[1.5rem] border border-slate-100">
                    <FileUploadField name="attachmentUrl" label="مرفق مساند (إن لزم)" value={form.attachmentUrl} onChange={(e) => setForm({...form, attachmentUrl: e.target.value})} />
                 </div>

                 <div className="flex justify-end pt-6 border-t border-slate-100">
                    <button type="submit" disabled={isSubmitting} className="px-10 py-4 bg-violet-700 hover:bg-violet-800 text-white font-black text-[15px] rounded-2xl transition shadow-lg flex items-center gap-2 disabled:opacity-50">
                       <Flag size={20} /> {isSubmitting ? 'جاري الإرسال...' : 'اعتماد وإطلاق التوجيه'}
                    </button>
                 </div>
              </form>
            )}

            {activeTab === 'LIST' && (
              loadError ? (
                <div role="alert" className="py-12 bg-white rounded-[2rem] border border-rose-200 flex flex-col items-center gap-4 text-center">
                  <AlertTriangle size={36} className="text-rose-400" />
                  <p className="font-bold text-slate-700">{loadError}</p>
                  <button type="button" onClick={() => { setIsLoading(true); fetchRequests(); }} className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-black text-[12px] rounded-xl transition">
                    <RefreshCw size={14} /> إعادة المحاولة
                  </button>
                </div>
              ) : (
              <div className="grid grid-cols-1 gap-4">
                 {requests.map((req) => (
                   <div key={req.id} className="bg-white border border-slate-200 rounded-[1.5rem] p-6 shadow-sm flex flex-col md:flex-row gap-6 md:items-center justify-between hover:border-violet-300 transition-colors">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                           {req.status === 'PENDING' && <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded text-[11px] font-black flex items-center gap-1"><Clock size={12}/>قيد الانتظار</span>}
                           {req.status === 'IN_PROGRESS' && <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded text-[11px] font-black flex items-center gap-1">جاري المعالجة</span>}
                           {req.status === 'COMPLETED' && <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded text-[11px] font-black flex items-center gap-1"><CheckCircle size={12}/>تم الإنجاز</span>}

                           <span className="text-slate-400 text-[11px] font-bold">{formatDate(req.createdAt)}</span>
                        </div>
                        <h3 className="font-black text-[15px] text-slate-800 mb-1">{req.title}</h3>
                        <p className="text-[13px] font-semibold text-slate-500 line-clamp-2">{req.details}</p>
                      </div>

                      <div className="md:w-64 border-t md:border-t-0 md:border-r border-slate-100 pt-4 md:pt-0 md:pr-6 shrink-0 text-left md:text-right">
                         <div className="text-[11px] text-slate-400 font-extrabold mb-1">الموجه إليه:</div>
                         <div className="font-black text-[13px] text-violet-900 mb-3">{req.assignedTo || 'لم يتم التحديد'}</div>

                         {req.attachmentUrl && (
                            <a href={req.attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-black bg-slate-50 text-slate-600 hover:bg-slate-800 hover:text-white border border-slate-200 px-3 py-1.5 rounded-lg transition inline-block">تحميل المرفق</a>
                         )}
                      </div>
                   </div>
                 ))}
                 {requests.length === 0 && (
                   <div className="py-12 bg-white text-center text-slate-500 font-bold border border-slate-200 rounded-[2rem]">لا يوجد طلبات موجهة حالياً.</div>
                 )}
              </div>
              )
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

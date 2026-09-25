"use client";

import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { FileSignature, Bell, AlertTriangle, RefreshCw } from 'lucide-react';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';

interface Circular {
  id: string;
  title: string;
  content: string;
  issuedBy?: string | null;
  attachmentUrl?: string | null;
  datePublished?: string | null;
  createdAt?: string | null;
}

const EMPTY_FORM = {
  title: '',
  content: '',
  issuedBy: 'الإدارة العليا',
  attachmentUrl: ''
};

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

export default function CircularsPage() {
  const [circulars, setCirculars] = useState<Circular[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);

  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE, LIST

  const fetchCirculars = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/owner-portal/circulars');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل القرارات الإدارية'));
        return;
      }
      const data = await res.json();
      setCirculars(Array.isArray(data) ? data : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchCirculars(); }, [fetchCirculars]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/owner-portal/circulars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر نشر القرار'));
        return;
      }
      const data = await res.json().catch(() => null);
      toast.success(typeof data?.message === 'string' ? data.message : 'تم نشر القرار بنجاح');
      setForm(EMPTY_FORM);
      await fetchCirculars();
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
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-blue-200">
          <div>
            <h1 className="text-3xl font-black text-blue-900 flex items-center gap-3">
               <span className="bg-blue-100 text-blue-700 p-3 rounded-2xl"><FileSignature size={26} /></span>
               القرارات الإدارية والتعميمات
            </h1>
            <p className="text-blue-700 font-bold mt-3 text-[14px]">
               إصدار ونشر القرارات الإدارية من الإدارة العليا وتوجيهها لكافة أفراد المؤسسة.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <button type="button" onClick={() => setActiveTab('CREATE')} className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all ${activeTab === 'CREATE' ? 'bg-blue-900 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>إصدار قرار جديد</button>
          <button type="button" onClick={() => setActiveTab('LIST')} className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all ${activeTab === 'LIST' ? 'bg-blue-900 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>أرشيف القرارات</button>
        </div>

        {isLoading && activeTab === 'LIST' ? (
          <div className="py-20 text-center text-slate-400 font-bold">جاري تحميل البيانات...</div>
        ) : (
          <div>
            {activeTab === 'CREATE' && (
              <form onSubmit={handleSubmit} className="bg-white border border-blue-100 rounded-[2rem] p-8 shadow-xl">
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div>
                        <label htmlFor="circular-title" className="text-[12px] font-extrabold text-slate-700 mb-2 block">عنوان القرار / التعميم</label>
                        <input id="circular-title" type="text" required placeholder="مثال: تعميم إداري بخصوص أوقات الدوام الرسمي" value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-blue-500 rounded-2xl font-bold text-[14px] outline-none transition-all focus:bg-white" />
                    </div>
                    <div>
                        <label htmlFor="circular-issuer" className="text-[12px] font-extrabold text-slate-700 mb-2 block">مُصدر القرار</label>
                        <input id="circular-issuer" type="text" required value={form.issuedBy} onChange={(e) => setForm({...form, issuedBy: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-blue-500 rounded-2xl font-bold text-[14px] outline-none transition-all focus:bg-white" />
                    </div>
                 </div>

                 <div className="mb-6">
                    <label htmlFor="circular-content" className="text-[12px] font-extrabold text-slate-700 mb-2 block">تفاصيل القرار (النص التعميمي)</label>
                    <textarea id="circular-content" rows={6} required placeholder="اكتب ديباجة وتفاصيل القرار هنا..." value={form.content} onChange={(e) => setForm({...form, content: e.target.value})} className="w-full p-5 bg-slate-50 border border-slate-200 focus:border-blue-500 rounded-2xl font-bold text-[14px] outline-none transition-all focus:bg-white"></textarea>
                 </div>

                 <div className="mb-8 p-6 bg-slate-50 rounded-[1.5rem] border border-slate-100">
                    <FileUploadField name="attachmentUrl" label="إرفاق نسخة معتمدة (صورة أو PDF) - اختياري" value={form.attachmentUrl} onChange={(e) => setForm({...form, attachmentUrl: e.target.value})} />
                 </div>

                 <div className="flex justify-end pt-6 border-t border-slate-100">
                    <button type="submit" disabled={isSubmitting} className="px-10 py-4 bg-blue-700 hover:bg-blue-800 text-white font-black text-[15px] rounded-2xl transition shadow-lg flex items-center gap-2 disabled:opacity-50">
                       <Bell size={20} /> {isSubmitting ? 'جاري النشر...' : 'تعميم ونشر القرار فوراً'}
                    </button>
                 </div>
              </form>
            )}

            {activeTab === 'LIST' && (
              loadError ? (
                <div role="alert" className="py-12 bg-white rounded-3xl border border-rose-200 flex flex-col items-center gap-4 text-center">
                  <AlertTriangle size={36} className="text-rose-400" />
                  <p className="font-bold text-slate-700">{loadError}</p>
                  <button type="button" onClick={() => { setIsLoading(true); fetchCirculars(); }} className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-black text-[12px] rounded-xl transition">
                    <RefreshCw size={14} /> إعادة المحاولة
                  </button>
                </div>
              ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 {circulars.map((c) => (
                   <div key={c.id} className="bg-white border border-slate-200 rounded-[2rem] p-6 shadow-sm hover:shadow-lg transition">
                     <div className="flex justify-between items-start mb-4">
                        <span className="bg-blue-50 text-blue-700 px-3 py-1 rounded-lg text-[11px] font-black">{formatDate(c.datePublished || c.createdAt)}</span>
                        <span className="text-[11px] font-bold text-slate-400">بواسطة: {c.issuedBy}</span>
                     </div>
                     <h3 className="text-[16px] font-black text-slate-800 mb-3">{c.title}</h3>
                     <p className="text-[13px] text-slate-600 font-bold leading-relaxed whitespace-pre-line mb-6 line-clamp-4">{c.content}</p>

                     {c.attachmentUrl && (
                        <a href={c.attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] font-black text-blue-600 bg-blue-50 px-4 py-2 rounded-xl inline-block hover:bg-blue-600 hover:text-white transition">عرض المرفق / القرار الأصلي</a>
                     )}
                   </div>
                 ))}
                 {circulars.length === 0 && (
                   <div className="col-span-full py-10 text-center text-slate-500 font-bold bg-white rounded-3xl border border-slate-200">لا يوجد قرارات إدارية سابقة.</div>
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

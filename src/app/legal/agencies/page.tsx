"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { FileSignature, UploadCloud, CheckCircle, FileText, UserCircle, CalendarDays, KeyRound, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate, daysUntil } from '@/lib/dates';

interface Agency {
  id: string;
  agencyNumber: string;
  principalName: string;
  principalId: string;
  agentName: string;
  agentId: string;
  startDate: string;
  endDate: string;
  attachmentUrl?: string | null;
}

const EMPTY_FORM = {
  agencyNumber: '',
  principalName: '',
  principalId: '',
  agentName: '',
  agentId: '',
  startDate: '',
  endDate: '',
  attachmentUrl: ''
};

export default function LegalAgenciesPage() {
  const [activeTab, setActiveTab] = useState('CREATE');
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);

  const [uploading, setUploading] = useState(false);

  const fetchAgencies = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/legal/agencies');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل الوكالات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setAgencies(Array.isArray(data) ? (data as Agency[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgencies(); }, [fetchAgencies]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'فشل في رفع المرفق')); return; }
      const data = await res.json();
      setForm(prev => ({ ...prev, attachmentUrl: data.url }));
      toast.success('تم رفع المرفق');
    } catch {
      toast.error('حدث خطأ أثناء الرفع');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.attachmentUrl) { toast.error('يجب إرفاق ملف الوكالة الموثقة بصيغة PDF.'); return; }
    if (form.startDate && form.endDate && form.endDate < form.startDate) { toast.error('تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/legal/agencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حفظ الوكالة')); return; }
      const data = await res.json();
      toast.success(data.message || 'تم حفظ الوكالة');
      setForm(EMPTY_FORM);
      fetchAgencies();
      setActiveTab('ARCHIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStatusDisplay = (endDate: string) => {
    const diffDays = daysUntil(endDate);
    if (diffDays === null) return null;

    if (diffDays < 0) return <span className="text-red-700 bg-red-50 px-2 py-1 rounded-md text-[11px] font-black border border-red-200">وكالة منتهية!</span>;
    if (diffDays <= 60) return <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded-md text-[11px] font-black border border-amber-200">سارية (تنتهي خلال {diffDays} يوم)</span>;
    return <span className="text-teal-700 bg-teal-50 px-2 py-1 rounded-md text-[11px] font-black border border-teal-200">سارية وثابتة</span>;
  };

  return (
    <DashboardLayout>
       <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-teal-100">
          <div>
            <h1 className="text-3xl font-black text-teal-900 tracking-tight flex items-center gap-3">
              <span className="bg-teal-100 text-teal-700 p-3 rounded-2xl"><FileSignature size={26} /></span>
              الإدارة القانونية: الوكالات الموثقة
            </h1>
            <p className="text-teal-700 font-bold mt-3 text-[14px]">
              إدارة صلاحيات الوكالات الشرعية والقانونية ومراقبة تواريخ انتهائها لضمان صحة الإجراءات.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="تسجيل وكالة شرعية/قانونية جديدة" />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => setActiveTab('ARCHIVE')} label="أرشيف الوكالات المعتمدة" />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب بيانات الوكالات...</div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {activeTab === 'CREATE' && (
               <form onSubmit={handleSubmit} className="bg-white border border-teal-100 rounded-[2rem] p-8 shadow-xl shadow-teal-900/5">

                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-teal-900 flex items-center gap-2 mb-6"><KeyRound size={20}/> بيانات الوكالة والمحكمة</h3>
                   <div className="bg-slate-50 p-6 border border-slate-100 rounded-[1.5rem]">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">رقم الوكالة المرجعي (الموثق)</label>
                         <input type="text" required placeholder="رقم الصك أو رقم التوثيق..." value={form.agencyNumber} onChange={(e) => setForm({...form, agencyNumber: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-teal-500 rounded-2xl font-black text-[15px] text-teal-900 focus:outline-none focus:ring-4 focus:ring-teal-50 transition-all shadow-sm" />
                      </div>
                   </div>
                 </div>

                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-teal-900 flex items-center gap-2 mb-6"><UserCircle size={20}/> الأطراف (الموكل والوكيل)</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <div className="bg-teal-50/50 p-6 rounded-[1.5rem] border border-teal-100">
                         <h4 className="font-black text-[14px] text-teal-800 mb-4 border-b border-teal-200 pb-2">تفاصيل الموكل (صاحب الصلاحية)</h4>
                         <div className="space-y-4">
                           <div>
                             <label className="text-[12px] font-extrabold text-teal-900 mb-2 block">اسم الموكل رباعيًا / اسم الشركة</label>
                             <input type="text" required value={form.principalName} onChange={(e) => setForm({...form, principalName: e.target.value})} className="w-full px-4 py-3 bg-white border border-teal-200 focus:border-teal-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all shadow-sm" />
                           </div>
                           <div>
                             <label className="text-[12px] font-extrabold text-teal-900 mb-2 block">رقم هوية الموكل / السجل التجاري</label>
                             <input type="text" required value={form.principalId} onChange={(e) => setForm({...form, principalId: e.target.value})} className="w-full px-4 py-3 bg-white border border-teal-200 focus:border-teal-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all shadow-sm" />
                           </div>
                         </div>
                      </div>

                      <div className="bg-slate-50 p-6 rounded-[1.5rem] border border-slate-200">
                         <h4 className="font-black text-[14px] text-slate-800 mb-4 border-b border-slate-200 pb-2">تفاصيل الوكيل (المستلم للصلاحية)</h4>
                         <div className="space-y-4">
                           <div>
                             <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم الوكيل رباعيًا</label>
                             <input type="text" required value={form.agentName} onChange={(e) => setForm({...form, agentName: e.target.value})} className="w-full px-4 py-3 bg-white border border-slate-300 focus:border-teal-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all shadow-sm" />
                           </div>
                           <div>
                             <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">رقم هوية الوكيل (الإقامة/الوطنية)</label>
                             <input type="text" required value={form.agentId} onChange={(e) => setForm({...form, agentId: e.target.value})} className="w-full px-4 py-3 bg-white border border-slate-300 focus:border-teal-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all shadow-sm" />
                           </div>
                         </div>
                      </div>
                   </div>
                 </div>

                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-teal-900 flex items-center gap-2 mb-6"><CalendarDays size={20}/> الإطار الزمني والصلاحية</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-6 rounded-[1.5rem] border border-slate-100">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ بداية الوكالة الصادرة</label>
                         <input type="date" required value={form.startDate} onChange={(e) => setForm({...form, startDate: e.target.value})} className="w-full px-5 py-3 bg-white border border-slate-300 focus:border-teal-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all text-right shadow-sm" dir="ltr" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ النفاذ أو الانتهاء للوكالة</label>
                         <input type="date" required min={form.startDate || undefined} value={form.endDate} onChange={(e) => setForm({...form, endDate: e.target.value})} className="w-full px-5 py-3 bg-white border border-slate-300 focus:border-teal-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all text-right shadow-sm" dir="ltr" />
                      </div>
                   </div>
                 </div>

                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-teal-900 flex items-center gap-2 mb-6"><FileText size={20}/> مستند الوكالة الرئيسي</h3>
                   <div className="border-2 border-dashed border-teal-300 hover:border-teal-500 bg-teal-50/50 hover:bg-teal-50 rounded-[1.5rem] p-6 text-center transition-all group relative max-w-sm">
                      {form.attachmentUrl ? (
                        <div className="text-emerald-600 flex flex-col items-center"><CheckCircle size={32} className="mb-2"/><p className="font-bold text-[13px]">تم إرفاق صك الوكالة بنجاح</p></div>
                      ) : (
                        <>
                          <div className="bg-white shadow-md w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 text-teal-600 group-hover:scale-110 transition"><UploadCloud size={20}/></div>
                          <p className="font-black text-[14px] text-teal-900 mb-1">نسخة الوكالة المعتمدة (صك)</p>
                          <p className="text-[10px] text-teal-400 font-bold">{uploading ? 'جاري رفع الملف...' : 'PDF مطلوب وحيوي'}</p>
                        </>
                      )}
                      <input type="file" aria-label="إرفاق صك الوكالة" required={!form.attachmentUrl} disabled={uploading} onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait" />
                   </div>
                 </div>

                 <div className="pt-8 border-t border-slate-100 flex justify-end">
                    <button type="submit" disabled={isSubmitting || uploading} className="px-12 py-4 bg-teal-700 hover:bg-teal-800 text-white font-black text-[16px] rounded-[1.25rem] transition disabled:opacity-50 shadow-xl shadow-teal-700/20 flex items-center gap-3">
                       <CheckCircle size={20} /> {isSubmitting ? 'جاري الحفظ...' : 'تسجيل واعتماد بيانات الوكالة في الأرشيف'}
                    </button>
                 </div>

               </form>
            )}

            {activeTab === 'ARCHIVE' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                 <div className="overflow-x-auto">
                   <table className="w-full text-right border-collapse min-w-[800px]">
                     <thead>
                       <tr className="bg-slate-50 border-b border-slate-200">
                         <th className="p-5 text-[13px] font-black text-slate-500">رقم الوكالة الموثقة</th>
                         <th className="p-5 text-[13px] font-black text-slate-500">أطراف التوكيل (الموكل والوكيل)</th>
                         <th className="p-5 text-[13px] font-black text-slate-500">الصلاحية والتاريخ</th>
                         <th className="p-5 text-[13px] font-black text-slate-500 text-center">المرفقات</th>
                       </tr>
                     </thead>
                     <tbody className="divide-y divide-slate-100">
                       {agencies.map((a) => (
                         <tr key={a.id} className="hover:bg-slate-50 transition">
                           <td className="p-5 font-black text-[15px] text-teal-900">{a.agencyNumber}</td>

                           <td className="p-5">
                              <div className="flex flex-col gap-1.5">
                                <p className="font-bold text-[13px] text-slate-800 border-b border-slate-100 pb-1">
                                  الموكل: <span className="font-black text-teal-700">{a.principalName}</span> <span className="text-slate-400 text-[11px]">({a.principalId})</span>
                                </p>
                                <p className="font-bold text-[13px] text-slate-800">
                                  الوكيل: <span className="font-black text-indigo-700">{a.agentName}</span> <span className="text-slate-400 text-[11px]">({a.agentId})</span>
                                </p>
                              </div>
                           </td>
                           <td className="p-5 whitespace-nowrap">
                              <div className="font-black text-[12px] text-slate-600 bg-slate-100 px-2 py-1 rounded inline-block mb-1 border border-slate-200">من: {formatDate(a.startDate)}</div>
                              <br/>
                              <div className="font-black text-[12px] text-slate-600 bg-slate-100 px-2 py-1 rounded inline-block border border-slate-200 mb-1.5">إلى: {formatDate(a.endDate)}</div>
                              <br/>
                              {getStatusDisplay(a.endDate)}
                           </td>
                           <td className="p-5 text-center">
                              {a.attachmentUrl && <a href={a.attachmentUrl} target="_blank" rel="noopener noreferrer" className="bg-teal-50 text-teal-600 hover:bg-teal-600 hover:text-white p-2.5 rounded-xl transition border border-teal-100 inline-flex items-center" title="استعراض الوكالة" aria-label="استعراض الوكالة"><FileText size={16}/></a>}
                           </td>
                         </tr>
                       ))}
                       {loadError && (
                          <tr><td colSpan={4} className="p-10 text-center">
                            <p className="text-rose-600 font-bold mb-3">{loadError}</p>
                            <button type="button" onClick={fetchAgencies} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
                          </td></tr>
                       )}
                       {!loadError && agencies.length === 0 && (
                          <tr><td colSpan={4} className="p-10 text-center text-slate-400 font-bold">لا يوجد أي وكالات شرعية مسجلة حاليًا.</td></tr>
                       )}
                     </tbody>
                   </table>
                 </div>
              </div>
            )}

          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function TabButton({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${
        active ? 'bg-teal-800 text-teal-50 shadow-md border border-teal-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

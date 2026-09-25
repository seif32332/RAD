"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Gavel, CheckCircle, Scale, ShieldAlert, Phone, Building, AlertCircle, X, UploadCloud, FileText, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';

interface Lawsuit {
  id: string;
  caseType: string;
  status: string;
  plaintiff: string;
  defendant: string;
  subject: string;
  lawFirmName?: string | null;
  lawFirmContact?: string | null;
  judgmentAttachment?: string | null;
  createdAt: string;
}

const EMPTY_FORM = {
  caseType: 'LABOR', // LABOR, COMMERCIAL, REAL_ESTATE
  plaintiff: '',
  defendant: '',
  subject: '',
  lawFirmName: '',
  lawFirmContact: '',
};

export default function LawsuitsPage() {
  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE, ACTIVE, ARCHIVE
  const [lawsuits, setLawsuits] = useState<Lawsuit[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completeModal, setCompleteModal] = useState<{isOpen: boolean, lawsuitId: string}>({isOpen: false, lawsuitId: ''});
  const [completeForm, setCompleteForm] = useState({ judgmentAttachment: '' });
  const [isCompleting, setIsCompleting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);

  const fetchLawsuits = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/legal/lawsuits');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل القضايا');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setLawsuits(Array.isArray(data) ? (data as Lawsuit[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchLawsuits(); }, [fetchLawsuits]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/legal/lawsuits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تسجيل الدعوى')); return; }
      const data = await res.json();

      toast.success(data.message || 'تم تسجيل الدعوى');
      setForm(EMPTY_FORM);
      fetchLawsuits();
      setActiveTab('ACTIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCompleteModal = (id: string) => {
    setCompleteModal({ isOpen: true, lawsuitId: id });
    setCompleteForm({ judgmentAttachment: '' });
  };

  const submitComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCompleting) return;
    if (!completeForm.judgmentAttachment) {
      toast.error('مرفق صك الحكم مطلوب لإنهاء الدعوى.');
      return;
    }
    setIsCompleting(true);
    try {
      const res = await fetch('/api/legal/lawsuits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'CLOSE_CASE',
          payload: { id: completeModal.lawsuitId, judgmentAttachment: completeForm.judgmentAttachment }
        })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر إغلاق الدعوى')); return; }
      const data = await res.json();

      toast.success(data.message || 'تم إغلاق الدعوى');
      setCompleteModal({ isOpen: false, lawsuitId: '' });
      fetchLawsuits();
      setActiveTab('ARCHIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsCompleting(false);
    }
  };

  const handleModalFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      if (response.status === 401) { window.location.href = '/login'; return; }
      if (!response.ok) { toast.error(await readApiError(response, 'فشل في رفع المرفق')); return; }
      const data = await response.json();
      setCompleteForm({ judgmentAttachment: data.url });
    } catch {
      toast.error('حدث خطأ أثناء الرفع');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const activeCases = lawsuits.filter((l) => l.status === 'REFERRED');
  const closedCases = lawsuits.filter((l) => l.status === 'CLOSED');

  return (
    <DashboardLayout>
       <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-amber-200">
          <div>
            <h1 className="text-3xl font-black text-amber-900 tracking-tight flex items-center gap-3">
              <span className="bg-amber-100 text-amber-700 p-3 rounded-2xl"><Gavel size={26} /></span>
              الإدارة القانونية: المنازعات القضائية
            </h1>
            <p className="text-amber-800 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              سجل الترافع وإدارة القضايا (العمالية، التجارية، والعقارية). تستطيع فور تسجيلك للدعوى إحالتها وتفويضها ورقياً لمكاتب المحاماة المعتمدة مع إمكانية متابعة حالات الانتهاء منها.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="تسجيل دعوى وإحالة لمكتب" />
          <TabButton active={activeTab === 'ACTIVE'} onClick={() => setActiveTab('ACTIVE')} label={`مُحالة نشطة (${activeCases.length})`} badge={activeCases.length > 0} />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => setActiveTab('ARCHIVE')} label="بالأرشيف (الدعاوى المنتهية والصادرة أحكامها)" />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب بيانات المحاكم...</div>
        ) : loadError && activeTab !== 'CREATE' ? (
          <div className="py-16 text-center bg-white border border-rose-200 rounded-[2rem]">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchLawsuits} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* TAB: CREATE NEW CASE */}
            {activeTab === 'CREATE' && (
               <form onSubmit={handleSubmit} className="bg-white border border-amber-100 rounded-[2rem] p-8 shadow-xl shadow-amber-900/5">

                 {/* Section: Case Type */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-amber-900 flex items-center gap-2 mb-6"><Scale size={20}/> نوع الدعوى والتصنيف القضائي</h3>
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.caseType === 'LABOR' ? 'bg-amber-50 border-amber-500' : 'bg-white border-slate-200 hover:border-amber-300'}`}>
                         <input type="radio" checked={form.caseType === 'LABOR'} onChange={() => setForm({...form, caseType: 'LABOR'})} className="w-5 h-5 text-amber-600" />
                         <div><p className="font-bold text-[14px] text-slate-800">دعاوى عمالية</p><p className="text-[11px] text-slate-500">مكتب العمل / المحاكم العمالية</p></div>
                      </label>
                      <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.caseType === 'COMMERCIAL' ? 'bg-amber-50 border-amber-500' : 'bg-white border-slate-200 hover:border-amber-300'}`}>
                         <input type="radio" checked={form.caseType === 'COMMERCIAL'} onChange={() => setForm({...form, caseType: 'COMMERCIAL'})} className="w-5 h-5 text-amber-600" />
                         <div><p className="font-bold text-[14px] text-slate-800">دعاوى تجارية</p><p className="text-[11px] text-slate-500">الموردين / الشركات / المحاكم</p></div>
                      </label>
                      <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.caseType === 'REAL_ESTATE' ? 'bg-amber-50 border-amber-500' : 'bg-white border-slate-200 hover:border-amber-300'}`}>
                         <input type="radio" checked={form.caseType === 'REAL_ESTATE'} onChange={() => setForm({...form, caseType: 'REAL_ESTATE'})} className="w-5 h-5 text-amber-600" />
                         <div><p className="font-bold text-[14px] text-slate-800">دعاوى عقارية وإيجارات</p><p className="text-[11px] text-slate-500">الوحدات / إيجار / المحاكم العامة</p></div>
                      </label>
                   </div>
                 </div>

                 {/* Section: Parties */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-amber-900 flex items-center gap-2 mb-6"><ShieldAlert size={20}/> أطراف الخصومة والموضوع</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الطرف المُدّعِي (الشاكي)</label>
                         <input type="text" required placeholder="مثال: شركة رديف المحدودة أو الموظف الفلاني.." value={form.plaintiff} onChange={(e) => setForm({...form, plaintiff: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-amber-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-amber-50 transition-all" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-rose-700 mb-2 block">الطرف المُدّعَى عليه (المتظلم ضده)</label>
                         <input type="text" required placeholder="مثال: مورد، موظف من الشركة..." value={form.defendant} onChange={(e) => setForm({...form, defendant: e.target.value})} className="w-full px-5 py-3.5 bg-rose-50/30 border border-slate-200 focus:border-rose-300 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-rose-50 transition-all" />
                      </div>
                   </div>

                   <div>
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تفاصيل الدعوى أو موضوع النزاع</label>
                       <textarea required rows={3} placeholder="وضح تفصيلياً ماهو الخلاف، المبالغ المتنازع عليها، أو أي معلومات تفيد المحامي..." value={form.subject} onChange={(e) => setForm({...form, subject: e.target.value})} className="w-full p-5 bg-white border border-slate-200 focus:border-amber-500 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-amber-50 transition-all shadow-sm" />
                   </div>
                 </div>

                 {/* Section: Law Firm */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-slate-800 flex items-center gap-2 mb-6"><Building size={20}/> تفويض وإحالة الدعوى</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 border border-slate-200 p-6 rounded-[1.5rem]">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم مكتب المحاماة المُفوّض بالدعوى</label>
                         <input type="text" placeholder="مثال: مكتب خالد فلان للمحاماة والاستشارات" value={form.lawFirmName} onChange={(e) => setForm({...form, lawFirmName: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-300 focus:border-amber-400 rounded-2xl font-bold text-[14px] focus:outline-none transition-all shadow-sm" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">بيانات ورقم تواصل المحامي أو المكتب</label>
                         <input type="text" placeholder="مثال: 05XXXXXXXX أو إيميل المحامي" value={form.lawFirmContact} onChange={(e) => setForm({...form, lawFirmContact: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-300 focus:border-amber-400 rounded-2xl font-bold text-[14px] focus:outline-none transition-all shadow-sm text-left" dir="ltr" />
                      </div>
                   </div>
                   <div className="mt-4 flex items-center gap-2 text-[12px] font-black tracking-wide text-amber-700 bg-amber-50 w-fit px-4 py-2 rounded-lg border border-amber-100">
                     <AlertCircle size={16}/> حالة الدعوى افتراضياً ستكون (مُحالة - نشطة للترافع)
                   </div>
                 </div>

                 {/* Submit Button */}
                 <div className="pt-8 border-t border-slate-100 flex justify-end">
                    <button type="submit" disabled={isSubmitting} className="px-12 py-4 bg-amber-600 hover:bg-amber-700 text-white font-black text-[16px] rounded-[1.25rem] transition disabled:opacity-50 shadow-xl shadow-amber-600/20 flex items-center gap-3">
                       <Gavel size={20} /> {isSubmitting ? 'جاري التسجيل...' : 'تسجيل الدعوى وإصدار الموافقة بالترافع'}
                    </button>
                 </div>

               </form>
            )}

            {/* TAB: ACTIVE CASES */}
            {activeTab === 'ACTIVE' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 {activeCases.map((c) => (
                    <div key={c.id} className="bg-white border-2 border-amber-100 p-6 rounded-[2rem] shadow-sm flex flex-col justify-between hover:border-amber-400 transition hover:-translate-y-1">
                       <div>
                          {/* Top Badges */}
                          <div className="flex justify-between items-start mb-4">
                             {c.caseType === 'LABOR' && <span className="bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg text-[11px] font-black tracking-wide">دعوى عمالية</span>}
                             {c.caseType === 'COMMERCIAL' && <span className="bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-lg text-[11px] font-black tracking-wide">دعوى تجارية وموردين</span>}
                             {c.caseType === 'REAL_ESTATE' && <span className="bg-rose-50 text-rose-700 px-3 py-1.5 rounded-lg text-[11px] font-black tracking-wide">عقارية ووحدات</span>}
                             <span className="font-bold text-[11px] text-slate-400">{formatDate(c.createdAt)}</span>
                          </div>

                          {/* Parties */}
                          <div className="mb-4">
                             <div className="flex items-center gap-2 font-bold text-[14px] text-slate-800 border-b border-slate-50 pb-2 mb-2"><span className="w-14 text-slate-400 text-[11px] font-black">المدعي:</span> <span className="text-emerald-700 font-extrabold">{c.plaintiff}</span></div>
                             <div className="flex items-center gap-2 font-bold text-[14px] text-slate-800"><span className="w-14 text-slate-400 text-[11px] font-black">المُدعى عليه:</span> <span className="text-rose-700 font-extrabold">{c.defendant}</span></div>
                          </div>

                          <div className="bg-slate-50 p-4 rounded-2xl mb-4 border border-slate-100">
                            <p className="text-[12px] text-slate-700 font-bold leading-relaxed line-clamp-3">{c.subject}</p>
                          </div>

                          <div className="text-[11px] font-bold text-slate-500 mb-6 flex flex-col gap-1.5">
                             <div className="flex items-center gap-1.5"><Building size={14}/> <strong>مكتب المحاماة:</strong> {c.lawFirmName || 'لم يُحدد'}</div>
                             <div className="flex items-center gap-1.5"><Phone size={14}/> <strong>تواصل المحامي:</strong> <span dir="ltr">{c.lawFirmContact || '---'}</span></div>
                          </div>
                       </div>

                       <div className="pt-4 border-t border-slate-100 flex gap-2">
                           <button
                             type="button"
                             onClick={() => openCompleteModal(c.id)}
                             className="w-full bg-slate-900 hover:bg-slate-800 text-white font-black text-[12px] py-3.5 rounded-xl transition flex items-center justify-center gap-2"
                           >
                              <CheckCircle size={16}/> تم الانتهاء والبت بهذه القضية وإغلاقها
                           </button>
                       </div>
                    </div>
                 ))}
                 {activeCases.length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-500 font-bold bg-white border border-slate-200 rounded-[2rem]">كل شيء على ما يرام. لا توجد قضايا نشطة حالياً، ولم نحيل أي قضية للمحاكم!</div>
                 )}
              </div>
            )}

            {/* TAB: ARCHIVE */}
            {activeTab === 'ARCHIVE' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                 <table className="w-full text-right border-collapse">
                   <thead>
                     <tr className="bg-slate-50 border-b border-slate-200">
                       <th className="p-5 text-[13px] font-black text-slate-500">التصنيف</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">أطراف النزاع</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">مكتب المحاماة المكلف حينها</th>
                       <th className="p-5 text-[13px] font-black text-slate-500 text-center">صك الحكم</th>
                       <th className="p-5 text-[13px] font-black text-slate-500 text-center">حالة الدعوى الحالية</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                     {closedCases.map((c) => (
                       <tr key={c.id} className="hover:bg-slate-50 transition">
                         <td className="p-5 font-black text-[13px] text-slate-600">
                            {c.caseType === 'LABOR' && 'قضاء عمالي'}
                            {c.caseType === 'COMMERCIAL' && 'قضاء تجاري'}
                            {c.caseType === 'REAL_ESTATE' && 'عقارات ووحدات'}
                         </td>

                         <td className="p-5">
                            <div className="flex flex-col gap-1.5">
                              <p className="font-bold text-[12px] text-slate-800">
                                المدعي: <span className="font-black text-emerald-700">{c.plaintiff}</span>
                              </p>
                              <p className="font-bold text-[12px] text-slate-800">
                                المُدعى عليه: <span className="font-black text-rose-700">{c.defendant}</span>
                              </p>
                            </div>
                         </td>
                         <td className="p-5 font-bold text-[13px] text-slate-600">
                            {c.lawFirmName || 'مرافعة داخلية للمؤسسة'}
                         </td>
                         <td className="p-5 text-center">
                            {c.judgmentAttachment ? (
                              <a href={c.judgmentAttachment} target="_blank" rel="noopener noreferrer" aria-label="عرض صك الحكم" className="bg-slate-100 text-slate-600 hover:bg-slate-600 hover:text-white p-2.5 rounded-xl transition inline-block shadow-sm border border-slate-200" title="تحميل أو عرض صك الحكم"><FileText size={16}/></a>
                            ) : (
                              <span className="text-[11px] font-bold text-slate-400">لا يوجد</span>
                            )}
                         </td>
                         <td className="p-5 text-center">
                            <span className="font-black text-[11px] text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200 flex items-center justify-center w-fit gap-1.5 mx-auto"><CheckCircle size={14}/> مُغلقة ومُنتهية </span>
                         </td>
                       </tr>
                     ))}
                     {closedCases.length === 0 && (
                        <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">الأرشيف القانوني القضائي نظيف وخالي من الأحكام.</td></tr>
                     )}
                   </tbody>
                 </table>
              </div>
            )}

          </div>
        )}
      </div>

      {completeModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
           <div className="bg-white rounded-[3rem] p-8 max-w-lg w-full shadow-2xl border border-slate-200 relative">
              <button
                type="button"
                aria-label="إغلاق"
                onClick={() => setCompleteModal({ isOpen: false, lawsuitId: '' })}
                className="absolute top-6 left-6 text-slate-400 hover:text-red-500 bg-slate-50 rounded-full p-2 transition">
                <X size={18} />
              </button>

              <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
                <span className="w-12 h-12 bg-amber-100 text-amber-600 rounded-2xl flex items-center justify-center shrink-0">
                  <Gavel size={24} />
                </span>
                <div>
                  <h3 className="text-xl font-black text-slate-900">إنهاء الدعوى وإرفاق الحكم</h3>
                  <p className="text-[12px] font-bold text-slate-500 mt-1">يجب إرفاق صك الحكم القضائي أو قرار الدائرة</p>
                </div>
              </div>

              <form onSubmit={submitComplete} className="space-y-6">

                <div className="flex flex-col gap-2">
                  <label className="text-[12px] font-extrabold text-slate-700">مرفق صك الحكم / القرار <span className="text-red-500">*</span></label>
                  <div className={`relative flex items-center justify-center border-2 border-dashed rounded-2xl p-6 transition-all ${completeForm.judgmentAttachment ? 'border-amber-400 bg-amber-50' : 'border-slate-300 hover:border-amber-400 hover:bg-slate-50'}`}>
                    <input type="file" aria-label="مرفق صك الحكم" accept="image/*,.pdf" disabled={uploading} onChange={handleModalFileUpload} required={!completeForm.judgmentAttachment}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                    <div className="flex flex-col items-center justify-center gap-3 pointer-events-none">
                      {uploading ? (
                        <div className="flex flex-col items-center gap-2 text-amber-600">
                          <div className="w-8 h-8 rounded-full border-2 border-amber-600/30 border-t-amber-600 animate-spin" />
                          <span className="text-[11px] font-black">جاري الرفع...</span>
                        </div>
                      ) : completeForm.judgmentAttachment ? (
                        <>
                          <div className="w-10 h-10 bg-amber-100 text-amber-600 rounded-xl flex items-center justify-center"><CheckCircle size={20}/></div>
                          <p className="font-extrabold text-[12px] text-amber-800">تم إرفاق المستند بنجاح</p>
                          <span className="text-[10px] bg-white px-3 py-1 rounded-full text-slate-500 shadow-sm border border-amber-100 mt-1">انقر للتغيير</span>
                        </>
                      ) : (
                        <>
                          <div className="w-12 h-12 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center"><UploadCloud size={24}/></div>
                          <p className="font-extrabold text-[13px] text-slate-700">اضغط لرفع صك الحكم أو اسحب الملف هنا</p>
                          <p className="font-semibold text-[11px] text-slate-400">يدعم JPG, PNG, PDF</p>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-rose-50 border border-rose-200 px-4 py-3 rounded-xl flex items-start gap-3 mt-4">
                  <AlertCircle size={16} className="text-rose-600 mt-0.5" />
                  <p className="text-[12px] font-bold text-rose-800 leading-relaxed">بمجرد توثيق الحكم وإغلاق القضية سيتم نقلها للأرشيف بشكل نهائي.</p>
                </div>

                <button type="submit" disabled={isCompleting || uploading} className="w-full py-4 text-[14px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-amber-600 disabled:opacity-50 transition-all shadow-lg flex items-center justify-center gap-2 mt-4">
                  {isCompleting ? 'جاري الحفظ...' : 'اعتماد المحضر وإنهاء الدعوى'}
                </button>
              </form>
           </div>
        </div>
      )}
    </DashboardLayout>
  );
}

function TabButton({ active, onClick, label, badge = false }: { active: boolean, onClick: () => void, label: string, badge?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${
        active ? 'bg-amber-900 text-amber-50 shadow-md border border-amber-900' : 'bg-transparent text-slate-500 hover:bg-amber-50 border-transparent hover:border-amber-200'
      }`}
    >
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}

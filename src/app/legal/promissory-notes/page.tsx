"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Scale, FileSignature, UploadCloud, CheckCircle, FileText, Download, Building2, UserCircle, CheckSquare, AlertCircle, X, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate, daysUntil, todayKey } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface PromissoryNote {
  id: string;
  amount: number;
  creditorName: string;
  debtorName: string;
  companyRole: string;
  isOnDemand: boolean;
  dueDate?: string | null;
  status: string;
  idAttachment?: string | null;
  noteAttachment?: string | null;
  otherAttachment?: string | null;
}

type FormAttachment = 'idAttachment' | 'noteAttachment' | 'otherAttachment';

const EMPTY_FORM = {
  amount: '',
  creditorName: '',
  debtorName: '',
  companyRole: 'CREDITOR', // CREDITOR, DEBTOR
  isOnDemand: false,
  dueDate: '',
  notes: '',
  idAttachment: '',
  noteAttachment: '',
  otherAttachment: ''
};

export default function PromissoryNotesPage() {
  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE, ARCHIVE
  const [notes, setNotes] = useState<PromissoryNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completeModal, setCompleteModal] = useState<{isOpen: boolean, noteId: string}>({isOpen: false, noteId: ''});
  const [completeForm, setCompleteForm] = useState({ paymentDate: '', paymentAttachment: '' });
  const [isCompleting, setIsCompleting] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);

  const [uploading, setUploading] = useState<Record<string, boolean>>({});

  const fetchNotes = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/legal/promissory-notes');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل السندات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setNotes(Array.isArray(data) ? (data as PromissoryNote[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  /** Uploads a file and returns its URL (or null on failure, after showing a toast). */
  const uploadFile = async (file: File, key: string): Promise<string | null> => {
    setUploading(prev => ({ ...prev, [key]: true }));
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      if (response.status === 401) { window.location.href = '/login'; return null; }
      if (!response.ok) { toast.error(await readApiError(response, 'فشل في رفع المرفق')); return null; }
      const data = await response.json();
      return typeof data.url === 'string' ? data.url : null;
    } catch {
      toast.error('حدث خطأ أثناء الرفع');
      return null;
    } finally {
      setUploading(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, fieldName: FormAttachment) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const url = await uploadFile(file, fieldName);
    input.value = '';
    if (url) setForm(prev => ({ ...prev, [fieldName]: url }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.noteAttachment) { toast.error('يجب إرفاق أصل السند المكتوب'); return; }
    if (!(Number(form.amount) > 0)) { toast.error('يرجى إدخال مبلغ صحيح للسند'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/legal/promissory-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حفظ السند')); return; }
      const data = await res.json();

      toast.success(data.message || 'تم حفظ السند');
      setForm(EMPTY_FORM);
      fetchNotes();
      setActiveTab('ARCHIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCompleteModal = (id: string) => {
    setCompleteModal({ isOpen: true, noteId: id });
    setCompleteForm({ paymentDate: todayKey(), paymentAttachment: '' });
  };

  const submitComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCompleting) return;
    if (!completeForm.paymentAttachment || !completeForm.paymentDate) {
      toast.error('يجب إرفاق إيصال التحويل أو السداد وتاريخ السداد.');
      return;
    }
    setIsCompleting(true);
    try {
      const res = await fetch(`/api/legal/promissory-notes/${completeModal.noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'PAID',
          paymentDate: completeForm.paymentDate,
          paymentAttachment: completeForm.paymentAttachment
        })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (res.ok) {
        toast.success('تم توثيق الوفاء بالسند');
        setCompleteModal({ isOpen: false, noteId: '' });
        fetchNotes();
      } else {
        toast.error(await readApiError(res, 'حدث خطأ أثناء التحديث.'));
      }
    } catch {
      toast.error('حدث خطأ أثناء التحديث.');
    } finally {
      setIsCompleting(false);
    }
  };

  const handleModalFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const url = await uploadFile(file, 'paymentAttachment');
    input.value = '';
    if (url) setCompleteForm(prev => ({ ...prev, paymentAttachment: url }));
  };

  const getNoteStatusDisplay = (n: PromissoryNote) => {
    if (n.status === 'PAID') {
        return <span className="text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200 font-extrabold text-[11px] shadow-sm flex items-center gap-1.5 w-fit"><CheckCircle size={14}/>منتهي (تم الوفاء)</span>;
    }

    if (n.isOnDemand) {
        return <span className="text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-200 font-extrabold text-[11px] shadow-sm w-fit">مستحق عند الطلب (صالح)</span>;
    }

    const diffDays = daysUntil(n.dueDate);
    if (diffDays === null) return <span className="text-slate-500">-</span>;

    if (diffDays > 0) {
        return <span className="text-amber-700 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-200 font-extrabold text-[11px] shadow-sm w-fit">فترة سماح ({diffDays} يوم)</span>;
    } else if (diffDays >= -7) {
        return <span className="text-orange-700 bg-orange-50 px-3 py-1.5 rounded-lg border border-orange-200 font-black text-[11px] shadow-sm animate-pulse w-fit">مستحق الدفع!</span>;
    } else {
        return <span className="text-red-700 bg-red-50 px-3 py-1.5 rounded-lg border border-red-200 font-black text-[11px] shadow-sm flex items-center gap-1.5 w-fit"><AlertCircle size={14}/>متأخر السداد</span>;
    }
  };

  return (
    <DashboardLayout>
       <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-100">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-700 p-3 rounded-2xl"><Scale size={26} /></span>
              الإدارة القانونية: السندات لأمر
            </h1>
            <p className="text-indigo-700 font-bold mt-3 text-[14px]">
              محفظة السندات وأوراق المطالبات، مع حفظ أصل السند واستحقاقاته وحالاته المؤتمتة.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="تسجيل واعتماد سند جديد" />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => setActiveTab('ARCHIVE')} label="أرشيف استعراض السندات وحالتها" />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب المحفظة القانونية...</div>
        ) : loadError && activeTab === 'ARCHIVE' ? (
          <div className="py-16 text-center bg-white border border-rose-200 rounded-[2rem]">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchNotes} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* TAB: CREATE NEW PROMISSORY NOTE */}
            {activeTab === 'CREATE' && (
               <form onSubmit={handleSubmit} className="bg-white border border-indigo-100 rounded-[2rem] p-8 shadow-xl shadow-indigo-900/5">

                 {/* Section: Parties */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-indigo-900 flex items-center gap-2 mb-6"><UserCircle size={20}/> أطراف السند لأمر</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-6 border border-slate-100 rounded-[1.5rem]">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم وتفاصيل (الدائن - المستفيد)</label>
                         <input type="text" required placeholder="مثال: شركة رديف، أو اسم مستثمر..." value={form.creditorName} onChange={(e) => setForm({...form, creditorName: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم وتفاصيل (المدين - متعهد الدفع)</label>
                         <input type="text" required placeholder="مثال: مورد، عميل، شركة رديف..." value={form.debtorName} onChange={(e) => setForm({...form, debtorName: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                      </div>
                   </div>
                 </div>

                 {/* Section: Company Role & Amount */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-indigo-900 flex items-center gap-2 mb-6"><Building2 size={20}/> صفة المؤسسة (الموقع القانوني) ومبلغ السند</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

                      <div className="col-span-1 border border-slate-200 rounded-2xl overflow-hidden flex flex-col">
                         <label className={`flex-1 flex items-center gap-3 p-4 cursor-pointer transition ${form.companyRole === 'CREDITOR' ? 'bg-indigo-50 border-b-2 border-indigo-600' : 'bg-white hover:bg-slate-50 border-b border-slate-100'}`}>
                            <input type="radio" value="CREDITOR" checked={form.companyRole === 'CREDITOR'} onChange={(e) => setForm({...form, companyRole: e.target.value})} className="w-4 h-4 text-indigo-600" />
                            <div><p className="font-bold text-[14px] text-slate-800">الشركة هي الدائن (مطالبة)</p><p className="text-[11px] text-slate-500">نحن من يملك هذا السند ضد الغير</p></div>
                         </label>
                         <label className={`flex-1 flex items-center gap-3 p-4 cursor-pointer transition ${form.companyRole === 'DEBTOR' ? 'bg-rose-50 border-b-2 border-rose-600' : 'bg-white hover:bg-slate-50 border-t border-slate-100'}`}>
                            <input type="radio" value="DEBTOR" checked={form.companyRole === 'DEBTOR'} onChange={(e) => setForm({...form, companyRole: e.target.value})} className="w-4 h-4 text-rose-600" />
                            <div><p className="font-bold text-[14px] text-rose-800">الشركة هي المدين (متعهدة)</p><p className="text-[11px] text-rose-500">هذا السند محرر كدين ضدنا للغير</p></div>
                         </label>
                      </div>

                      <div className="col-span-1 lg:col-span-2 bg-indigo-50 border border-indigo-100 rounded-[1.5rem] p-6">
                         <label className="text-[12px] font-extrabold text-indigo-900 mb-2 block">مبلغ السند (قيمة التعهد) بالريال السعودي</label>
                         <div className="relative">
                           <input type="number" step="0.01" min="0.01" required placeholder="0.00" value={form.amount} onChange={(e) => setForm({...form, amount: e.target.value})} className="w-full pl-5 pr-16 py-4 bg-white border border-indigo-200 focus:border-indigo-500 rounded-2xl font-black text-[20px] text-indigo-900 focus:outline-none focus:ring-4 focus:ring-indigo-100 transition-all text-left shadow-sm shadow-indigo-900/5" dir="ltr" />
                           <span className="absolute right-6 top-1/2 -translate-y-1/2 font-black text-indigo-400">ر.س</span>
                         </div>
                      </div>
                   </div>
                 </div>

                 {/* Section: Due Date Setting */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-indigo-900 flex items-center gap-2 mb-6"><FileSignature size={20}/> موعد الاستحقاق والصلاحية</h3>
                   <div className="flex flex-wrap items-center gap-4 bg-slate-50 p-6 rounded-[1.5rem] border border-slate-100">
                      <label className="flex items-center gap-3 mr-4 cursor-pointer group">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${form.isOnDemand ? 'bg-indigo-600 shadow-md ring-4 ring-indigo-100' : 'bg-white border-2 border-slate-300'}`}>
                           {form.isOnDemand && <div className="w-2.5 h-2.5 bg-white rounded-full"></div>}
                        </div>
                        <input type="radio" className="hidden" checked={form.isOnDemand} onChange={() => setForm({...form, isOnDemand: true, dueDate: ''})} />
                        <span className="font-bold text-[14px] text-slate-800">لدى الاطلاع (مستحق عند الطلب بلا تاريخ)</span>
                      </label>

                      <label className="flex items-center gap-3 cursor-pointer group">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${!form.isOnDemand ? 'bg-indigo-600 shadow-md ring-4 ring-indigo-100' : 'bg-white border-2 border-slate-300'}`}>
                           {!form.isOnDemand && <div className="w-2.5 h-2.5 bg-white rounded-full"></div>}
                        </div>
                        <input type="radio" className="hidden" checked={!form.isOnDemand} onChange={() => setForm({...form, isOnDemand: false})} />
                        <span className="font-bold text-[14px] text-slate-800">محدد بتاريخ استحقاق قطعي:</span>
                      </label>

                      {!form.isOnDemand && (
                        <input type="date" required value={form.dueDate} onChange={(e) => setForm({...form, dueDate: e.target.value})} className="px-5 py-2.5 bg-white border border-slate-300 focus:border-indigo-400 rounded-xl font-bold text-[14px] transition-all text-right shadow-sm" dir="ltr" />
                      )}
                   </div>
                 </div>

                 {/* Section: Attachments */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-indigo-900 flex items-center gap-2 mb-6"><FileText size={20}/> المرفقات والسندات الأصلية</h3>
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

                      <div className="border border-dashed border-slate-300 hover:border-indigo-400 bg-slate-50 hover:bg-indigo-50/30 rounded-[1.5rem] p-6 text-center transition-all group relative">
                         {form.idAttachment ? (
                           <div className="text-emerald-600 flex flex-col items-center"><CheckCircle size={32} className="mb-2"/><p className="font-bold text-[12px]">تم إرفاق الهوية</p></div>
                         ) : (
                           <>
                             <div className="bg-white shadow-sm w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 text-slate-400 group-hover:text-indigo-600"><UploadCloud size={20}/></div>
                             <p className="font-bold text-[13px] text-slate-700 mb-1">صورة هوية المنفذ ضده</p>
                             <p className="text-[10px] text-slate-400 font-bold">{uploading['idAttachment'] ? 'جاري الرفع...' : 'JPG/PNG/PDF'}</p>
                           </>
                         )}
                         <input type="file" aria-label="صورة هوية المنفذ ضده" disabled={uploading['idAttachment']} onChange={(e) => handleFileUpload(e, 'idAttachment')} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait" />
                      </div>

                      <div className="border-2 border-dashed border-indigo-300 hover:border-indigo-500 bg-indigo-50/50 hover:bg-indigo-50 rounded-[1.5rem] p-6 text-center transition-all group relative">
                         {form.noteAttachment ? (
                           <div className="text-emerald-600 flex flex-col items-center"><CheckCircle size={32} className="mb-2"/><p className="font-bold text-[12px]">تم إرفاق أصل السند</p></div>
                         ) : (
                           <>
                             <div className="bg-white shadow-md w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 text-indigo-600 group-hover:scale-110 transition"><UploadCloud size={20}/></div>
                             <p className="font-black text-[14px] text-indigo-900 mb-1">أصل السند المكتوب</p>
                             <p className="text-[10px] text-indigo-400 font-bold">{uploading['noteAttachment'] ? 'جاري رفع الملف...' : '(مطلوب وحيوي)'}</p>
                           </>
                         )}
                         <input type="file" aria-label="أصل السند المكتوب" required={!form.noteAttachment} disabled={uploading['noteAttachment']} onChange={(e) => handleFileUpload(e, 'noteAttachment')} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait" />
                      </div>

                      <div className="border border-dashed border-slate-300 hover:border-indigo-400 bg-slate-50 hover:bg-indigo-50/30 rounded-[1.5rem] p-6 text-center transition-all group relative">
                         {form.otherAttachment ? (
                           <div className="text-emerald-600 flex flex-col items-center"><CheckCircle size={32} className="mb-2"/><p className="font-bold text-[12px]">تم إضافة مرفقات مساندة</p></div>
                         ) : (
                           <>
                             <div className="bg-white shadow-sm w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 text-slate-400 group-hover:text-indigo-600"><UploadCloud size={20}/></div>
                             <p className="font-bold text-[13px] text-slate-700 mb-1">مرفقات أخرى مساندة</p>
                             <p className="text-[10px] text-slate-400 font-bold">{uploading['otherAttachment'] ? 'جاري الرفع...' : 'مخالصات/تقارير..'}</p>
                           </>
                         )}
                         <input type="file" aria-label="مرفقات أخرى مساندة" disabled={uploading['otherAttachment']} onChange={(e) => handleFileUpload(e, 'otherAttachment')} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait" />
                      </div>

                   </div>
                 </div>

                 {/* Submit Button */}
                 <div className="pt-8 border-t border-slate-100 flex justify-end">
                    <button type="submit" disabled={isSubmitting || Object.values(uploading).some(Boolean)} className="px-12 py-4 bg-indigo-900 hover:bg-indigo-950 text-white font-black text-[16px] rounded-[1.25rem] transition disabled:opacity-50 shadow-xl shadow-indigo-900/20 flex items-center gap-3">
                       <CheckCircle size={20} /> {isSubmitting ? 'جاري الحفظ...' : 'حفظ واعتماد السند وإدراجه في المحفظة'}
                    </button>
                 </div>

               </form>
            )}

            {/* TAB: ARCHIVE HISTORY */}
            {activeTab === 'ARCHIVE' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                 <div className="overflow-x-auto">
                   <table className="w-full text-right border-collapse min-w-[800px]">
                     <thead>
                       <tr className="bg-slate-50 border-b border-slate-200">
                         <th className="p-5 text-[13px] font-black text-slate-500">حالة الشركة وأطراف السند</th>
                         <th className="p-5 text-[13px] font-black text-slate-500">القيمة بالريال (ر.س)</th>
                         <th className="p-5 text-[13px] font-black text-slate-500">الاستحقاق والحالة</th>
                         <th className="p-5 text-[13px] font-black text-slate-500 text-center">المرفقات</th>
                         <th className="p-5 text-[13px] font-black text-slate-500 text-center">إجراءات</th>
                       </tr>
                     </thead>
                     <tbody className="divide-y divide-slate-100">
                       {notes.map((n) => (
                         <tr key={n.id} className="hover:bg-slate-50 transition">
                           <td className="p-5 whitespace-nowrap">
                              <div className="flex flex-col gap-1.5">
                                {n.companyRole === 'CREDITOR' ? (
                                  <span className="bg-indigo-100 text-indigo-800 w-fit px-2 py-0.5 rounded text-[10px] font-black">نحن الدائن (مطالبة لنا)</span>
                                ) : (
                                  <span className="bg-rose-100 text-rose-800 w-fit px-2 py-0.5 rounded text-[10px] font-black">نحن المدين (دين علينا)</span>
                                )}
                                <p className="font-bold text-[14px] text-slate-800 mt-1">
                                  الدائن: <span className="font-black text-indigo-700">{n.creditorName}</span>
                                </p>
                                <p className="font-bold text-[14px] text-slate-800">
                                  المدين: <span className="font-black text-rose-700">{n.debtorName}</span>
                                </p>
                              </div>
                           </td>
                           <td className="p-5 font-black text-[18px] text-slate-800 whitespace-nowrap">{formatMoney(n.amount)}</td>
                           <td className="p-5 whitespace-nowrap">
                              <div className="flex flex-col gap-2 items-start">
                                {n.isOnDemand ? (
                                  <span className="font-bold text-[13px] text-slate-500">لدى الاطلاع الاستحقاق (عند الطلب)</span>
                                ) : (
                                  <span className="font-bold text-[13px] text-slate-500 bg-white border border-slate-200 px-3 py-1 rounded-md">{formatDate(n.dueDate)}</span>
                                )}
                                {getNoteStatusDisplay(n)}
                              </div>
                           </td>
                           <td className="p-5 text-center align-middle whitespace-nowrap">
                              <div className="flex items-center justify-center gap-2">
                                {n.noteAttachment && <a href={n.noteAttachment} target="_blank" rel="noopener noreferrer" aria-label="أصل السند" className="bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white p-2.5 rounded-xl transition shadow-sm" title="أصل السند"><FileText size={16}/></a>}
                                {n.idAttachment && <a href={n.idAttachment} target="_blank" rel="noopener noreferrer" aria-label="بطاقة الهوية" className="bg-slate-50 text-slate-600 hover:bg-slate-600 hover:text-white p-2.5 rounded-xl transition border border-slate-200" title="بطاقة الهوية"><UserCircle size={16}/></a>}
                                {n.otherAttachment && <a href={n.otherAttachment} target="_blank" rel="noopener noreferrer" aria-label="مرفقات أخرى" className="bg-slate-50 text-slate-600 hover:bg-slate-600 hover:text-white p-2.5 rounded-xl transition border border-slate-200" title="مرفقات أخرى"><Download size={16}/></a>}
                                {(!n.noteAttachment && !n.idAttachment && !n.otherAttachment) && <span className="text-[11px] font-bold text-slate-400">لا يوجد</span>}
                              </div>
                           </td>
                           <td className="p-5 text-center whitespace-nowrap">
                             {n.status !== 'PAID' ? (
                               <button type="button" onClick={() => openCompleteModal(n.id)} className="bg-white border border-emerald-200 hover:bg-emerald-600 text-emerald-700 hover:text-white px-4 py-2 rounded-xl text-[12px] font-extrabold transition flex items-center gap-2 mx-auto active:scale-95 shadow-sm">
                                 <CheckSquare size={16} /> تم الوفاء (تحويل لمنتهي)
                               </button>
                             ) : (
                               <span className="text-slate-400 font-bold text-[12px] px-4 py-2 border border-dashed border-slate-200 rounded-xl bg-slate-50 inline-block">-- السند مكتمل --</span>
                             )}
                           </td>
                         </tr>
                       ))}
                       {!loadError && notes.length === 0 && (
                          <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">المحفظة القانونية للسندات فارغة.</td></tr>
                       )}
                     </tbody>
                   </table>
                 </div>
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
                onClick={() => setCompleteModal({ isOpen: false, noteId: '' })}
                className="absolute top-6 left-6 text-slate-400 hover:text-red-500 bg-slate-50 rounded-full p-2 transition">
                <X size={18} />
              </button>

              <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
                <span className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center shrink-0">
                  <CheckCircle size={24} />
                </span>
                <div>
                  <h3 className="text-xl font-black text-slate-900">إثبات الوفاء وإقفال السند</h3>
                  <p className="text-[12px] font-bold text-slate-500 mt-1">يجب إرفاق مستند التحويل لتوثيق سداد قيمة السند</p>
                </div>
              </div>

              <form onSubmit={submitComplete} className="space-y-6">

                <div className="flex flex-col gap-2">
                  <label className="text-[12px] font-extrabold text-slate-700">تاريخ استلام المبلغ <span className="text-red-500">*</span></label>
                  <input type="date" value={completeForm.paymentDate} max={todayKey()} required dir="ltr"
                    onChange={(e) => setCompleteForm({...completeForm, paymentDate: e.target.value})}
                    className="px-5 py-4 bg-slate-50 border border-slate-200 focus:border-emerald-400 rounded-[1.25rem] font-bold text-slate-800 text-[14px] outline-none text-right transition-all" />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-[12px] font-extrabold text-slate-700">مرفق إيصال السداد / مخالصة <span className="text-red-500">*</span></label>
                  <div className={`relative flex items-center justify-center border-2 border-dashed rounded-2xl p-6 transition-all ${completeForm.paymentAttachment ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300 hover:border-emerald-400 hover:bg-slate-50'}`}>
                    <input type="file" aria-label="مرفق إيصال السداد" accept="image/*,.pdf" disabled={uploading.paymentAttachment} onChange={handleModalFileUpload} required={!completeForm.paymentAttachment}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                    <div className="flex flex-col items-center justify-center gap-3 pointer-events-none">
                      {uploading.paymentAttachment ? (
                        <div className="flex flex-col items-center gap-2 text-emerald-600">
                          <div className="w-8 h-8 rounded-full border-2 border-emerald-600/30 border-t-emerald-600 animate-spin" />
                          <span className="text-[11px] font-black">جاري الرفع...</span>
                        </div>
                      ) : completeForm.paymentAttachment ? (
                        <>
                          <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center"><CheckCircle size={20}/></div>
                          <p className="font-extrabold text-[12px] text-emerald-800">تم إرفاق المستند بنجاح</p>
                          <span className="text-[10px] bg-white px-3 py-1 rounded-full text-slate-500 shadow-sm border border-emerald-100 mt-1">انقر للتغيير</span>
                        </>
                      ) : (
                        <>
                          <div className="w-12 h-12 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center"><UploadCloud size={24}/></div>
                          <p className="font-extrabold text-[13px] text-slate-700">اضغط لرفع الإيصال أو اسحب الملف هنا</p>
                          <p className="font-semibold text-[11px] text-slate-400">يدعم JPG, PNG, PDF</p>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <button type="submit" disabled={isCompleting || uploading.paymentAttachment} className="w-full py-4 text-[14px] font-black text-white bg-slate-900 rounded-[1.25rem] hover:bg-emerald-600 disabled:opacity-50 transition-all shadow-lg flex items-center justify-center gap-2">
                  {isCompleting ? 'جاري الحفظ...' : 'تأكيد الوفاء بالسند'}
                </button>
              </form>
           </div>
        </div>
      )}
    </DashboardLayout>
  );
}

function TabButton({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${
        active ? 'bg-indigo-900 text-indigo-50 shadow-md border border-indigo-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

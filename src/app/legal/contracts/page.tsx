"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { BriefcaseBusiness, FileSignature, UploadCloud, CheckCircle, FileText, Download, UserCircle, CalendarDays, Edit, Trash2, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate, daysUntil, toDateInputValue } from '@/lib/dates';

interface Contract {
  id: string;
  title: string;
  firstParty: string;
  secondParty: string;
  startDate: string;
  endDate: string | null;
  notes?: string | null;
  contractAttachment?: string | null;
  otherAttachment?: string | null;
}

type AttachmentField = 'contractAttachment' | 'otherAttachment';

const EMPTY_FORM = {
  title: '',
  firstParty: 'شركة رديف المحدودة',
  secondParty: '',
  startDate: '',
  endDate: '',
  notes: '',
  contractAttachment: '',
  otherAttachment: ''
};

export default function LegalContractsPage() {
  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE, ARCHIVE
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);

  const [uploading, setUploading] = useState<Record<AttachmentField, boolean>>({ contractAttachment: false, otherAttachment: false });

  const fetchContracts = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/legal/contracts');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل العقود');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setContracts(Array.isArray(data) ? (data as Contract[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchContracts(); }, [fetchContracts]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, fieldName: AttachmentField) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(prev => ({ ...prev, [fieldName]: true }));
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      if (response.status === 401) { window.location.href = '/login'; return; }
      if (!response.ok) { toast.error(await readApiError(response, 'فشل في رفع المرفق')); return; }
      const data = await response.json();
      setForm(prev => ({ ...prev, [fieldName]: data.url }));
      toast.success('تم رفع المرفق');
    } catch {
      toast.error('حدث خطأ أثناء الرفع');
    } finally {
      setUploading(prev => ({ ...prev, [fieldName]: false }));
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.contractAttachment) {
      toast.error('يجب رفع أصل العقد المصدق والموقع بصيغة ملف أولاً');
      return;
    }
    if (form.endDate && form.startDate && form.endDate < form.startDate) {
      toast.error('تاريخ انتهاء العقد يجب أن يكون بعد تاريخ البداية');
      return;
    }
    setIsSubmitting(true);
    try {
      const method = editId ? 'PATCH' : 'POST';
      const url = editId ? `/api/legal/contracts/${editId}` : '/api/legal/contracts';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حفظ العقد')); return; }
      const data = await res.json();

      toast.success(data.message || 'تم حفظ العقد');
      setForm(EMPTY_FORM);
      setEditId(null);
      fetchContracts();
      setActiveTab('ARCHIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (contract: Contract) => {
    setForm({
      title: contract.title || '',
      firstParty: contract.firstParty || '',
      secondParty: contract.secondParty || '',
      startDate: toDateInputValue(contract.startDate),
      endDate: toDateInputValue(contract.endDate),
      notes: contract.notes || '',
      contractAttachment: contract.contractAttachment || '',
      otherAttachment: contract.otherAttachment || ''
    });
    setEditId(contract.id);
    setActiveTab('CREATE');
  };

  const handleDelete = async (id: string, title: string) => {
    if (!(await confirmDialog(`هل أنت متأكد من حذف العقد "${title}"؟ لا يمكن التراجع عن هذا الإجراء.`, { danger: true }))) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/legal/contracts/${id}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (res.ok) {
        toast.success('تم حذف العقد بنجاح');
        fetchContracts();
      } else {
        toast.error(await readApiError(res, 'حدث خطأ أثناء الحذف'));
      }
    } catch {
      toast.error('حدث خطأ أثناء الحذف');
    } finally {
      setDeletingId(null);
    }
  };

  const getContractStatusDisplay = (endDate: string | null) => {
    if (!endDate) {
      return <span className="text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md text-[11px] font-black border border-emerald-200 shadow-sm mt-1.5 inline-block">ساري (عقد مفتوح)</span>;
    }
    const diffDays = daysUntil(endDate);
    if (diffDays === null) return null;

    if (diffDays < 0) {
      return <span className="text-red-700 bg-red-50 px-2 py-1 rounded-md text-[11px] font-black border border-red-200 shadow-sm mt-1.5 inline-block">عقد منتهي!</span>;
    } else if (diffDays <= 60) {
      return <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded-md text-[11px] font-black border border-amber-200 shadow-sm mt-1.5 inline-block">ساري (ينتهي خلال {diffDays} يوم)</span>;
    } else {
      return <span className="text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md text-[11px] font-black border border-emerald-200 shadow-sm mt-1.5 inline-block">عقد ساري</span>;
    }
  };

  return (
    <DashboardLayout>
       <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-blue-100">
          <div>
            <h1 className="text-3xl font-black text-blue-900 tracking-tight flex items-center gap-3">
              <span className="bg-blue-100 text-blue-700 p-3 rounded-2xl"><BriefcaseBusiness size={26} /></span>
              الإدارة القانونية: العقود والاتفاقيات
            </h1>
            <p className="text-blue-700 font-bold mt-3 text-[14px]">
              محفظة مركزية للوثائق والاتفاقيات المبرمة، شاملة أطراف التوقيع وتواريخ البداية ومواعيد الانتهاء والمرفقات الرسمية.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => { setActiveTab('CREATE'); if(!editId) setForm(EMPTY_FORM); }} label={editId ? "تعديل العقد" : "توثيق وإضافة عقد جديد"} />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => { setActiveTab('ARCHIVE'); setEditId(null); setForm(EMPTY_FORM); }} label="أرشيف العقود المُبرمة" />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب المحفظة القانونية...</div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            {/* TAB: CREATE NEW CONTRACT */}
            {activeTab === 'CREATE' && (
               <form onSubmit={handleSubmit} className="bg-white border border-blue-100 rounded-[2rem] p-8 shadow-xl shadow-blue-900/5">
                 
                 {/* Section: Contract General Details */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-blue-900 flex items-center gap-2 mb-6"><FileSignature size={20}/> تفاصيل موضوع العقد</h3>
                   <div className="bg-slate-50 p-6 border border-slate-100 rounded-[1.5rem]">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">مسمى وموضوع العقد / الاتفاقية</label>
                         <input type="text" required placeholder="مثال: عقد توريد معدات، اتفاقية صيانة سنوية، عقد مقاولة..." value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-blue-500 rounded-2xl font-black text-[15px] text-blue-900 focus:outline-none focus:ring-4 focus:ring-blue-50 transition-all shadow-sm" />
                      </div>
                   </div>
                 </div>

                 {/* Section: Parties */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-blue-900 flex items-center gap-2 mb-6"><UserCircle size={20}/> الأطراف المعنية (الموقعين)</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الطرف الأول (صاحب العمل/المُكلف)</label>
                         <input type="text" required placeholder="مثال: شركة رديف المحدودة" value={form.firstParty} onChange={(e) => setForm({...form, firstParty: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-blue-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-blue-50 transition-all" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الطرف الثاني (المُنفذ/المورد/وغيره)</label>
                         <input type="text" required placeholder="اسم أو صفة الطرف المقابل" value={form.secondParty} onChange={(e) => setForm({...form, secondParty: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-blue-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-blue-50 transition-all" />
                      </div>
                   </div>
                 </div>

                 {/* Section: Dates */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-blue-900 flex items-center gap-2 mb-6"><CalendarDays size={20}/> الإطار الزمني والصلاحية</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-blue-50/50 p-6 rounded-[1.5rem] border border-blue-100">
                      <div>
                         <label className="text-[12px] font-extrabold text-blue-900 mb-2 block">تاريخ بداية العقد الفعلي</label>
                         <input type="date" required value={form.startDate} onChange={(e) => setForm({...form, startDate: e.target.value})} className="w-full px-5 py-3 bg-white border border-blue-200 focus:border-blue-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all text-right shadow-sm" dir="ltr" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-blue-900 mb-2 block">تاريخ انتهاء العقد (اختياري إذا كان مفتوح)</label>
                         <input type="date" min={form.startDate || undefined} value={form.endDate} onChange={(e) => setForm({...form, endDate: e.target.value})} className="w-full px-5 py-3 bg-white border border-blue-200 focus:border-blue-500 rounded-xl font-bold text-[14px] focus:outline-none transition-all text-right shadow-sm" dir="ltr" />
                      </div>
                   </div>
                 </div>

                 {/* Section: Attachments */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-lg text-blue-900 flex items-center gap-2 mb-6"><FileText size={20}/> المرفقات والصيغ المكتوبة</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      
                      <div className="border-2 border-dashed border-blue-300 hover:border-blue-500 bg-blue-50/50 hover:bg-blue-50 rounded-[1.5rem] p-6 text-center transition-all group relative">
                         {form.contractAttachment ? (
                           <div className="text-emerald-600 flex flex-col items-center"><CheckCircle size={32} className="mb-2"/><p className="font-bold text-[13px]">تم إرفاق أصل العقد</p></div>
                         ) : (
                           <>
                             <div className="bg-white shadow-md w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 text-blue-600 group-hover:scale-110 transition"><UploadCloud size={20}/></div>
                             <p className="font-black text-[14px] text-blue-900 mb-1">صيغة العقد المعتمدة (موقعة)</p>
                             <p className="text-[10px] text-blue-400 font-bold">{uploading['contractAttachment'] ? 'جاري رفع الملف...' : 'PDF مطلوب وإلزامي'}</p>
                           </>
                         )}
                         <input type="file" aria-label="إرفاق صيغة العقد المعتمدة" required={!form.contractAttachment} disabled={uploading['contractAttachment']} onChange={(e) => handleFileUpload(e, 'contractAttachment')} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait" />
                      </div>

                      <div className="border border-dashed border-slate-300 hover:border-blue-400 bg-slate-50 hover:bg-blue-50/30 rounded-[1.5rem] p-6 text-center transition-all group relative">
                         {form.otherAttachment ? (
                           <div className="text-emerald-600 flex flex-col items-center"><CheckCircle size={32} className="mb-2"/><p className="font-bold text-[13px]">تم إضافة المرفقات المساندة</p></div>
                         ) : (
                           <>
                             <div className="bg-white shadow-sm w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 text-slate-400 group-hover:text-blue-600"><UploadCloud size={20}/></div>
                             <p className="font-bold text-[13px] text-slate-700 mb-1">مرفقات أخرى مساندة وملاحق</p>
                             <p className="text-[10px] text-slate-400 font-bold">{uploading['otherAttachment'] ? 'جاري الرفع...' : 'بطاقات/تفويض/سجل تجاري'}</p>
                           </>
                         )}
                         <input type="file" aria-label="إرفاق مرفقات مساندة" disabled={uploading['otherAttachment']} onChange={(e) => handleFileUpload(e, 'otherAttachment')} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-wait" />
                      </div>
                      
                   </div>
                 </div>

                 {/* Submit Button */}
                 <div className="pt-8 border-t border-slate-100 flex justify-end gap-3">
                    {editId && (
                      <button type="button" onClick={() => { setEditId(null); setForm(EMPTY_FORM); setActiveTab('ARCHIVE'); }} className="px-8 py-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[16px] rounded-[1.25rem] transition">
                         إلغاء التعديل
                      </button>
                    )}
                    <button type="submit" disabled={isSubmitting || uploading.contractAttachment || uploading.otherAttachment} className="px-12 py-4 bg-blue-700 hover:bg-blue-800 text-white font-black text-[16px] rounded-[1.25rem] transition disabled:opacity-50 shadow-xl shadow-blue-700/20 flex items-center gap-3">
                       <CheckCircle size={20} /> {isSubmitting ? 'جاري الحفظ...' : editId ? 'حفظ التعديلات' : 'اعتماد وحفظ العقد بالأرشيف القانوني'}
                    </button>
                 </div>

               </form>
            )}

            {/* TAB: ARCHIVE HISTORY */}
            {activeTab === 'ARCHIVE' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                 <table className="w-full text-right border-collapse">
                   <thead>
                     <tr className="bg-slate-50 border-b border-slate-200">
                       <th className="p-5 text-[13px] font-black text-slate-500">مسمى العقد</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">الأطراف المتعاقدة</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">مدة الصلاحية، التنفيذ وحالة العقد</th>
                       <th className="p-5 text-[13px] font-black text-slate-500 text-center">مستند العقد</th>
                       <th className="p-5 text-[13px] font-black text-slate-500 text-center">خيارات</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                     {contracts.map((c) => (
                       <tr key={c.id} className="hover:bg-slate-50 transition">
                         <td className="p-5 font-black text-[15px] text-blue-900 border-l border-slate-50">{c.title}</td>

                         <td className="p-5">
                            <div className="flex flex-col gap-1.5">
                              <p className="font-bold text-[13px] text-slate-800 border-b border-slate-100 pb-1">
                                ط1: <span className="font-black text-slate-600">{c.firstParty}</span>
                              </p>
                              <p className="font-bold text-[13px] text-slate-800">
                                ط2: <span className="font-black text-blue-700">{c.secondParty}</span>
                              </p>
                            </div>
                         </td>
                         <td className="p-5 whitespace-nowrap">
                            <div className="font-black text-[13px] text-emerald-700 bg-emerald-50 px-2 py-1 rounded inline-block mb-1 border border-emerald-100">بداية: {formatDate(c.startDate)}</div>
                            <br/>
                            {c.endDate ? (
                               <div className="font-black text-[13px] text-rose-700 bg-rose-50 px-2 py-1 rounded inline-block border border-rose-100">نهاية: {formatDate(c.endDate)}</div>
                            ) : (
                               <div className="font-black text-[11px] text-slate-500 bg-slate-100 px-2 py-1 rounded inline-block border border-slate-200">مفتوح (لا يوجد تاريخ نهاية)</div>
                            )}
                            <br/>
                            {getContractStatusDisplay(c.endDate)}
                         </td>
                         <td className="p-5 text-center">
                            <div className="inline-flex items-center gap-2">
                              {c.contractAttachment && <a href={c.contractAttachment} target="_blank" rel="noopener noreferrer" aria-label="فتح العقد الرئيسي" className="bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white p-2 rounded-lg transition" title="فتح العقد الرئيسي"><FileText size={16}/></a>}
                              {c.otherAttachment && <a href={c.otherAttachment} target="_blank" rel="noopener noreferrer" aria-label="الملاحق والمرفقات المستندية" className="bg-slate-100 text-slate-600 hover:bg-slate-600 hover:text-white p-2 rounded-lg transition" title="الملاحق والمرفقات المستندية"><Download size={16}/></a>}
                            </div>
                         </td>
                         <td className="p-5 text-center">
                            <div className="inline-flex items-center gap-1 bg-slate-50 border border-slate-100 rounded-xl overflow-hidden p-1 shadow-[inset_0_2px_4px_rgba(0,0,0,0.02)]">
                              <button type="button" onClick={() => handleEdit(c)} aria-label="تعديل" className="bg-white hover:bg-indigo-50 text-indigo-600 p-2.5 rounded-lg border border-transparent hover:border-indigo-100 transition shadow-sm" title="تعديل"><Edit size={16}/></button>
                              <div className="w-px h-6 bg-slate-200 mx-1 max-md:hidden"></div>
                              <button type="button" onClick={() => handleDelete(c.id, c.title)} disabled={deletingId === c.id} aria-label="حذف" className="bg-white hover:bg-rose-50 text-rose-600 p-2.5 rounded-lg border border-transparent hover:border-rose-100 transition shadow-sm disabled:opacity-50" title="حذف"><Trash2 size={16}/></button>
                            </div>
                         </td>
                       </tr>
                     ))}
                     {loadError && (
                        <tr><td colSpan={5} className="p-10 text-center">
                          <p className="text-rose-600 font-bold mb-3">{loadError}</p>
                          <button type="button" onClick={fetchContracts} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
                        </td></tr>
                     )}
                     {!loadError && contracts.length === 0 && (
                        <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">لا توجد عقود مدرجة في الأرشيف القانوني.</td></tr>
                     )}
                   </tbody>
                 </table>
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
        active ? 'bg-blue-900 text-blue-50 shadow-md border border-blue-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

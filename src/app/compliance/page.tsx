"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Crosshair, AlertTriangle, Building2, Store, CheckCircle, HandCoins, FileText, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface NamedEntity { id: string; nameArabic: string }

interface Violation {
  id: string;
  status: string;
  amount: number;
  authority: string;
  targetName: string;
  correctivePeriod?: number | null;
  canObject?: boolean;
  notes?: string | null;
  createdAt: string;
}

export default function CompliancePage() {
  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE, ACTIVE, HISTORY
  const [violations, setViolations] = useState<Violation[]>([]);
  const [companies, setCompanies] = useState<NamedEntity[]>([]);
  const [branches, setBranches] = useState<NamedEntity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Form State
  const [form, setForm] = useState({
    targetType: 'BRANCH', // COMPANY or BRANCH
    targetId: '',
    authority: 'وزارة الموارد البشرية - مكتب العمل',
    amount: '',
    correctivePeriod: '',
    canObject: false,
    notes: '',
  });

  const fetchViolations = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/compliance');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل المخالفات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json();
      setViolations(Array.isArray(data?.violations) ? data.violations : []);
      if (data?.metadata) {
          const nextBranches: NamedEntity[] = data.metadata.branches || [];
          setCompanies(data.metadata.companies || []);
          setBranches(nextBranches);
          // Set defaults
          if (nextBranches.length > 0) {
             setForm(prev => (prev.targetType === 'BRANCH' && !prev.targetId ? { ...prev, targetId: nextBranches[0].id } : prev));
          }
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchViolations(); }, [fetchViolations]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.targetId) { toast.error('يرجى اختيار الفرع أو الشركة المستهدفة أولاً!'); return; }
    if (!(Number(form.amount) > 0)) { toast.error('يرجى إدخال قيمة صحيحة للمخالفة'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/compliance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تسجيل المخالفة')); return; }
      const data = await res.json();

      toast.success(data.message || 'تم تسجيل المخالفة');
      setForm(prev => ({...prev, amount: '', correctivePeriod: '', notes: '', canObject: false}));
      fetchViolations();
      setActiveTab('ACTIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    const confirmMsg = status === 'PAID' ? 'هل أنت متأكد من سداد مبلغ المخالفة نهائياً؟' : 'هل تؤكد أنك قمت بتصحيح وتصويب المخالفة لدى الجهات المختصة؟';
    if (!(await confirmDialog(confirmMsg, { danger: status === 'PAID' }))) return;

    setUpdatingId(id);
    try {
      const res = await fetch('/api/compliance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'UPDATE_STATUS', payload: { id, status } })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحديث حالة المخالفة')); return; }
      const data = await res.json().catch(() => ({}));
      toast.success(data?.message || 'تم تحديث حالة المخالفة');
      fetchViolations();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setUpdatingId(null);
    }
  };

  const activeViolations = violations.filter(v => v.status === 'PENDING_PAYMENT' || v.status === 'CORRECTED');
  const closedViolations = violations.filter(v => v.status === 'PAID');

  const authorities = [
      'وزارة الموارد البشرية - مكتب العمل',
      'وزارة التجارة الاستثمار',
      'البلدية والأمانة',
      'الدفاع المدني - سلامة',
      'هيئة الزكاة والضريبة والجمارك',
      'وزارة النقل (هيئة النقل)',
      'المرور والأمن العام',
      'أخرى'
  ];

  return (
    <DashboardLayout>
       <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-rose-200">
          <div>
            <h1 className="text-3xl font-black text-rose-900 tracking-tight flex items-center gap-3">
              <span className="bg-rose-100 text-rose-700 p-3 rounded-2xl"><ShieldCheck size={26} /></span>
              إدارة الالتزام ومتابعة المخالفات (Compliance)
            </h1>
            <p className="text-rose-800 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              شاشة استباقية لمتابعة المخالفات الحكومية بأنواعها للفروع أو الشركة (غرامات مكتب العمل، البلدية، التجارة..) ومتابعة الفترات التصحيحية حتى يتم التسوية والسداد.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="تسجيل مخالفة جديدة" />
          <TabButton active={activeTab === 'ACTIVE'} onClick={() => setActiveTab('ACTIVE')} label={`المخالفات النشطة (${activeViolations.length})`} badge={activeViolations.length > 0} />
          <TabButton active={activeTab === 'HISTORY'} onClick={() => setActiveTab('HISTORY')} label={`أرشيف المسددات (${closedViolations.length})`} />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب بيانات الالتزام الحكومية للقطاعات...</div>
        ) : loadError ? (
          <div className="py-16 text-center bg-white border border-rose-200 rounded-[2rem]">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchViolations} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* TAB: CREATE NEW */}
            {activeTab === 'CREATE' && (
               <form onSubmit={handleSubmit} className="bg-white border border-rose-100 rounded-[2rem] p-8 shadow-xl shadow-rose-900/5">

                 {/* Target Section */}
                 <div className="mb-10 p-6 bg-slate-50 border border-slate-100 rounded-2xl">
                   <h3 className="font-extrabold text-[15px] text-slate-800 flex items-center gap-2 mb-6"><Crosshair size={18}/> تحديد جهة وتصنيف المخالفة</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                      <div className="flex bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden p-1">
                         <button type="button" onClick={() => { setForm({...form, targetType: 'BRANCH', targetId: branches[0]?.id || ''})}} className={`flex-1 py-3 text-[13px] font-black transition-all rounded-lg flex items-center justify-center gap-2 ${form.targetType === 'BRANCH' ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'text-slate-500 hover:bg-slate-50'}`}>
                            <Store size={18}/> مخالفة على الفرع
                         </button>
                         <button type="button" onClick={() => { setForm({...form, targetType: 'COMPANY', targetId: companies[0]?.id || ''})}} className={`flex-1 py-3 text-[13px] font-black transition-all rounded-lg flex items-center justify-center gap-2 ${form.targetType === 'COMPANY' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'text-slate-500 hover:bg-slate-50'}`}>
                            <Building2 size={18}/> مخالفة على المقر (شركة)
                         </button>
                      </div>

                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اختيار الكيان المستهدف بالمخالفة</label>
                         <select required value={form.targetId} onChange={(e) => setForm({...form, targetId: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-rose-400 rounded-xl font-bold text-[14px] shadow-sm">
                           <option value="" disabled>-- اختر --</option>
                           {form.targetType === 'BRANCH' ? branches.map((b) => (
                               <option key={b.id} value={b.id}>{b.nameArabic}</option>
                           )) : companies.map((c) => (
                               <option key={c.id} value={c.id}>{c.nameArabic}</option>
                           ))}
                         </select>
                      </div>

                   </div>
                 </div>

                 {/* Details Section */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-[15px] text-rose-800 flex items-center gap-2 mb-6"><AlertTriangle size={18}/> تفاصيل الغرامة والاستحقاق المالي</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">

                      <div className="lg:col-span-1">
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الجهة الصادرة منها المخالفة</label>
                         <select value={form.authority} onChange={(e)=>setForm({...form, authority: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-rose-400 rounded-xl font-bold text-[14px] shadow-sm">
                             {authorities.map(a => <option key={a} value={a}>{a}</option>)}
                         </select>
                      </div>

                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">قيمة المخالفة النقدية (ريال)</label>
                         <input type="number" required min="0.01" step="0.01" placeholder="مثال: 5000" value={form.amount} onChange={(e) => setForm({...form, amount: e.target.value})} className="w-full px-5 py-3.5 bg-rose-50/50 border border-slate-200 focus:border-rose-400 rounded-xl font-bold text-[16px] focus:outline-none transition-all text-red-700 shadow-sm" />
                      </div>

                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الفترة التصحيحية (إن وجدت) - بالأيام</label>
                         <input type="number" min="0" step="1" placeholder="مثال: 15 للإنذار قبل السداد" value={form.correctivePeriod} onChange={(e) => setForm({...form, correctivePeriod: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-rose-400 rounded-xl font-bold text-[14px] focus:outline-none transition-all shadow-sm" />
                      </div>

                   </div>

                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                       <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.canObject ? 'bg-blue-50 border-blue-400' : 'bg-white border-slate-200'} lg:col-span-1`}>
                          <input type="checkbox" checked={form.canObject} onChange={(e) => setForm({...form, canObject: e.target.checked})} className="w-5 h-5 text-blue-600 rounded" />
                          <div><p className="font-bold text-[13px] text-slate-800">قابلة للاعتراض؟</p><p className="text-[10px] text-slate-500 mt-0.5">هل يحق لك قانونياً الاعتراض عليها وإلغائها؟</p></div>
                       </label>

                       <div className="lg:col-span-2">
                           <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">ملاحظات / وصف المخالفة</label>
                           <input type="text" placeholder="اكتب رقم الإشعار أو تفصيل المخالفة هنا" value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} className="w-full p-4 bg-white border border-slate-200 rounded-xl font-bold text-[14px] shadow-sm focus:border-rose-400 outline-none" />
                       </div>
                   </div>
                 </div>

                 {/* Submit */}
                 <div className="pt-6 border-t border-slate-100 flex justify-end">
                    <button type="submit" disabled={isSubmitting} className="px-12 py-3.5 bg-rose-600 hover:bg-rose-700 text-white font-black text-[15px] rounded-xl transition disabled:opacity-50 shadow-lg shadow-rose-600/20 flex items-center gap-2">
                       <ShieldCheck size={20} /> {isSubmitting ? 'جاري التسجيل...' : 'تسجيل وقيد المخالفة باللوحة'}
                    </button>
                 </div>
               </form>
            )}

            {/* TAB: ACTIVE */}
            {activeTab === 'ACTIVE' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 {activeViolations.map((v) => (
                    <div key={v.id} className="bg-white border-2 border-rose-100 p-6 rounded-[2rem] shadow-sm flex flex-col justify-between hover:border-rose-300 transition hover:-translate-y-1 relative overflow-hidden">
                       {v.canObject && (
                           <div className="absolute top-6 left-6 flex items-center gap-1.5 px-3 py-1 bg-blue-50 text-blue-700 font-black text-[11px] rounded-lg border border-blue-200 shadow-sm"><Crosshair size={14}/> يحق الاعتراض عليها</div>
                       )}

                       <div>
                          <p className="font-black text-[13px] text-slate-500 mb-4">{formatDate(v.createdAt)}</p>

                          {/* Alert Amount */}
                          <div className="mb-4 bg-rose-50/50 p-4 rounded-xl border border-rose-100/50">
                             <div className="flex items-end gap-2 mb-1">
                                <span className="font-black text-3xl text-rose-700 tracking-tight">{formatMoney(v.amount)}</span>
                                <span className="text-[12px] font-bold text-rose-500 mb-1.5 uppercase">ريال رسوم والتزام مالي</span>
                             </div>
                             <p className="font-extrabold text-[12px] text-slate-600 bg-white inline-block px-3 py-1 rounded-md shadow-sm border border-slate-200 mt-2">📍 {v.targetName}</p>
                          </div>

                          <div className="text-[13px] font-bold text-slate-700 mb-6 flex flex-col gap-2.5">
                             <div className="flex items-center gap-2"><Building2 size={16} className="text-slate-400"/> <strong>الجهة المُصدرَة:</strong> {v.authority}</div>
                             {v.correctivePeriod ? (
                                <div className="flex items-center gap-2 text-amber-700"><CheckCircle size={16}/> <strong>فترة السماح (تصحيحية):</strong> متبقي أو ممنوح {v.correctivePeriod} أيام</div>
                             ) : null}
                             <div className="flex items-center gap-2"><FileText size={16} className="text-slate-400"/> <strong>الوصف والملاحظات:</strong> {v.notes || 'لا يوجد إشعار/وصف مرفق'}</div>
                             <div className="flex items-center gap-2"><AlertTriangle size={16} className="text-slate-400"/> <strong>حالة المخالفة الآن:</strong>
                                 {v.status === 'PENDING_PAYMENT' && <span className="text-rose-600 font-extrabold">بانتظار السداد المالي (والتصحيح)</span>}
                                 {v.status === 'CORRECTED' && <span className="text-emerald-600 font-extrabold">تصحيح ناجح ومُعلق للسداد 💰</span>}
                             </div>
                          </div>
                       </div>

                       <div className="pt-5 border-t border-slate-100 flex gap-3">
                          {v.status === 'PENDING_PAYMENT' && (
                              <button type="button" disabled={updatingId === v.id} onClick={() => handleUpdateStatus(v.id, 'CORRECTED')} className="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-black text-[12px] py-3 rounded-xl transition flex items-center justify-center gap-2 border border-emerald-200 disabled:opacity-50">
                                 <CheckCircle size={16}/> إثبات تصحيح الخطأ! (العمالي/البلدي)
                              </button>
                          )}
                          <button type="button" disabled={updatingId === v.id} onClick={() => handleUpdateStatus(v.id, 'PAID')} className="flex-1 bg-slate-900 hover:bg-slate-800 text-white font-black text-[12px] py-3 rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50">
                             <HandCoins size={16}/> تم إيداع السداد ونقلها للأرشيف
                          </button>
                       </div>
                    </div>
                 ))}
                 {activeViolations.length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-500 font-bold bg-white border border-slate-200 rounded-[2rem]">التزام حكومي وإداري مثالي 100%. لا توجد أي مخالفات نشطة أو قيد السداد على أي فرع!</div>
                 )}
              </div>
            )}

            {/* TAB: HISTORY */}
            {activeTab === 'HISTORY' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                 <table className="w-full text-right border-collapse">
                   <thead>
                     <tr className="bg-slate-50 border-b border-slate-200">
                       <th className="p-5 text-[13px] font-black text-slate-500">موقع المخالفة</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">المصدر والهيئة</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">القيمة المسددة</th>
                       <th className="p-5 text-[13px] font-black text-slate-500">الحالة الراهنة</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                     {closedViolations.map((v) => (
                       <tr key={v.id} className="hover:bg-slate-50 transition">
                         <td className="p-5 font-black text-[13px] text-slate-700">📍 {v.targetName}</td>
                         <td className="p-5 font-bold text-[12px] text-slate-600">{v.authority}</td>
                         <td className="p-5 font-black text-[15px] text-rose-700 tracking-wide">{formatMoney(v.amount)} <span className="text-[10px] text-rose-500">ر.س</span></td>
                         <td className="p-5">
                            <span className="font-black text-[11px] text-emerald-700 bg-emerald-50 px-3 py-1.5 border border-emerald-200 rounded-lg flex items-center w-fit gap-1.5"><HandCoins size={14}/> مدفوعة ومنتهية السداد </span>
                         </td>
                       </tr>
                     ))}
                     {closedViolations.length === 0 && (
                        <tr><td colSpan={4} className="p-10 text-center text-slate-400 font-bold">لا يوجد أي تاريخ للمخالفات المسددة مسبقاً في أرشيف الالتزام.</td></tr>
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

function TabButton({ active, onClick, label, badge = false }: { active: boolean, onClick: () => void, label: string, badge?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${
        active ? 'bg-rose-900 text-rose-50 shadow-md border border-rose-900' : 'bg-transparent text-slate-500 hover:bg-rose-50 border-transparent hover:border-rose-200'
      }`}
    >
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}

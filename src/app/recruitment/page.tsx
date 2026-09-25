"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { UserPlus, Briefcase, Globe2, Building, Send, Clock, CheckCircle, XCircle, RefreshCw, Link2 } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';

interface Manager { id: string; employeeId: string; firstNameArabic: string; lastNameArabic: string }
interface Department { id: string; nameArabic: string }

interface JobRequest {
  id: string;
  status: string;
  jobType: string;
  jobTitle: string;
  nationality: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  department?: { nameArabic?: string } | null;
  requester?: { firstNameArabic?: string; lastNameArabic?: string } | null;
}

export default function RecruitmentHubPage() {
  const { role } = useRole();
  // Approving, rejecting and closing vacancies is HR-only on the server (403 for other managers).
  const canDecide = roleIn(role, ROLE_GROUPS.HR);
  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE, ACTIVE, HISTORY
  const [jobRequests, setJobRequests] = useState<JobRequest[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Form State
  const [form, setForm] = useState({
    requesterId: '',
    departmentId: '',
    jobTitle: '',
    jobType: 'FULL_TIME', // FULL_TIME, PART_TIME, REMOTE
    nationality: 'سعودي',
    description: '',
  });

  const fetchRequests = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/recruitment');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل طلبات التوظيف');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json();
      setJobRequests(Array.isArray(data?.jobRequests) ? data.jobRequests : []);
      if (data?.metadata) {
          const nextManagers: Manager[] = data.metadata.managers || [];
          const nextDepartments: Department[] = data.metadata.departments || [];
          setManagers(nextManagers);
          setDepartments(nextDepartments);
          // Set defaults for dropdowns
          setForm(prev => ({
            ...prev,
            requesterId: prev.requesterId || nextManagers[0]?.id || '',
            departmentId: prev.departmentId || nextDepartments[0]?.id || '',
          }));
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.requesterId || !form.departmentId) { toast.error('يرجى اختيار الإدارة والمدير رافع الطلب'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/recruitment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر رفع طلب التوظيف')); return; }
      const data = await res.json().catch(() => ({}));

      toast.success(data?.message || 'تم رفع طلب التوظيف');
      setForm(prev => ({...prev, jobTitle: '', description: '', jobType: 'FULL_TIME', nationality: 'سعودي'}));
      fetchRequests();
      setActiveTab('ACTIVE');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    let confirmMsg = 'هل أنت متأكد من تغيير حالة طلب التوظيف ورده؟';
    if (status === 'APPROVED') confirmMsg = 'هل أنت متأكد من الموافقة على فتح الشاغر وبدء الاستقطاب؟';
    if (status === 'FULFILLED') confirmMsg = 'هل تم توظيف شخص بنجاح وتريد إغلاق هذا الطلب للحفظ في الأرشيف؟';
    if (!(await confirmDialog(confirmMsg, { danger: status === 'REJECTED' }))) return;

    setUpdatingId(id);
    try {
      const res = await fetch('/api/recruitment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'UPDATE_STATUS', payload: { id, status } })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحديث حالة الطلب')); return; }
      const data = await res.json().catch(() => ({}));
      toast.success(data?.message || 'تم تحديث حالة الطلب');
      fetchRequests();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setUpdatingId(null);
    }
  };

  const copyApplyLink = async (id: string) => {
    const url = `${window.location.origin}/apply/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('تم نسخ رابط التقديم العام');
    } catch {
      toast.info(url);
    }
  };

  const activeRequests = jobRequests.filter(r => r.status === 'PENDING' || r.status === 'APPROVED');
  const closedRequests = jobRequests.filter(r => r.status === 'REJECTED' || r.status === 'FULFILLED');

  return (
    <DashboardLayout>
       <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-200">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-700 p-3 rounded-2xl"><UserPlus size={26} /></span>
              إدارة التوظيف والاستقطاب
            </h1>
            <p className="text-indigo-800 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              بوابة تقديم طلبات وشواغر التوظيف المفتوحة من مدراء الأقسام (الاحتياج)، مع تحديد نوع التوظيف وجنسية المستقطبين، وتمريرها للموارد البشرية للموافقة والتوظيف.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="رفع نموذج احتياج جديد" />
          <TabButton active={activeTab === 'ACTIVE'} onClick={() => setActiveTab('ACTIVE')} label={`الشواغر والطلبات النشطة (${activeRequests.length})`} badge={activeRequests.length > 0} />
          <TabButton active={activeTab === 'HISTORY'} onClick={() => setActiveTab('HISTORY')} label={`أرشيف التوظيفات المغلقة (${closedRequests.length})`} />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب الهيكل وطلبات التوظيف الحالية...</div>
        ) : loadError ? (
          <div className="py-16 text-center bg-white border border-rose-200 rounded-[2rem]">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchRequests} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* TAB: CREATE NEW JOB REQUEST */}
            {activeTab === 'CREATE' && (
               <form onSubmit={handleSubmit} className="bg-white border border-indigo-100 rounded-[2rem] p-8 shadow-xl shadow-indigo-900/5">

                 {/* Metadata Section: Department and Manager */}
                 <div className="mb-10 p-6 bg-slate-50 border border-slate-100 rounded-2xl">
                   <h3 className="font-extrabold text-[15px] text-slate-800 flex items-center gap-2 mb-6"><Building size={18}/> مصدر رفع الطلب (الإدارة)</h3>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">القسم أو الإدارة الطالبة</label>
                         <select required value={form.departmentId} onChange={(e) => setForm({...form, departmentId: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[14px] shadow-sm">
                           {departments.length === 0 && <option value="">لا توجد إدارات</option>}
                           {departments.map((d) => (
                               <option key={d.id} value={d.id}>{d.nameArabic}</option>
                           ))}
                         </select>
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">المدير أو المسؤول المفوّض رافع الطلب</label>
                         <select required value={form.requesterId} onChange={(e) => setForm({...form, requesterId: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[14px] shadow-sm">
                           {managers.length === 0 && <option value="">لا يوجد مدراء</option>}
                           {managers.map((m) => (
                               <option key={m.id} value={m.id}>{m.firstNameArabic} {m.lastNameArabic} (#{m.employeeId})</option>
                           ))}
                         </select>
                      </div>
                   </div>
                 </div>

                 {/* Job Type Section */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-[15px] text-indigo-900 flex items-center gap-2 mb-6"><Briefcase size={18}/> طبيعة ونوع الشاغر الوظيفي</h3>
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.jobType === 'FULL_TIME' ? 'bg-indigo-50 border-indigo-500 shadow-sm' : 'bg-white border-slate-200 hover:border-indigo-200'}`}>
                         <input type="radio" checked={form.jobType === 'FULL_TIME'} onChange={() => setForm({...form, jobType: 'FULL_TIME'})} className="w-5 h-5 text-indigo-600" />
                         <div><p className="font-bold text-[13px] text-slate-800">وظيفة دوام كامل (Full-Time)</p><p className="text-[11px] text-slate-500">حضور للمقر كامل</p></div>
                      </label>
                      <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.jobType === 'PART_TIME' ? 'bg-indigo-50 border-indigo-500 shadow-sm' : 'bg-white border-slate-200 hover:border-indigo-200'}`}>
                         <input type="radio" checked={form.jobType === 'PART_TIME'} onChange={() => setForm({...form, jobType: 'PART_TIME'})} className="w-5 h-5 text-indigo-600" />
                         <div><p className="font-bold text-[13px] text-slate-800">وظيفة دوام جزئي (Part-Time)</p><p className="text-[11px] text-slate-500">ساعات وفترات محددة</p></div>
                      </label>
                      <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${form.jobType === 'REMOTE' ? 'bg-indigo-50 border-indigo-500 shadow-sm' : 'bg-white border-slate-200 hover:border-indigo-200'}`}>
                         <input type="radio" checked={form.jobType === 'REMOTE'} onChange={() => setForm({...form, jobType: 'REMOTE'})} className="w-5 h-5 text-indigo-600" />
                         <div><p className="font-bold text-[13px] text-slate-800">وظيفة عن بعد (Remote)</p><p className="text-[11px] text-slate-500">من المنزل وغير حضوري</p></div>
                      </label>
                   </div>
                 </div>

                 {/* Core Details Section */}
                 <div className="mb-10">
                   <h3 className="font-extrabold text-[15px] text-indigo-900 flex items-center gap-2 mb-6"><Globe2 size={18}/> تفاصيل المستهدف</h3>
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">

                      <div className="md:col-span-2">
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">المسمى الوظيفي المطلوب (الوظيفة)</label>
                         <input type="text" required placeholder="مثال: محاسب مالي أول، مطور برمجيات، مشرف مبيعات.." value={form.jobTitle} onChange={(e) => setForm({...form, jobTitle: e.target.value})} className="w-full px-5 py-3.5 bg-indigo-50/50 border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[15px] focus:outline-none transition-all shadow-sm" />
                      </div>

                      <div className="md:col-span-1">
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الجنسية المطلوبة</label>
                         <select required value={form.nationality} onChange={(e) => setForm({...form, nationality: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[14px] shadow-sm">
                            <option value="سعودي">سعودي / مواطن</option>
                            <option value="مقيم/أجنبي">مقيم / أجنبي</option>
                            <option value="لا يهم (جميع الجنسيات)">لا يهم (جميع الجنسيات)</option>
                         </select>
                      </div>
                   </div>

                   <div>
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الوصف الوظيفي (شرح دقيق للمهام والصلاحيات المطلوبة والخلفية الأكاديمية)</label>
                       <textarea required rows={4} placeholder="اكتب هنا التوصيف الكامل للوظيفة لكي يتسنى لموظفي الموارد البشرية فلترة السير الذاتية وإجراء المقابلات المعيارية بشكل صحيح بناءً على هذا الوصف.." value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} className="w-full p-5 bg-white border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[13px] shadow-sm outline-none" />
                   </div>
                 </div>

                 {/* Submit */}
                 <div className="pt-6 border-t border-slate-100 flex justify-end">
                    <button type="submit" disabled={isSubmitting} className="px-12 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[15px] rounded-xl transition disabled:opacity-50 shadow-lg shadow-indigo-600/20 flex items-center gap-2">
                       <Send size={18} /> {isSubmitting ? 'جاري الرفع...' : 'رفع الطلب الاعتماد (فتح شاغر بالمنشأة)'}
                    </button>
                 </div>
               </form>
            )}

            {/* TAB: ACTIVE REQUESTS */}
            {activeTab === 'ACTIVE' && (
              <div className="grid grid-cols-1 gap-6">
                 {activeRequests.map((r) => (
                    <div key={r.id} className="bg-white border-2 border-indigo-100 p-6 md:p-8 rounded-[2rem] shadow-sm flex flex-col md:flex-row gap-8 hover:border-indigo-300 transition hover:-translate-y-1 relative group">

                       <div className="flex-1">
                          {/* Top Badges */}
                          <div className="flex flex-wrap items-center gap-2 mb-4">
                             {r.jobType === 'FULL_TIME' && <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-lg text-[10px] font-black tracking-wide border border-indigo-100">+ دوام مكتبي حضوري (Full-Time)</span>}
                             {r.jobType === 'PART_TIME' && <span className="bg-emerald-50 text-emerald-700 px-3 py-1 rounded-lg text-[10px] font-black tracking-wide border border-emerald-100">+ دوام جزئي ومرن (Part-Time)</span>}
                             {r.jobType === 'REMOTE' && <span className="bg-sky-50 text-sky-700 px-3 py-1 rounded-lg text-[10px] font-black tracking-wide border border-sky-100">+ عن بعد من المنزل (Remote)</span>}

                             <span className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg text-[10px] font-black tracking-wide border border-slate-200">🌎 {r.nationality}</span>
                          </div>

                          {/* Titles */}
                          <h2 className="font-black text-2xl text-slate-800 mb-2">{r.jobTitle}</h2>

                          <div className="flex flex-wrap items-center gap-4 text-[12px] font-bold text-slate-500 mb-5 pb-5 border-b border-slate-100">
                             <div className="flex items-center gap-1.5"><Building size={14}/> الإدارة: {r.department?.nameArabic || 'متعدد'}</div>
                             <div className="flex items-center gap-1.5"><UserPlus size={14}/> الرافع: {r.requester?.firstNameArabic} {r.requester?.lastNameArabic}</div>
                             <div className="flex items-center gap-1.5"><Clock size={14}/> تاريخ الطلب: {formatDate(r.createdAt)}</div>
                          </div>

                          <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                             <h4 className="text-[11px] font-black text-indigo-600 uppercase mb-2">الوصف والمهام الوظيفية (JD)</h4>
                             <p className="text-[13px] text-slate-700 font-bold leading-relaxed whitespace-pre-line">{r.description}</p>
                          </div>
                       </div>

                       {/* Operations Sidebar Panel */}
                       <div className="shrink-0 w-full md:w-56 flex flex-col justify-center gap-3 bg-slate-50 p-4 rounded-3xl border border-slate-100">
                          {r.status === 'PENDING' && (
                              <div className="text-center mb-2">
                                  <span className="text-[10px] font-extrabold uppercase bg-amber-100 text-amber-800 px-2 py-1 rounded w-fit mx-auto animate-pulse">مُعلق وينتظر المراجعة</span>
                              </div>
                          )}
                          {r.status === 'APPROVED' && (
                              <div className="text-center mb-2">
                                  <span className="text-[10px] font-extrabold uppercase bg-emerald-100 text-emerald-800 px-2 py-1 rounded w-fit mx-auto">مفتوح للتوظيف والاستقطاب</span>
                              </div>
                          )}

                          {r.status === 'PENDING' && canDecide && (
                              <>
                                <button type="button" disabled={updatingId === r.id} onClick={() => handleUpdateStatus(r.id, 'APPROVED')} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[12px] py-3 rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50">
                                   <CheckCircle size={15}/> موافقة وفتح الشاغر
                                </button>
                                <button type="button" disabled={updatingId === r.id} onClick={() => handleUpdateStatus(r.id, 'REJECTED')} className="w-full bg-slate-200 hover:bg-rose-100 hover:text-rose-700 text-slate-600 font-black text-[12px] py-3 rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50">
                                   <XCircle size={15}/> رفض ورد الطلب للإدارة
                                </button>
                              </>
                          )}

                          {r.status === 'APPROVED' && (
                              <div className="mt-auto pt-4 border-t border-slate-200 flex flex-col gap-2">
                                  <button type="button" onClick={() => copyApplyLink(r.id)} className="w-full bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 font-black text-[11px] py-3 rounded-xl transition flex items-center justify-center gap-2">
                                     <Link2 size={15}/> نسخ رابط التقديم العام
                                  </button>
                                  {canDecide && (
                                    <>
                                      <button type="button" disabled={updatingId === r.id} onClick={() => handleUpdateStatus(r.id, 'FULFILLED')} className="w-full bg-slate-900 hover:bg-slate-800 text-white font-black text-[11px] py-3.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg disabled:opacity-50">
                                         <UserPlus size={15}/> تم الاستقطاب والمباشرة!
                                      </button>
                                      <p className="text-center text-[9px] font-black text-slate-400 leading-tight px-2">اضغط هنا لإغلاق الشاغر ونقله للأرشيف فور توقيعك مع المرشح النهائي.</p>
                                    </>
                                  )}
                              </div>
                          )}
                       </div>
                    </div>
                 ))}
                 {activeRequests.length === 0 && (
                    <div className="col-span-full py-16 text-center shadow-sm text-indigo-500 font-bold bg-white border border-indigo-100 rounded-[2rem]">كل الشواغر تم تسكيرها. لا توجد أي طلبات مستعجلة للتوظيف بالمنشأة حالياً!</div>
                 )}
              </div>
            )}

            {/* TAB: HISTORY */}
            {activeTab === 'HISTORY' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                 <table className="w-full text-right border-collapse">
                   <thead>
                     <tr className="bg-slate-50 border-b border-slate-200">
                       <th className="p-5 text-[12px] font-black text-slate-500">القسم الطالِب والسائق</th>
                       <th className="p-5 text-[12px] font-black text-slate-500">المُسمى الوظيفي المُرشح</th>
                       <th className="p-5 text-[12px] font-black text-slate-500">تاريخ غلق الشاغر</th>
                       <th className="p-5 text-[12px] font-black text-slate-500">الحالة الختامية للطلب</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                     {closedRequests.map((r) => (
                       <tr key={r.id} className="hover:bg-slate-50 transition">
                         <td className="p-5">
                             <div className="flex flex-col gap-1">
                               <p className="font-bold text-[13px] text-slate-800"><Building size={12} className="inline mr-1 text-slate-400"/> {r.department?.nameArabic}</p>
                               <p className="font-bold text-[11px] text-slate-500"><UserPlus size={12} className="inline mr-1 text-slate-400"/> المدخل: {r.requester?.firstNameArabic}</p>
                             </div>
                         </td>
                         <td className="p-5 font-black text-[14px] text-indigo-800">{r.jobTitle}</td>
                         <td className="p-5 font-bold text-[12px] text-slate-600">{formatDate(r.updatedAt)}</td>
                         <td className="p-5">
                            {r.status === 'REJECTED' && <span className="font-black text-[10px] text-rose-700 bg-rose-50 px-2 py-1 border border-rose-200 rounded-lg flex items-center w-fit gap-1"><XCircle size={14}/> مرفوضة إدارياً ومغلقة </span>}
                            {r.status === 'FULFILLED' && <span className="font-black text-[10px] text-emerald-700 bg-emerald-50 px-2 py-1 border border-emerald-200 rounded-lg flex items-center w-fit gap-1"><CheckCircle size={14}/> تم الاستقطاب والمباشرة بنجاح </span>}
                         </td>
                       </tr>
                     ))}
                     {closedRequests.length === 0 && (
                        <tr><td colSpan={4} className="p-10 text-center text-slate-400 font-bold">الأرشيف نظيف. لا يوجد طلبات توظيف أُغلقت أو رُفضت بعد.</td></tr>
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
        active ? 'bg-indigo-900 text-indigo-50 shadow-md border border-indigo-900' : 'bg-transparent text-slate-500 hover:bg-indigo-50 border-transparent hover:border-indigo-200'
      }`}
    >
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-rose-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}

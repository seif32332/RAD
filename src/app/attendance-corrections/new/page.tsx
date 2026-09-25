"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Save, AlertCircle, ArrowRight, Calendar, Search, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { todayKey } from '@/lib/dates';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { useRole } from '@/context/RoleContext';

interface EmployeeOption {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  isTerminated?: boolean | null;
}

function AttendanceCorrectionForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const employeeIdParam = searchParams.get('employeeId');
  const { role, user, loading: roleLoading } = useRole();
  // HR and managers file corrections for employees; everyone else files for themselves.
  const canPickEmployee = roleIn(role, ROLE_GROUPS.MANAGERS);

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    employeeId: employeeIdParam || '',
    date: '',
    reason: '',
    attachmentUrl: '',
    correctionType: 'GENERAL',
  });

  const loadEmployees = useCallback(async () => {
    setEmployeesError(null);
    try {
      const res = await fetch('/api/employees?fields=basic', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        setEmployeesError(await readApiError(res, 'تعذر جلب قائمة الموظفين'));
        return;
      }
      const data: unknown = await res.json();
      setEmployees(Array.isArray(data) ? (data as EmployeeOption[]).filter((e) => !e.isTerminated) : []);
    } catch {
      setEmployeesError('تعذر الاتصال بالخادم');
    }
  }, []);

  useEffect(() => {
    if (roleLoading) return;
    if (canPickEmployee) void loadEmployees();
  }, [roleLoading, canPickEmployee, loadEmployees]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((f) => ({ ...f, [name]: value }));
  };

  const filteredEmployees = employees.filter((e) =>
    `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} ${e.employeeId ?? ''}`.includes(searchTerm),
  );
  const selected = employees.find((e) => e.id === formData.employeeId);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;
    setErrorMsg(null);

    const employeeId = canPickEmployee ? formData.employeeId : user?.employeeId || '';
    if (!employeeId || !formData.date || !formData.reason.trim()) {
      const msg = canPickEmployee
        ? 'البيانات الأساسية مطلوبة: الموظف، التاريخ، السبب'
        : !user?.employeeId
          ? 'حسابك غير مرتبط بملف وظيفي. يرجى التواصل مع الموارد البشرية.'
          : 'البيانات الأساسية مطلوبة: التاريخ، السبب';
      setErrorMsg(msg);
      toast.warning(msg);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/attendance-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, employeeId }),
      });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        const msg = await readApiError(res, 'حدث خطأ أثناء رفع الطلب');
        setErrorMsg(msg);
        toast.error(msg);
        return;
      }
      toast.success('تم رفع طلب تصحيح الحضور بنجاح');
      router.push('/attendance-corrections');
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-[800px] mx-auto min-h-screen">
      <Link href="/attendance-corrections" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition font-bold text-[14px] mb-8">
        <ArrowRight size={18} /> العودة لسجل طلبات تصحيح البصمة
      </Link>
      <div className="mb-10">
        <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
          <Calendar className="text-blue-600" size={32} />
          طلب مسار ثاني (تصحيح حضور)
        </h1>
        <p className="text-slate-500 font-bold mt-2">قم بإنشاء طلب تصحيح بصمة لمعالجة غياب، إرفاق إجازة مرضية، أو تبرير الانصراف.</p>
      </div>

      {errorMsg && (
        <div role="alert" className="bg-red-50 border-2 border-red-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
          <AlertCircle className="text-red-500 shrink-0" size={20} />
          <p className="font-extrabold text-red-800 text-[13px]">{errorMsg}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8 bg-white p-10 rounded-[2.5rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100">
        {roleLoading ? (
          <div className="text-center text-slate-400 font-bold py-4">جاري التحميل...</div>
        ) : canPickEmployee ? (
          <div>
            <label htmlFor="employee-search" className="text-[13px] font-extrabold text-slate-700 block mb-2">اختر الموظف *</label>
            {employeesError && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-3 flex items-center gap-3">
                <p className="text-[12px] font-bold text-rose-700 flex-1">{employeesError}</p>
                <button type="button" onClick={() => void loadEmployees()} className="flex items-center gap-1 text-[12px] font-bold text-rose-700 hover:underline">
                  <RefreshCw size={12} /> إعادة المحاولة
                </button>
              </div>
            )}
            <div className="relative mb-3">
              <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input id="employee-search" type="text" placeholder="ابحث عن موظف بالاسم أو الرقم..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl pl-5 pr-12 py-3.5 font-bold text-slate-800 focus:outline-none transition-all" />
            </div>
            {searchTerm && (
              <div className="border border-slate-100 rounded-xl max-h-48 overflow-y-auto bg-white mb-4 shadow-sm">
                {filteredEmployees.length === 0 ? (
                  <p className="px-4 py-3 text-[12px] font-bold text-slate-400">لا توجد نتائج مطابقة</p>
                ) : filteredEmployees.slice(0, 10).map((emp) => (
                  <button key={emp.id} type="button" onClick={() => { setFormData((f) => ({ ...f, employeeId: emp.id })); setSearchTerm(''); }}
                    className="w-full text-right px-4 py-3 hover:bg-blue-50 focus:bg-blue-50 transition border-b border-slate-50 last:border-0 font-bold text-slate-700 text-sm">
                    {emp.firstNameArabic} {emp.lastNameArabic} <span className="text-slate-400 text-[11px] mr-2">#{emp.employeeId}</span>
                  </button>
                ))}
              </div>
            )}
            {formData.employeeId && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 flex items-center gap-3 mt-3">
                <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-lg flex items-center justify-center font-bold">✓</div>
                <div>
                  <p className="text-[11px] font-bold text-emerald-600">الموظف المحدد</p>
                  <p className="font-black text-slate-800 text-sm">
                    {selected ? `${selected.firstNameArabic ?? ''} ${selected.lastNameArabic ?? ''}` : 'جاري التحميل...'}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center font-bold">✓</div>
            <div>
              <p className="text-[11px] font-bold text-blue-600">مقدم الطلب</p>
              <p className="font-black text-slate-800 text-sm">{user?.name || '—'}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label htmlFor="correction-date" className="text-[13px] font-extrabold text-slate-700 block mb-2">تاريخ التصحيح المراد *</label>
            <input id="correction-date" type="date" name="date" value={formData.date} onChange={handleChange} required dir="ltr" max={todayKey()}
              className="w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none transition-all" />
          </div>

          <div>
            <label htmlFor="correction-type" className="text-[13px] font-extrabold text-slate-700 block mb-2">نوع التصحيح *</label>
            <select id="correction-type" name="correctionType" value={formData.correctionType} onChange={handleChange}
              className="w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none transition-all">
              <option value="LATE">تبرير تأخير (إلغاء دقائق التأخير)</option>
              <option value="EARLY_LEAVE">تبرير خروج مبكر (إلغاء دقائق الخروج المبكر)</option>
              <option value="ABSENT">غياب / نسيان بصمة (تسجيل الحضور حسب جدول الدوام)</option>
              <option value="GENERAL">عام (إكمال البصمة الناقصة حسب جدول الدوام)</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label htmlFor="correction-reason" className="text-[13px] font-extrabold text-slate-700 block mb-2">المبرر / تفاصيل الطلب *</label>
            <textarea id="correction-reason" name="reason" value={formData.reason} onChange={handleChange} required rows={3} maxLength={2000} placeholder="اكتب مبرر التصحيح هنا، مثلا: إجازة مرضية مرفقة طبياً، نسيان بصمة..."
              className="w-full bg-slate-50 border-2 border-slate-100 focus:border-blue-400 focus:bg-white rounded-2xl px-5 py-4 font-bold text-slate-800 focus:outline-none transition-all resize-none" />
          </div>
        </div>

        <div className="pt-2 border-t border-slate-100">
          <FileUploadField name="attachment" value={formData.attachmentUrl} onChange={(e) => setFormData((f) => ({ ...f, attachmentUrl: e.target.value }))} label="مرفق الطلب (تقرير طبي، إثبات...) اختياري" />
          <p className="text-[11px] font-semibold text-amber-600 bg-amber-50 px-3 py-2 border border-amber-100 rounded-lg mt-3 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" /> مسارات الحضور الثانية تخضع لدورة الموافقة بدءاً من المدير المباشر ثم الموارد البشرية.
          </p>
        </div>

        <div className="pt-4">
          <button disabled={isSubmitting || roleLoading} type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-[1.25rem] py-5 font-black text-[15px] flex items-center justify-center gap-3 transition-all hover:-translate-y-1 hover:shadow-lg hover:shadow-blue-600/30 disabled:opacity-50">
            {isSubmitting ? <span className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <>إرسال الطلب للاعتماد <Save size={20} /></>}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewAttendanceCorrectionPage() {
  return (
    <DashboardLayout>
      <React.Suspense fallback={<div className="p-20 text-center font-bold text-slate-500">جاري التحميل...</div>}>
        <AttendanceCorrectionForm />
      </React.Suspense>
    </DashboardLayout>
  );
}

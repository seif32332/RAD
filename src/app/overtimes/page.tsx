"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Briefcase, Clock, Award, CalendarClock, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface EmployeeRef {
  id?: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
}

interface Employee extends EmployeeRef { id: string }

interface Overtime {
  id: string;
  employee?: EmployeeRef | null;
  date: string;
  type?: string | null;
  hours?: number | null;
  amount?: number | null;
  reason?: string | null;
  status: string;
}

interface Allowance {
  id: string;
  employee?: EmployeeRef | null;
  name: string;
  amount: number;
  isMonthly: boolean;
  payrollMonth?: number | null;
  payrollYear?: number | null;
  isPaid?: boolean | null;
}

interface WorkAssignment {
  id: string;
  employee?: EmployeeRef | null;
  destination?: string | null;
  startDate: string;
  endDate: string;
  details?: string | null;
  status: string;
}

interface HubData {
  overtimes: Overtime[];
  allowances: Allowance[];
  workAssignments: WorkAssignment[];
}

const EMPTY_OVERTIME = { employeeId: '', date: '', type: 'HOURS', hours: '', amount: '', reason: '' };
/** payrollPeriod: optional "YYYY-MM"; empty lets the server pick the current (open) payroll month. */
const EMPTY_BONUS = { employeeId: '', name: '', amount: '', payrollPeriod: '' };

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

const fullName = (e?: EmployeeRef | null) => `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim() || '—';

export default function OvertimeAndBonusesPage() {
  const [activeTab, setActiveTab] = useState('OVERTIME'); // OVERTIME, BONUS, WORK_TASK, ARCHIVE
  const [data, setData] = useState<HubData>({ overtimes: [], allowances: [], workAssignments: [] });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Overtime Form
  const [overtimeForm, setOvertimeForm] = useState(EMPTY_OVERTIME);

  // Bonus Form
  const [bonusForm, setBonusForm] = useState(EMPTY_BONUS);

  const fetchHubData = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/payroll-hub');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل بيانات التكليفات'));
        return;
      }
      const json = await res.json();
      setData({
        overtimes: Array.isArray(json?.overtimes) ? json.overtimes : [],
        allowances: Array.isArray(json?.allowances) ? json.allowances : [],
        workAssignments: Array.isArray(json?.workAssignments) ? json.workAssignments : [],
      });
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchEmployees = useCallback(async () => {
    try {
      const res = await fetch('/api/employees?fields=basic');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تحميل قائمة الموظفين'));
        return;
      }
      const d = await res.json();
      if (Array.isArray(d)) setEmployees(d);
    } catch {
      toast.error('تعذر تحميل قائمة الموظفين');
    }
  }, []);

  useEffect(() => {
    fetchEmployees();
    fetchHubData();
  }, [fetchEmployees, fetchHubData]);

  /** POST to the payroll hub; returns true on success (toasts the server message). */
  const postHub = async (body: Record<string, unknown>, successFallback: string): Promise<boolean> => {
    const res = await fetch('/api/payroll-hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) {
      redirectToLogin();
      return false;
    }
    if (!res.ok) {
      toast.error(await readApiError(res));
      return false;
    }
    const json = await res.json().catch(() => null);
    toast.success(typeof json?.message === 'string' ? json.message : successFallback);
    return true;
  };

  const handleAssignOvertime = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if ((overtimeForm.type === 'HOURS' || overtimeForm.type === 'BIOMETRIC') && !overtimeForm.hours) { toast.warning("يرجى إدخال عدد الساعات"); return; }
    if (overtimeForm.type === 'LUMP_SUM' && !overtimeForm.amount) { toast.warning("يرجى إدخال المبلغ المقطوع"); return; }
    setIsSubmitting(true);
    try {
      if (await postHub({ actionType: 'CREATE_OVERTIME_ASSIGNMENT', payload: overtimeForm }, "تم تسجيل التكليف واعتماده وإضافته لمسير الرواتب!")) {
        setOvertimeForm(EMPTY_OVERTIME);
        await fetchHubData({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddBonus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const { payrollPeriod, ...bonus } = bonusForm;
      const [py, pm] = payrollPeriod ? payrollPeriod.split('-').map(Number) : [];
      const payload = py && pm ? { ...bonus, payrollMonth: pm, payrollYear: py } : bonus;
      if (await postHub({ actionType: 'CREATE_BONUS', payload }, "تم إدراج المكافأة بنجاح!")) {
        setBonusForm(EMPTY_BONUS);
        await fetchHubData({ silent: true });
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWorkAssignmentAction = async (id: string, newStatus: 'APPROVED' | 'REJECTED') => {
    if (newStatus === 'REJECTED' && !(await confirmDialog('هل أنت متأكد من رفض تكليف العمل؟', { danger: true }))) return;
    setBusyId(id);
    try {
      const ok = await postHub(
        { actionType: 'UPDATE_WORK_ASSIGNMENT', payload: { id, status: newStatus } },
        newStatus === 'APPROVED' ? "تم اعتماد تكليف العمل وبُرمج بموجهات الحضور والرواتب." : "تم رفض التكليف"
      );
      if (ok) await fetchHubData({ silent: true });
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  // Filter approved assignments specifically (the direct assignments are 'APPROVED')
  const approvedOvertimes = data.overtimes.filter((o) => o.status === 'APPROVED');
  // Allowances where isMonthly is false represent emergency bonuses
  const emergencyBonuses = data.allowances.filter((a) => !a.isMonthly);
  // Pending HR work assignments
  const pendingWorkAssignments = data.workAssignments.filter((w) => w.status === 'PENDING_HR' || w.status === 'PENDING_EMPLOYEE'); // Both are visible to HR so they can pre-approve or wait for employee.
  const approvedWorkAssignments = data.workAssignments.filter((w) => w.status === 'APPROVED');

  const employeeOptions = employees.map(e => ({ label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} - #${e.employeeId ?? ''}`, value: e.id }));

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-600 p-3 rounded-2xl"><CalendarClock size={26} /></span>
              إدارة التكليفات والعمل الإضافي
            </h1>
            <p className="text-indigo-700 font-bold mt-3 text-[14px]">
              واجهة مخصصة لتكليف الموظفين بساعات أو مبالغ إضافية، وكذلك مكافأتهم ببدلات استثنائية وطارئة ستُدرج أوتوماتيكياً في مسير الراتب.
            </p>
          </div>
        </div>

        {/* Tabs Menu */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'OVERTIME'} onClick={() => setActiveTab('OVERTIME')} label="تكليف بعمل إضافي (أوفرتايم)" />
          <TabButton active={activeTab === 'BONUS'} onClick={() => setActiveTab('BONUS')} label="المكافآت والبدلات الطارئة" />
          <TabButton active={activeTab === 'WORK_TASK'} onClick={() => setActiveTab('WORK_TASK')} label="انتداب ومهمة عمل خارجية" />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => setActiveTab('ARCHIVE')} label="سجلات التكليف المعتمدة" />
        </div>

        {!isLoading && loadError && (activeTab === 'OVERTIME' || activeTab === 'BONUS') && (
          <div role="alert" className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="font-bold text-[13px] text-rose-800">{loadError}</p>
            <button type="button" onClick={() => fetchHubData()} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-rose-200 text-rose-700 font-black text-[12px] rounded-xl hover:bg-rose-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب بيانات التكليفات...</div>
        ) : loadError && (activeTab === 'WORK_TASK' || activeTab === 'ARCHIVE') ? (
          <div role="alert" className="bg-white border border-rose-200 rounded-[2rem] p-12 text-center flex flex-col items-center gap-4">
            <div className="bg-rose-50 p-5 rounded-full text-rose-500"><AlertTriangle size={40} /></div>
            <p className="font-black text-slate-800">{loadError}</p>
            <button type="button" onClick={() => fetchHubData()} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white font-black text-[13px] rounded-xl transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* TAB: OVERTIME */}
            {activeTab === 'OVERTIME' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
                 <h3 className="font-extrabold text-xl text-indigo-800 mb-6 flex items-center gap-3">
                    <div className="bg-indigo-100 p-2 rounded-xl"><Clock size={20} className="text-indigo-600"/></div>
                    إصدار تكليف بعمل إضافي مباشرة
                 </h3>
                 <form onSubmit={handleAssignOvertime} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <SearchableSelect name="employeeId" value={overtimeForm.employeeId} onChange={(e) => setOvertimeForm({...overtimeForm, employeeId: e.target.value})} label="الموظف المُكلف" required accentColor="indigo"
                         options={employeeOptions} />

                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ التكليف أو العمل الإضافي</label>
                         <input type="date" required value={overtimeForm.date} onChange={(e) => setOvertimeForm({...overtimeForm, date: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all text-right" dir="ltr" />
                      </div>
                    </div>

                    <div className="bg-slate-50 border border-slate-100 p-6 rounded-[1.5rem] space-y-6">
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">آلية وصيغة التكليف المالي (التوقيت)</label>
                       <div className="flex flex-wrap gap-4">
                          <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${overtimeForm.type === 'HOURS' ? 'bg-indigo-50 border-indigo-500' : 'bg-white border-slate-200 hover:border-indigo-300'}`}>
                             <input type="radio" name="timingType" checked={overtimeForm.type === 'HOURS'} onChange={() => setOvertimeForm({...overtimeForm, type: 'HOURS', amount: ''})} className="w-4 h-4 text-indigo-600" />
                             <div><p className="font-bold text-[14px] text-slate-800">توقيت بعدد الساعات</p><p className="text-[11px] text-slate-500">سيتم ضرب الساعات في (الساعة بساعة ونصف)</p></div>
                          </label>
                          <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${overtimeForm.type === 'LUMP_SUM' ? 'bg-indigo-50 border-indigo-500' : 'bg-white border-slate-200 hover:border-indigo-300'}`}>
                             <input type="radio" name="timingType" checked={overtimeForm.type === 'LUMP_SUM'} onChange={() => setOvertimeForm({...overtimeForm, type: 'LUMP_SUM', hours: ''})} className="w-4 h-4 text-indigo-600" />
                             <div><p className="font-bold text-[14px] text-slate-800">مبلغ أوفرتايم مقطوع</p><p className="text-[11px] text-slate-500">ينزل كزيادة مالية مباشرة مع الراتب</p></div>
                          </label>
                          <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition ${overtimeForm.type === 'BIOMETRIC' ? 'bg-indigo-50 border-indigo-500' : 'bg-white border-slate-200 hover:border-indigo-300'}`}>
                             <input type="radio" name="timingType" checked={overtimeForm.type === 'BIOMETRIC'} onChange={() => setOvertimeForm({...overtimeForm, type: 'BIOMETRIC', amount: ''})} className="w-4 h-4 text-indigo-600" />
                             <div><p className="font-bold text-[14px] text-slate-800">سحب من بصمة الانصراف</p><p className="text-[11px] text-slate-500">محاسبته على أي دقائق بعد دوامه الرسمي</p></div>
                          </label>
                       </div>

                       {/* Conditional Inputs */}
                       {(overtimeForm.type === 'HOURS' || overtimeForm.type === 'BIOMETRIC') && (
                         <div className="mt-4 animate-in fade-in max-w-sm">
                            <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">{overtimeForm.type === 'BIOMETRIC' ? 'الساعات الإضافية حسب تقرير البصمة' : 'الساعات الإضافية المُكلف بها'}</label>
                            <input type="number" step="0.5" placeholder="عدد الساعات..." required value={overtimeForm.hours} onChange={(e) => setOvertimeForm({...overtimeForm, hours: e.target.value})} className="w-full px-5 py-4 bg-white border border-indigo-200 focus:border-indigo-500 rounded-2xl font-black text-[16px] text-indigo-900 focus:outline-none focus:ring-4 focus:ring-indigo-100 transition-all text-left shadow-sm shadow-indigo-900/5" dir="ltr" />
                         </div>
                       )}

                       {overtimeForm.type === 'LUMP_SUM' && (
                         <div className="mt-4 animate-in fade-in max-w-sm">
                            <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">قيمة المبلغ المقطوع (ر.س)</label>
                            <input type="number" step="0.01" placeholder="0.00" required value={overtimeForm.amount} onChange={(e) => setOvertimeForm({...overtimeForm, amount: e.target.value})} className="w-full px-5 py-4 bg-white border border-indigo-200 focus:border-indigo-500 rounded-2xl font-black text-[16px] text-indigo-900 focus:outline-none focus:ring-4 focus:ring-indigo-100 transition-all text-left shadow-sm shadow-indigo-900/5" dir="ltr" />
                         </div>
                       )}
                    </div>

                    <div>
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">إيضاح مبرر التكليف وتفاصيل العمل الموكل (اختياري)</label>
                       <input type="text" placeholder="مثال: جرد نهاية العام، تغطية عجز..." value={overtimeForm.reason} onChange={(e) => setOvertimeForm({...overtimeForm, reason: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                    </div>

                    <div className="pt-4 border-t border-slate-100">
                       <button type="submit" disabled={isSubmitting} className="w-full md:w-auto px-10 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[15px] rounded-[1.25rem] transition disabled:opacity-50 shadow-lg shadow-indigo-600/20">{isSubmitting ? 'جاري الحفظ...' : 'اعتمـــــاد التكليـــف فوراً'}</button>
                    </div>
                 </form>
              </div>
            )}

            {/* TAB: BONUS */}
            {activeTab === 'BONUS' && (
              <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
                 <h3 className="font-extrabold text-xl text-teal-800 mb-6 flex items-center gap-3">
                    <div className="bg-teal-100 p-2 rounded-xl"><Award size={20} className="text-teal-600"/></div>
                    اعتماد مكافأة مالية أو بدل طارئ
                 </h3>
                 <form onSubmit={handleAddBonus} className="space-y-6">
                    <SearchableSelect name="employeeId" value={bonusForm.employeeId} onChange={(e) => setBonusForm({...bonusForm, employeeId: e.target.value})} label="الموظف المُستحق" required accentColor="teal"
                       options={employeeOptions} />

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-6 rounded-[1.5rem] border border-slate-100">
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">مسمى المكافأة / البدل الطارئ</label>
                         <input type="text" required placeholder="مثال: عيديات، مكافأة تميز، تعويض بنزين..." value={bonusForm.name} onChange={(e) => setBonusForm({...bonusForm, name: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-teal-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-50 transition-all" />
                      </div>
                      <div>
                         <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">إجمالي المبلغ المعتمَد (ر.س)</label>
                         <input type="number" step="0.01" required placeholder="0.00" value={bonusForm.amount} onChange={(e) => setBonusForm({...bonusForm, amount: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-teal-200 focus:border-teal-500 rounded-2xl font-black text-[16px] text-teal-900 focus:outline-none focus:ring-4 focus:ring-teal-100 transition-all text-left shadow-sm shadow-teal-900/5" dir="ltr" />
                      </div>
                      <div className="md:col-span-2">
                         <label htmlFor="bonus-payroll-period" className="text-[12px] font-extrabold text-slate-700 mb-2 block">شهر الصرف في المسير <span className="text-slate-400 font-bold">(اختياري)</span></label>
                         <input id="bonus-payroll-period" type="month" value={bonusForm.payrollPeriod} onChange={(e) => setBonusForm({...bonusForm, payrollPeriod: e.target.value})} className="w-full md:w-1/2 px-5 py-3.5 bg-white border border-slate-200 focus:border-teal-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-50 transition-all" dir="ltr" />
                         <p className="text-[11px] font-bold text-slate-400 mt-2">اتركه فارغاً لإدراجها في مسير الشهر الحالي. إذا كان مسير الشهر المختار معتمداً تُنقل تلقائياً إلى أول شهر مفتوح.</p>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-slate-100">
                       <button type="submit" disabled={isSubmitting} className="w-full md:w-auto px-10 py-4 bg-teal-600 hover:bg-teal-700 text-white font-black text-[15px] rounded-[1.25rem] transition disabled:opacity-50 shadow-lg shadow-teal-600/20">{isSubmitting ? 'جاري الحفظ...' : 'صرف المكافأة وإدراجها بمسير الراتب'}</button>
                    </div>
                 </form>
              </div>
            )}

             {/* TAB: WORK TASK */}
             {activeTab === 'WORK_TASK' && (
               <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm">
                  <h3 className="font-extrabold text-xl text-fuchsia-800 mb-6 flex items-center gap-3">
                     <div className="bg-fuchsia-100 p-2 rounded-xl"><Briefcase size={20} className="text-fuchsia-600"/></div>
                     إدارة تكليف المهام الخارجية (الانتداب)
                  </h3>

                  <div className="space-y-6">
                    {pendingWorkAssignments.length === 0 ? (
                      <div className="text-center p-12 text-slate-400 font-bold bg-slate-50 rounded-2xl border border-slate-100">
                        لا توجد تكاليف عمل خارجية بانتظار الاعتماد.
                      </div>
                    ) : (
                      pendingWorkAssignments.map((task) => (
                        <div key={task.id} className="border border-slate-200 rounded-2xl p-6 bg-slate-50 flex flex-col md:flex-row gap-6 justify-between items-start md:items-center">
                          <div>
                            <h4 className="font-bold text-lg text-slate-800">{fullName(task.employee)}</h4>
                            <p className="text-[13px] font-bold text-fuchsia-600 mt-1 mb-3">الوجهة: {task.destination}</p>
                            <div className="flex flex-wrap gap-4 text-[12px] font-bold text-slate-500">
                              <span className="bg-white px-3 py-1 rounded-lg border">من: {formatDate(task.startDate)}</span>
                              <span className="bg-white px-3 py-1 rounded-lg border">إلى: {formatDate(task.endDate)}</span>
                              <span className="bg-amber-50 px-3 py-1 text-amber-600 rounded-lg border border-amber-200">
                                {task.status === 'PENDING_EMPLOYEE' ? 'بانتظار موافقة الموظف' : 'بانتظار الاعتماد النهائي من الموارد'}
                              </span>
                            </div>
                            <p className="text-[12px] text-slate-600 mt-3 font-medium max-w-lg">{task.details}</p>
                          </div>

                          <div className="flex gap-2 w-full md:w-auto shrink-0">
                            <button type="button" onClick={() => handleWorkAssignmentAction(task.id, 'APPROVED')} disabled={busyId === task.id} className="flex-1 md:flex-auto px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[13px] rounded-xl transition shadow-lg shadow-emerald-600/20 disabled:opacity-50">
                              اعتماد
                            </button>
                            <button type="button" onClick={() => handleWorkAssignmentAction(task.id, 'REJECTED')} disabled={busyId === task.id} className="px-6 py-2 bg-slate-200 hover:bg-rose-100 text-slate-700 hover:text-rose-700 font-bold text-[13px] rounded-xl transition disabled:opacity-50">
                              رفض
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
               </div>
             )}

            {/* TAB: ARCHIVE */}
            {activeTab === 'ARCHIVE' && (
              <div className="space-y-12">

                 {/* Overtimes Logic output */}
                 <div>
                   <h3 className="font-extrabold text-xl text-slate-800 mb-6 flex items-center gap-3">
                     <Clock size={24} className="text-indigo-600"/> سجل التكليفات والعمل الإضافي (الأوفرتايم)
                   </h3>
                   <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100">
                            <th className="p-4 text-[13px] font-black text-slate-500">اسم الموظف</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">التاريخ</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">نوع التوقيت / السياسة</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">الاستحقاق المُعتمد</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">السبب</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {approvedOvertimes.map((o) => (
                            <tr key={o.id} className="hover:bg-slate-50 transition">
                              <td className="p-4 font-bold text-slate-800 text-[14px]">
                                {fullName(o.employee)}
                              </td>
                              <td className="p-4 font-bold text-slate-500 text-[13px]">{formatDate(o.date)}</td>
                              <td className="p-4">
                                {o.type === 'HOURS' && <span className="bg-blue-50 text-blue-700 px-3 py-1 rounded-lg text-[11px] font-black tracking-wide">بعدد الساعات</span>}
                                {o.type === 'LUMP_SUM' && <span className="bg-amber-50 text-amber-700 px-3 py-1 rounded-lg text-[11px] font-black tracking-wide">مبلغ مقطوع</span>}
                                {o.type === 'BIOMETRIC' && <span className="bg-green-50 text-green-700 px-3 py-1 rounded-lg text-[11px] font-black tracking-wide">مطابقة من البصمة</span>}
                                {(!o.type || o.type === 'PENDING') && <span className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg text-[11px] font-black">أخرى</span>}
                              </td>
                              <td className="p-4 font-black text-indigo-700 text-[15px]">
                                 {o.type === 'HOURS' && `${o.hours} ساعة`}
                                 {o.type === 'LUMP_SUM' && `${formatMoney(o.amount)} ر.س`}
                                 {o.type === 'BIOMETRIC' && `يُحدد آلياً`}
                              </td>
                              <td className="p-4 text-[12px] text-slate-600 font-bold max-w-[200px] truncate">{o.reason || '-'}</td>
                            </tr>
                          ))}
                          {approvedOvertimes.length === 0 && (
                            <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">لا يوجد سجل تكليفات معتمدة حالياً.</td></tr>
                          )}
                        </tbody>
                      </table>
                   </div>
                 </div>

                 {/* Work Assignments Logic output */}
                 <div>
                   <h3 className="font-extrabold text-xl text-slate-800 mb-6 flex items-center gap-3">
                     <Briefcase size={24} className="text-fuchsia-600"/> سجل المهام والانتدابات الخارجية
                   </h3>
                   <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100">
                            <th className="p-4 text-[13px] font-black text-slate-500">اسم الموظف</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">الوجهة (الجهة)</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">من تاريخ</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">إلى تاريخ</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">الحالة</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {approvedWorkAssignments.map((task) => (
                            <tr key={task.id} className="hover:bg-slate-50 transition">
                              <td className="p-4 font-bold text-slate-800 text-[14px]">
                                {fullName(task.employee)}
                              </td>
                              <td className="p-4 font-bold text-slate-600 text-[13px]">{task.destination}</td>
                              <td className="p-4 font-bold text-slate-600 text-[13px]">{formatDate(task.startDate)}</td>
                              <td className="p-4 font-bold text-slate-600 text-[13px]">{formatDate(task.endDate)}</td>
                              <td className="p-4">
                                <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-1 rounded-lg text-[11px] font-black">مُعتمد (يعوّض كحضور)</span>
                              </td>
                            </tr>
                          ))}
                          {approvedWorkAssignments.length === 0 && (
                            <tr><td colSpan={5} className="p-10 text-center text-slate-400 font-bold">لا يوجد مهام خارجية معتمدة حالياً.</td></tr>
                          )}
                        </tbody>
                      </table>
                   </div>
                 </div>

                 {/* Emergency Bonuses output */}
                 <div>
                   <h3 className="font-extrabold text-xl text-slate-800 mb-6 flex items-center gap-3">
                     <Award size={24} className="text-teal-600"/> سجل المكافآت والبدلات الطارئة المنصرفة
                   </h3>
                   <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                      <table className="w-full text-right border-collapse">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-100">
                            <th className="p-4 text-[13px] font-black text-slate-500">المُستفيد</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">المُسمى</th>
                            <th className="p-4 text-[13px] font-black text-slate-500">القيمة</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {emergencyBonuses.map((b) => (
                            <tr key={b.id} className="hover:bg-slate-50 transition">
                              <td className="p-4 font-bold text-slate-800 text-[14px]">
                                {fullName(b.employee)}
                              </td>
                              <td className="p-4 font-bold text-slate-600 text-[13px]">{b.name} <span className="text-[10px] text-teal-600 bg-teal-50 px-2 py-0.5 rounded ml-2">طوارئ</span>
                                {b.payrollMonth && b.payrollYear ? (
                                  <span className="block text-[11px] text-slate-400 mt-1">
                                    مسير {b.payrollMonth}/{b.payrollYear}{b.isPaid ? ' — تم الصرف' : ' — بانتظار الصرف'}
                                  </span>
                                ) : null}
                              </td>
                              <td className="p-4 font-black text-teal-700 text-[15px]">{formatMoney(b.amount)} ر.س</td>
                            </tr>
                          ))}
                          {emergencyBonuses.length === 0 && (
                            <tr><td colSpan={3} className="p-10 text-center text-slate-400 font-bold">لم يتم صرف أي مكافأة استثنائية أو بدل طارئ بعد.</td></tr>
                          )}
                        </tbody>
                      </table>
                   </div>
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
        active ? 'bg-indigo-900 text-white shadow-md border border-indigo-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

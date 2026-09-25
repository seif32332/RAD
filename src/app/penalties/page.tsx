"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle, XCircle, Shield, Briefcase, FileX2, Clock, Ban, Flame, TrendingDown, Filter, Hash, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, confirmDialog, readApiError } from '@/components/ui/feedback';
import { useRole } from '@/context/RoleContext';
import { DEDUCTION_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { daysBetween, formatDate, todayKey } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

// --- تصنيفات المخالفات ---
const violationCategories = {
  ATTENDANCE: {
    label: 'مخالفات الالتزام بالمواعيد',
    icon: <Clock size={18} />,
    color: 'amber',
    types: [
      { value: 'LATE', label: 'تأخير عن موعد الدوام' },
      { value: 'ABSENCE', label: 'غياب بدون إذن' },
      { value: 'EARLY_LEAVE', label: 'خروج قبل نهاية الدوام' },
      { value: 'BREAK_OVERUSE', label: 'تجاوز وقت الاستراحة' },
      { value: 'NO_PUNCH', label: 'عدم التبصيم / عدم تسجيل الحضور' },
    ]
  },
  BEHAVIORAL: {
    label: 'مخالفات سلوكية',
    icon: <Ban size={18} />,
    color: 'orange',
    types: [
      { value: 'INAPPROPRIATE_LANGUAGE', label: 'التحدث بأسلوب غير لائق' },
      { value: 'DISRESPECT_COLLEAGUES', label: 'إساءة التعامل مع الزملاء' },
      { value: 'DISRESPECT_CLIENTS', label: 'إساءة التعامل مع العملاء' },
      { value: 'DRESS_CODE', label: 'عدم الالتزام بالزي الرسمي' },
      { value: 'PHONE_MISUSE', label: 'استخدام الهاتف أثناء العمل' },
      { value: 'SMOKING_VIOLATION', label: 'التدخين في أماكن غير مصرح بها' },
    ]
  },
  SERIOUS: {
    label: 'مخالفات جسيمة',
    icon: <Flame size={18} />,
    color: 'red',
    types: [
      { value: 'VERBAL_ABUSE', label: 'سب أو شتم' },
      { value: 'PHYSICAL_ASSAULT', label: 'اعتداء جسدي / ضرب' },
      { value: 'HARASSMENT', label: 'تحرش بأي شكل' },
      { value: 'THEFT', label: 'سرقة أو اختلاس' },
      { value: 'FORGERY', label: 'تزوير مستندات رسمية' },
      { value: 'SUBSTANCE_ABUSE', label: 'تعاطي مواد محظورة' },
      { value: 'CONFIDENTIALITY_BREACH', label: 'إفشاء أسرار العمل' },
    ]
  },
  PERFORMANCE: {
    label: 'مخالفات أداء وظيفي / إدارية',
    icon: <TrendingDown size={18} />,
    color: 'purple',
    types: [
      { value: 'TASK_NEGLIGENCE', label: 'التقصير في المهام الموكلة' },
      { value: 'TASK_DELAY', label: 'التأخير في تسليم المهام' },
      { value: 'QUALITY_ISSUE', label: 'ضعف جودة العمل المُنجز' },
      { value: 'INSUBORDINATION', label: 'رفض تنفيذ أوامر المسؤول' },
      { value: 'UNAUTHORIZED_ABSENCE', label: 'ترك موقع العمل بدون إذن' },
      { value: 'EQUIPMENT_DAMAGE', label: 'إتلاف معدات أو ممتلكات' },
    ]
  }
};

// --- جدول إرشادي للجزاءات حسب التكرار ---
// مرجع إرشادي فقط: المرجع النظامي هو لائحة تنظيم العمل المعتمدة للمنشأة (المادة 67 لا تجيز جزاءً
// غير وارد فيها). لا يقترح الجدول الفصل آلياً ولا الإنذار الشفهي، ولا يُطبَّق منه شيء تلقائياً.
const REFER_TO_INVESTIGATION = 'إحالة للتحقيق، والجزاء وفق اللائحة المعتمدة';
const penaltyScale: Record<string, { 1: string; 2: string; 3: string; 4: string; 5: string }> = {
  ATTENDANCE: {
    1: 'إنذار كتابي',
    2: 'إنذار كتابي ثانٍ',
    3: 'خصم يوم واحد',
    4: 'خصم 3 أيام',
    5: 'خصم 5 أيام + إنذار نهائي',
  },
  BEHAVIORAL: {
    1: 'إنذار كتابي',
    2: 'خصم يوم واحد',
    3: 'خصم 3 أيام',
    4: 'خصم 5 أيام + إنذار نهائي',
    5: REFER_TO_INVESTIGATION,
  },
  SERIOUS: {
    1: 'خصم 5 أيام + إنذار نهائي',
    2: REFER_TO_INVESTIGATION,
    3: REFER_TO_INVESTIGATION,
    4: REFER_TO_INVESTIGATION,
    5: REFER_TO_INVESTIGATION,
  },
  PERFORMANCE: {
    1: 'إنذار كتابي مع متابعة',
    2: 'إنذار كتابي ثانٍ',
    3: 'خصم يوم واحد',
    4: 'خصم 3 أيام + خطة تحسين',
    5: 'خصم 5 أيام + إنذار نهائي',
  },
};

/** Article 68: repeats are counted within 180 days (the API computes the stored number the same way). */
const OCCURRENCE_WINDOW_DAYS = 180;

type CategoryKey = keyof typeof violationCategories;

interface PenaltyEmployee {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
}

interface Deduction {
  id: string;
  employeeId: string;
  employee?: PenaltyEmployee | null;
  amount: number;
  reason: string;
  date: string;
  category?: string | null;
  violationType?: string | null;
  occurrenceNumber?: number | null;
  lawArticle?: string | null;
  status: string;
}

type ColorKey = 'amber' | 'orange' | 'red' | 'purple' | 'slate';

/** Static Tailwind classes per category color (dynamic class names are invisible to Tailwind). */
const BADGE_CLASSES: Record<ColorKey, string> = {
  amber: 'bg-amber-100 text-amber-700',
  orange: 'bg-orange-100 text-orange-700',
  red: 'bg-red-100 text-red-700',
  purple: 'bg-purple-100 text-purple-700',
  slate: 'bg-slate-100 text-slate-700',
};

const FILTER_CLASSES: Record<ColorKey, { active: string; idle: string }> = {
  amber: { active: 'bg-amber-500 text-white border-amber-500', idle: 'bg-white text-amber-700 border-amber-200 hover:bg-amber-50' },
  orange: { active: 'bg-orange-500 text-white border-orange-500', idle: 'bg-white text-orange-700 border-orange-200 hover:bg-orange-50' },
  red: { active: 'bg-red-500 text-white border-red-500', idle: 'bg-white text-red-700 border-red-200 hover:bg-red-50' },
  purple: { active: 'bg-purple-500 text-white border-purple-500', idle: 'bg-white text-purple-700 border-purple-200 hover:bg-purple-50' },
  slate: { active: 'bg-slate-500 text-white border-slate-500', idle: 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50' },
};

const EMPTY_FORM = {
  employeeId: '', date: '', amount: '', reason: '',
  category: 'ATTENDANCE' as CategoryKey, violationType: '', lawArticle: ''
};

function redirectToLogin() {
  if (typeof window !== 'undefined') window.location.assign('/login');
}

export default function PenaltiesPage() {
  const [activeTab, setActiveTab] = useState('CREATE');
  // The role comes from the signed server session; the server decides whether a new
  // violation is applied directly (HR/payroll) or waits for HR to set the amount (managers).
  const { role } = useRole();
  const isHr = roleIn(role, ROLE_GROUPS.PAYROLL);
  const isManager = !!role && !isHr && roleIn(role, ROLE_GROUPS.MANAGERS);

  const [deductions, setDeductions] = useState<Deduction[]>([]);
  const [employees, setEmployees] = useState<PenaltyEmployee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Form
  const [penaltyForm, setPenaltyForm] = useState(EMPTY_FORM);

  const fetchHubData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/payroll-hub');
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل سجل المخالفات'));
        return;
      }
      const json = await res.json();
      setDeductions(Array.isArray(json?.deductions) ? json.deductions : []);
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

  // Compute occurrence count for selected employee + category + violationType
  const selectedEmployeePenalties = penaltyForm.employeeId
    ? deductions.filter((d) => d.employeeId === penaltyForm.employeeId)
    : [];

  // Mirrors the server (Article 68): only same-type violations in the 180 days up to the new
  // violation's date (today when no date is chosen yet) count as repeats.
  const occurrenceDate = penaltyForm.date || todayKey();
  const sameTypeCount = penaltyForm.employeeId && penaltyForm.category
    ? deductions.filter((d) => {
        if (d.employeeId !== penaltyForm.employeeId || d.category !== penaltyForm.category) return false;
        if (penaltyForm.violationType && d.violationType !== penaltyForm.violationType) return false;
        if (d.status === DEDUCTION_STATUS.WAIVED || d.status === DEDUCTION_STATUS.REJECTED) return false;
        const age = daysBetween(d.date, occurrenceDate);
        return age >= 0 && age <= OCCURRENCE_WINDOW_DAYS;
      }).length
    : 0;

  const nextOccurrence = sameTypeCount + 1;
  const suggestedPenalty = penaltyScale[penaltyForm.category]?.[Math.min(nextOccurrence, 5) as 1|2|3|4|5] || 'غير محدد';

  const handleAddPenalty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      // No status is sent: the server derives it from the signed-in user's role.
      const { amount, ...rest } = penaltyForm;
      const payload = isManager ? rest : { ...rest, amount };
      const res = await fetch('/api/payroll-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: 'CREATE_DEDUCTION', payload })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر إدراج المخالفة'));
        return;
      }
      const json: unknown = await res.json().catch(() => null);
      const body = (json && typeof json === 'object' ? json : {}) as { message?: unknown; warnings?: unknown };
      setPenaltyForm(EMPTY_FORM);
      await fetchHubData();
      toast.success(isManager
        ? 'تم إرسال المخالفة للموارد البشرية لتقدير الخصم'
        : typeof body.message === 'string' ? body.message : 'تم إدراج المخالفة');
      if (Array.isArray(body.warnings)) {
        for (const w of body.warnings) if (typeof w === 'string') toast.warning(w);
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const postAction = async (actionType: string, payload: { id: string; amount?: number }, successFallback: string) => {
    setBusyId(payload.id);
    try {
      const res = await fetch('/api/payroll-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType, payload })
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(await readApiError(res));
        return;
      }
      const json = await res.json().catch(() => null);
      toast.success(typeof json?.message === 'string' ? json.message : successFallback);
      await fetchHubData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusyId(null);
    }
  };

  const handleAction = async (actionType: string, id: string, message: string) => {
    if (!(await confirmDialog(message, { danger: true }))) return;
    await postAction(actionType, { id }, 'تم تنفيذ الإجراء بنجاح');
  };

  const handleApproveAmount = async (id: string, input: HTMLInputElement) => {
    const value = input.value.trim();
    if (!value) return;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('أدخل مبلغاً صحيحاً أكبر من صفر');
      return;
    }
    if (!(await confirmDialog(`اعتماد مبلغ الخصم (${formatMoney(amount)} ر.س)؟`))) return;
    await postAction('APPROVE_DEDUCTION_AMOUNT', { id, amount }, 'تم اعتماد مبلغ الخصم');
  };

  const activePenalties = deductions.filter((d) => d.status === DEDUCTION_STATUS.DEDUCTED);
  const pendingRequests = deductions.filter((d) => d.status === DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL);
  const allPenaltiesHistory = deductions;

  const getCategoryLabel = (cat: string | null | undefined) => violationCategories[cat as CategoryKey]?.label || cat || 'غير مصنف';
  const getCategoryColor = (cat: string | null | undefined): ColorKey => {
    switch(cat) {
      case 'ATTENDANCE': return 'amber';
      case 'BEHAVIORAL': return 'orange';
      case 'SERIOUS': return 'red';
      case 'PERFORMANCE': return 'purple';
      default: return 'slate';
    }
  };

  const getViolationTypeLabel = (cat: string | null | undefined, type: string | null | undefined) => {
    if (!cat || !type) return type || '';
    const catObj = violationCategories[cat as CategoryKey];
    if (!catObj) return type;
    return catObj.types.find(t => t.value === type)?.label || type;
  };

  /** The recorded amount only; the guidance table is never shown as the imposed penalty. */
  const amountLabel = (d: Deduction) => {
    if (!(d.amount > 0)) return 'بلا خصم مالي';
    return d.status === DEDUCTION_STATUS.DEDUCTED ? `خصم معتمد: ${formatMoney(d.amount)} ر.س` : `مبلغ مقترح: ${formatMoney(d.amount)} ر.س`;
  };

  const employeeName = (d: Deduction) => `${d.employee?.firstNameArabic ?? ''} ${d.employee?.lastNameArabic ?? ''}`.trim() || '—';

  // Stats for archive filter
  const [archiveFilter, setArchiveFilter] = useState('ALL');

  const filteredArchive = archiveFilter === 'ALL'
    ? allPenaltiesHistory
    : allPenaltiesHistory.filter((d) => d.category === archiveFilter);

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-rose-200">
          <div>
            <h1 className="text-3xl font-black text-rose-900 tracking-tight flex items-center gap-3">
              <span className="bg-rose-100 text-rose-600 p-3 rounded-2xl"><AlertTriangle size={26} /></span>
              إدارة الجزاءات والمخالفات
            </h1>
            <p className="text-rose-700 font-bold mt-3 text-[14px]">
              تقييد المخالفات مصنفة حسب النوع، مع جدول إرشادي للجزاءات حسب التكرار. المرجع النظامي لائحة تنظيم العمل المعتمدة للمنشأة.
            </p>
          </div>
          
          {role && (
            <div className="bg-slate-50 border border-slate-200 p-2 rounded-2xl flex items-center gap-2">
              <span className="px-4 py-2 rounded-xl text-[12px] font-black tracking-wide bg-slate-900 text-white shadow-md">
                {isHr ? 'صلاحية: موارد بشرية' : isManager ? 'صلاحية: مدير مباشر' : 'صلاحية: عرض فقط'}
              </span>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabButton active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="تسجيل مخالفة جديدة" />
          <TabButton active={activeTab === 'WORKFLOW'} onClick={() => setActiveTab('WORKFLOW')} label="سلسلة الموافقات والإسقاط" badge={isHr && pendingRequests.length > 0} />
          <TabButton active={activeTab === 'PENALTY_TABLE'} onClick={() => setActiveTab('PENALTY_TABLE')} label="جدول الجزاءات الإرشادي" />
          <TabButton active={activeTab === 'ARCHIVE'} onClick={() => setActiveTab('ARCHIVE')} label="أرشيف المخالفات" />
        </div>

        {loadError && activeTab !== 'PENALTY_TABLE' && (
          <div role="alert" className="bg-rose-50 border border-rose-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="font-bold text-[13px] text-rose-800">{loadError}</p>
            <button type="button" onClick={fetchHubData} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-rose-200 text-rose-700 font-black text-[12px] rounded-xl hover:bg-rose-100 transition">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب المحفظة الجزائية...</div>
        ) : loadError && (activeTab === 'WORKFLOW' || activeTab === 'ARCHIVE') ? null : (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            {/* === TAB: CREATE === */}
            {activeTab === 'CREATE' && (
              <div className="bg-white border border-rose-200 rounded-[2rem] p-8 shadow-sm">
                <h3 className="font-extrabold text-xl text-rose-800 mb-6 flex items-center gap-3">
                  <div className="bg-rose-100 p-2 rounded-xl"><AlertTriangle size={20} className="text-rose-600"/></div>
                  تسجيل مخالفة جديدة على موظف
                </h3>
                <form onSubmit={handleAddPenalty} className="space-y-6">
                  
                  {/* Employee Selection */}
                  <SearchableSelect name="employeeId" value={penaltyForm.employeeId} onChange={(e) => setPenaltyForm({...penaltyForm, employeeId: e.target.value})} label="الموظف المخالف" required accentColor="rose"
                    options={employees.map(e => ({ label: `${e.firstNameArabic ?? ""} ${e.lastNameArabic ?? ""} - #${e.employeeId ?? ""}`, value: e.id }))} />

                  {/* === Violation Category Selection === */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {(Object.keys(violationCategories) as CategoryKey[]).map(key => {
                      const cat = violationCategories[key];
                      const isActive = penaltyForm.category === key;
                      const colorMap: Record<string, string> = {
                        amber: isActive ? 'bg-amber-500 text-white border-amber-500 shadow-amber-300/40' : 'bg-white text-amber-700 border-amber-200 hover:bg-amber-50',
                        orange: isActive ? 'bg-orange-500 text-white border-orange-500 shadow-orange-300/40' : 'bg-white text-orange-700 border-orange-200 hover:bg-orange-50',
                        red: isActive ? 'bg-red-600 text-white border-red-600 shadow-red-300/40' : 'bg-white text-red-700 border-red-200 hover:bg-red-50',
                        purple: isActive ? 'bg-purple-600 text-white border-purple-600 shadow-purple-300/40' : 'bg-white text-purple-700 border-purple-200 hover:bg-purple-50',
                      };
                      return (
                        <button key={key} type="button"
                          onClick={() => setPenaltyForm({...penaltyForm, category: key, violationType: ''})}
                          className={`flex items-center gap-3 p-4 rounded-2xl border-2 font-black text-[12px] transition-all duration-200 ${colorMap[cat.color]} ${isActive ? 'shadow-lg scale-[1.02]' : ''}`}
                        >
                          {cat.icon}
                          <span className="text-right leading-tight">{cat.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* === Violation Sub-Type === */}
                  <div className="relative z-40">
                    <SearchableSelect 
                      name="violationType" 
                      value={penaltyForm.violationType} 
                      onChange={(e) => setPenaltyForm({...penaltyForm, violationType: e.target.value})} 
                      label="نوع المخالفة التفصيلي" 
                      required
                      accentColor={getCategoryColor(penaltyForm.category)}
                      options={violationCategories[penaltyForm.category].types.map(t => ({ label: t.label, value: t.value }))} 
                    />
                  </div>

                  {/* === Progressive Discipline Preview === */}
                  {penaltyForm.employeeId && penaltyForm.violationType && (
                    <div className={`border-2 rounded-[1.5rem] p-5 ${
                      nextOccurrence >= 4 ? 'bg-red-50 border-red-200' : 
                      nextOccurrence >= 2 ? 'bg-amber-50 border-amber-200' : 
                      'bg-emerald-50 border-emerald-200'
                    }`}>
                      <div className="flex items-center gap-3 mb-3">
                        <Hash size={18} className={nextOccurrence >= 4 ? 'text-red-600' : nextOccurrence >= 2 ? 'text-amber-600' : 'text-emerald-600'} />
                        <h4 className="font-black text-[14px] text-slate-800">مرجع إرشادي حسب التكرار خلال 180 يوماً</h4>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="bg-white/70 rounded-xl p-3 border border-slate-100">
                          <p className="text-[11px] font-extrabold text-slate-400 mb-1">رقم التكرار</p>
                          <p className="font-black text-[20px] text-slate-800">{nextOccurrence}</p>
                        </div>
                        <div className="bg-white/70 rounded-xl p-3 border border-slate-100">
                          <p className="text-[11px] font-extrabold text-slate-400 mb-1">التصنيف</p>
                          <p className="font-black text-[13px] text-slate-800">{getCategoryLabel(penaltyForm.category)}</p>
                        </div>
                        <div className={`rounded-xl p-3 border-2 ${
                          nextOccurrence >= 4 ? 'bg-red-100 border-red-300' : 
                          nextOccurrence >= 2 ? 'bg-amber-100 border-amber-300' : 
                          'bg-emerald-100 border-emerald-300'
                        }`}>
                          <p className="text-[11px] font-extrabold text-slate-500 mb-1">الجزاء في الجدول الإرشادي</p>
                          <p className={`font-black text-[13px] ${
                            nextOccurrence >= 4 ? 'text-red-700' : 
                            nextOccurrence >= 2 ? 'text-amber-700' : 
                            'text-emerald-700'
                          }`}>{suggestedPenalty}</p>
                        </div>
                      </div>
                      <p className="text-[11px] font-bold text-slate-500 mt-3">للاسترشاد فقط، ولا يُطبَّق تلقائياً. المرجع لائحة المنشأة المعتمدة، ويُحدَّد الجزاء بقرار مكتوب بعد التحقيق عند الحاجة.</p>
                    </div>
                  )}

                  {/* Employee History */}
                  {penaltyForm.employeeId && (
                    <div className="bg-orange-50/80 border border-orange-200 rounded-[1.5rem] p-5 shadow-inner">
                      <h4 className="font-black text-orange-900 text-[14px] flex items-center gap-2 mb-3">
                        <AlertTriangle size={16}/> السجل التاريخي لمخالفات الموظف ({selectedEmployeePenalties.length})
                      </h4>
                      {selectedEmployeePenalties.length === 0 ? (
                        <p className="text-[12px] font-bold text-orange-600 bg-white/60 p-3 rounded-xl">ملف الموظف نظيف، لا يوجد عليه أي مخالفات سابقة.</p>
                      ) : (
                        <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                          {selectedEmployeePenalties.map((p) => (
                            <div key={p.id} className="bg-white p-3 rounded-xl border border-orange-100 flex items-center justify-between gap-4 hover:border-orange-300 transition-colors">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  {p.category && <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase ${BADGE_CLASSES[getCategoryColor(p.category)]}`}>{getCategoryLabel(p.category)}</span>}
                                  {p.occurrenceNumber && <span className="text-[9px] font-black text-slate-400">المرة #{p.occurrenceNumber}</span>}
                                  {p.lawArticle && <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">المادة: {p.lawArticle}</span>}
                                </div>
                                <p className="font-extrabold text-[12px] text-slate-800">{p.reason}</p>
                                <p className="font-bold text-[10px] text-slate-400 mt-1">{formatDate(p.date)}</p>
                              </div>
                              <div className="shrink-0 text-left">
                                <span className="font-black text-rose-600 text-[12px] block">{amountLabel(p)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Date & Amount */}
                  <div className={`grid grid-cols-1 ${isManager ? 'md:grid-cols-1' : 'md:grid-cols-2'} gap-6 bg-slate-50 p-6 rounded-[1.5rem] border border-slate-100`}>
                    <div>
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ وقـوع المخالفة / التجاوز</label>
                      <input type="date" required value={penaltyForm.date} onChange={(e) => setPenaltyForm({...penaltyForm, date: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-rose-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-rose-50 transition-all text-right" dir="ltr" />
                    </div>
                    {!isManager && (
                      <div>
                        <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">مبلغ الخصم أو الجزاء (ر.س)</label>
                        <p className="text-[11px] font-bold text-slate-500 -mt-1 mb-2">المبلغ الذي يتجاوز أجر يوم واحد يُسجَّل بانتظار اعتماد المبلغ ولا يدخل المسير قبل اعتماده.</p>
                        <input type="number" step="0.01" required placeholder="0.00" value={penaltyForm.amount} onChange={(e) => setPenaltyForm({...penaltyForm, amount: e.target.value})} className="w-full px-5 py-3.5 bg-white border border-rose-200 focus:border-rose-500 rounded-2xl font-black text-[16px] text-rose-900 focus:outline-none focus:ring-4 focus:ring-rose-100 transition-all text-left shadow-sm shadow-rose-900/5" dir="ltr" />
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-2">
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الوصف أو السبب التفصيلي للمخالفة</label>
                      <input type="text" placeholder="مثال: تأخر عن الدوام 45 دقيقة بدون عذر..." required value={penaltyForm.reason} onChange={(e) => setPenaltyForm({...penaltyForm, reason: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-rose-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-rose-50 transition-all" />
                    </div>
                    <div>
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">رقم أو نص المادة النظامية (اختياري)</label>
                      <input type="text" placeholder="مثال: المادة 41 / الفقرة ب..." value={penaltyForm.lawArticle} onChange={(e) => setPenaltyForm({...penaltyForm, lawArticle: e.target.value})} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-rose-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-rose-50 transition-all" />
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-100">
                    <button type="submit" disabled={isSubmitting || (!isHr && !isManager)} className="w-full md:w-auto px-10 py-4 bg-rose-600 hover:bg-rose-700 text-white font-black text-[15px] rounded-[1.25rem] transition disabled:opacity-50 shadow-lg shadow-rose-600/20">
                      {isSubmitting ? 'جاري الحفظ...' : isManager ? 'إرسال المخالفة للموارد البشرية لتقدير الخصم' : 'تسجيل المخالفة'}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* === TAB: PENALTY TABLE === */}
            {activeTab === 'PENALTY_TABLE' && (
              <div className="space-y-8">
                <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                  <div className="p-6 border-b border-slate-100 bg-slate-50">
                    <h3 className="font-black text-xl text-slate-800 flex items-center gap-3">
                      <Hash size={22} className="text-indigo-500" />
                      جدول إرشادي للجزاءات حسب نوع المخالفة وعدد التكرار
                    </h3>
                    <p className="text-slate-500 font-bold text-[13px] mt-2">مرجع إرشادي فقط، والمرجع لائحة تنظيم العمل المعتمدة للمنشأة. لا يُطبَّق أي جزاء منه تلقائياً، ولا يجوز جزاء غير وارد في اللائحة (المادة 67). يُعدّ التكرار خلال 180 يوماً من المخالفة السابقة من النوع نفسه، ولا يتجاوز الخصم أجر 5 أيام عن المخالفة الواحدة.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-right border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b-2 border-slate-200">
                          <th className="p-4 text-[12px] font-black text-slate-600 w-48">التصنيف</th>
                          <th className="p-4 text-[12px] font-black text-emerald-600 text-center">المرة الأولى</th>
                          <th className="p-4 text-[12px] font-black text-amber-600 text-center">المرة الثانية</th>
                          <th className="p-4 text-[12px] font-black text-orange-600 text-center">المرة الثالثة</th>
                          <th className="p-4 text-[12px] font-black text-red-600 text-center">المرة الرابعة</th>
                          <th className="p-4 text-[12px] font-black text-rose-700 text-center">المرة الخامسة+</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(Object.keys(penaltyScale) as CategoryKey[]).map(key => (
                          <tr key={key} className="hover:bg-slate-50 transition">
                            <td className="p-4">
                              <div className="flex items-center gap-2">
                                {violationCategories[key].icon}
                                <span className="font-black text-[12px] text-slate-800">{violationCategories[key].label}</span>
                              </div>
                            </td>
                            {[1,2,3,4,5].map(n => (
                              <td key={n} className="p-4 text-center">
                                <span className={`inline-block px-3 py-1.5 rounded-xl text-[11px] font-black ${
                                  n >= 4 ? 'bg-red-50 text-red-700 border border-red-200' :
                                  n >= 2 ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                                  'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                }`}>
                                  {penaltyScale[key][n as 1|2|3|4|5]}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* === TAB: WORKFLOW === */}
            {activeTab === 'WORKFLOW' && (
              <div className="space-y-8">
                {isManager && (
                  <div className="bg-slate-50 border-2 border-slate-200 rounded-[2rem] p-8">
                    <div className="bg-white p-6 rounded-[1.5rem] flex items-center gap-4 shadow-sm mb-6 border border-slate-100">
                      <div className="bg-slate-100 text-slate-500 p-3 rounded-xl"><Briefcase size={28}/></div>
                      <div>
                        <h3 className="font-black text-slate-800 text-[16px]">أهلاً بك أيها المدير المباشر</h3>
                        <p className="text-slate-500 font-bold text-[12px] mt-1">يمكنك طلب الإسقاط (عفو) عن المخالفات لموظفيك لتُرسل فوراً لمدير الموارد البشرية.</p>
                      </div>
                    </div>
                    
                    <h4 className="font-extrabold text-[15px] text-slate-800 mb-4">المخالفات النشطة الجاهزة لطلب الإسقاط:</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {activePenalties.length === 0 && <div className="col-span-full py-6 text-center text-slate-500 font-bold">لا يوجد مخالفات نشطة حالياً.</div>}
                      {activePenalties.map((d) => (
                        <div key={d.id} className="bg-white border border-rose-200 p-5 rounded-[1.5rem] shadow-sm flex flex-col justify-between hover:-translate-y-1 transition duration-300">
                          <div>
                            <p className="font-black text-[15px] text-slate-800 border-b border-slate-100 pb-2 mb-2">{employeeName(d)}</p>
                            {d.category && <span className={`inline-block px-2 py-0.5 rounded-md text-[9px] font-black uppercase mb-2 ${BADGE_CLASSES[getCategoryColor(d.category)]}`}>{getCategoryLabel(d.category)}</span>}
                            <p className="font-black text-[15px] text-rose-600 mb-1">{formatMoney(d.amount)} ر.س خصم</p>
                            <p className="font-bold text-[12px] text-slate-500 truncate max-w-[250px]">{d.reason}</p>
                          </div>
                          <button type="button" disabled={busyId === d.id} onClick={() => handleAction('REQUEST_WAIVE_DEDUCTION', d.id, "هل أنت متأكد من إرسال طلب إسقاط وعفو للموارد البشرية؟")}
                            className="mt-4 w-full bg-slate-900 hover:bg-indigo-600 text-white font-black text-[11px] py-3 rounded-xl transition disabled:opacity-50">
                            إرسال التماس للموارد البشرية لإسقاطها
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isHr && (
                  <div className="bg-indigo-50 border-2 border-indigo-100 rounded-[2rem] p-8">
                    <div className="bg-white p-6 rounded-[1.5rem] flex items-center gap-4 shadow-sm mb-6 border border-slate-100">
                      <div className="bg-indigo-100 text-indigo-600 p-3 rounded-xl"><Shield size={28}/></div>
                      <div>
                        <h3 className="font-black text-indigo-900 text-[16px]">صلاحيات الموارد البشرية (صاحب القرار النهائي)</h3>
                        <p className="text-indigo-700 font-bold text-[12px] mt-1">تستقبل هنا التماسات المدراء، ويمكنك الموافقة عليها، كما تملك السلطة لإسقاط أي مخالفة مباشرة.</p>
                      </div>
                    </div>
                    
                    <h4 className="font-extrabold text-[15px] text-slate-800 mb-4">طلبات العفو الواردة من المدراء:</h4>
                    <div className="bg-white border border-indigo-100 rounded-[1.5rem] p-2 mb-8 shadow-sm">
                      {pendingRequests.length === 0 && <div className="py-10 text-center text-slate-500 font-bold">صندوق طلبات الإسقاط فارغ حالياً.</div>}
                      {pendingRequests.map((d) => (
                        <div key={d.id} className="p-4 border-b last:border-0 border-slate-100 flex flex-col md:flex-row items-center justify-between gap-4 hover:bg-slate-50 transition rounded-xl">
                          <div className="flex items-center gap-4">
                            <div className="bg-amber-100 p-2 rounded-xl text-amber-600"><AlertTriangle size={20}/></div>
                            <div>
                              <p className="font-black text-[14px] text-slate-800">{employeeName(d)}</p>
                              <p className="font-bold text-[12px] text-slate-600 mt-1">يطلب مديره إسقاط جزاء قدره <span className="text-rose-600 font-black">{formatMoney(d.amount)} ر.س</span> بسبب: {d.reason}</p>
                            </div>
                          </div>
                          <div className="flex gap-2 w-full md:w-auto">
                            <button type="button" disabled={busyId === d.id} onClick={() => handleAction('WAIVE_DEDUCTION', d.id, "هل أنت متأكد من قرار العفو؟")} className="flex-1 px-4 py-2.5 bg-emerald-100 hover:bg-emerald-500 hover:text-white text-emerald-700 font-black text-[11px] rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-2"><CheckCircle size={14}/> الموافقة</button>
                            <button type="button" disabled={busyId === d.id} onClick={() => handleAction('REJECT_WAIVE_DEDUCTION', d.id, "هل أنت متأكد من رفض العفو وتثبيت الجزاء؟")} className="flex-1 px-4 py-2.5 bg-rose-50 hover:bg-rose-500 hover:text-white text-rose-700 font-black text-[11px] rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-2"><XCircle size={14}/> رفض</button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <h4 className="font-extrabold text-[15px] text-rose-800 mb-4 pt-4 border-t border-indigo-100/50">صلاحية الإسقاط المباشر:</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {activePenalties.length === 0 && <div className="col-span-full py-6 text-center text-slate-500 font-bold">لا يوجد مخالفات نشطة.</div>}
                      {activePenalties.map((d) => (
                        <div key={`hr-${d.id}`} className="bg-white border border-rose-100 p-4 rounded-2xl shadow-sm flex items-center justify-between">
                          <div>
                            <p className="font-black text-[13px] text-slate-800">{employeeName(d)}</p>
                            <p className="font-black text-[14px] text-rose-600 mt-0.5">{formatMoney(d.amount)} ر.س</p>
                          </div>
                          <button type="button" disabled={busyId === d.id} onClick={() => handleAction('WAIVE_DEDUCTION', d.id, "هل فعلاً تريد إسقاطه مباشرة؟")} className="bg-slate-100 hover:bg-rose-600 hover:text-white text-rose-700 font-black text-[10px] px-3 py-2 rounded-lg transition disabled:opacity-50">إسقاط فوراً</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* === TAB: ARCHIVE === */}
            {activeTab === 'ARCHIVE' && (
              <div className="space-y-6">
                {/* Category Filter */}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setArchiveFilter('ALL')} className={`px-4 py-2 rounded-xl text-[11px] font-black border-2 transition ${archiveFilter === 'ALL' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                    <Filter size={12} className="inline ml-1" /> الكل ({allPenaltiesHistory.length})
                  </button>
                  {(Object.keys(violationCategories) as CategoryKey[]).map(key => {
                    const count = allPenaltiesHistory.filter((d) => d.category === key).length;
                    return (
                      <button key={key} type="button" onClick={() => setArchiveFilter(key)} className={`px-4 py-2 rounded-xl text-[11px] font-black border-2 transition flex items-center gap-1.5 ${archiveFilter === key ? FILTER_CLASSES[getCategoryColor(key)].active : FILTER_CLASSES[getCategoryColor(key)].idle}`}>
                        {violationCategories[key].icon}
                        {violationCategories[key].label} ({count})
                      </button>
                    );
                  })}
                </div>

                <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
                  <table className="w-full text-right border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        <th className="p-4 text-[12px] font-black text-slate-500">الموظف</th>
                        <th className="p-4 text-[12px] font-black text-slate-500">التصنيف</th>
                        <th className="p-4 text-[12px] font-black text-slate-500">نوع المخالفة</th>
                        <th className="p-4 text-[12px] font-black text-slate-500">التكرار</th>
                        <th className="p-4 text-[12px] font-black text-slate-500">التاريخ</th>
                        <th className="p-4 text-[12px] font-black text-slate-500">الخصم</th>
                        <th className="p-4 text-[12px] font-black text-slate-500 text-left">الحالة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredArchive.map((d) => (
                        <tr key={d.id} className="hover:bg-slate-50 transition">
                          <td className="p-4 font-bold text-slate-800 text-[13px]">{employeeName(d)}</td>
                          <td className="p-4">
                            <span className={`px-2 py-1 rounded-lg text-[10px] font-black ${BADGE_CLASSES[getCategoryColor(d.category)]}`}>
                              {getCategoryLabel(d.category)}
                            </span>
                          </td>
                          <td className="p-4 font-bold text-[12px] text-slate-600">
                            {getViolationTypeLabel(d.category, d.violationType)}
                            {d.lawArticle && (
                              <span className="block text-[10px] font-bold text-slate-400 mt-0.5 bg-slate-100 px-1.5 py-0.5 rounded-md w-fit">
                                المادة: {d.lawArticle}
                              </span>
                            )}
                          </td>
                          <td className="p-4 font-black text-[14px] text-slate-800 text-center">{d.occurrenceNumber || '-'}</td>
                          <td className="p-4 font-bold text-slate-500 text-[12px]">{formatDate(d.date)}</td>
                          <td className="p-4">
                            {d.status === DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL && isHr ? (
                              <div className="flex bg-slate-50 p-1 border border-slate-200 rounded-lg shrink-0 w-28 items-center">
                                <input type="number" min="0" step="0.01" aria-label="مبلغ الخصم" disabled={busyId === d.id} className="w-full bg-transparent text-sm text-center font-bold outline-none text-rose-600 disabled:opacity-50" placeholder="مبلغ..."
                                  onBlur={(e) => { void handleApproveAmount(d.id, e.currentTarget); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
                                <span className="text-[9px] text-slate-400 pl-1 shrink-0">ر.س</span>
                              </div>
                            ) : (
                              <div className="text-right">
                                <span className="font-black text-rose-700 text-[12px] block">{amountLabel(d)}</span>
                              </div>
                            )}
                          </td>
                          <td className="p-4 text-left">
                            {d.status === 'DEDUCTED' && <span className="bg-rose-100 text-rose-800 border border-rose-200 px-3 py-1.5 rounded-lg text-[10px] uppercase font-black tracking-wide">خصم نافذ</span>}
                            {d.status === 'PENDING_WAIVE_APPROVAL' && <span className="bg-amber-100 text-amber-800 border border-amber-200 px-3 py-1.5 rounded-lg text-[10px] uppercase font-black tracking-wide animate-pulse">معلق بالموافقة</span>}
                            {d.status === 'PENDING_AMOUNT_APPROVAL' && <span className="bg-blue-100 text-blue-800 border border-blue-200 px-3 py-1.5 rounded-lg text-[10px] uppercase font-black tracking-wide animate-pulse">بانتظار اعتماد المبلغ</span>}
                            {d.status === 'WAIVED' && <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 px-3 py-1.5 rounded-lg text-[10px] uppercase font-black tracking-wide inline-flex items-center gap-1"><FileX2 size={12}/>مُسقط</span>}
                          </td>
                        </tr>
                      ))}
                      {filteredArchive.length === 0 && (
                        <tr><td colSpan={7} className="p-10 text-center text-slate-400 font-bold">أرشيف المخالفات نظيف.</td></tr>
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

function TabButton({ active, onClick, label, badge = false }: { active: boolean, onClick: () => void, label: string, badge?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 ${active ? 'bg-rose-900 text-white shadow-md border border-rose-900' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'}`}>
      {badge && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-pulse ring-4 ring-white"></span>}
      {label}
    </button>
  );
}

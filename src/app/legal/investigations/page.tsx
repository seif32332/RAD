"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Scale, Search, CheckCircle, Clock, Pause, FileText, Plus, X, User, UsersRound, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, promptDialog, confirmDialog, readApiError } from '@/components/ui/feedback';
import { parseDateOnly, todayKey } from '@/lib/dates';

type StatusColor = 'blue' | 'amber' | 'red' | 'emerald' | 'slate' | 'orange';

const statusLabels: Record<string, { label: string; color: StatusColor }> = {
  OPENED: { label: 'تم فتح الملف', color: 'blue' },
  IN_PROGRESS: { label: 'جاري التحقيق', color: 'amber' },
  COMPLETED_GUILTY: { label: 'ثبتت الإدانة', color: 'red' },
  COMPLETED_INNOCENT: { label: 'ثبتت البراءة', color: 'emerald' },
  CLOSED: { label: 'مغلق', color: 'slate' },
  SUSPENDED: { label: 'إيقاف مؤقت', color: 'orange' },
};

/** Static class lists (Tailwind cannot see dynamically built class names). */
const COLOR_CLASSES: Record<StatusColor, { bar: string; badge: string; iconBox: string; filterActive: string; filterIdle: string }> = {
  blue: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700', iconBox: 'bg-blue-50 text-blue-500', filterActive: 'bg-blue-500 text-white border-blue-500', filterIdle: 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50' },
  amber: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700', iconBox: 'bg-amber-50 text-amber-500', filterActive: 'bg-amber-500 text-white border-amber-500', filterIdle: 'bg-white text-amber-700 border-amber-200 hover:bg-amber-50' },
  red: { bar: 'bg-red-500', badge: 'bg-red-100 text-red-700', iconBox: 'bg-red-50 text-red-500', filterActive: 'bg-red-500 text-white border-red-500', filterIdle: 'bg-white text-red-700 border-red-200 hover:bg-red-50' },
  emerald: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700', iconBox: 'bg-emerald-50 text-emerald-500', filterActive: 'bg-emerald-500 text-white border-emerald-500', filterIdle: 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50' },
  slate: { bar: 'bg-slate-500', badge: 'bg-slate-100 text-slate-700', iconBox: 'bg-slate-50 text-slate-500', filterActive: 'bg-slate-500 text-white border-slate-500', filterIdle: 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50' },
  orange: { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700', iconBox: 'bg-orange-50 text-orange-500', filterActive: 'bg-orange-500 text-white border-orange-500', filterIdle: 'bg-white text-orange-700 border-orange-200 hover:bg-orange-50' },
};

const categoryLabels: Record<string, string> = {
  ATTENDANCE: 'مخالفات مواعيد',
  BEHAVIORAL: 'مخالفات سلوكية',
  SERIOUS: 'مخالفات جسيمة',
  PERFORMANCE: 'مخالفات أداء',
};

const severityLabels: Record<string, string> = {
  LOW: 'منخفضة',
  MEDIUM: 'متوسطة',
  HIGH: 'عالية',
  CRITICAL: 'حرجة',
};

interface EmployeeOption {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic: string;
}

interface Investigation {
  id: string;
  subject: string;
  status: string;
  category?: string | null;
  severity?: string | null;
  isSuspended?: boolean;
  notes?: string | null;
  investigatorName?: string | null;
  investigatorRole?: string | null;
  findings?: string | null;
  employee?: { firstNameArabic?: string; lastNameArabic?: string } | null;
}

/**
 * The system sends no notice to the employee. `sendNotification` stays false (the server ignores
 * it); the user may instead record a notice given outside the system (method + date).
 */
const EMPTY_FORM = {
  employeeId: '', subject: '', description: '', category: 'SERIOUS', severity: 'HIGH',
  investigatorName: '', investigatorRole: '', committeeMember3: '', notes: '',
  investigationDate: '', investigationTime: '', sendNotification: false, suspendEmployee: false,
  employeeNotifiedManually: false, notificationMethod: '', notificationDate: '',
};

/** Mirrors MANUAL_NOTICE_METHODS in the investigations API. */
const NOTICE_METHODS: { value: string; label: string }[] = [
  { value: 'HAND_DELIVERY', label: 'خطاب مسلّم باليد' },
  { value: 'EMAIL', label: 'البريد الإلكتروني' },
  { value: 'SMS', label: 'رسالة نصية' },
  { value: 'PHONE', label: 'اتصال هاتفي' },
  { value: 'OTHER', label: 'طريقة أخرى' },
];

/** Prefix of the notes line recording a manual notice (written by the API). */
const MANUAL_NOTICE_PREFIX = '[إبلاغ يدوي]';

/** Article 70: a single violation's penalty may not exceed five days' wage (the API enforces it). */
const PENALTY_DAYS_MAX = 5;

const manualNoticeLine = (notes: string | null | undefined): string | null => {
  const line = notes?.split('\n').map((l) => l.trim()).find((l) => l.startsWith(MANUAL_NOTICE_PREFIX));
  return line ? line.slice(MANUAL_NOTICE_PREFIX.length).trim() : null;
};

/** The "موعد التحقيق: ..." line written at opening (always the first line when present). */
const hearingLine = (notes: string | null | undefined): string | null => {
  const first = notes?.split('\n')[0]?.trim();
  return first && first.startsWith('موعد التحقيق:') ? first : null;
};

/** Investigations without a verdict yet (the API accepts updates / verdicts on these). */
const OPEN_STATUSES = ['OPENED', 'IN_PROGRESS', 'SUSPENDED'];

const EMPTY_UPDATE = { status: '', findings: '', recommendation: '', finalDecision: '', penaltyAmount: '', penaltyDays: '', notes: '' };

export default function InvestigationsPage() {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('LIST');
  const [selectedInv, setSelectedInv] = useState<Investigation | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Create form
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [suspendingId, setSuspendingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  // Update form
  const [updateForm, setUpdateForm] = useState(EMPTY_UPDATE);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [invRes, empRes] = await Promise.all([
        fetch('/api/legal/investigations'),
        fetch('/api/employees?fields=basic'),
      ]);
      if (invRes.status === 401 || empRes.status === 401) { window.location.href = '/login'; return; }
      if (!invRes.ok) {
        const msg = await readApiError(invRes, 'تعذر تحميل ملفات التحقيق');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const invData: unknown = await invRes.json();
      setInvestigations(Array.isArray(invData) ? (invData as Investigation[]) : []);
      if (empRes.ok) {
        const empData: unknown = await empRes.json();
        setEmployees(Array.isArray(empData) ? (empData as EmployeeOption[]) : []);
      } else {
        toast.error(await readApiError(empRes, 'تعذر تحميل قائمة الموظفين'));
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally { setIsLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const postAction = async (action: string, payload: Record<string, unknown>, fallback: string): Promise<boolean> => {
    const res = await fetch('/api/legal/investigations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload })
    });
    if (res.status === 401) { window.location.href = '/login'; return false; }
    if (!res.ok) { toast.error(await readApiError(res, fallback)); return false; }
    const data = await res.json().catch(() => ({}));
    toast.success(data?.message || 'تم الحفظ');
    return true;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.employeeId) { toast.error('يرجى اختيار الموظف المُحال للتحقيق'); return; }
    if (form.employeeNotifiedManually && (!form.notificationMethod || !form.notificationDate)) {
      toast.error('يرجى تحديد طريقة إبلاغ الموظف وتاريخه');
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = form.employeeNotifiedManually
        ? form
        : { ...form, notificationMethod: '', notificationDate: '' };
      const ok = await postAction('CREATE', payload, 'تعذر فتح ملف التحقيق');
      if (!ok) return;
      setForm(EMPTY_FORM);
      setActiveTab('LIST');
      fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally { setIsSubmitting(false); }
  };

  const handleUpdateStatus = async () => {
    if (!selectedInv || !updateForm.status || isUpdating) return;
    if (updateForm.status === 'COMPLETED_GUILTY' && !updateForm.findings.trim()) {
      toast.error('يرجى كتابة نتائج التحقيق قبل اعتماد الإدانة');
      return;
    }
    if (updateForm.status === 'COMPLETED_GUILTY' || updateForm.status === 'COMPLETED_INNOCENT') {
      const ok = await confirmDialog('بعد اعتماد القرار تُقفل نتائج التحقيق والتوصية والقرار النهائي ولا يمكن تعديلها، وتُضاف أي توضيحات لاحقة كملحق مؤرخ. متابعة؟');
      if (!ok) return;
    }
    setIsUpdating(true);
    try {
      const ok = await postAction('UPDATE_STATUS', { id: selectedInv.id, ...updateForm }, 'تعذر تحديث ملف التحقيق');
      if (!ok) return;
      setSelectedInv(null);
      fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally { setIsUpdating(false); }
  };

  const handleSuspend = async (id: string) => {
    const startDate = await promptDialog('تاريخ بداية الإيقاف (YYYY-MM-DD):', { defaultValue: todayKey(), confirmText: 'إيقاف الموظف', danger: true });
    if (startDate === null) return;
    if (!parseDateOnly(startDate.trim())) { toast.error('صيغة التاريخ غير صحيحة، استخدم YYYY-MM-DD'); return; }
    setSuspendingId(id);
    try {
      const ok = await postAction('SUSPEND', { id, suspensionStartDate: startDate.trim() }, 'تعذر إيقاف الموظف');
      if (ok) fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally { setSuspendingId(null); }
  };

  const handleClose = async (inv: Investigation) => {
    if (!(await confirmDialog(`إغلاق ملف التحقيق "${inv.subject}" نهائياً؟ تبقى نتائج التحقيق والقرار النهائي كما اعتُمدت دون تعديل.`, { title: 'إغلاق ملف التحقيق', confirmText: 'متابعة' }))) return;
    // Optional dated addendum (cancelling / leaving it empty closes without one).
    const addendum = await promptDialog(
      'هل تريد إضافة ملحق إلى الملف؟ يُحفظ بتاريخ اليوم واسمك دون تغيير النص السابق.',
      { title: 'ملحق اختياري', confirmText: 'إغلاق مع الملحق', cancelText: 'إغلاق بدون ملحق', placeholder: 'نص الملحق' },
    );
    setClosingId(inv.id);
    try {
      const payload: Record<string, unknown> = { id: inv.id, status: 'CLOSED' };
      if (addendum) payload.notes = addendum;
      const ok = await postAction('UPDATE_STATUS', payload, 'تعذر إغلاق ملف التحقيق');
      if (ok) fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally { setClosingId(null); }
  };

  const filteredInvestigations = statusFilter === 'ALL'
    ? investigations
    : investigations.filter(i => i.status === statusFilter);

  const openCount = investigations.filter(i => OPEN_STATUSES.includes(i.status)).length;
  const completedCount = investigations.filter(i => i.status === 'COMPLETED_GUILTY' || i.status === 'COMPLETED_INNOCENT').length;

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-200">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-600 p-3 rounded-2xl"><Scale size={26} /></span>
              التحقيقات الإدارية
            </h1>
            <p className="text-indigo-700 font-bold mt-3 text-[14px]">
              إدارة ملفات التحقيق مع الموظفين المحالين بسبب مخالفات جسيمة أو متكررة.
            </p>
          </div>
          <div className="flex gap-4 shrink-0">
            <div className="bg-amber-50 border border-amber-200 py-2 px-4 rounded-[1rem] text-center">
              <p className="text-amber-800 font-black text-[22px]">{openCount}</p>
              <p className="text-amber-600 text-[10px] font-extrabold uppercase">قيد التحقيق</p>
            </div>
            <div className="bg-emerald-50 border border-emerald-200 py-2 px-4 rounded-[1rem] text-center">
              <p className="text-emerald-800 font-black text-[22px]">{completedCount}</p>
              <p className="text-emerald-600 text-[10px] font-extrabold uppercase">مكتمل</p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 border border-slate-200 shadow-sm rounded-2xl md:rounded-full">
          <TabBtn active={activeTab === 'LIST'} onClick={() => setActiveTab('LIST')} label={`ملفات التحقيق (${investigations.length})`} icon={<FileText size={14} />} />
          <TabBtn active={activeTab === 'CREATE'} onClick={() => setActiveTab('CREATE')} label="فتح ملف تحقيق جديد" icon={<Plus size={14} />} />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-indigo-400 font-bold animate-pulse">جاري تحميل ملفات التحقيق...</div>
        ) : (
          <>
            {/* === LIST TAB === */}
            {activeTab === 'LIST' && (
              <div className="space-y-6">
                {/* Status Filter */}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setStatusFilter('ALL')} className={`px-4 py-2 rounded-xl text-[11px] font-black border-2 transition ${statusFilter === 'ALL' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-indigo-50'}`}>
                    الكل ({investigations.length})
                  </button>
                  {Object.entries(statusLabels).map(([key, val]) => {
                    const count = investigations.filter(i => i.status === key).length;
                    if (count === 0) return null;
                    return (
                      <button type="button" key={key} onClick={() => setStatusFilter(key)} className={`px-4 py-2 rounded-xl text-[11px] font-black border-2 transition ${statusFilter === key ? COLOR_CLASSES[val.color].filterActive : COLOR_CLASSES[val.color].filterIdle}`}>
                        {val.label} ({count})
                      </button>
                    );
                  })}
                </div>

                {loadError ? (
                  <div className="bg-white border border-rose-200 rounded-[2rem] py-16 text-center shadow-sm">
                    <p className="text-rose-600 font-bold mb-4">{loadError}</p>
                    <button type="button" onClick={fetchData} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
                  </div>
                ) : filteredInvestigations.length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-[2rem] py-20 text-center shadow-sm">
                    <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-4 text-indigo-400"><Search size={36} /></div>
                    <h3 className="font-black text-slate-700 text-lg">لا توجد تحقيقات</h3>
                    <p className="text-slate-500 font-bold text-[13px] mt-2">سجل التحقيقات فارغ حالياً.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {filteredInvestigations.map((inv) => {
                      const st = statusLabels[inv.status] || { label: inv.status, color: 'slate' as const };
                      const cc = COLOR_CLASSES[st.color];
                      return (
                        <div key={inv.id} className="bg-white rounded-[2rem] p-6 border border-slate-200 shadow-sm hover:shadow-lg hover:-translate-y-1 transition-all duration-300 flex flex-col gap-4 relative overflow-hidden">
                          <div className={`absolute top-0 left-0 right-0 h-1.5 ${cc.bar}`} />

                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest mb-2 ${cc.badge}`}>{st.label}</span>
                              <h3 className="font-extrabold text-[15px] text-slate-800">{inv.subject}</h3>
                              <p className="text-[12px] font-bold text-slate-400 mt-1 flex items-center gap-1"><User size={12} /> {inv.employee?.firstNameArabic} {inv.employee?.lastNameArabic}</p>
                            </div>
                            <div className={`p-2.5 rounded-2xl ${cc.iconBox}`}><Scale size={20} /></div>
                          </div>

                          {inv.category && (
                            <span className="text-[11px] font-black text-slate-500">{categoryLabels[inv.category] || inv.category} • خطورة: {(inv.severity && severityLabels[inv.severity]) || inv.severity}</span>
                          )}

                          {inv.isSuspended && (
                            <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-2">
                              <Pause size={14} className="text-red-500" />
                              <span className="text-[11px] font-black text-red-700">إيقاف عن العمل مسجّل في ملف التحقيق</span>
                            </div>
                          )}

                          {(hearingLine(inv.notes) || manualNoticeLine(inv.notes)) && (
                            <div className="bg-indigo-50/50 rounded-xl p-3 border border-indigo-100 flex flex-col gap-1">
                               {hearingLine(inv.notes) && (
                                 <p className="text-[11px] font-black text-indigo-800 flex items-center gap-1"><Clock size={12}/> {hearingLine(inv.notes)}</p>
                               )}
                               {manualNoticeLine(inv.notes) && (
                                 <p className="text-[10px] font-bold text-indigo-600 flex items-start gap-1"><CheckCircle size={10} className="mt-0.5 shrink-0" /> إبلاغ يدوي: {manualNoticeLine(inv.notes)}</p>
                               )}
                            </div>
                          )}

                          {inv.investigatorName && (
                            <div className="flex flex-col gap-1 mt-1">
                               <p className="text-[11px] font-bold text-slate-500"><UsersRound size={12} className="inline mr-1" /> لجنة التحقيق:</p>
                               <p className="text-[11px] font-black text-slate-700 truncate">{inv.investigatorName} - {inv.investigatorRole}</p>
                            </div>
                          )}

                          {inv.findings && (
                            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                              <p className="text-[11px] font-extrabold text-slate-500 mb-1">نتائج التحقيق:</p>
                              <p className="text-[12px] font-bold text-slate-700">{inv.findings}</p>
                            </div>
                          )}

                          <div className="flex gap-2 mt-auto">
                            {OPEN_STATUSES.includes(inv.status) && (
                              <>
                                <button type="button" onClick={() => { setSelectedInv(inv); setUpdateForm({ ...EMPTY_UPDATE, status: 'IN_PROGRESS', findings: inv.findings || '' }); }}
                                  className="flex-1 py-2.5 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 font-black text-[11px] rounded-xl transition flex items-center justify-center gap-1">
                                  <FileText size={12} /> تحديث الملف
                                </button>
                                {!inv.isSuspended && (
                                  <button type="button" onClick={() => handleSuspend(inv.id)} disabled={suspendingId === inv.id}
                                    className="px-4 py-2.5 bg-red-50 hover:bg-red-600 hover:text-white text-red-700 font-black text-[11px] rounded-xl transition flex items-center justify-center gap-1 disabled:opacity-50">
                                    <Pause size={12} /> إيقاف
                                  </button>
                                )}
                              </>
                            )}
                            {(inv.status === 'COMPLETED_GUILTY' || inv.status === 'COMPLETED_INNOCENT') && (
                              <button type="button" onClick={() => handleClose(inv)} disabled={closingId === inv.id}
                                className="flex-1 py-2.5 bg-slate-50 hover:bg-slate-700 hover:text-white text-slate-700 font-black text-[11px] rounded-xl transition flex items-center justify-center gap-1 disabled:opacity-50">
                                <X size={12} /> إغلاق الملف
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* === CREATE TAB === */}
            {activeTab === 'CREATE' && (
              <div className="bg-white border border-indigo-200 rounded-[2rem] p-8 shadow-sm">
                <h3 className="font-extrabold text-xl text-indigo-800 mb-6 flex items-center gap-3">
                  <div className="bg-indigo-100 p-2 rounded-xl"><Plus size={20} className="text-indigo-600" /></div>
                  فتح ملف تحقيق إداري جديد
                </h3>
                <form onSubmit={handleCreate} className="space-y-6">
                  <div className="relative z-50">
                    <SearchableSelect name="employeeId" value={form.employeeId} onChange={(e) => setForm({...form, employeeId: e.target.value})} label="الموظف المُحال للتحقيق" required accentColor="indigo"
                      options={employees.map(e => ({ label: `${e.firstNameArabic} ${e.lastNameArabic} - #${e.employeeId}`, value: e.id }))} />
                  </div>

                  <div>
                    <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">موضوع التحقيق</label>
                    <input type="text" required value={form.subject} onChange={e => setForm({...form, subject: e.target.value})} placeholder="مثال: اعتداء لفظي على زميل في بيئة العمل"
                      className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                  </div>

                  <div>
                    <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">الوصف التفصيلي</label>
                    <textarea rows={3} value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="أدخل تفاصيل الواقعة..."
                      className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all resize-none" />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-6 rounded-[1.5rem] border border-slate-100">
                    <div className="relative z-40">
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">تصنيف المخالفة</label>
                      <select value={form.category} onChange={e => setForm({...form, category: e.target.value})}
                        className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all appearance-none">
                        <option value="ATTENDANCE">مخالفات مواعيد</option>
                        <option value="BEHAVIORAL">مخالفات سلوكية</option>
                        <option value="SERIOUS">مخالفات جسيمة</option>
                        <option value="PERFORMANCE">مخالفات أداء</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">درجة الخطورة</label>
                      <select value={form.severity} onChange={e => setForm({...form, severity: e.target.value})}
                        className="w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all appearance-none">
                        <option value="HIGH">عالية</option>
                        <option value="CRITICAL">حرجة (فصل محتمل)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">موعد التحقيق (التاريخ)</label>
                      <input type="date" required value={form.investigationDate} onChange={e => setForm({...form, investigationDate: e.target.value})}
                        className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all" />
                    </div>
                    <div>
                        <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">وقت التحقيق</label>
                        <input type="time" required value={form.investigationTime} onChange={e => setForm({...form, investigationTime: e.target.value})}
                          className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 focus:border-indigo-400 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-50 transition-all font-sans" dir="ltr" />
                    </div>
                  </div>

                  <div className="bg-indigo-50/50 p-6 rounded-[1.5rem] border border-indigo-100">
                    <h4 className="font-extrabold text-[13px] text-indigo-900 mb-4 flex items-center gap-2"><UsersRound size={16}/> أعضاء لجنة التحقيق (3 كحد أدنى)</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <input type="text" required value={form.investigatorName} onChange={e => setForm({...form, investigatorName: e.target.value})} placeholder="العضو الأول (الرئيس)"
                          className="w-full px-4 py-3 bg-white border border-indigo-200 focus:border-indigo-500 rounded-xl font-bold text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-100" />
                      </div>
                      <div>
                        <input type="text" required value={form.investigatorRole} onChange={e => setForm({...form, investigatorRole: e.target.value})} placeholder="العضو الثاني"
                          className="w-full px-4 py-3 bg-white border border-indigo-200 focus:border-indigo-500 rounded-xl font-bold text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-100" />
                      </div>
                      <div>
                        <input type="text" required value={form.committeeMember3} onChange={e => setForm({...form, committeeMember3: e.target.value})} placeholder="العضو الثالث"
                          className="w-full px-4 py-3 bg-white border border-indigo-200 focus:border-indigo-500 rounded-xl font-bold text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-100" />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-6 p-6 bg-slate-50 border border-slate-200 rounded-[1.5rem]">
                    <div className="flex-1 flex flex-col gap-3">
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <div className="relative flex items-center justify-center mt-1">
                          <input type="checkbox" checked={form.employeeNotifiedManually} onChange={e => setForm({...form, employeeNotifiedManually: e.target.checked})} className="peer sr-only" />
                          <div className="w-5 h-5 border-2 border-slate-300 rounded peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-all flex items-center justify-center">
                            <CheckCircle size={14} className="text-white opacity-0 peer-checked:opacity-100" />
                          </div>
                        </div>
                        <div>
                          <p className="font-extrabold text-[13px] text-slate-800">تم إبلاغ الموظف يدوياً</p>
                          <p className="font-bold text-[11px] text-slate-500 mt-1 leading-relaxed">لا يرسل النظام أي إشعار للموظف. إذا أبلغته بموعد التحقيق وموضوعه خارج النظام، فحدد الطريقة والتاريخ ليُسجَّلا في ملف التحقيق.</p>
                        </div>
                      </label>
                      {form.employeeNotifiedManually && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-8">
                          <div>
                            <label htmlFor="notice-method" className="text-[11px] font-extrabold text-slate-600 mb-1 block">طريقة الإبلاغ</label>
                            <select id="notice-method" required value={form.notificationMethod} onChange={e => setForm({...form, notificationMethod: e.target.value})}
                              className="w-full px-3 py-2.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[13px] focus:outline-none">
                              <option value="">اختر الطريقة</option>
                              {NOTICE_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label htmlFor="notice-date" className="text-[11px] font-extrabold text-slate-600 mb-1 block">تاريخ الإبلاغ</label>
                            <input id="notice-date" type="date" required max={todayKey()} value={form.notificationDate} onChange={e => setForm({...form, notificationDate: e.target.value})}
                              className="w-full px-3 py-2.5 bg-white border border-slate-200 focus:border-indigo-400 rounded-xl font-bold text-[13px] focus:outline-none" />
                          </div>
                        </div>
                      )}
                    </div>

                    <label className="flex items-start gap-3 cursor-pointer group flex-1">
                      <div className="relative flex items-center justify-center mt-1">
                        <input type="checkbox" checked={form.suspendEmployee} onChange={e => setForm({...form, suspendEmployee: e.target.checked})} className="peer sr-only" />
                        <div className="w-5 h-5 border-2 border-slate-300 rounded peer-checked:bg-rose-500 peer-checked:border-rose-500 transition-all flex items-center justify-center">
                          <CheckCircle size={14} className="text-white opacity-0 peer-checked:opacity-100" />
                        </div>
                      </div>
                      <div>
                        <p className="font-extrabold text-[13px] text-rose-800">تسجيل إيقاف الموظف عن العمل خلال التحقيق</p>
                        <p className="font-bold text-[11px] text-rose-600 mt-1 leading-relaxed">يُسجَّل الإيقاف في ملف التحقيق فقط، ولا يغيّر حالة الموظف أو راتبه في النظام. ويُرفع تلقائياً عند صدور القرار أو إغلاق الملف.</p>
                      </div>
                    </label>
                  </div>

                  <div className="pt-4 border-t border-slate-100">
                    <button type="submit" disabled={isSubmitting}
                      className="w-full md:w-auto px-10 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[15px] rounded-[1.25rem] transition disabled:opacity-50 shadow-lg shadow-indigo-600/20">
                      {isSubmitting ? 'جاري فتح الملف...' : 'فتح ملف التحقيق وإحالة الموظف'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </>
        )}

        {/* Update Modal */}
        {selectedInv && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setSelectedInv(null)} />
            <div className="bg-white w-full max-w-lg rounded-[2.5rem] p-6 sm:p-8 shadow-2xl relative z-10 max-h-[85vh] overflow-y-auto">
              <button type="button" aria-label="إغلاق" onClick={() => setSelectedInv(null)} className="absolute top-6 left-6 w-10 h-10 bg-slate-50 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full flex items-center justify-center transition">
                <X size={20} />
              </button>

              <div className="mb-6">
                <h2 className="text-xl font-black text-indigo-800 mb-2">تحديث ملف التحقيق</h2>
                <p className="text-[13px] font-bold text-slate-500">{selectedInv.subject} — {selectedInv.employee?.firstNameArabic} {selectedInv.employee?.lastNameArabic}</p>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">حالة التحقيق الجديدة</label>
                  <select value={updateForm.status} onChange={e => setUpdateForm({...updateForm, status: e.target.value})}
                    className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-[14px] focus:outline-none focus:border-indigo-400 appearance-none">
                    <option value="IN_PROGRESS">جاري التحقيق</option>
                    <option value="COMPLETED_GUILTY">ثبتت الإدانة</option>
                    <option value="COMPLETED_INNOCENT">ثبتت البراءة</option>
                    <option value="CLOSED">إغلاق الملف</option>
                  </select>
                </div>

                <div>
                  <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">نتائج التحقيق{updateForm.status === 'COMPLETED_GUILTY' && <span className="text-rose-600"> (إلزامية لاعتماد الإدانة)</span>}</label>
                  <textarea rows={3} value={updateForm.findings} onChange={e => setUpdateForm({...updateForm, findings: e.target.value})} placeholder="ما توصل إليه التحقيق..."
                    className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-[13px] focus:outline-none focus:border-indigo-400 resize-none" />
                </div>

                {(updateForm.status === 'COMPLETED_GUILTY') && (
                  <>
                    <div>
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">التوصية</label>
                      <input type="text" value={updateForm.recommendation} onChange={e => setUpdateForm({...updateForm, recommendation: e.target.value})} placeholder="مثال: إنذار نهائي وخصم 5 أيام"
                        className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-[13px] focus:outline-none focus:border-indigo-400" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">أيام الخصم (5 كحد أقصى)</label>
                        <input type="number" min={0} max={PENALTY_DAYS_MAX} value={updateForm.penaltyDays} onChange={e => setUpdateForm({...updateForm, penaltyDays: e.target.value})} placeholder="0"
                          className="w-full px-5 py-3.5 bg-slate-50 border border-rose-200 rounded-2xl font-black text-[14px] text-rose-700 focus:outline-none focus:border-rose-400" dir="ltr" />
                      </div>
                      <div>
                        <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">المبلغ (ر.س)</label>
                        <input type="number" min={0} step="0.01" value={updateForm.penaltyAmount} onChange={e => setUpdateForm({...updateForm, penaltyAmount: e.target.value})} placeholder="0.00"
                          className="w-full px-5 py-3.5 bg-slate-50 border border-rose-200 rounded-2xl font-black text-[14px] text-rose-700 focus:outline-none focus:border-rose-400" dir="ltr" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">القرار النهائي</label>
                      <input type="text" value={updateForm.finalDecision} onChange={e => setUpdateForm({...updateForm, finalDecision: e.target.value})} placeholder="القرار النهائي بعد التحقيق"
                        className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-[13px] focus:outline-none focus:border-indigo-400" />
                    </div>
                  </>
                )}

                <div className="pt-4 border-t border-slate-100">
                  <button type="button" onClick={handleUpdateStatus} disabled={isUpdating}
                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[14px] rounded-[1.25rem] transition shadow-lg shadow-indigo-600/20 disabled:opacity-50">
                    {isUpdating ? 'جاري الحفظ...' : 'حفظ التحديثات على ملف التحقيق'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function TabBtn({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`px-6 py-3 rounded-[1rem] md:rounded-full text-[13px] font-black transition-all relative shrink-0 flex items-center gap-2 ${active ? 'bg-indigo-800 text-white shadow-md border border-indigo-800' : 'bg-transparent text-slate-500 hover:bg-slate-50 border-transparent hover:border-slate-200'}`}>
      {icon} {label}
    </button>
  );
}

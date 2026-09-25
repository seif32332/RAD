"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ClipboardCheck, Plus, Calendar, Users, BarChart3, CheckCircle2,
  FileText, Target, Award, Loader2, X, AlertCircle, RefreshCw,
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';

interface CycleEvaluation { id: string; status: string; totalScore?: number | null }
interface EvalCycle {
  id: string;
  title: string;
  status: string;
  cycleType: string;
  startDate: string;
  endDate: string;
  template?: { name?: string | null } | null;
  evaluations?: CycleEvaluation[];
}
interface TemplateSection { id: string; items?: { id: string }[] }
interface EvalTemplate { id: string; name: string; description?: string | null; isActive?: boolean; sections?: TemplateSection[] }
interface EmployeeLite {
  id: string;
  employeeId?: string | null;
  firstNameArabic?: string | null;
  lastNameArabic?: string | null;
  jobTitle?: string | null;
  isTerminated?: boolean | null;
}

const statusMap: Record<string, { label: string; color: string }> = {
  OPEN: { label: 'مفتوحة', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  IN_PROGRESS: { label: 'قيد التنفيذ', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  CLOSED: { label: 'مغلقة', color: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const cycleTypeMap: Record<string, string> = {
  MONTHLY: 'شهري', QUARTERLY: 'ربع سنوي', ANNUAL: 'سنوي', PROBATION: 'فترة تجربة',
};

const EMPTY_CYCLE = { title: '', templateId: '', cycleType: 'QUARTERLY', startDate: '', endDate: '', targetAll: true, targetEmployeeIds: [] as string[] };

async function getArray<T>(url: string): Promise<{ ok: true; data: T[] } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 401) {
      window.location.assign('/login');
      return { ok: false, error: 'انتهت الجلسة', status: 401 };
    }
    if (!res.ok) return { ok: false, error: await readApiError(res), status: res.status };
    const data: unknown = await res.json();
    return { ok: true, data: Array.isArray(data) ? (data as T[]) : [] };
  } catch {
    return { ok: false, error: 'تعذر الاتصال بالخادم', status: 0 };
  }
}

export default function EvaluationsPage() {
  const { role } = useRole();
  // Templates and cycles are created by HR only (the server returns 403 for other managers).
  const isHr = roleIn(role, ROLE_GROUPS.HR);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [cycles, setCycles] = useState<EvalCycle[]>([]);
  const [templates, setTemplates] = useState<EvalTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);
  const [isCreatingCycle, setIsCreatingCycle] = useState(false);

  const [newCycle, setNewCycle] = useState(EMPTY_CYCLE);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    const [cyclesRes, templatesRes, empRes] = await Promise.all([
      getArray<EvalCycle>('/api/evaluations?view=cycles'),
      getArray<EvalTemplate>('/api/evaluations?view=templates'),
      getArray<EmployeeLite>('/api/employees?fields=basic'),
    ]);
    if (cyclesRes.ok) setCycles(cyclesRes.data);
    else setLoadError(cyclesRes.error);
    if (templatesRes.ok) setTemplates(templatesRes.data);
    if (empRes.ok) setEmployees(empRes.data);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const postAction = async (body: Record<string, unknown>): Promise<boolean> => {
    const res = await fetch('/api/evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.assign('/login');
      return false;
    }
    if (!res.ok) {
      toast.error(await readApiError(res, 'تعذر تنفيذ العملية'));
      return false;
    }
    const data = (await res.json()) as { message?: string };
    toast.success(data.message || 'تمت العملية بنجاح');
    return true;
  };

  const handleCreateDefaultTemplate = async () => {
    if (isCreatingTemplate) return;
    setIsCreatingTemplate(true);
    try {
      if (await postAction({ action: 'CREATE_DEFAULT_TEMPLATE' })) await loadData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsCreatingTemplate(false);
    }
  };

  const handleCreateCycle = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isCreatingCycle) return;
    if (!newCycle.title.trim() || !newCycle.templateId || !newCycle.startDate || !newCycle.endDate) {
      toast.warning('يرجى تعبئة جميع الحقول المطلوبة');
      return;
    }
    if (newCycle.endDate < newCycle.startDate) {
      toast.warning('تاريخ نهاية الدورة يجب أن يكون بعد تاريخ البداية');
      return;
    }
    if (!newCycle.targetAll && newCycle.targetEmployeeIds.length === 0) {
      toast.warning('يرجى اختيار موظف واحد على الأقل أو تفعيل تقييم جميع الموظفين');
      return;
    }
    setIsCreatingCycle(true);
    try {
      const ok = await postAction({
        action: 'CREATE_CYCLE',
        ...newCycle,
        targetEmployeeIds: newCycle.targetAll ? [] : newCycle.targetEmployeeIds,
      });
      if (ok) {
        setShowCreateModal(false);
        setNewCycle(EMPTY_CYCLE);
        await loadData();
      }
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsCreatingCycle(false);
    }
  };

  const activeEmployees = employees.filter((e) => !e.isTerminated);
  const employeeQuery = employeeSearch.trim().toLowerCase();
  const pickableEmployees = employeeQuery
    ? activeEmployees.filter((e) =>
        `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} ${e.employeeId ?? ''} ${e.jobTitle ?? ''}`.toLowerCase().includes(employeeQuery))
    : activeEmployees;
  const toggleTarget = (id: string) =>
    setNewCycle((p) => ({
      ...p,
      targetEmployeeIds: p.targetEmployeeIds.includes(id)
        ? p.targetEmployeeIds.filter((x) => x !== id)
        : [...p.targetEmployeeIds, id],
    }));

  // Stats
  const openCycles = cycles.filter((c) => c.status === 'OPEN' || c.status === 'IN_PROGRESS').length;
  const closedCycles = cycles.filter((c) => c.status === 'CLOSED').length;
  const totalEvals = cycles.reduce((s, c) => s + (c.evaluations?.length || 0), 0);
  const completedEvals = cycles.reduce((s, c) => s + (c.evaluations?.filter((e) => e.status === 'CLOSED').length || 0), 0);

  const stats = [
    { label: 'دورات مفتوحة', value: openCycles, icon: Target, color: 'text-blue-600 bg-blue-50' },
    { label: 'دورات مغلقة', value: closedCycles, icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50' },
    { label: 'إجمالي التقييمات', value: totalEvals, icon: Users, color: 'text-violet-600 bg-violet-50' },
    { label: 'تقييمات مكتملة', value: completedEvals, icon: Award, color: 'text-amber-600 bg-amber-50' },
  ];

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-violet-100 text-violet-600 p-3 rounded-2xl"><ClipboardCheck size={26} /></span>
              إدارة التقييم
            </h1>
            <p className="text-slate-500 font-bold mt-2 text-[14px]">
              إنشاء دورات التقييم ومتابعة أداء الموظفين وإصدار التوصيات الإدارية.
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <Link href="/evaluations/reports" className="bg-indigo-100 hover:bg-indigo-200 text-indigo-700 px-5 py-3 rounded-2xl font-black text-[13px] flex items-center gap-2 transition">
              <BarChart3 size={18} /> لوحة التقارير
            </Link>
            {isHr && (
            <Link href="/evaluations/templates/new" className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-5 py-3 rounded-2xl font-black text-[13px] flex items-center gap-2 transition">
              <FileText size={18} /> نموذج مخصص
            </Link>
            )}
            {isHr && !isLoading && templates.length === 0 && (
              <button type="button" onClick={() => void handleCreateDefaultTemplate()} disabled={isCreatingTemplate} className="bg-amber-500 hover:bg-amber-600 text-white px-5 py-3 rounded-2xl font-black text-[13px] flex items-center gap-2 transition shadow-lg shadow-amber-200 disabled:opacity-50">
                {isCreatingTemplate ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />} إنشاء النموذج الافتراضي
              </button>
            )}
            {isHr && (
            <button type="button" onClick={() => setShowCreateModal(true)} disabled={templates.length === 0} className="bg-violet-600 hover:bg-violet-700 text-white px-5 py-3 rounded-2xl font-black text-[13px] flex items-center gap-2 transition shadow-lg shadow-violet-200 disabled:opacity-40">
              <Plus size={18} /> إنشاء دورة تقييم جديدة
            </button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm flex items-center gap-4">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${s.color}`}><s.icon size={22} /></div>
              <div>
                <p className="text-[11px] font-black text-slate-400 uppercase tracking-wider">{s.label}</p>
                <h3 className="text-2xl font-black text-slate-800">{isLoading ? '—' : s.value}</h3>
              </div>
            </div>
          ))}
        </div>

        {/* Templates */}
        {templates.length > 0 && (
          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <h2 className="font-black text-lg text-slate-800 mb-4 flex items-center gap-2"><FileText size={20} className="text-violet-500" /> نماذج التقييم المتاحة</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {templates.map((t) => (
                <div key={t.id} className="bg-violet-50/50 rounded-xl p-4 border border-violet-100">
                  <h3 className="font-black text-violet-800 text-[14px] mb-1">{t.name}</h3>
                  <p className="text-[11px] font-bold text-violet-500 mb-2">{t.description || 'بدون وصف'}</p>
                  <div className="flex gap-2 flex-wrap">
                    <span className="text-[10px] font-black bg-violet-100 text-violet-600 px-2 py-1 rounded-lg">{t.sections?.length || 0} محاور</span>
                    <span className="text-[10px] font-black bg-violet-100 text-violet-600 px-2 py-1 rounded-lg">{(t.sections || []).reduce((s, sec) => s + (sec.items?.length || 0), 0)} عنصر</span>
                    <span className={`text-[10px] font-black px-2 py-1 rounded-lg ${t.isActive ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>{t.isActive ? 'مفعل' : 'غير مفعل'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cycles List */}
        <div>
          <h2 className="font-black text-lg text-slate-800 mb-4 flex items-center gap-2"><Calendar size={20} className="text-violet-500" /> دورات التقييم</h2>

          {isLoading ? (
            <div className="text-center py-20 text-slate-400 font-bold animate-pulse flex items-center justify-center gap-2">
              <Loader2 size={20} className="animate-spin" /> جاري تحميل دورات التقييم...
            </div>
          ) : loadError ? (
            <div className="bg-white rounded-[2rem] border border-rose-200 p-16 text-center flex flex-col items-center gap-4 shadow-sm">
              <AlertCircle size={40} className="text-rose-400" />
              <p className="text-slate-600 font-bold">{loadError}</p>
              <button type="button" onClick={() => void loadData()} className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-5 py-2.5 rounded-xl font-black text-[13px] transition">
                <RefreshCw size={16} /> إعادة المحاولة
              </button>
            </div>
          ) : cycles.length === 0 ? (
            <div className="bg-white rounded-[2rem] border border-dashed border-slate-300 p-16 text-center flex flex-col items-center shadow-sm">
              <div className="bg-violet-50 w-20 h-20 rounded-full flex items-center justify-center mb-4 text-violet-300">
                <ClipboardCheck size={36} />
              </div>
              <h3 className="font-black text-slate-700 text-lg mb-2">لا توجد دورات تقييم بعد</h3>
              <p className="text-slate-500 font-bold text-[13px]">ابدأ بإنشاء أول دورة تقييم لمتابعة أداء الموظفين.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {cycles.map((cycle) => {
                const st = statusMap[cycle.status] || statusMap.OPEN;
                const evals = cycle.evaluations || [];
                const totalInCycle = evals.length;
                const closedInCycle = evals.filter((e) => e.status === 'CLOSED').length;
                const scored = evals.filter((e) => e.totalScore);
                const avgScore = scored.length > 0
                  ? (scored.reduce((s, e) => s + (e.totalScore || 0), 0) / scored.length).toFixed(1)
                  : '—';
                const progress = totalInCycle > 0 ? Math.round((closedInCycle / totalInCycle) * 100) : 0;

                return (
                  <Link key={cycle.id} href={`/evaluations/${cycle.id}`}
                    className="bg-white rounded-[1.5rem] p-6 border-2 border-slate-100 shadow-sm hover:shadow-lg hover:border-violet-200 transition-all group block">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-black text-slate-800 text-[16px] group-hover:text-violet-700 transition">{cycle.title}</h3>
                        <p className="text-[12px] font-bold text-slate-400 mt-1">{cycle.template?.name}</p>
                      </div>
                      <span className={`px-3 py-1 rounded-xl text-[11px] font-black border ${st.color}`}>{st.label}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="bg-slate-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] font-black text-slate-400 mb-1">النوع</p>
                        <p className="font-black text-slate-700 text-[13px]">{cycleTypeMap[cycle.cycleType] || cycle.cycleType}</p>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] font-black text-slate-400 mb-1">الموظفين</p>
                        <p className="font-black text-slate-700 text-[13px]">{totalInCycle}</p>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3 text-center">
                        <p className="text-[10px] font-black text-slate-400 mb-1">المتوسط</p>
                        <p className="font-black text-violet-600 text-[13px]">{avgScore === '—' ? '—' : `${avgScore}%`}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                        <div className="bg-violet-500 h-full rounded-full transition-all" style={{ width: `${progress}%` }}></div>
                      </div>
                      <span className="text-[11px] font-black text-slate-500">{progress}%</span>
                    </div>
                    <p className="text-[11px] font-bold text-slate-400 mt-2">
                      {formatDate(cycle.startDate)} — {formatDate(cycle.endDate)}
                    </p>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Create Cycle Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !isCreatingCycle && setShowCreateModal(false)}>
          <div role="dialog" aria-modal="true" aria-label="إنشاء دورة تقييم جديدة" className="bg-white rounded-[2rem] p-8 max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-black text-slate-800 flex items-center gap-2"><Plus size={20} className="text-violet-500" /> إنشاء دورة تقييم جديدة</h2>
              <button type="button" aria-label="إغلاق" onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600 transition"><X size={22} /></button>
            </div>

            <form onSubmit={handleCreateCycle} className="space-y-5">
              <div>
                <label htmlFor="cycle-title" className="text-[12px] font-extrabold text-slate-700 mb-2 block">عنوان الدورة <span className="text-red-500">*</span></label>
                <input id="cycle-title" type="text" required maxLength={200} value={newCycle.title} onChange={(e) => setNewCycle((p) => ({ ...p, title: e.target.value }))}
                  placeholder="مثال: تقييم الربع الأول 2026"
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 focus:bg-white rounded-xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-violet-100 transition" />
              </div>

              <div>
                <label htmlFor="cycle-template" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نموذج التقييم <span className="text-red-500">*</span></label>
                <select id="cycle-template" required value={newCycle.templateId} onChange={(e) => setNewCycle((p) => ({ ...p, templateId: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[14px] focus:outline-none transition appearance-none">
                  <option value="">— اختر نموذج —</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>

              <div>
                <label htmlFor="cycle-type" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نوع التقييم</label>
                <select id="cycle-type" value={newCycle.cycleType} onChange={(e) => setNewCycle((p) => ({ ...p, cycleType: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[14px] focus:outline-none transition appearance-none">
                  <option value="MONTHLY">شهري</option>
                  <option value="QUARTERLY">ربع سنوي</option>
                  <option value="ANNUAL">سنوي</option>
                  <option value="PROBATION">فترة تجربة</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="cycle-start" className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ البداية <span className="text-red-500">*</span></label>
                  <input id="cycle-start" type="date" required value={newCycle.startDate} onChange={(e) => setNewCycle((p) => ({ ...p, startDate: e.target.value }))}
                    className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[14px] focus:outline-none transition" />
                </div>
                <div>
                  <label htmlFor="cycle-end" className="text-[12px] font-extrabold text-slate-700 mb-2 block">تاريخ النهاية <span className="text-red-500">*</span></label>
                  <input id="cycle-end" type="date" required min={newCycle.startDate || undefined} value={newCycle.endDate} onChange={(e) => setNewCycle((p) => ({ ...p, endDate: e.target.value }))}
                    className="w-full px-4 py-3 bg-slate-50 border-2 border-transparent focus:border-violet-400 rounded-xl font-bold text-[14px] focus:outline-none transition" />
                </div>
              </div>

              <div className="bg-violet-50 rounded-xl p-4 border border-violet-100">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={newCycle.targetAll} onChange={(e) => setNewCycle((p) => ({ ...p, targetAll: e.target.checked }))}
                    className="w-5 h-5 rounded accent-violet-500" />
                  <span className="font-black text-[13px] text-violet-700">تقييم جميع الموظفين النشطين</span>
                </label>
                <p className="text-[11px] font-bold text-violet-500 mt-1 mr-8">{activeEmployees.length} موظف نشط</p>

                {!newCycle.targetAll && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <input type="search" value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} aria-label="بحث عن موظف"
                        placeholder="ابحث بالاسم أو الرقم الوظيفي..."
                        className="flex-1 px-3 py-2 bg-white border border-violet-200 rounded-lg font-bold text-[12px] focus:outline-none focus:border-violet-400" />
                      <span className="text-[11px] font-black text-violet-700 shrink-0">{newCycle.targetEmployeeIds.length} محدد</span>
                    </div>
                    <div role="group" aria-label="اختيار الموظفين المشمولين بالتقييم" className="max-h-56 overflow-y-auto bg-white rounded-lg border border-violet-100 divide-y divide-violet-50">
                      {pickableEmployees.length === 0 ? (
                        <p className="p-3 text-center text-[12px] font-bold text-slate-400">لا يوجد موظفون مطابقون</p>
                      ) : pickableEmployees.map((emp) => (
                        <label key={emp.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-violet-50/60">
                          <input type="checkbox" checked={newCycle.targetEmployeeIds.includes(emp.id)} onChange={() => toggleTarget(emp.id)} className="w-4 h-4 accent-violet-500" />
                          <span className="font-bold text-[12px] text-slate-700 flex-1 truncate">{emp.firstNameArabic} {emp.lastNameArabic}</span>
                          <span className="text-[10px] font-bold text-slate-400 shrink-0">{emp.employeeId}</span>
                        </label>
                      ))}
                    </div>
                    {newCycle.targetEmployeeIds.length > 0 && (
                      <button type="button" onClick={() => setNewCycle((p) => ({ ...p, targetEmployeeIds: [] }))} className="text-[11px] font-black text-violet-600 hover:text-violet-800">إلغاء التحديد</button>
                    )}
                  </div>
                )}
              </div>

              <button type="submit" disabled={isCreatingCycle || (!newCycle.targetAll && newCycle.targetEmployeeIds.length === 0)}
                className="w-full bg-violet-600 hover:bg-violet-700 text-white py-4 rounded-xl font-black text-[14px] flex items-center justify-center gap-2 transition shadow-lg shadow-violet-200 disabled:opacity-50">
                {isCreatingCycle ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />} {isCreatingCycle ? 'جاري الإنشاء...' : 'إنشاء الدورة وإرسال التقييمات'}
              </button>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

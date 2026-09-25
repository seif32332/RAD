"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Wallet, Clock, ShieldAlert, ArrowUpRight, Truck, CalendarDays, Gavel, Building2, GitBranch, Layers, AlertTriangle, UserPlus, Car, RefreshCw, ListChecks, CheckCircle2 } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Link from 'next/link';
import { readApiError } from '@/components/ui/feedback';
import { formatMoney } from '@/lib/money';
import { LEAVE_STATUS } from '@/lib/constants';
import { leaveTypeLabel } from '@/lib/leave';
import { alertBadgeLabel } from '@/app/api/dashboard/onboarding';
import { useRole } from '@/context/RoleContext';

interface RecentLeave {
  employeeName: string;
  department?: string;
  branch?: string;
  type?: string;
  status?: string;
  days?: number;
  date?: string;
}

interface OnboardingStepView {
  key: string;
  label: string;
  hint: string;
  href: string;
  count: number;
  done: boolean;
}

/** Shape of GET /api/dashboard. Sections sent as null are hidden for the role (team-scoped managers). */
interface DashboardData {
  /** TEAM = branch / department manager: numbers cover their own team only. */
  scope?: 'TEAM' | 'ALL';
  kpis?: {
    totalEmployees?: number;
    terminatedEmployees?: number;
    activeLeaves?: number;
    /** null when the role may not see payroll totals (the tile is hidden). */
    totalPayroll?: number | null;
    /** Reference payroll month 'YYYY-M': latest APPROVED / PAID month, never after the current month. */
    latestPayrollMonth?: string;
    /** Arabic label of that month, e.g. 'مارس 2026'. */
    latestPayrollLabel?: string;
    attendanceRate?: number;
    todayAttendance?: number;
    /** Employees expected today (active, started, not on approved leave): the rate's denominator. */
    expectedToday?: number;
    /** false when no attendance was ever recorded: the rate would be a misleading 0%. */
    hasAttendanceData?: boolean;
  };
  alerts?: {
    hrAlertCount?: number | null;
    adminAlertCount?: number | null;
    /** Admin alerts without legal contracts (those are counted under legal): what totalAlerts adds. */
    adminAlertCountExcludingLegal?: number | null;
    logisticsAlertCount?: number | null;
    legalAlertCount?: number | null;
    totalAlerts?: number;
    byLevel?: { expired?: number; critical?: number; warning?: number };
  };
  /** Records each alert screen watches; 0 = nothing on file yet (honest empty state). */
  coverage?: { employeeDocs?: number | null; companyDocs?: number | null; vehicles?: number | null; legalRecords?: number | null };
  compliance?: { activeViolations?: number; totalPendingAmount?: number } | null;
  recruitment?: { openVacancies?: number; pendingVacancies?: number; pendingApplications?: number; scheduledInterviews?: number } | null;
  legal?: { activeLawsuits?: number; activeContracts?: number } | null;
  structure?: { totalVehicles?: number; totalBranches?: number; totalCompanies?: number; totalDepartments?: number } | null;
  onboarding?: { steps: OnboardingStepView[]; completed: number; total: number; allDone: boolean } | null;
  recentLeaves?: RecentLeave[];
}

type Tone = 'emerald' | 'amber' | 'blue' | 'purple' | 'slate' | 'rose' | 'indigo';

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export default function Dashboard() {
  const router = useRouter();
  const { role, loading: roleLoading } = useRole();
  // Plain employees have no dashboard (the API answers 403): send them to their self-service portal.
  const isEmployeeOnly = role === 'EMPLOYEE';
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (res.status === 403) {
        // Not a back-office role (e.g. plain employee whose role was not known yet): self-service portal.
        router.replace('/portal');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل بيانات لوحة القيادة'));
        return;
      }
      setData((await res.json()) as DashboardData);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (roleLoading) return;
    if (isEmployeeOnly) {
      router.replace('/portal');
      return;
    }
    load();
  }, [load, roleLoading, isEmployeeOnly, router]);

  const kpis = data?.kpis || {};
  const alerts = data?.alerts || {};
  const coverage = data?.coverage || {};
  // null sections = hidden for this role (branch / department managers see their team only).
  const teamScoped = data?.scope === 'TEAM';
  // Team-scoped managers cannot open the alert screens: send them to their own workspace.
  const teamHref = teamScoped ? (role === 'DEPT_MANAGER' ? '/dept-manager' : '/manager-portal') : null;
  const compliance = data?.compliance ?? null;
  const recruitment = data?.recruitment ?? null;
  const legal = data?.legal ?? null;
  const structure = data?.structure ?? null;
  const onboarding = data?.onboarding ?? null;
  const recentLeaves = data?.recentLeaves || [];

  const totalActiveAlerts = n(alerts.totalAlerts);
  const byLevel = alerts.byLevel;
  const pendingAmount = n(compliance?.totalPendingAmount);
  const trackedRecords = n(coverage.employeeDocs) + n(coverage.companyDocs) + n(coverage.vehicles) + n(coverage.legalRecords);
  const badge = alertBadgeLabel(totalActiveAlerts, trackedRecords);

  // The API sends totalPayroll: null to roles outside payroll/finance/owner.
  const showPayroll = typeof kpis.totalPayroll === 'number';
  // Older API versions did not send the flag: assume data exists.
  const hasAttendanceData = kpis.hasAttendanceData !== false;

  let content: React.ReactNode;
  if (isLoading && !data) {
    content = (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-500 font-bold text-[14px] animate-pulse">جاري تحميل لوحة القيادة الرئيسية...</p>
        </div>
      </div>
    );
  } else if (loadError && !data) {
    content = (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center bg-white rounded-[2rem] p-10 border border-rose-100 shadow-sm max-w-md">
          <AlertTriangle size={40} className="text-rose-500 mx-auto mb-4" />
          <p className="text-slate-800 font-black text-[15px] mb-2">تعذر تحميل لوحة القيادة</p>
          <p className="text-slate-500 font-bold text-[13px] mb-6">{loadError}</p>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-[13px] transition-colors"
          >
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="max-w-[1400px] mx-auto space-y-8 pt-2">

        {teamScoped && (
          <p className="text-[12px] font-bold text-slate-500 bg-white border border-slate-200 rounded-2xl px-4 py-3">
            تعرض اللوحة أرقام فريقك فقط (الفرع أو القسم الذي تديره والموظفين التابعين لك مباشرة).
          </p>
        )}

        {onboarding && !onboarding.allDone && <OnboardingChecklist onboarding={onboarding} />}

        {/* ======================== ROW 1: PRIMARY KPIs ======================== */}
        <div className={`grid grid-cols-1 md:grid-cols-2 ${showPayroll ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-6`}>
          <KpiCard
            title={teamScoped ? 'موظفو فريقك النشطون' : 'إجمالي الموظفين النشطين'}
            value={formatMoney(n(kpis.totalEmployees))}
            note={n(kpis.totalEmployees) === 0 && n(kpis.terminatedEmployees) === 0 ? 'لم يُسجَّل موظفون بعد' : n(kpis.terminatedEmployees) > 0 ? `${formatMoney(n(kpis.terminatedEmployees))} منتهي الخدمة` : 'لا يوجد منتهي خدمة'}
            icon={<Users size={22} className="text-emerald-600"/>}
          />
          <KpiCard
            title="معدل الحضور اليوم"
            value={hasAttendanceData ? `${n(kpis.attendanceRate)}%` : '—'}
            note={hasAttendanceData
              ? (typeof kpis.expectedToday === 'number'
                ? `من ${formatMoney(kpis.expectedToday)} موظف متوقع حضوره اليوم`
                : `${formatMoney(n(kpis.todayAttendance))} سجل حضور اليوم`)
              : 'لم يُسجَّل حضور بعد'}
            icon={<Clock size={22} className="text-amber-600"/>}
          />
          {showPayroll && (
            <KpiCard
              title="صافي آخر مسير معتمد"
              value={kpis.latestPayrollMonth ? formatMoney(kpis.totalPayroll) : '—'}
              unit={kpis.latestPayrollMonth ? 'ر.س' : undefined}
              note={kpis.latestPayrollMonth ? (kpis.latestPayrollLabel || kpis.latestPayrollMonth) : 'لا يوجد مسير معتمد بعد'}
              icon={<Wallet size={22} className="text-blue-600"/>}
            />
          )}
          <KpiCard
            title="موظفين في إجازة حالياً"
            value={formatMoney(n(kpis.activeLeaves))}
            note="إجازات معتمدة سارية اليوم"
            icon={<CalendarDays size={22} className="text-purple-600"/>}
          />
        </div>

        {/* ======================== ROW 2: ALERT CENTER + STRUCTURE ======================== */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">

          {/* ALERTS COMMAND CENTER */}
          <div className="bg-white rounded-[2rem] p-6 md:p-8 border border-slate-200/60 shadow-[0_4px_24px_rgba(0,0,0,0.02)] xl:col-span-1 flex flex-col relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-red-500 to-amber-500 opacity-80" />

            <div className="flex flex-wrap items-start justify-between gap-3 mb-8">
              <div>
                <h3 className="font-extrabold text-[1.1rem] text-slate-900 flex items-center gap-2">
                  <ShieldAlert className="text-red-500" size={22} />
                  {teamScoped ? 'تنبيهات وثائق فريقك' : 'مركز التنبيهات الحي'}
                </h3>
                <p className="text-[12px] text-slate-500 font-bold mt-1.5">
                  {teamScoped ? 'إقامات وجوازات وعقود موظفي فريقك' : 'تقرير فوري من جميع الأقسام'}
                </p>
                {byLevel && totalActiveAlerts > 0 && (
                  <p className="text-[11px] font-black mt-2 flex flex-wrap gap-2">
                    <span className="text-red-600">منتهية: {n(byLevel.expired)}</span>
                    <span className="text-orange-600">حرجة (7 أيام): {n(byLevel.critical)}</span>
                    <span className="text-amber-600">قريبة الانتهاء: {n(byLevel.warning)}</span>
                  </p>
                )}
              </div>
              <span className={`text-[11px] px-3 py-1.5 rounded-[10px] font-black shadow-sm border ${badge.tone === 'alert' ? 'bg-red-50 text-red-600 border-red-100' : badge.tone === 'ok' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                {badge.label}
              </span>
            </div>

            <div className="space-y-4 flex-1">
              <AlertRow icon={<Users size={18}/>} label="تنبيهات الموارد البشرية" count={n(alerts.hrAlertCount)} href={teamHref ?? '/hr-alerts'} color="amber" desc="إقامات، جوازات، عقود، شهادات صحية" tracked={n(coverage.employeeDocs)} emptyText="لم تُسجَّل وثائق موظفين بعد" />
              {typeof alerts.adminAlertCount === 'number' && (
                <AlertRow icon={<Building2 size={18}/>} label="تنبيهات الشؤون الإدارية" count={typeof alerts.adminAlertCountExcludingLegal === 'number' ? alerts.adminAlertCountExcludingLegal : alerts.adminAlertCount} href="/admin-alerts" color="blue" desc="سجلات تجارية، رخص بلدية، دفاع مدني (العقود القانونية تُحسب ضمن القانونية)" tracked={n(coverage.companyDocs)} emptyText="لم تُسجَّل وثائق منشأة بعد" />
              )}
              {typeof alerts.logisticsAlertCount === 'number' && (
                <AlertRow icon={<Truck size={18}/>} label="تنبيهات المركبات واللوجستي" count={alerts.logisticsAlertCount} href="/logistics-alerts" color="slate" desc="استمارات، تأمين، فحص، كروت تشغيل" tracked={n(coverage.vehicles)} emptyText="لم تُسجَّل مركبات بعد" />
              )}
              {typeof alerts.legalAlertCount === 'number' && (
                <AlertRow icon={<Gavel size={18}/>} label="تنبيهات الإدارة القانونية" count={alerts.legalAlertCount} href="/legal-alerts" color="purple" desc="نزاعات قضائية، سندات، عقود ووكالات" tracked={n(coverage.legalRecords)} emptyText="لم تُسجَّل سجلات قانونية بعد" />
              )}
              {compliance && (
                <AlertRow icon={<AlertTriangle size={18}/>} label="مخالفات بانتظار السداد" count={n(compliance.activeViolations)} href="/compliance" color="rose" desc={pendingAmount > 0 ? `إجمالي: ${formatMoney(pendingAmount)} ر.س` : 'لا توجد مخالفات بانتظار السداد'} />
              )}
            </div>

            <Link href={teamHref ?? '/unified-alerts'} className="w-full mt-8 py-3.5 text-[13px] text-center text-slate-700 font-black tracking-wide bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-all rounded-[14px] border border-slate-200/80 shadow-sm group flex justify-center items-center gap-2">
              {teamHref ? 'فتح بوابة المدير' : 'فتح جميع شاشات التنبيهات'}
              <ArrowUpRight size={16} className="text-slate-400 group-hover:text-slate-800 transition-colors" />
            </Link>
          </div>

          {/* RECRUITMENT + LEGAL + STRUCTURE */}
          <div className="xl:col-span-2 space-y-6">

            {/* Sub Row: Recruitment + Legal (tenant-wide: hidden for team-scoped managers) */}
            {(recruitment || legal) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {recruitment && (
              <div className="bg-white rounded-[2rem] p-7 border border-slate-200/60 shadow-[0_4px_24px_rgba(0,0,0,0.02)] relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-500 to-fuchsia-500 opacity-80" />
                <h3 className="font-extrabold text-[15px] text-slate-900 flex items-center gap-2 mb-6"><UserPlus size={20} className="text-indigo-600"/> التوظيف والاستقطاب</h3>
                <div className="grid grid-cols-2 gap-4">
                  <MiniStat label="شواغر مفتوحة" value={n(recruitment.openVacancies)} color="indigo" />
                  <MiniStat label="طلبات معلقة" value={n(recruitment.pendingVacancies)} color="amber" />
                  <MiniStat label="سير ذاتية للفرز" value={n(recruitment.pendingApplications)} color="emerald" />
                  <MiniStat label="مقابلات مجدولة" value={n(recruitment.scheduledInterviews)} color="blue" />
                </div>
                <Link href="/recruitment" className="w-full mt-5 py-2.5 text-[12px] text-center text-indigo-700 font-black bg-indigo-50 hover:bg-indigo-100 transition-all rounded-xl border border-indigo-100 flex justify-center items-center gap-1">
                  فتح إدارة التوظيف <ArrowUpRight size={14}/>
                </Link>
              </div>
              )}

              {legal && (
              <div className="bg-white rounded-[2rem] p-7 border border-slate-200/60 shadow-[0_4px_24px_rgba(0,0,0,0.02)] relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 to-rose-500 opacity-80" />
                <h3 className="font-extrabold text-[15px] text-slate-900 flex items-center gap-2 mb-6"><Gavel size={20} className="text-amber-600"/> الإدارة القانونية</h3>
                <div className="grid grid-cols-2 gap-4">
                  <MiniStat label="دعاوى قضائية نشطة" value={n(legal.activeLawsuits)} color="rose" />
                  <MiniStat label="عقود سارية المفعول" value={n(legal.activeContracts)} color="emerald" />
                  <MiniStat label="مخالفات معلقة" value={n(compliance?.activeViolations)} color="amber" />
                  <MiniStat label="مبالغ قيد السداد" value={`${formatMoney(pendingAmount)} ر.س`} color="rose" isText />
                </div>
                <Link href="/legal/lawsuits" className="w-full mt-5 py-2.5 text-[12px] text-center text-amber-700 font-black bg-amber-50 hover:bg-amber-100 transition-all rounded-xl border border-amber-100 flex justify-center items-center gap-1">
                  فتح القسم القانوني <ArrowUpRight size={14}/>
                </Link>
              </div>
              )}
            </div>
            )}

            {/* Structure Cards Row */}
            {structure && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StructureCard label="الشركات" value={n(structure.totalCompanies)} icon={<Building2 size={20}/>} href="/companies" />
              <StructureCard label="الفروع" value={n(structure.totalBranches)} icon={<GitBranch size={20}/>} href="/branches" />
              <StructureCard label="الأقسام" value={n(structure.totalDepartments)} icon={<Layers size={20}/>} href="/departments" />
              <StructureCard label="المركبات" value={n(structure.totalVehicles)} icon={<Car size={20}/>} href="/vehicles" />
            </div>
            )}

            {/* Recent Leaves Table */}
            <div className="bg-white rounded-[2rem] border border-slate-200/60 shadow-[0_4px_24px_rgba(0,0,0,0.02)] overflow-hidden relative">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 to-indigo-500 opacity-80" />
              <div className="p-6 md:p-7 pb-5 border-b border-slate-100/80 flex flex-wrap gap-3 justify-between items-end bg-white">
                <div>
                  <h3 className="font-extrabold text-[15px] text-slate-900">{teamScoped ? 'آخر طلبات إجازة فريقك' : 'آخر طلبات الإجازة الواردة'}</h3>
                  <p className="text-[11px] text-slate-500 font-bold mt-1">أحدث الحركات المسجلة في نظام الإجازات</p>
                </div>
                <Link href="/leaves" className="text-[12px] px-4 py-2 bg-slate-50 border border-slate-200/80 text-slate-600 rounded-[12px] hover:bg-slate-100 transition-colors font-black flex items-center gap-1">
                  عرض الكل <ArrowUpRight size={14}/>
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-right whitespace-nowrap">
                  <thead className="bg-[#FAFBFD] border-b border-slate-100/80 text-slate-400">
                    <tr>
                      <th className="py-3.5 px-7 font-black text-[10px] uppercase tracking-widest">الموظف</th>
                      <th className="py-3.5 px-7 font-black text-[10px] uppercase tracking-widest">القسم / الفرع</th>
                      <th className="py-3.5 px-7 font-black text-[10px] uppercase tracking-widest">نوع الإجازة</th>
                      <th className="py-3.5 px-7 font-black text-[10px] uppercase tracking-widest">المدة</th>
                      <th className="py-3.5 px-7 font-black text-[10px] uppercase tracking-widest">الحالة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {recentLeaves.length > 0 ? recentLeaves.map((l, i) => {
                      const st = LEAVE_STATUS_STYLE[l.status || ''] || DEFAULT_LEAVE_STYLE;
                      return (
                        <tr key={`${l.employeeName}-${l.date ?? ''}-${i}`} className="hover:bg-[#FDFDFE] transition-colors">
                          <td className="py-3.5 px-7">
                            <p className="font-extrabold text-slate-900 text-[13px]">{l.employeeName}</p>
                          </td>
                          <td className="py-3.5 px-7">
                            <p className="text-slate-800 font-bold text-[12px]">{l.department || '-'}</p>
                            <p className="text-[10px] text-slate-400 font-bold">{l.branch || '-'}</p>
                          </td>
                          <td className="py-3.5 px-7">
                            <span className="text-slate-700 font-bold text-[12px]">{l.type ? leaveTypeLabel(l.type) : '-'}</span>
                          </td>
                          <td className="py-3.5 px-7">
                            <span className="text-slate-800 font-black text-[13px]">{l.days || '-'} يوم</span>
                          </td>
                          <td className="py-3.5 px-7">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-[10px] rounded-lg font-black border ${st.badge}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`}/>
                              {st.label || l.status}
                            </span>
                          </td>
                        </tr>
                      );
                    }) : (
                      <tr><td colSpan={5} className="py-10 text-center text-slate-400 font-bold text-[13px]">لا توجد طلبات إجازة مسجلة حتى الآن</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        </div>
      </div>
    );
  }

  return <DashboardLayout>{content}</DashboardLayout>;
}

/** Admin onboarding checklist (DEC-010 item 3), computed server-side from record counts. */
function OnboardingChecklist({ onboarding }: { onboarding: NonNullable<DashboardData['onboarding']> }) {
  const pct = onboarding.total > 0 ? Math.round((onboarding.completed / onboarding.total) * 100) : 0;
  return (
    <section aria-labelledby="onboarding-title" className="bg-white rounded-[2rem] p-6 md:p-8 border border-indigo-100 shadow-[0_4px_24px_rgba(0,0,0,0.02)]">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 id="onboarding-title" className="font-extrabold text-[1.1rem] text-slate-900 flex items-center gap-2">
            <ListChecks size={22} className="text-indigo-600" aria-hidden="true" /> خطوات تجهيز النظام
          </h2>
          <p className="text-[12px] text-slate-500 font-bold mt-1">تختفي هذه القائمة تلقائياً بعد اكتمال كل الخطوات.</p>
        </div>
        <span className="text-[12px] font-black text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-xl">
          {onboarding.completed} من {onboarding.total} مكتملة
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden mb-5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="نسبة اكتمال التجهيز">
        <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ol className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {onboarding.steps.map((s, i) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className={`flex items-start gap-3 p-4 rounded-2xl border transition hover:-translate-y-0.5 ${s.done ? 'bg-emerald-50/50 border-emerald-100' : 'bg-slate-50 border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/40'}`}
            >
              <span className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-black ${s.done ? 'bg-emerald-500 text-white' : 'bg-white border border-slate-300 text-slate-500'}`} aria-hidden="true">
                {s.done ? <CheckCircle2 size={16} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block font-black text-[13px] ${s.done ? 'text-emerald-800' : 'text-slate-800'}`}>
                  {s.label}
                  <span className="sr-only">{s.done ? ' (مكتملة)' : ' (غير مكتملة)'}</span>
                </span>
                <span className="block text-[11px] font-bold text-slate-500 mt-0.5">{s.done ? `مسجّل: ${s.count}` : s.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ==============================
   STATIC STYLE MAPS (Tailwind cannot see dynamic class names)
   ============================== */

const DEFAULT_LEAVE_STYLE = { badge: 'bg-slate-50 text-slate-600 border-slate-200', dot: 'bg-slate-400', label: '' };
const LEAVE_STATUS_STYLE: Record<string, { badge: string; dot: string; label: string }> = {
  [LEAVE_STATUS.APPROVED]: { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', label: 'معتمدة' },
  [LEAVE_STATUS.PENDING]: { badge: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500', label: 'معلقة' },
  [LEAVE_STATUS.REJECTED]: { badge: 'bg-slate-50 text-slate-600 border-slate-200', dot: 'bg-slate-400', label: 'مرفوضة' },
  [LEAVE_STATUS.CANCELLED]: { badge: 'bg-slate-50 text-slate-600 border-slate-200', dot: 'bg-slate-400', label: 'ملغاة' },
  [LEAVE_STATUS.COMPLETED]: { badge: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500', label: 'مكتملة' },
};

const ALERT_ROW_STYLE: Record<Tone, { box: string; icon: string; count: string }> = {
  emerald: { box: 'bg-emerald-50/50 border-emerald-200 hover:shadow-md', icon: 'text-emerald-600', count: 'text-emerald-700' },
  amber: { box: 'bg-amber-50/50 border-amber-200 hover:shadow-md', icon: 'text-amber-600', count: 'text-amber-700' },
  blue: { box: 'bg-blue-50/50 border-blue-200 hover:shadow-md', icon: 'text-blue-600', count: 'text-blue-700' },
  purple: { box: 'bg-purple-50/50 border-purple-200 hover:shadow-md', icon: 'text-purple-600', count: 'text-purple-700' },
  slate: { box: 'bg-slate-50/50 border-slate-200 hover:shadow-md', icon: 'text-slate-600', count: 'text-slate-700' },
  rose: { box: 'bg-rose-50/50 border-rose-200 hover:shadow-md', icon: 'text-rose-600', count: 'text-rose-700' },
  indigo: { box: 'bg-indigo-50/50 border-indigo-200 hover:shadow-md', icon: 'text-indigo-600', count: 'text-indigo-700' },
};

const MINI_STAT_STYLE: Record<Tone, { box: string; value: string; label: string }> = {
  emerald: { box: 'bg-emerald-50/50 border-emerald-100', value: 'text-emerald-800', label: 'text-emerald-600' },
  amber: { box: 'bg-amber-50/50 border-amber-100', value: 'text-amber-800', label: 'text-amber-600' },
  blue: { box: 'bg-blue-50/50 border-blue-100', value: 'text-blue-800', label: 'text-blue-600' },
  purple: { box: 'bg-purple-50/50 border-purple-100', value: 'text-purple-800', label: 'text-purple-600' },
  slate: { box: 'bg-slate-50/50 border-slate-100', value: 'text-slate-800', label: 'text-slate-600' },
  rose: { box: 'bg-rose-50/50 border-rose-100', value: 'text-rose-800', label: 'text-rose-600' },
  indigo: { box: 'bg-indigo-50/50 border-indigo-100', value: 'text-indigo-800', label: 'text-indigo-600' },
};

/* ==============================
   SUB-COMPONENTS
   ============================== */

interface KpiCardProps {
  title: string;
  value: string;
  /** Context of the value (not a trend: the dashboard has no history to compare with). */
  note: string;
  icon: React.ReactNode;
  /** Small unit after the value (e.g. ر.س). */
  unit?: string;
}

function KpiCard({ title, value, note, icon, unit }: KpiCardProps) {
  return (
    <div className="bg-white rounded-[2rem] p-7 border border-slate-200/60 shadow-[0_4px_24px_rgba(0,0,0,0.02)] relative overflow-hidden group hover:border-slate-300 transition-all duration-300 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
      <div className="flex justify-between items-start mb-6 relative z-10">
        <div className="w-14 h-14 rounded-2xl bg-slate-50/80 border border-slate-100/80 flex items-center justify-center transition-colors duration-300 group-hover:scale-110 group-hover:-rotate-3">
          {icon}
        </div>
        <div className="px-2.5 py-1.5 rounded-[10px] text-[11px] font-black flex items-center gap-1.5 shadow-sm border bg-slate-50 text-slate-600 border-slate-200">
           {note}
        </div>
      </div>
      <div className="relative z-10">
        <h4 className="text-[12px] text-slate-500 font-bold mb-1.5 uppercase tracking-wider">{title}</h4>
        <h2 className={`${value.length > 10 ? 'text-[1.7rem]' : 'text-[2.2rem]'} font-black text-slate-800 tracking-tight leading-none break-words`}>
          {value}
          {unit && <span className="text-[14px] font-bold text-slate-400 mr-1.5">{unit}</span>}
        </h2>
      </div>
    </div>
  );
}

interface AlertRowProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  href: string;
  color: Tone;
  desc: string;
  /** Records this alert source watches; with none on file the row says so instead of "0". */
  tracked?: number;
  emptyText?: string;
}

function AlertRow({ icon, label, count, href, color, desc, tracked, emptyText }: AlertRowProps) {
  const isActive = count > 0;
  const nothingTracked = !isActive && tracked === 0 && !!emptyText;
  const style = ALERT_ROW_STYLE[color];
  return (
    <Link href={href} className={`block p-4 rounded-2xl border transition-all hover:-translate-y-0.5 ${isActive ? style.box : 'bg-slate-50/50 border-slate-100 hover:bg-slate-100'}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2.5">
          <div className={isActive ? style.icon : 'text-slate-400'}>{icon}</div>
          <p className="font-black text-[13px] text-slate-800">{label}</p>
        </div>
        <span className={`font-black text-[16px] ${isActive ? style.count : 'text-slate-400'}`}>{nothingTracked ? '—' : count}</span>
      </div>
      <p className="text-[10px] font-bold text-slate-500 mr-7">{nothingTracked ? emptyText : desc}</p>
    </Link>
  );
}

interface MiniStatProps {
  label: string;
  value: number | string;
  color: Tone;
  isText?: boolean;
}

function MiniStat({ label, value, color, isText = false }: MiniStatProps) {
  const style = MINI_STAT_STYLE[color];
  return (
    <div className={`border rounded-xl p-3.5 text-center ${style.box}`}>
      <p className={`font-black ${isText ? 'text-[14px]' : 'text-[22px]'} ${style.value} tracking-tight`}>{value ?? 0}</p>
      <p className={`text-[10px] font-bold ${style.label} mt-0.5`}>{label}</p>
    </div>
  );
}

interface StructureCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  href: string;
}

function StructureCard({ label, value, icon, href }: StructureCardProps) {
  return (
    <Link href={href} className="bg-white rounded-2xl p-5 border border-slate-200/60 shadow-sm hover:shadow-md hover:-translate-y-1 transition-all text-center group">
      <div className="text-slate-400 group-hover:text-indigo-500 transition-colors mx-auto w-fit mb-2">{icon}</div>
      <p className="font-black text-[22px] text-slate-800">{value ?? 0}</p>
      <p className="text-[11px] font-bold text-slate-500 mt-0.5">{label}</p>
    </Link>
  );
}

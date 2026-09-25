"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  BellRing, ShieldAlert, FileWarning, Plane, FileText, Activity, CheckCircle,
  HeartPulse, DollarSign, Target, Filter, Users, Building2, Scale, Truck, AlertCircle, AlertTriangle, RefreshCw, Layers
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';

/** Roles each alert endpoint accepts (mirrors the routes' requireUser); skipped otherwise. */
const SOURCE_ROLES: Record<string, readonly string[]> = {
  '/api/hr/alerts': [...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV],
  '/api/admin/alerts': [...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.GOV],
  '/api/logistics/alerts': ROLE_GROUPS.LOGISTICS,
  '/api/legal/alerts': ROLE_GROUPS.LEGAL,
};

type Department = 'HR' | 'ADMIN' | 'FINANCE' | 'LOGISTICS' | 'LEGAL';
type Tab = Department | 'ALL';

/** Raw row as returned by any of the alert endpoints (HR / admin / logistics / legal). */
interface RawAlert {
  id: string;
  type: string;
  level?: string;
  daysLeft?: number;
  dueDate: string;
  message: string;
  employee?: string;
  employeeId?: string;
  source?: string;
  category?: string;
}

interface UnifiedAlert {
  id: string;
  dept: Department;
  /** Person / entity the alert is about. */
  title: string;
  /** File / reference number (employees, policies); empty for entities. */
  reference: string;
  type: string;
  level?: string;
  /** Server-computed days until the due date (Riyadh day; 0 = today). null = informational. */
  daysLeft: number | null;
  dueDate: string;
  message: string;
}

/** Department of an alert served by /api/hr/alerts. */
function hrDepartment(type: string): Department {
  if (type.includes('MEDICAL')) return 'ADMIN';
  if (type.includes('SETTLEMENT')) return 'FINANCE';
  return 'HR';
}

// Document group (filter + card label), per department so that e.g. legal contracts are not
// mixed with employment contracts.
function getDocGroup(a: Pick<UnifiedAlert, 'dept' | 'type'>): string {
  const t = a.type;
  switch (a.dept) {
    case 'HR':
      if (t.includes('IQAMA')) return 'الإقامات والهويات';
      if (t.includes('CONTRACT')) return 'عقود العمل';
      if (t.includes('PASSPORT')) return 'جوازات السفر';
      if (t.includes('HEALTH_CERT')) return 'الشهادات الصحية';
      if (t.includes('PROBATION')) return 'فترة التجربة';
      if (t.includes('INCOMING')) return 'الطلبات الواردة';
      if (t.includes('EVAL')) return 'التقييمات';
      return 'أخرى';
    case 'ADMIN':
      if (t.includes('MEDICAL')) return 'التأمين الطبي';
      if (t.startsWith('CR')) return 'السجلات التجارية';
      if (t.includes('TRADEMARK')) return 'العلامات التجارية';
      if (t.includes('MUN_LICENSE')) return 'رخص البلدية';
      if (t.includes('CIVIL_DEFENSE')) return 'الدفاع المدني';
      if (t.includes('LEASE')) return 'عقود الإيجار';
      return 'أخرى';
    case 'FINANCE':
      return 'مستحقات وتصفيات';
    case 'LOGISTICS':
      if (t.includes('CLAIM')) return 'مطالبات الحوادث';
      return 'المركبات والأسطول';
    case 'LEGAL':
      if (t.includes('NOTE')) return 'السندات لأمر';
      if (t.includes('AGENCY')) return 'الوكالات';
      if (t.includes('LAWSUIT')) return 'المنازعات القضائية';
      return 'العقود القانونية';
  }
}

function getDocIcon(docGroup: string) {
  switch (docGroup) {
    case 'الإقامات والهويات': return <ShieldAlert size={20} />;
    case 'عقود العمل': return <FileText size={20} />;
    case 'جوازات السفر': return <Plane size={20} />;
    case 'الشهادات الصحية': return <Activity size={20} />;
    case 'التأمين الطبي': return <HeartPulse size={20} />;
    case 'مستحقات وتصفيات': return <DollarSign size={20} />;
    case 'فترة التجربة': return <Target size={20} />;
    case 'الطلبات الواردة': return <BellRing size={20} />;
    case 'التقييمات': return <Target size={20} />;
    case 'المركبات والأسطول':
    case 'مطالبات الحوادث': return <Truck size={20} />;
    case 'السجلات التجارية':
    case 'العلامات التجارية':
    case 'رخص البلدية':
    case 'الدفاع المدني':
    case 'عقود الإيجار': return <Building2 size={20} />;
    case 'السندات لأمر':
    case 'الوكالات':
    case 'المنازعات القضائية':
    case 'العقود القانونية': return <Scale size={20} />;
    default: return <FileWarning size={20} />;
  }
}

/**
 * "Waiting for an action" items are not document-expiry risks: request / evaluation summaries,
 * pending settlements and open lawsuits (no due date), and open accident claims (counted in days
 * open, not days to an expiry). They get their own counter instead of inflating the risk count.
 */
const isPendingAction = (a: UnifiedAlert) => a.daysLeft === null || a.type.startsWith('CLAIM');

/** Uses the server's level first (0 days = expires today = not expired yet). */
const isExpired = (a: UnifiedAlert) =>
  !isPendingAction(a) &&
  (a.level ? a.level === 'expired' : a.type.includes('EXPIRED') || (a.daysLeft !== null && a.daysLeft < 0));

function normalize(rows: RawAlert[], dept: (a: RawAlert) => Department): UnifiedAlert[] {
  return rows.map((a) => ({
    id: `${dept(a)}:${a.id}`,
    dept: dept(a),
    title: a.employee || a.source || '',
    reference: a.employeeId && a.employeeId !== '*' ? a.employeeId : '',
    type: a.type,
    level: a.level,
    // Request summaries (employeeId '*') and pending settlements are not date-based.
    daysLeft: typeof a.daysLeft === 'number' && a.employeeId !== '*' && a.type !== 'SETTLEMENT_PENDING' ? a.daysLeft : null,
    dueDate: a.dueDate,
    message: a.message,
  }));
}

type SourceResult = { ok: true; alerts: RawAlert[] } | { ok: false; status: number; message: string };

async function loadSource(url: string, role: string | null): Promise<SourceResult> {
  if (role && !roleIn(role, SOURCE_ROLES[url] ?? [])) return { ok: false, status: 403, message: '' };
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return { ok: false, status: res.status, message: await readApiError(res, 'تعذر تحميل التنبيهات') };
  const data = (await res.json()) as { alerts?: unknown };
  return { ok: true, alerts: Array.isArray(data.alerts) ? (data.alerts as RawAlert[]) : [] };
}

export default function UnifiedAlertsPage() {
  const router = useRouter();
  const { role, loading: roleLoading } = useRole();
  const [alerts, setAlerts] = useState<UnifiedAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A section failed for a reason other than "not allowed" (shown above the results). */
  const [partialError, setPartialError] = useState<string | null>(null);

  // Filters
  const [activeTab, setActiveTab] = useState<Tab>('ALL');
  const [selectedDocFilter, setSelectedDocFilter] = useState('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState('ALL');

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setPartialError(null);
    try {
      // Each department is served by its own endpoint; a 403 only means the current role does
      // not see that department, so it is skipped silently.
      const [hr, admin, logistics, legal] = await Promise.all([
        loadSource('/api/hr/alerts', role),
        loadSource('/api/admin/alerts', role),
        loadSource('/api/logistics/alerts', role),
        loadSource('/api/legal/alerts', role),
      ]);
      const results = [hr, admin, logistics, legal];
      if (results.some((r) => !r.ok && r.status === 401)) {
        router.replace('/login');
        return;
      }
      const hardError = results.find((r): r is Extract<SourceResult, { ok: false }> => !r.ok && r.status !== 403);
      if (results.every((r) => !r.ok)) {
        setLoadError(hardError?.message || 'ليس لديك صلاحية لعرض أي من التنبيهات');
        return;
      }
      if (hardError) setPartialError(`تعذر تحميل بعض الأقسام: ${hardError.message}`);

      const next: UnifiedAlert[] = [];
      if (hr.ok) next.push(...normalize(hr.alerts, (a) => hrDepartment(a.type)));
      if (admin.ok) {
        // Legal contracts are also listed by the legal endpoint: keep the admin copy only when
        // the legal endpoint is not available to this role.
        const rows = legal.ok ? admin.alerts.filter((a) => a.category !== 'LEGAL') : admin.alerts;
        next.push(...normalize(rows, (a) => (a.category === 'LEGAL' ? 'LEGAL' : 'ADMIN')));
      }
      if (logistics.ok) next.push(...normalize(logistics.alerts, () => 'LOGISTICS'));
      if (legal.ok) next.push(...normalize(legal.alerts, () => 'LEGAL'));
      next.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
      setAlerts(next);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router, role]);

  useEffect(() => {
    if (!roleLoading) fetchData();
  }, [fetchData, roleLoading]);

  // Tab change resets sub-filters
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSelectedDocFilter('ALL');
    setSelectedStatusFilter('ALL');
  };

  const inTab = useCallback((a: UnifiedAlert) => activeTab === 'ALL' || a.dept === activeTab, [activeTab]);

  // --- Master Filter Logic ---
  const filteredAlerts = useMemo(() => alerts.filter(a => {
    if (!inTab(a)) return false;
    if (selectedDocFilter !== 'ALL' && getDocGroup(a) !== selectedDocFilter) return false;
    if (selectedStatusFilter === 'EXPIRED' && !isExpired(a)) return false;
    if (selectedStatusFilter === 'WARNING' && (isExpired(a) || isPendingAction(a))) return false;
    if (selectedStatusFilter === 'PENDING' && !isPendingAction(a)) return false;
    return true;
  }), [alerts, inTab, selectedDocFilter, selectedStatusFilter]);

  // Available doc types (with counts) for the current tab
  const docOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of alerts) {
      if (!inTab(a)) continue;
      const g = getDocGroup(a);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([doc, count]) => ({ label: `${doc} (${count})`, value: doc }));
  }, [alerts, inTab]);

  // Stats
  const deptCounts = useMemo(() => {
    const counts: Record<Department, number> = { HR: 0, ADMIN: 0, FINANCE: 0, LOGISTICS: 0, LEGAL: 0 };
    for (const a of alerts) counts[a.dept]++;
    return counts;
  }, [alerts]);

  // Two separate counters for the current tab: document-expiry risks vs items waiting for action.
  const tabAlerts = alerts.filter(inTab);
  const pendingCount = tabAlerts.filter(isPendingAction).length;
  const riskAlerts = tabAlerts.filter((a) => !isPendingAction(a));
  const expiredCount = riskAlerts.filter(isExpired).length;
  const nearCount = riskAlerts.length - expiredCount;

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 mb-20 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10">
          <div>
            <h1 className="text-3xl font-black text-rose-900 tracking-tight flex items-center gap-3">
              <span className="bg-rose-100 text-rose-700 p-3 rounded-2xl relative">
                <BellRing size={26} />
                {alerts.length > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4 w-4">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-4 w-4 bg-rose-500 border-2 border-white"></span>
                  </span>
                )}
              </span>
              شاشة التنبيهات المجمعة
            </h1>
            <p className="text-rose-700 font-bold mt-2 mr-16 text-[14px] leading-relaxed">
              شاشة مراقبة استباقية تجمع تنبيهات جميع الأقسام: وثائق الموظفين، السجلات والرخص، المركبات، والسندات والعقود القانونية لضمان التجديد والامتثال.
            </p>
          </div>
          <div className="flex flex-wrap gap-4 shrink-0">
            <div className="bg-rose-50 border border-rose-200 py-2 px-4 rounded-[1rem] text-center min-w-[9rem]">
              <p className="text-rose-800 font-black text-[22px]">{riskAlerts.length}</p>
              <p className="text-rose-700 text-[11px] font-extrabold">مخاطر انتهاء الوثائق</p>
              <p className="text-[10px] font-bold text-slate-500 mt-0.5">منتهية {expiredCount} · قريبة الانتهاء {nearCount}</p>
            </div>
            <div className="bg-sky-50 border border-sky-200 py-2 px-4 rounded-[1rem] text-center min-w-[9rem]">
              <p className="text-sky-800 font-black text-[22px]">{pendingCount}</p>
              <p className="text-sky-700 text-[11px] font-extrabold">بانتظار إجراء</p>
              <p className="text-[10px] font-bold text-slate-500 mt-0.5">طلبات وتصفيات ومطالبات وقضايا</p>
            </div>
          </div>
        </div>

        {/* Department Tabs */}
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide" role="tablist" aria-label="الأقسام">
          <TabButton active={activeTab === 'ALL'} onClick={() => handleTabChange('ALL')} icon={<Layers size={16} />} label={`الكل (${alerts.length})`} />
          <TabButton active={activeTab === 'HR'} onClick={() => handleTabChange('HR')} icon={<Users size={16} />} label={`الموارد البشرية (${deptCounts.HR})`} />
          <TabButton active={activeTab === 'ADMIN'} onClick={() => handleTabChange('ADMIN')} icon={<Building2 size={16} />} label={`الشؤون الإدارية (${deptCounts.ADMIN})`} />
          <TabButton active={activeTab === 'FINANCE'} onClick={() => handleTabChange('FINANCE')} icon={<DollarSign size={16} />} label={`المالية (${deptCounts.FINANCE})`} />
          <TabButton active={activeTab === 'LOGISTICS'} onClick={() => handleTabChange('LOGISTICS')} icon={<Truck size={16} />} label={`اللوجستية (${deptCounts.LOGISTICS})`} />
          <TabButton active={activeTab === 'LEGAL'} onClick={() => handleTabChange('LEGAL')} icon={<Scale size={16} />} label={`القانونية (${deptCounts.LEGAL})`} />
        </div>

        {/* Filters Row */}
        <div className="bg-white border border-slate-100 p-5 rounded-[1.5rem] shadow-sm flex flex-col md:flex-row items-center gap-6 relative z-10 w-full mt-2">

          {/* Document Type Filter */}
          <div className="flex items-center gap-4 w-full md:w-auto flex-1 opacity-90 hover:opacity-100 transition relative z-50">
            <div className="w-12 h-12 bg-indigo-50 border border-indigo-100 text-indigo-500 rounded-[1rem] items-center justify-center shrink-0 hidden md:flex">
              <FileText size={20} />
            </div>
            <div className="flex-1 w-full relative z-50">
              <SearchableSelect
                name="docFilter"
                value={selectedDocFilter}
                onChange={(e) => setSelectedDocFilter(e.target.value)}
                label="تصفية حسب نوع الوثيقة"
                options={[{ label: '📄 جميع الوثائق المتاحة في القسم', value: 'ALL' }, ...docOptions]}
                accentColor="indigo"
              />
            </div>
          </div>

          <div className="w-full md:w-px h-px md:h-16 bg-slate-100 hidden md:block"></div>

          {/* Status Filter */}
          <div className="flex items-center gap-4 w-full md:w-auto flex-1 opacity-90 hover:opacity-100 transition relative z-40">
            <div className="w-12 h-12 bg-rose-50 border border-rose-100 text-rose-500 rounded-[1rem] items-center justify-center shrink-0 hidden md:flex">
              <AlertCircle size={20} />
            </div>
            <div className="flex-1 w-full relative z-40">
              <SearchableSelect
                name="statusFilter"
                value={selectedStatusFilter}
                onChange={(e) => setSelectedStatusFilter(e.target.value)}
                label="تصفية حسب الحالة"
                options={[
                  { label: '⭕ جميع الحالات', value: 'ALL' },
                  { label: '🔴 منتهي فعلياً', value: 'EXPIRED' },
                  { label: '🟡 على وشك الانتهاء (إنذار مبكر)', value: 'WARNING' },
                  { label: '🔵 بانتظار إجراء (ليست وثيقة تنتهي)', value: 'PENDING' },
                ]}
                accentColor="rose"
              />
            </div>
          </div>
        </div>

        {partialError && !isLoading && !loadError && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl px-5 py-3 font-bold text-[13px] flex items-center gap-2">
            <AlertTriangle size={16} /> {partialError}
          </div>
        )}

        {/* Content */}
        {isLoading ? (
          <div className="py-20 flex flex-col justify-center items-center">
            <div className="w-10 h-10 border-4 border-rose-200 border-t-rose-600 rounded-full animate-spin"></div>
            <div className="text-rose-900 mt-4 font-black">جاري جلب التنبيهات...</div>
          </div>
        ) : loadError ? (
          <div className="bg-white border border-rose-100 rounded-[2.5rem] py-20 flex flex-col items-center justify-center text-center shadow-sm">
            <AlertTriangle size={40} className="text-rose-400 mb-4" />
            <h3 className="text-xl font-black text-slate-800 mb-2">تعذر تحميل التنبيهات</h3>
            <p className="text-slate-500 font-bold max-w-sm px-4 mb-6">{loadError}</p>
            <button type="button" onClick={fetchData} className="inline-flex items-center gap-2 px-6 py-3 bg-rose-600 text-white rounded-xl font-bold text-[13px] hover:bg-rose-700 transition">
              <RefreshCw size={16} /> إعادة المحاولة
            </button>
          </div>
        ) : alerts.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] py-24 flex flex-col items-center justify-center text-center shadow-sm">
            <div className="w-24 h-24 bg-emerald-50 rounded-full flex items-center justify-center mb-6 text-emerald-500">
              <CheckCircle size={40} />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">لا توجد تنبيهات حالياً</h3>
            <p className="text-slate-500 font-bold max-w-sm px-4">لا توجد وثائق منتهية أو قريبة الانتهاء ولا طلبات بانتظار إجراء في الأقسام المتاحة لك.</p>
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] py-24 flex flex-col items-center justify-center text-center shadow-sm">
            <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mb-6 text-slate-400">
              <Filter size={40} />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">لا توجد نتائج مطابقة</h3>
            <p className="text-slate-500 font-bold max-w-sm px-4 mb-4">لا توجد تنبيهات تطابق الفلاتر المحددة.</p>
            <button type="button" onClick={() => handleTabChange('ALL')} className="px-6 py-3 bg-rose-600 text-white rounded-xl font-bold text-[13px] hover:bg-rose-700 transition shadow-lg shadow-rose-500/20">
              مسح الفلاتر وعرض الكل
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAlerts.map((alert) => {
              const pending = isPendingAction(alert);
              const expired = isExpired(alert);
              const docGroup = getDocGroup(alert);
              const tone = pending
                ? { bar: 'bg-sky-400', chip: 'bg-sky-50 text-sky-700', box: 'bg-sky-50/50 border-sky-100', text: 'text-sky-800', num: 'text-sky-600' }
                : expired
                  ? { bar: 'bg-red-500', chip: 'bg-red-50 text-red-600', box: 'bg-red-50/50 border-red-100', text: 'text-red-700', num: 'text-red-500' }
                  : { bar: 'bg-amber-400', chip: 'bg-amber-50 text-amber-600', box: 'bg-amber-50/50 border-amber-100', text: 'text-amber-700', num: 'text-amber-500' };

              return (
                <div key={alert.id} className="bg-white rounded-[2rem] p-6 border border-slate-200 shadow-[0_4px_24px_rgba(0,0,0,0.03)] hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col gap-5 relative overflow-hidden group">
                  {/* Status Indicator Bar */}
                  <div className={`absolute top-0 left-0 right-0 h-1.5 ${tone.bar}`} />

                  <div className="flex justify-between items-start gap-3 w-full">
                    <div className="flex-1">
                      <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest mb-3 ${tone.chip}`}>
                        {docGroup}{pending ? ' · بانتظار إجراء' : expired ? ' · منتهية' : ' · قريبة الانتهاء'}
                      </span>
                      <h3 className="font-extrabold text-[15px] text-slate-800 leading-snug">{alert.title}</h3>
                      {alert.reference && <p className="text-[12px] font-bold text-slate-400 mt-1">رقم الملف: {alert.reference}</p>}
                    </div>

                    <div className="text-left flex flex-col items-end shrink-0">
                      <div className={`p-2.5 rounded-2xl ${tone.chip}`}>
                        {getDocIcon(docGroup)}
                      </div>
                    </div>
                  </div>

                  {/* Alert Message */}
                  <div className={`rounded-[1.25rem] p-4 border ${tone.box}`}>
                    <p className={`font-bold text-[13px] leading-relaxed ${tone.text}`}>
                      {alert.message}
                    </p>
                  </div>

                  {/* Date Info */}
                  <div className="bg-slate-50 border border-slate-100 rounded-[1.25rem] p-4 flex items-center justify-between">
                    <div>
                      <div className="text-[11px] font-extrabold text-slate-400 mb-1 leading-none">
                        {alert.daysLeft === null ? 'الحالة' : pending ? 'مفتوحة منذ' : alert.daysLeft < 0 ? 'انتهت منذ' : alert.daysLeft === 0 ? 'تنتهي' : 'تنتهي بعد'}
                      </div>
                      <div className={`font-black text-[16px] ${tone.num}`}>
                        {alert.daysLeft === null ? 'قائم' : alert.daysLeft === 0 ? 'اليوم' : `${Math.abs(alert.daysLeft)} يوم`}
                      </div>
                    </div>
                    <div className="text-left">
                      <div className="text-[11px] font-extrabold text-slate-400 mb-1 leading-none">{pending ? 'التاريخ' : 'الموعد النهائي'}</div>
                      <div className="font-bold text-[13px] text-slate-700" dir="ltr">
                        {formatDateShort(alert.dueDate)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`whitespace-nowrap flex items-center gap-2 px-5 py-3 rounded-2xl text-[13px] font-extrabold transition-all ${active ? 'bg-rose-600 text-white shadow-md shadow-rose-200' : 'bg-white text-slate-500 border border-slate-200 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-600'}`}>
      {icon} {label}
    </button>
  );
}

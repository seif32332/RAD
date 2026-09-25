"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  BellRing, ShieldAlert, FileWarning, Plane, FileText, Activity, CheckCircle,
  Target, Filter, AlertCircle, AlertTriangle, RefreshCw
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import SearchableSelect from '@/components/SearchableSelect';
import { readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface HrAlertRow {
  id: string;
  employee: string;
  employeeId: string;
  type: string;
  level?: string;
  daysLeft: number;
  dueDate: string;
  message: string;
}

const HR_TYPES = ['IQAMA', 'PASSPORT', 'HEALTH_CERT', 'CONTRACT', 'PROBATION'];
const isHrAlert = (type: string) => HR_TYPES.some((t) => type.includes(t));

// Get document group key from alert type
function getDocGroup(type: string): string {
  if (type.includes('IQAMA')) return 'الإقامات والهويات';
  if (type.includes('CONTRACT')) return 'عقود العمل';
  if (type.includes('PASSPORT')) return 'جوازات السفر';
  if (type.includes('HEALTH_CERT')) return 'الشهادات الصحية';
  if (type.includes('PROBATION')) return 'فترة التجربة';
  return 'أخرى';
}

function getDocIcon(docGroup: string) {
  switch (docGroup) {
    case 'الإقامات والهويات': return <ShieldAlert size={20} />;
    case 'عقود العمل': return <FileText size={20} />;
    case 'جوازات السفر': return <Plane size={20} />;
    case 'الشهادات الصحية': return <Activity size={20} />;
    case 'فترة التجربة': return <Target size={20} />;
    default: return <FileWarning size={20} />;
  }
}

const isExpired = (a: HrAlertRow) => a.type.includes('EXPIRED') || a.level === 'expired' || a.daysLeft < 0;

export default function HRAlertsPage() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<HrAlertRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [selectedDocFilter, setSelectedDocFilter] = useState('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState('ALL');

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/hr/alerts', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل التنبيهات'));
        return;
      }
      const data = (await res.json()) as { alerts?: unknown };
      const list = Array.isArray(data.alerts) ? (data.alerts as HrAlertRow[]) : [];
      setAlerts(list.filter((a) => isHrAlert(a.type)));
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const clearFilters = () => {
    setSelectedDocFilter('ALL');
    setSelectedStatusFilter('ALL');
  };

  // --- Master Filter Logic ---
  const filteredAlerts = useMemo(() => alerts.filter(a => {
    if (selectedDocFilter !== 'ALL' && getDocGroup(a.type) !== selectedDocFilter) return false;
    if (selectedStatusFilter === 'EXPIRED' && !isExpired(a)) return false;
    if (selectedStatusFilter === 'WARNING' && isExpired(a)) return false;
    return true;
  }), [alerts, selectedDocFilter, selectedStatusFilter]);

  const docOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of alerts) {
      const g = getDocGroup(a.type);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([doc, count]) => ({ label: `${doc} (${count})`, value: doc }));
  }, [alerts]);

  // Stats
  const criticalCount = alerts.filter(isExpired).length;
  const warningCount = alerts.length - criticalCount;

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
              تنبيهات الموارد البشرية
            </h1>
            <p className="text-rose-700 font-bold mt-2 mr-16 text-[14px] leading-relaxed">
              مراقبة استباقية لملفات الموظفين: الإقامات، العقود، الشهادات الصحية، جوازات السفر، وفترة التجربة.
            </p>
          </div>
          <div className="flex gap-4 shrink-0">
            <div className="bg-rose-50 border border-rose-200 py-2 px-4 rounded-[1rem] text-center">
              <p className="text-rose-800 font-black text-[22px]">{criticalCount}</p>
              <p className="text-rose-600 text-[10px] font-extrabold uppercase">منتهي</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 py-2 px-4 rounded-[1rem] text-center">
              <p className="text-amber-800 font-black text-[22px]">{warningCount}</p>
              <p className="text-amber-600 text-[10px] font-extrabold uppercase">على وشك</p>
            </div>
          </div>
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
                ]}
                accentColor="rose"
              />
            </div>
          </div>
        </div>

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
            <h3 className="text-xl font-black text-slate-800 mb-2">النظام آمن ومستقر 100%</h3>
            <p className="text-slate-500 font-bold max-w-sm px-4">لا توجد أي ملفات للموظفين قاربت على الانتهاء أو انتهت.</p>
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] py-24 flex flex-col items-center justify-center text-center shadow-sm">
            <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mb-6 text-slate-400">
              <Filter size={40} />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">لا توجد نتائج مطابقة</h3>
            <p className="text-slate-500 font-bold max-w-sm px-4 mb-4">لا توجد تنبيهات تطابق الفلاتر المحددة.</p>
            <button type="button" onClick={clearFilters} className="px-6 py-3 bg-rose-600 text-white rounded-xl font-bold text-[13px] hover:bg-rose-700 transition shadow-lg shadow-rose-500/20">
              مسح الفلاتر وعرض الكل
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAlerts.map((alert) => {
              const expired = isExpired(alert);
              const docGroup = getDocGroup(alert.type);

              return (
                <div key={alert.id} className="bg-white rounded-[2rem] p-6 border border-slate-200 shadow-[0_4px_24px_rgba(0,0,0,0.03)] hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col gap-5 relative overflow-hidden group">
                  {/* Status Indicator Bar */}
                  <div className={`absolute top-0 left-0 right-0 h-1.5 ${expired ? 'bg-red-500' : 'bg-amber-400'}`} />

                  <div className="flex justify-between items-start gap-3 w-full">
                    <div className="flex-1">
                      <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest mb-3 ${expired ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                        {docGroup}
                      </span>
                      <h3 className="font-extrabold text-[15px] text-slate-800 leading-snug">{alert.employee}</h3>
                      <p className="text-[12px] font-bold text-slate-400 mt-1">رقم الملف: {alert.employeeId}</p>
                    </div>

                    <div className="text-left flex flex-col items-end shrink-0">
                      <div className={`p-2.5 rounded-2xl ${expired ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-500'}`}>
                        {getDocIcon(docGroup)}
                      </div>
                    </div>
                  </div>

                  {/* Alert Message */}
                  <div className={`rounded-[1.25rem] p-4 border ${expired ? 'bg-red-50/50 border-red-100' : 'bg-amber-50/50 border-amber-100'}`}>
                    <p className={`font-bold text-[13px] leading-relaxed ${expired ? 'text-red-700' : 'text-amber-700'}`}>
                      {alert.message}
                    </p>
                  </div>

                  {/* Date Info */}
                  <div className="bg-slate-50 border border-slate-100 rounded-[1.25rem] p-4 flex items-center justify-between">
                    <div>
                      <div className="text-[11px] font-extrabold text-slate-400 mb-1 leading-none">{expired ? 'انتهت منذ' : alert.level && alert.daysLeft === 0 ? 'تنتهي' : 'تنتهي بعد'}</div>
                      <div className={`font-black text-[16px] ${expired ? 'text-red-500' : 'text-amber-500'}`}>
                        {!expired && alert.level && alert.daysLeft === 0 ? 'اليوم' : `${Math.abs(alert.daysLeft)} يوم`}
                      </div>
                    </div>
                    <div className="text-left">
                      <div className="text-[11px] font-extrabold text-slate-400 mb-1 leading-none">الموعد النهائي</div>
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

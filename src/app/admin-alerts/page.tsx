"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert, CheckCircle, Landmark, Store, Flame, BadgeCent, Home, ChevronDown, ChevronUp, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface AdminAlert {
  id: string;
  type: string;
  level?: string;
  category?: string;
  source?: string;
  message: string;
  dueDate: string;
  daysLeft?: number;
}

type CategoryKey = 'CR' | 'MUN_LICENSE' | 'CIVIL_DEFENSE' | 'TRADEMARK' | 'LEASE';
type Tone = 'indigo' | 'amber' | 'rose' | 'blue' | 'emerald';

const CATEGORIES: { key: CategoryKey; title: string; icon: React.ReactNode; tone: Tone; match: (a: AdminAlert) => boolean }[] = [
  { key: 'CR', title: 'السجلات التجارية', icon: <Landmark size={28} />, tone: 'indigo', match: (a) => a.type.includes('CR') },
  { key: 'MUN_LICENSE', title: 'رخص البلدية', icon: <Store size={28} />, tone: 'amber', match: (a) => a.type.includes('MUN_LICENSE') },
  { key: 'CIVIL_DEFENSE', title: 'الدفاع المدني', icon: <Flame size={28} />, tone: 'rose', match: (a) => a.type.includes('CIVIL_DEFENSE') },
  { key: 'TRADEMARK', title: 'العلامات التجارية', icon: <BadgeCent size={28} />, tone: 'blue', match: (a) => a.type.includes('TRADEMARK') },
  { key: 'LEASE', title: 'عقود الإيجار', icon: <Home size={28} />, tone: 'emerald', match: (a) => a.type.includes('LEASE') || a.type.includes('CONTRACT') },
];

// Static class maps: Tailwind cannot see dynamically built class names.
const TONE_ICON: Record<Tone, string> = {
  indigo: 'bg-indigo-50 text-indigo-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  blue: 'bg-blue-50 text-blue-600',
  emerald: 'bg-emerald-50 text-emerald-600',
};

const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  COMPANY: { label: 'شركة أو مؤسسة', className: 'bg-indigo-100 text-indigo-800' },
  BRANCH: { label: 'فرع تشغيلي', className: 'bg-emerald-100 text-emerald-800' },
  LEGAL: { label: 'عقد قانوني', className: 'bg-slate-200 text-slate-800' },
};

const isExpired = (a: AdminAlert) => a.type.includes('EXPIRED') || a.level === 'expired';

export default function AdminAlertsPage() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryKey | null>(null);

  const fetchAlerts = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/alerts', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل التنبيهات'));
        return;
      }
      const data = (await res.json()) as { alerts?: unknown };
      setAlerts(Array.isArray(data.alerts) ? (data.alerts as AdminAlert[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  // --- Grouping Logic ---
  const grouped = useMemo(() => {
    const out = {} as Record<CategoryKey, AdminAlert[]>;
    for (const c of CATEGORIES) out[c.key] = alerts.filter(c.match);
    return out;
  }, [alerts]);

  const criticalCount = alerts.filter(isExpired).length;
  const warningCount = alerts.length - criticalCount;
  const active = CATEGORIES.find((c) => c.key === activeCategory) ?? null;

  const getAlertStyle = (a: AdminAlert) =>
    isExpired(a) ? 'bg-red-50 border-red-300 text-red-900 shadow-sm ring-2 ring-red-200 ring-offset-2' : 'bg-blue-50 border-blue-300 text-blue-900 shadow-sm';

  return (
    <DashboardLayout>
       <div className="max-w-[1200px] mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-100">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-700 p-3 rounded-2xl relative">
                <ShieldAlert size={26} />
                {criticalCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 w-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500 border-2 border-white"></span>
                    </span>
                )}
              </span>
              التنبيهات الإدارية والمؤسسية
            </h1>
            <p className="text-indigo-700 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              شاشة مراقبة استباقية تحلل السجلات التجارية للشركات والفروع، ورخص البلدية، وشهادات الدفاع المدني والعلامات التجارية لضمان التجديد والامتثال.
            </p>
          </div>

          <div className="flex gap-4">
             <div className="bg-red-50 border border-red-200 py-2 px-4 rounded-[1rem] text-center">
                 <p className="text-red-800 font-black text-[22px]">{criticalCount}</p>
                 <p className="text-red-600 text-[10px] font-extrabold uppercase">انتهت فعلياً!</p>
             </div>
             <div className="bg-blue-50 border border-blue-200 py-2 px-4 rounded-[1rem] text-center">
                 <p className="text-blue-800 font-black text-[22px]">{warningCount}</p>
                 <p className="text-blue-600 text-[10px] font-extrabold uppercase">إنذارات مبكرة</p>
             </div>
          </div>
        </div>

        {/* Content Area */}
        {isLoading ? (
          <div className="flex justify-center items-center py-20">
             <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" aria-label="جاري التحميل"></div>
          </div>
        ) : loadError ? (
          <div className="bg-white border-2 border-dashed border-rose-200 p-12 text-center rounded-[2rem] shadow-sm flex flex-col items-center">
             <AlertTriangle size={36} className="text-rose-400 mb-4" />
             <h3 className="text-xl font-black text-slate-800 mb-2">تعذر تحميل التنبيهات</h3>
             <p className="text-slate-500 font-bold text-[14px] mb-6">{loadError}</p>
             <button type="button" onClick={fetchAlerts} className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-xl font-bold text-[13px] hover:bg-indigo-700 transition">
               <RefreshCw size={16} /> إعادة المحاولة
             </button>
          </div>
        ) : alerts.length === 0 ? (
          <div className="bg-white border-2 border-dashed border-emerald-200 p-12 text-center rounded-[2rem] shadow-sm">
             <div className="bg-emerald-50 text-emerald-500 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-200">
                <CheckCircle size={36} />
             </div>
             <h3 className="text-xl font-black text-emerald-900 mb-2">استقرار مؤسسي كامل</h3>
             <p className="text-emerald-700 font-bold text-[14px]">كافة السجلات والرخص والعقود التشغيلية للشركة وفروعها سارية المفعول.</p>
          </div>
        ) : (
          <>
            {/* Category Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              {CATEGORIES.map((c) => {
                const list = grouped[c.key];
                if (list.length === 0) return null;
                const expired = list.filter(isExpired).length;
                const warning = list.length - expired;
                const isActive = activeCategory === c.key;
                return (
                  <button
                    type="button"
                    key={c.key}
                    aria-expanded={isActive}
                    onClick={() => setActiveCategory(isActive ? null : c.key)}
                    className={`text-right bg-white rounded-[2rem] p-6 border-2 transition-all cursor-pointer shadow-sm hover:shadow-md ${isActive ? 'border-indigo-500 ring-4 ring-indigo-50' : 'border-slate-100 hover:border-indigo-200'}`}>

                     <div className="flex items-center justify-between mb-6">
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${TONE_ICON[c.tone]}`}>
                           {c.icon}
                        </div>
                        <div className="bg-slate-50 px-3 py-1 rounded-full text-slate-500 font-extrabold text-[12px]">
                           {list.length} ملف
                        </div>
                     </div>

                     <h3 className="font-black text-xl text-slate-800 mb-4">{c.title}</h3>

                     <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className={`bg-red-50/50 rounded-xl p-3 border ${expired > 0 ? 'border-red-200 bg-red-50' : 'border-red-100/50'}`}>
                           <p className="text-red-900 font-black text-xl">{expired}</p>
                           <p className="text-red-600 text-[10px] font-extrabold uppercase">انتهت فعلياً</p>
                        </div>
                        <div className={`bg-blue-50/50 rounded-xl p-3 border ${warning > 0 ? 'border-blue-200 bg-blue-50' : 'border-blue-100/50'}`}>
                           <p className="text-blue-900 font-black text-xl">{warning}</p>
                           <p className="text-blue-600 text-[10px] font-extrabold uppercase">إنذار مبكر</p>
                        </div>
                     </div>

                     <div className="flex items-center justify-center mt-2 text-indigo-500">
                       {isActive ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                     </div>
                  </button>
                );
              })}
            </div>

            {/* List Details for Active Category */}
            {active && (
              <div className="bg-white rounded-[2rem] p-8 mt-10 shadow-xl shadow-slate-200/50 border border-indigo-100 animate-in fade-in slide-in-from-bottom-4 duration-300">
                 <h2 className="text-2xl font-black text-slate-800 mb-6 flex items-center gap-3">
                    {active.icon}
                    تفاصيل تنبيهات {active.title}
                 </h2>

                 {grouped[active.key].length === 0 ? (
                    <div className="text-center py-10 font-bold text-slate-400">لا يوجد تنبيهات في هذا القسم حاليًا.</div>
                 ) : (
                    <div className="grid grid-cols-1 gap-4">
                        {grouped[active.key].map((alert) => {
                          const badge = alert.category ? SOURCE_BADGE[alert.category] : undefined;
                          return (
                            <div key={alert.id} className={`p-6 rounded-[1.5rem] border-2 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all hover:-translate-y-1 ${getAlertStyle(alert)}`}>

                                <div className="flex items-center gap-5">
                                    <div className="bg-white/60 p-3 rounded-xl shadow-sm">
                                      {active.icon}
                                    </div>
                                    <div>
                                       <div className="flex items-center gap-2 mb-1">
                                          {badge && <span className={`${badge.className} px-2 py-0.5 rounded text-[10px] font-black`}>{badge.label}</span>}
                                          <h3 className="font-black text-[16px] mr-2">{alert.source}</h3>
                                       </div>
                                       <p className="font-bold text-[14px] opacity-90">{alert.message}</p>
                                    </div>
                                </div>

                                <div className="shrink-0 text-left md:text-right">
                                    <p className="text-[11px] font-extrabold uppercase mb-1 opacity-70">الموعد النهائي</p>
                                    <p className="font-black text-[18px] tracking-wide" dir="ltr">
                                      {formatDateShort(alert.dueDate)}
                                    </p>
                                </div>

                            </div>
                          );
                        })}
                    </div>
                 )}
              </div>
            )}
          </>
        )}

      </div>
    </DashboardLayout>
  );
}

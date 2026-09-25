"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, Scale, FileText, Landmark, Gavel, ChevronDown, ChevronUp, FileSignature, AlertTriangle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface LegalAlertRow {
  id: string;
  category: string;
  type: string;
  level?: string;
  source?: string;
  message: string;
  employee?: string;
  dueDate: string;
  /** Promissory notes only: the company's side of the note. */
  companyRole?: 'CREDITOR' | 'DEBTOR';
}

// The company's side of a promissory note (PromissoryNote.companyRole).
const NOTE_ROLE: Record<'CREDITOR' | 'DEBTOR', { label: string; className: string }> = {
  CREDITOR: { label: 'مستحق لنا', className: 'bg-emerald-100 text-emerald-800 border border-emerald-200' },
  DEBTOR: { label: 'مستحق علينا', className: 'bg-rose-100 text-rose-800 border border-rose-200' },
};

type CategoryKey = 'AGENCY' | 'LAWSUIT' | 'NOTE' | 'CONTRACT';
type Tone = 'purple' | 'indigo' | 'rose' | 'teal';

const CATEGORIES: { key: CategoryKey; category: string; title: string; icon: React.ReactNode; tone: Tone; badge: string; expiredLabel: string; warningLabel: string }[] = [
  { key: 'AGENCY', category: 'AGENCY', title: 'الوكالات الموثقة', icon: <FileSignature size={28} />, tone: 'teal', badge: 'وكالة شرعية', expiredLabel: 'توكيل منتهي', warningLabel: 'قارب الانتهاء' },
  { key: 'LAWSUIT', category: 'LAWSUIT', title: 'المنازعات القضائية', icon: <Gavel size={28} />, tone: 'rose', badge: 'قضية محالة', expiredLabel: 'قضايا منتهية', warningLabel: 'نزاع قائم' },
  { key: 'NOTE', category: 'PROMISSORY_NOTE', title: 'السندات لأمر', icon: <Landmark size={28} />, tone: 'purple', badge: 'سند لأمر', expiredLabel: 'مستحق غير مسدد', warningLabel: 'يستحق قريباً' },
  { key: 'CONTRACT', category: 'LEGAL_CONTRACT', title: 'العقود والاتفاقيات', icon: <FileText size={28} />, tone: 'indigo', badge: 'عقد قانوني', expiredLabel: 'انتهت فعلياً', warningLabel: 'إنذار مبكر' },
];

// Static class maps: Tailwind cannot see dynamically built class names.
const TONE: Record<Tone, { icon: string; active: string; idle: string; chevron: string }> = {
  purple: { icon: 'bg-purple-50 text-purple-600', active: 'border-purple-500 ring-4 ring-purple-50', idle: 'border-slate-100 hover:border-purple-200', chevron: 'text-purple-500' },
  indigo: { icon: 'bg-indigo-50 text-indigo-600', active: 'border-indigo-500 ring-4 ring-indigo-50', idle: 'border-slate-100 hover:border-indigo-200', chevron: 'text-indigo-500' },
  rose: { icon: 'bg-rose-50 text-rose-600', active: 'border-rose-500 ring-4 ring-rose-50', idle: 'border-slate-100 hover:border-rose-200', chevron: 'text-rose-500' },
  teal: { icon: 'bg-teal-50 text-teal-600', active: 'border-teal-500 ring-4 ring-teal-50', idle: 'border-slate-100 hover:border-teal-200', chevron: 'text-teal-500' },
};

const isExpired = (a: LegalAlertRow) => a.type.includes('EXPIRED') || a.level === 'expired';

export default function LegalAlertsPage() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<LegalAlertRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryKey | null>(null);

  const fetchAlerts = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/legal/alerts', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setLoadError(await readApiError(res, 'تعذر تحميل التنبيهات'));
        return;
      }
      const data = (await res.json()) as { alerts?: unknown };
      setAlerts(Array.isArray(data.alerts) ? (data.alerts as LegalAlertRow[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  // --- Grouping Logic ---
  const grouped = useMemo(() => {
    const out = {} as Record<CategoryKey, LegalAlertRow[]>;
    for (const c of CATEGORIES) out[c.key] = alerts.filter((a) => a.category === c.category);
    return out;
  }, [alerts]);

  const criticalCount = alerts.filter(isExpired).length;
  const warningCount = alerts.length - criticalCount;
  const active = CATEGORIES.find((c) => c.key === activeCategory) ?? null;

  const getAlertStyle = (a: LegalAlertRow) =>
    isExpired(a) ? 'bg-red-50 border-red-300 text-red-900 shadow-sm ring-2 ring-red-200 ring-offset-2' : 'bg-amber-50 border-amber-300 text-amber-900 shadow-sm';

  return (
    <DashboardLayout>
       <div className="max-w-[1200px] mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-100">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-slate-100 text-slate-700 p-3 rounded-2xl relative">
                <Scale size={26} />
                {criticalCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 w-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500 border-2 border-white"></span>
                    </span>
                )}
              </span>
              التنبيهات والمخاطر القانونية
            </h1>
            <p className="text-slate-700 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              شاشة رقابة قانونية ترصد أوقات استحقاق السندات لأمر وانتهاء العقود والاتفاقيات لتفعيل المتابعة القانونية قبل فوات الأوان.
            </p>
          </div>

          <div className="flex gap-4">
             <div className="bg-red-50 border border-red-200 py-2 px-4 rounded-[1rem] text-center">
                 <p className="text-red-800 font-black text-[22px]">{criticalCount}</p>
                 <p className="text-red-600 text-[10px] font-extrabold uppercase">استحقاق / منتهي!</p>
             </div>
             <div className="bg-amber-50 border border-amber-200 py-2 px-4 rounded-[1rem] text-center">
                 <p className="text-amber-800 font-black text-[22px]">{warningCount}</p>
                 <p className="text-amber-600 text-[10px] font-extrabold uppercase">إنذارات مبكرة</p>
             </div>
          </div>
        </div>

        {/* Content Area */}
        {isLoading ? (
          <div className="flex justify-center items-center py-20">
             <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-600 rounded-full animate-spin" aria-label="جاري التحميل"></div>
          </div>
        ) : loadError ? (
          <div className="bg-white border-2 border-dashed border-rose-200 p-12 text-center rounded-[2rem] shadow-sm flex flex-col items-center">
             <AlertTriangle size={36} className="text-rose-400 mb-4" />
             <h3 className="text-xl font-black text-slate-800 mb-2">تعذر تحميل التنبيهات</h3>
             <p className="text-slate-500 font-bold text-[14px] mb-6">{loadError}</p>
             <button type="button" onClick={fetchAlerts} className="inline-flex items-center gap-2 px-6 py-3 bg-slate-800 text-white rounded-xl font-bold text-[13px] hover:bg-slate-900 transition">
               <RefreshCw size={16} /> إعادة المحاولة
             </button>
          </div>
        ) : alerts.length === 0 ? (
          <div className="bg-white border-2 border-dashed border-emerald-200 p-12 text-center rounded-[2rem] shadow-sm">
             <div className="bg-emerald-50 text-emerald-500 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-200">
                <CheckCircle size={36} />
             </div>
             <h3 className="text-xl font-black text-emerald-900 mb-2">رقابة قانونية صارمة</h3>
             <p className="text-emerald-700 font-bold text-[14px]">لا توجد عقود قاربت على الانتهاء ولا سندات لأمر مستحقة حالياً.</p>
          </div>
        ) : (
          <>
            {/* Category Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {CATEGORIES.map((c) => {
                const list = grouped[c.key];
                if (list.length === 0) return null;
                const expired = list.filter(isExpired).length;
                const warning = list.length - expired;
                const isActive = activeCategory === c.key;
                const tone = TONE[c.tone];
                return (
                  <button
                    type="button"
                    key={c.key}
                    aria-expanded={isActive}
                    onClick={() => setActiveCategory(isActive ? null : c.key)}
                    className={`text-right bg-white rounded-[2rem] p-6 border-2 transition-all cursor-pointer shadow-sm hover:shadow-md ${isActive ? tone.active : tone.idle}`}>

                     <div className="flex items-center justify-between mb-6">
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${tone.icon}`}>
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
                           <p className="text-red-600 text-[10px] font-extrabold uppercase">{c.expiredLabel}</p>
                        </div>
                        <div className={`bg-amber-50/50 rounded-xl p-3 border ${warning > 0 ? 'border-amber-200 bg-amber-50' : 'border-amber-100/50'}`}>
                           <p className="text-amber-900 font-black text-xl">{warning}</p>
                           <p className="text-amber-600 text-[10px] font-extrabold uppercase">{c.warningLabel}</p>
                        </div>
                     </div>

                     {c.key === 'NOTE' && (
                       <div className="flex flex-wrap gap-2 text-[11px] font-extrabold mb-2">
                         <span className={`px-2 py-0.5 rounded-full ${NOTE_ROLE.CREDITOR.className}`}>{NOTE_ROLE.CREDITOR.label}: {list.filter((a) => a.companyRole !== 'DEBTOR').length}</span>
                         <span className={`px-2 py-0.5 rounded-full ${NOTE_ROLE.DEBTOR.className}`}>{NOTE_ROLE.DEBTOR.label}: {list.filter((a) => a.companyRole === 'DEBTOR').length}</span>
                       </div>
                     )}

                     <div className={`flex items-center justify-center mt-2 ${tone.chevron}`}>
                       {isActive ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                     </div>
                  </button>
                );
              })}
            </div>

            {/* List Details for Active Category */}
            {active && (
              <div className="bg-white rounded-[2rem] p-8 mt-10 shadow-xl shadow-slate-200/50 border border-slate-200 animate-in fade-in slide-in-from-bottom-4 duration-300">
                 <h2 className="text-2xl font-black text-slate-800 mb-6 flex items-center gap-3">
                    {active.icon}
                    تفاصيل تنبيهات {active.title}
                 </h2>

                 {grouped[active.key].length === 0 ? (
                    <div className="text-center py-10 font-bold text-slate-400">لا يوجد تنبيهات في هذا القسم حاليًا.</div>
                 ) : (
                    <div className="grid grid-cols-1 gap-4">
                        {grouped[active.key].map((alert) => (
                            <div key={alert.id} className={`p-6 rounded-[1.5rem] border-2 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all hover:-translate-y-1 ${getAlertStyle(alert)}`}>

                                <div className="flex items-center gap-5">
                                    <div className="bg-white/60 p-3 rounded-xl shadow-sm">
                                      {active.icon}
                                    </div>
                                    <div className="max-w-xl">
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <span className="bg-slate-200 text-slate-800 px-2 py-0.5 rounded text-[10px] font-black">{active.badge}</span>
                                          {alert.category === 'PROMISSORY_NOTE' && alert.companyRole && (
                                            <span className={`px-2 py-0.5 rounded text-[10px] font-black ${NOTE_ROLE[alert.companyRole].className}`}>
                                              صفة الشركة: {NOTE_ROLE[alert.companyRole].label}
                                            </span>
                                          )}
                                          <h3 className="font-black text-[15px] mr-2 text-slate-900">{alert.employee || alert.source}</h3>
                                       </div>
                                       {alert.category === 'PROMISSORY_NOTE' && alert.source && (
                                         <p className="text-[12px] font-bold opacity-75 mb-1">{alert.source}</p>
                                       )}
                                       <p className="font-bold text-[14px] opacity-90">{alert.message}</p>
                                    </div>
                                </div>

                                <div className="shrink-0 text-left md:text-right">
                                    <p className="text-[11px] font-extrabold uppercase mb-1 opacity-70">{alert.category === 'PROMISSORY_NOTE' ? 'تاريخ الاستحقاق' : 'الموعد النهائي'}</p>
                                    <p className="font-black text-[18px] tracking-wide">
                                      {formatDateShort(alert.dueDate)}
                                    </p>
                                </div>

                            </div>
                        ))}
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

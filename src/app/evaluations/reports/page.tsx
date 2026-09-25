"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BarChart3, Users, TrendingUp, TrendingDown, CheckCircle2,
  Clock, ClipboardCheck, Star, AlertCircle, ChevronRight, Loader2, Building2, Download, RefreshCw,
} from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError } from '@/components/ui/feedback';
import { todayKey } from '@/lib/dates';
import type { ScoreBuckets } from '@/app/api/evaluations/scoring';

interface ReportEvaluation {
  id: string;
  totalScore?: number | null;
  finalRating?: string | null;
  employee?: {
    firstNameArabic?: string | null;
    lastNameArabic?: string | null;
    employeeId?: string | null;
    jobTitle?: string | null;
    department?: { nameArabic?: string | null } | null;
  } | null;
  cycle?: { title?: string | null } | null;
}

interface DashboardData extends Partial<ScoreBuckets> {
  totalClosed?: number;
  avgScore?: string | number;
  top5?: ReportEvaluation[];
  bottom5?: ReportEvaluation[];
  deptAverages?: { name: string; avg: number; count: number }[];
  pendingManager?: number;
  pendingApproval?: number;
  pendingAck?: number;
}

/** Quote a CSV cell (commas, quotes and new lines inside names/notes). Neutralises spreadsheet formulas. */
function csvCell(value: string): string {
  const v = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${v.replace(/"/g, '""')}"`;
}

function deptClass(avg: number): string {
  if (avg >= 80) return 'text-emerald-600 bg-emerald-50';
  if (avg >= 60) return 'text-amber-600 bg-amber-50';
  return 'text-red-600 bg-red-50';
}

export default function EvaluationReportsPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/evaluations?view=dashboard', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        setError(await readApiError(res, 'تعذر تحميل لوحة التقارير'));
        return;
      }
      setData((await res.json()) as DashboardData);
    } catch {
      setError('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-[60vh] text-slate-400 font-bold animate-pulse">
          <Loader2 size={24} className="animate-spin ml-2" /> جاري تحميل لوحة التقارير...
        </div>
      </DashboardLayout>
    );
  }

  if (error || !data) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4 text-center px-4">
          <AlertCircle size={32} className="text-rose-400" />
          <p className="text-slate-600 font-bold">{error || 'لم يتم العثور على بيانات'}</p>
          <button type="button" onClick={() => void load()} className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-5 py-2.5 rounded-xl font-black text-[13px] transition">
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      </DashboardLayout>
    );
  }

  const exportCsv = () => {
    const rows: string[][] = [['الاسم', 'الرقم الوظيفي', 'المسمى', 'القسم', 'النتيجة', 'التصنيف', 'الدورة']];
    const seen = new Set<string>();
    [...(data.top5 || []), ...(data.bottom5 || [])].forEach((ev) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      rows.push([
        `${ev.employee?.firstNameArabic || ''} ${ev.employee?.lastNameArabic || ''}`.trim(),
        ev.employee?.employeeId || '',
        ev.employee?.jobTitle || '',
        ev.employee?.department?.nameArabic || '',
        (ev.totalScore || 0).toFixed(1),
        ev.finalRating || '',
        ev.cycle?.title || '',
      ]);
    });
    if (rows.length === 1) {
      toast.info('لا توجد بيانات للتصدير');
      return;
    }
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `evaluation_report_${todayKey()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const distData = [
    { label: 'ممتاز', value: data.excellent || 0, color: 'bg-emerald-500' },
    { label: 'جيد جداً', value: data.veryGood || 0, color: 'bg-blue-500' },
    { label: 'جيد', value: data.good || 0, color: 'bg-amber-500' },
    { label: 'مقبول', value: data.acceptable || 0, color: 'bg-orange-500' },
    { label: 'ضعيف', value: data.weak || 0, color: 'bg-red-500' },
  ];
  const maxDist = Math.max(...distData.map((d) => d.value), 1);

  const cards = [
    { label: 'تقييمات مكتملة', value: data.totalClosed ?? 0, icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50' },
    { label: 'متوسط الأداء العام', value: `${data.avgScore ?? 0}%`, icon: TrendingUp, color: 'text-violet-600 bg-violet-50' },
    { label: 'بانتظار الاعتماد', value: data.pendingApproval ?? 0, icon: ClipboardCheck, color: 'text-indigo-600 bg-indigo-50' },
    { label: 'بانتظار تعبئة المدير', value: data.pendingManager ?? 0, icon: Clock, color: 'text-amber-600 bg-amber-50' },
    { label: 'بانتظار اطلاع الموظف', value: data.pendingAck ?? 0, icon: Users, color: 'text-blue-600 bg-blue-50' },
  ];

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-24 space-y-8">

        {/* Breadcrumb */}
        <nav aria-label="مسار التنقل" className="flex items-center gap-2 text-[13px] font-bold text-slate-400">
          <Link href="/evaluations" className="hover:text-violet-600 transition">إدارة التقييم</Link>
          <ChevronRight size={14} />
          <span className="text-slate-700">لوحة التقارير والمؤشرات</span>
        </nav>

        {/* Header */}
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <span className="bg-violet-100 text-violet-600 p-3 rounded-2xl"><BarChart3 size={26} /></span>
            لوحة تقارير الأداء
          </h1>
          <p className="text-slate-500 font-bold mt-2 text-[14px]">مؤشرات مجمعة ونتائج التقييمات المعتمدة.</p>
          <button type="button" onClick={exportCsv} className="mt-3 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-4 py-2 rounded-xl font-black text-[12px] flex items-center gap-2 transition border border-emerald-200">
            <Download size={14} /> تصدير Excel (CSV)
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {cards.map((s) => (
            <div key={s.label} className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm flex items-center gap-4">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${s.color}`}><s.icon size={22} /></div>
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{s.label}</p>
                <h3 className="text-2xl font-black text-slate-800">{s.value}</h3>
              </div>
            </div>
          ))}
        </div>

        {/* Distribution & Departments */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Rating Distribution */}
          <div className="bg-white rounded-[1.5rem] p-6 border border-slate-100 shadow-sm">
            <h3 className="font-black text-slate-800 text-[16px] mb-6 flex items-center gap-2"><Star size={18} className="text-amber-500" /> توزيع التصنيفات</h3>
            <div className="space-y-4">
              {distData.map((d) => (
                <div key={d.label} className="flex items-center gap-4">
                  <span className="min-w-[70px] text-[13px] font-black text-slate-600 text-left">{d.label}</span>
                  <div className="flex-1 bg-slate-100 rounded-full h-6 overflow-hidden relative" role="img" aria-label={`${d.label}: ${d.value}`}>
                    <div className={`${d.color} h-full rounded-full transition-all duration-500`} style={{ width: `${(d.value / maxDist) * 100}%` }}></div>
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-black text-white mix-blend-difference">{d.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Department Averages */}
          <div className="bg-white rounded-[1.5rem] p-6 border border-slate-100 shadow-sm">
            <h3 className="font-black text-slate-800 text-[16px] mb-6 flex items-center gap-2"><Building2 size={18} className="text-indigo-500" /> متوسط الأداء حسب القسم</h3>
            {data.deptAverages && data.deptAverages.length > 0 ? (
              <div className="space-y-3">
                {data.deptAverages.map((dept) => (
                  <div key={dept.name} className="flex items-center justify-between bg-slate-50 rounded-xl p-3 border border-slate-100">
                    <div>
                      <p className="font-bold text-[13px] text-slate-700">{dept.name}</p>
                      <p className="text-[10px] font-bold text-slate-400">{dept.count} تقييم</p>
                    </div>
                    <span className={`font-black text-[14px] px-3 py-1 rounded-lg ${deptClass(dept.avg)}`}>
                      {dept.avg.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-slate-400 font-bold py-10">لا توجد بيانات أقسام بعد</p>
            )}
          </div>
        </div>

        {/* Top & Bottom Performers */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top 5 */}
          <div className="bg-white rounded-[1.5rem] p-6 border border-slate-100 shadow-sm">
            <h3 className="font-black text-slate-800 text-[16px] mb-4 flex items-center gap-2"><TrendingUp size={18} className="text-emerald-500" /> الموظفون الأعلى تقييماً</h3>
            {data.top5 && data.top5.length > 0 ? (
              <div className="space-y-3">
                {data.top5.map((ev, i) => (
                  <div key={ev.id} className="flex items-center justify-between bg-emerald-50/50 rounded-xl p-3 border border-emerald-100">
                    <div className="flex items-center gap-3">
                      <span className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center font-black text-[12px]">{i + 1}</span>
                      <div>
                        <p className="font-bold text-[13px] text-slate-700">{ev.employee?.firstNameArabic} {ev.employee?.lastNameArabic}</p>
                        <p className="text-[10px] font-bold text-slate-400">{ev.employee?.jobTitle || ''} • {ev.employee?.department?.nameArabic || ''}</p>
                      </div>
                    </div>
                    <div className="text-center">
                      <span className="font-black text-emerald-600 text-[15px]">{(ev.totalScore ?? 0).toFixed(1)}%</span>
                      <p className="text-[10px] font-black text-emerald-500">{ev.finalRating}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-slate-400 font-bold py-10">لا توجد بيانات بعد</p>
            )}
          </div>

          {/* Bottom 5 */}
          <div className="bg-white rounded-[1.5rem] p-6 border border-slate-100 shadow-sm">
            <h3 className="font-black text-slate-800 text-[16px] mb-4 flex items-center gap-2"><TrendingDown size={18} className="text-red-500" /> الموظفون الأقل تقييماً (يحتاجون خطة تحسين)</h3>
            {data.bottom5 && data.bottom5.length > 0 ? (
              <div className="space-y-3">
                {data.bottom5.map((ev, i) => {
                  const low = (ev.totalScore || 0) < 60;
                  return (
                    <div key={ev.id} className="flex items-center justify-between bg-red-50/50 rounded-xl p-3 border border-red-100">
                      <div className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center font-black text-[12px]">{i + 1}</span>
                        <div>
                          <p className="font-bold text-[13px] text-slate-700">{ev.employee?.firstNameArabic} {ev.employee?.lastNameArabic}</p>
                          <p className="text-[10px] font-bold text-slate-400">{ev.employee?.jobTitle || ''} • {ev.employee?.department?.nameArabic || ''}</p>
                        </div>
                      </div>
                      <div className="text-center">
                        <span className={`font-black text-[15px] ${low ? 'text-red-600' : 'text-amber-600'}`}>{(ev.totalScore ?? 0).toFixed(1)}%</span>
                        <p className={`text-[10px] font-black ${low ? 'text-red-500' : 'text-amber-500'}`}>{ev.finalRating}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-center text-slate-400 font-bold py-10">لا توجد بيانات بعد</p>
            )}
          </div>
        </div>

      </div>
    </DashboardLayout>
  );
}

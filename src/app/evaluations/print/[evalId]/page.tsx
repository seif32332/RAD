"use client";

import React, { useState, useEffect, use } from 'react';
import { Loader2, Printer, AlertCircle } from 'lucide-react';
import { readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';

interface PrintItem { id: string; title: string }
interface PrintSection { id: string; title: string; weight: number; items: PrintItem[] }
interface PrintEvaluation {
  id: string;
  updatedAt: string;
  totalScore?: number | null;
  finalRating?: string | null;
  strengths?: string | null;
  improvements?: string | null;
  finalNotes?: string | null;
  recommendation?: string | null;
  recommendationReason?: string | null;
  employeeAcknowledgedAt?: string | null;
  employeeComment?: string | null;
  itemScores?: { itemId: string; score: number; note?: string | null }[];
  employee?: {
    firstNameArabic?: string | null;
    lastNameArabic?: string | null;
    employeeId?: string | null;
    jobTitle?: string | null;
    joinDate?: string | null;
    department?: { nameArabic?: string | null } | null;
    branch?: { nameArabic?: string | null } | null;
    directManager?: { firstNameArabic?: string | null; lastNameArabic?: string | null } | null;
  } | null;
  cycle?: {
    title?: string | null;
    cycleType?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    template?: { name?: string | null; sections?: PrintSection[] } | null;
  } | null;
}

const cycleTypeLabels: Record<string, string> = { MONTHLY: 'شهري', QUARTERLY: 'ربع سنوي', ANNUAL: 'سنوي', PROBATION: 'فترة تجربة' };

const finalRatingClass: Record<string, string> = {
  'ممتاز': 'bg-emerald-100 text-emerald-700',
  'جيد جداً': 'bg-blue-100 text-blue-700',
  'جيد': 'bg-amber-100 text-amber-700',
  'مقبول': 'bg-orange-100 text-orange-700',
};

const scoreLabels = ['', 'ضعيف جداً', 'ضعيف', 'جيد', 'جيد جداً', 'ممتاز'];
const recommendationLabels: Record<string, string> = {
  NO_ACTION: 'لا يوجد إجراء', BONUS: 'مكافأة', PROMOTION: 'ترقية', RAISE: 'زيادة راتب',
  TRAINING: 'خطة تدريب', WARNING: 'لفت نظر', NOTICE: 'إنذار', EXTEND_MONITORING: 'تمديد متابعة',
  NO_RENEWAL: 'عدم تجديد', TERMINATION: 'إنهاء خدمة', OTHER: 'أخرى',
};

export default function PrintEvaluationPage({ params }: { params: Promise<{ evalId: string }> }) {
  const resolvedParams = use(params);
  const evalId = resolvedParams.evalId;
  const [evaluation, setEvaluation] = useState<PrintEvaluation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/evaluations?view=evaluation&evalId=${encodeURIComponent(evalId)}`, { cache: 'no-store' });
        if (res.status === 401) {
          window.location.assign('/login');
          return;
        }
        if (res.status === 404) {
          if (!cancelled) setEvaluation(null);
          return;
        }
        if (!res.ok) {
          const msg = await readApiError(res, 'تعذر تحميل التقييم');
          if (!cancelled) setError(msg);
          return;
        }
        const data = (await res.json()) as PrintEvaluation | null;
        if (!cancelled) setEvaluation(data);
      } catch {
        if (!cancelled) setError('تعذر الاتصال بالخادم');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evalId]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-screen"><Loader2 size={32} className="animate-spin text-violet-500" /></div>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 text-red-500 font-bold" dir="rtl">
        <AlertCircle size={32} />
        {error}
        <button type="button" onClick={() => window.location.reload()} className="text-violet-600 hover:underline text-[13px]">إعادة المحاولة</button>
      </div>
    );
  }

  if (!evaluation) {
    return <div className="flex items-center justify-center h-screen text-red-500 font-bold" dir="rtl">لم يتم العثور على التقييم</div>;
  }

  const emp = evaluation.employee;
  const cycle = evaluation.cycle;
  const template = cycle?.template;
  const sections = template?.sections || [];

  // Calculate section scores
  const sectionResults = sections.map((section) => {
    const sectionScores = section.items.map((item) => {
      const found = evaluation.itemScores?.find((is) => is.itemId === item.id);
      return { item, score: found?.score || 0, note: found?.note || '' };
    });
    const validScores = sectionScores.filter((s) => s.score > 0);
    const avg = validScores.length > 0 ? validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length : 0;
    const pct = (avg / 5) * 100;
    const weighted = (pct * section.weight) / 100;
    return { section, sectionScores, avg, pct, weighted };
  });

  return (
    <>
      {/* Print Button - hidden in print */}
      <div className="print:hidden fixed top-4 left-4 z-50">
        <button type="button" onClick={() => window.print()} className="bg-violet-600 text-white px-6 py-3 rounded-xl font-black flex items-center gap-2 shadow-lg hover:bg-violet-700 transition">
          <Printer size={18} /> طباعة / حفظ PDF
        </button>
      </div>

      {/* Print Styles */}
      <style>{`
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .page-break { page-break-before: always; }
        }
        @page { size: A4; margin: 15mm; }
      `}</style>

      <div className="max-w-[800px] mx-auto p-8 bg-white font-[Arial,'Noto Sans Arabic',sans-serif]" dir="rtl">

        {/* Header */}
        <div className="text-center border-b-4 border-violet-600 pb-6 mb-6">
          <h1 className="text-2xl font-black text-violet-800 mb-1">نموذج تقييم الأداء الوظيفي</h1>
          <p className="text-sm font-bold text-slate-500">{cycle?.title} | {template?.name}</p>
          <p className="text-xs text-slate-400 mt-1">رقم التقييم: {evaluation.id?.slice(0, 8).toUpperCase()}</p>
        </div>

        {/* Employee Info */}
        <div className="border-2 border-slate-200 rounded-lg mb-6">
          <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
            <h2 className="font-black text-sm text-slate-700">القسم الأول: البيانات الأساسية</h2>
          </div>
          <div className="grid grid-cols-2 gap-0 text-[12px]">
            {[
              ['اسم الموظف', `${emp?.firstNameArabic || ''} ${emp?.lastNameArabic || ''}`],
              ['الرقم الوظيفي', emp?.employeeId || '—'],
              ['المسمى الوظيفي', emp?.jobTitle || '—'],
              ['القسم', emp?.department?.nameArabic || '—'],
              ['الفرع', emp?.branch?.nameArabic || '—'],
              ['تاريخ المباشرة', formatDate(emp?.joinDate)],
              ['المدير المباشر', emp?.directManager ? `${emp.directManager.firstNameArabic} ${emp.directManager.lastNameArabic}` : '—'],
              ['نوع التقييم', cycleTypeLabels[cycle?.cycleType ?? ''] || '—'],
              ['الفترة', `${formatDate(cycle?.startDate)} — ${formatDate(cycle?.endDate)}`],
              ['تاريخ التقييم', formatDate(evaluation.updatedAt)],
            ].map(([label, value]) => (
              <div key={label} className="flex border-b border-slate-100 last:border-0">
                <span className="bg-slate-50 px-3 py-2 font-bold text-slate-600 w-[120px] border-l border-slate-100">{label}</span>
                <span className="px-3 py-2 font-bold text-slate-800 flex-1">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Evaluation Sections */}
        <div className="border-2 border-slate-200 rounded-lg mb-6">
          <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
            <h2 className="font-black text-sm text-slate-700">القسم الثاني: محاور التقييم</h2>
          </div>

          {sectionResults.map((sr, si) => (
            <div key={sr.section.id} className={si > 0 ? 'border-t-2 border-slate-200' : ''}>
              <div className="flex justify-between items-center px-4 py-2 bg-violet-50 border-b border-violet-100">
                <span className="font-black text-[12px] text-violet-800">{si + 1}. {sr.section.title}</span>
                <span className="text-[11px] font-bold text-violet-600">الوزن: {sr.section.weight}% | المتوسط: {sr.avg.toFixed(1)} | النسبة: {sr.pct.toFixed(0)}% | النقاط: {sr.weighted.toFixed(1)}</span>
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="text-right px-3 py-1.5 font-bold text-slate-500 border-b border-slate-100">العنصر</th>
                    <th className="text-center px-2 py-1.5 font-bold text-slate-500 border-b border-slate-100 w-[50px]">الدرجة</th>
                    <th className="text-center px-2 py-1.5 font-bold text-slate-500 border-b border-slate-100 w-[70px]">التصنيف</th>
                  </tr>
                </thead>
                <tbody>
                  {sr.sectionScores.map((sc) => (
                    <tr key={sc.item.id} className="border-b border-slate-50">
                      <td className="px-3 py-1.5 font-bold text-slate-700">{sc.item.title}</td>
                      <td className="text-center font-black text-slate-800">{sc.score || '—'}</td>
                      <td className={`text-center font-bold text-[10px] ${sc.score >= 4 ? 'text-emerald-600' : sc.score === 3 ? 'text-amber-600' : sc.score > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                        {sc.score > 0 ? scoreLabels[sc.score] : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Final Score */}
        <div className="border-2 border-violet-300 rounded-lg mb-6 bg-violet-50 p-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="font-black text-lg text-violet-800">النتيجة النهائية</h2>
              <p className="text-[11px] font-bold text-violet-500 mt-1">
                {sectionResults.map((sr) => `${sr.section.title}: ${sr.weighted.toFixed(1)}`).join(' + ')} = {(evaluation.totalScore ?? 0).toFixed(1)}
              </p>
            </div>
            <div className="text-center">
              <p className="text-4xl font-black text-violet-800">{(evaluation.totalScore ?? 0).toFixed(1)}%</p>
              <p className={`text-sm font-black mt-1 px-4 py-1 rounded-lg inline-block ${finalRatingClass[evaluation.finalRating ?? ''] || 'bg-red-100 text-red-700'}`}>{evaluation.finalRating}</p>
            </div>
          </div>
        </div>

        {/* Notes & Recommendations */}
        <div className="border-2 border-slate-200 rounded-lg mb-6">
          <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
            <h2 className="font-black text-sm text-slate-700">القسم الثالث: الملاحظات والتوصيات</h2>
          </div>
          <div className="p-4 space-y-3 text-[12px]">
            {evaluation.strengths && (
              <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-100">
                <p className="font-black text-emerald-600 text-[11px] mb-1">نقاط القوة:</p>
                <p className="font-bold text-emerald-800">{evaluation.strengths}</p>
              </div>
            )}
            {evaluation.improvements && (
              <div className="bg-amber-50 rounded-lg p-3 border border-amber-100">
                <p className="font-black text-amber-600 text-[11px] mb-1">نقاط التحسين:</p>
                <p className="font-bold text-amber-800">{evaluation.improvements}</p>
              </div>
            )}
            {evaluation.finalNotes && (
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                <p className="font-black text-slate-500 text-[11px] mb-1">ملاحظات ختامية:</p>
                <p className="font-bold text-slate-800">{evaluation.finalNotes}</p>
              </div>
            )}
            {evaluation.recommendation && (
              <div className="bg-indigo-50 rounded-lg p-3 border border-indigo-100">
                <p className="font-black text-indigo-600 text-[11px] mb-1">التوصية الإدارية:</p>
                <p className="font-bold text-indigo-800">{recommendationLabels[evaluation.recommendation] || evaluation.recommendation}</p>
                {evaluation.recommendationReason && <p className="font-bold text-indigo-600 text-[11px] mt-1">السبب: {evaluation.recommendationReason}</p>}
              </div>
            )}
          </div>
        </div>

        {/* Employee Acknowledgment */}
        <div className="border-2 border-slate-200 rounded-lg mb-6">
          <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
            <h2 className="font-black text-sm text-slate-700">القسم الرابع: إقرار الموظف</h2>
          </div>
          <div className="p-4 text-[12px]">
            {evaluation.employeeAcknowledgedAt ? (
              <div className="space-y-2">
                <p className="font-bold text-emerald-700">✅ تم الاطلاع بتاريخ: {formatDate(evaluation.employeeAcknowledgedAt)}</p>
                {evaluation.employeeComment && <p className="font-bold text-slate-600">تعليق الموظف: {evaluation.employeeComment}</p>}
              </div>
            ) : (
              <p className="font-bold text-amber-600">⏳ لم يتم الاطلاع بعد</p>
            )}
          </div>
        </div>

        {/* Signatures */}
        <div className="grid grid-cols-3 gap-6 mt-10 text-[11px]">
          {['المدير المباشر (المُقيّم)', 'مدير الموارد البشرية', 'الموظف'].map((title) => (
            <div key={title} className="text-center">
              <p className="font-black text-slate-700 mb-8">{title}</p>
              <div className="border-b-2 border-slate-300 mx-4"></div>
              <p className="font-bold text-slate-400 mt-2">التوقيع</p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="text-center mt-8 pt-4 border-t border-slate-200 text-[10px] text-slate-400 font-bold">
          تم إنشاء هذا التقرير آلياً بواسطة نظام رديف لإدارة الموارد البشرية — {formatDate(new Date())}
        </div>
      </div>
    </>
  );
}

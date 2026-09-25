"use client";

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, CheckCircle2, XCircle, ArrowRight, Download, AlertTriangle, Users, Loader2, SearchCheck } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Link from 'next/link';
import { toast, readApiError } from '@/components/ui/feedback';

type PreviewRow = Record<string, unknown>;

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

interface ImportResult {
  message?: string;
  /** True for the dry run (?validateOnly=1): nothing was written. */
  validateOnly?: boolean;
  totalRows?: number;
  successCount?: number;
  createdCount?: number;
  updatedCount?: number;
  errorCount?: number;
  warningCount?: number;
  errors?: { row: number; name?: string; reason: string; warnings?: string[] }[];
  success?: { row?: number; name: string; empId: string; status?: string; warnings?: string[] }[];
  /** Data-quality warnings: they never reject a row. */
  warnings?: { row: number; name?: string; message: string }[];
}

/** Row errors of an import / dry-run report. */
function ErrorList({ errors }: { errors: NonNullable<ImportResult['errors']> }) {
  if (errors.length === 0) return null;
  return (
    <div className="bg-white rounded-[2rem] border border-red-200 overflow-hidden">
      <div className="bg-red-50 px-6 py-4 border-b border-red-200">
        <h3 className="font-black text-red-700 flex items-center gap-2"><XCircle size={18} /> صفوف مرفوضة ({errors.length})</h3>
        <p className="text-[12px] font-bold text-red-600/80 mt-1">هذه الصفوف لن تُستورد حتى يتم تصحيحها في الملف.</p>
      </div>
      <div className="divide-y divide-red-100 max-h-[300px] overflow-y-auto">
        {errors.map((err) => (
          <div key={`${err.row}-${err.reason}`} className="px-6 py-3 flex flex-wrap items-center gap-4 text-[13px]">
            <span className="bg-red-100 text-red-700 px-2 py-1 rounded-lg font-black text-[11px]">صف {err.row}</span>
            <span className="font-bold text-slate-700">{err.name || '—'}</span>
            <span className="text-red-600 font-bold">{err.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Data-quality warnings of an import / dry-run report (the rows are imported anyway). */
function WarningList({ warnings }: { warnings: NonNullable<ImportResult['warnings']> }) {
  if (warnings.length === 0) return null;
  return (
    <div className="bg-white rounded-[2rem] border border-amber-200 overflow-hidden">
      <div className="bg-amber-50 px-6 py-4 border-b border-amber-200">
        <h3 className="font-black text-amber-800 flex items-center gap-2"><AlertTriangle size={18} /> تنبيهات تحتاج مراجعة ({warnings.length})</h3>
        <p className="text-[12px] font-bold text-amber-700/80 mt-1">التنبيهات لا تمنع الاستيراد، لكن يُنصح بمراجعتها وتصحيح الملف إن لزم.</p>
      </div>
      <div className="divide-y divide-amber-100 max-h-[300px] overflow-y-auto">
        {warnings.map((w, i) => (
          // Several warnings can share a row: the index keeps keys unique.
          <div key={`${w.row}-${i}`} className="px-6 py-3 flex flex-wrap items-center gap-4 text-[13px]">
            <span className="bg-amber-100 text-amber-800 px-2 py-1 rounded-lg font-black text-[11px]">صف {w.row}</span>
            <span className="font-bold text-slate-700">{w.name || '—'}</span>
            <span className="text-amber-800 font-bold">{w.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : fallback;
}

export default function ImportEmployeesPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'upload' | 'preview' | 'result'>('upload');
  const [fileName, setFileName] = useState('');
  const [previewData, setPreviewData] = useState<PreviewRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // Dry run (?validateOnly=1): run automatically before the real import can be confirmed.
  const [dryRun, setDryRun] = useState<ImportResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const resetToUpload = () => {
    setStep('upload');
    setResult(null);
    setDryRun(null);
    setDryRunError(null);
    setPreviewData([]);
    setTotalRows(0);
    setSelectedFile(null);
    setFileName('');
    if (fileRef.current) fileRef.current.value = '';
  };

  // Download the blank template generated by the server.
  const downloadTemplate = async () => {
    if (isDownloadingTemplate) return;
    setIsDownloadingTemplate(true);
    try {
      const res = await fetch('/api/employees/import/template');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تحميل النموذج'));
        return;
      }
      const blob = await res.blob();
      triggerDownload(blob, fileNameFromDisposition(res.headers.get('Content-Disposition'), 'نموذج_استيراد_الموظفين.xlsx'));
    } catch {
      toast.error('تعذر تحميل النموذج');
    } finally {
      setIsDownloadingTemplate(false);
    }
  };

  // Download the current employees in the template layout (built by the server with the same
  // columns and labels the import reads, so the file can be edited and re-imported as is).
  const downloadCurrentEmployees = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const res = await fetch('/api/employees/import/template?withEmployees=1', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء تحميل البيانات'));
        return;
      }
      const count = Number(res.headers.get('X-Row-Count') ?? '');
      const blob = await res.blob();
      triggerDownload(blob, fileNameFromDisposition(res.headers.get('Content-Disposition'), 'قاعدة_بيانات_الموظفين.xlsx'));
      toast.success(Number.isFinite(count) && count >= 0 ? `تم تصدير ${count} موظف` : 'تم تصدير الموظفين');
    } catch {
      toast.error('حدث خطأ أثناء تحميل البيانات');
    } finally {
      setIsDownloading(false);
    }
  };

  // Dry run: the server parses and checks the file exactly like the import but writes nothing.
  const runDryRun = async (file: File) => {
    setIsValidating(true);
    setDryRun(null);
    setDryRunError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/employees/import?validateOnly=1', { method: 'POST', body: formData });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setDryRunError(await readApiError(res, 'تعذر فحص الملف'));
        return;
      }
      setDryRun((await res.json()) as ImportResult);
    } catch {
      setDryRunError('تعذر الاتصال بالخادم لفحص الملف');
    } finally {
      setIsValidating(false);
    }
  };

  // Handle file selection
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // The server parses .xlsx only (legacy .xls / CSV are refused) and caps uploads at 5 MB.
    if (!/.xlsx$/i.test(file.name)) {
      toast.error('صيغة الملف غير مدعومة. يرجى حفظ الملف بصيغة Excel الحديثة (.xlsx) ثم رفعه.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('حجم الملف يتجاوز 5 ميجابايت. قسّم البيانات على أكثر من ملف.');
      e.target.value = '';
      return;
    }

    setIsReadingFile(true);
    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) {
        toast.error('الملف لا يحتوي على أي ورقة بيانات');
        return;
      }
      const rows = XLSX.utils.sheet_to_json<PreviewRow>(sheet, { defval: '', raw: false });
      if (rows.length === 0) {
        toast.warning('الملف فارغ: لا توجد صفوف بيانات للاستيراد');
        return;
      }

      setFileName(file.name);
      setSelectedFile(file);
      setTotalRows(rows.length);
      setPreviewData(rows.slice(0, 20)); // Preview first 20
      setStep('preview');
      void runDryRun(file);
    } catch {
      toast.error('تعذر قراءة الملف. تأكد أنه ملف Excel (.xlsx) صالح.');
    } finally {
      setIsReadingFile(false);
      e.target.value = '';
    }
  };

  // Upload and import (only after a successful dry run)
  const handleImport = async () => {
    if (!selectedFile || isUploading || !dryRun) return;
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const res = await fetch('/api/employees/import', {
        method: 'POST',
        body: formData,
      });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'حدث خطأ أثناء رفع الملف'));
        return;
      }

      const data = (await res.json()) as ImportResult;
      setResult(data);
      setStep('result');
      if ((data.errorCount ?? 0) === 0) toast.success(data.message || 'تم الاستيراد بنجاح');
      else toast.warning(data.message || 'تم الاستيراد مع وجود أخطاء');
    } catch {
      toast.error('حدث خطأ أثناء رفع الملف');
    } finally {
      setIsUploading(false);
    }
  };

  const previewColumns = previewData.length > 0 ? Object.keys(previewData[0]) : [];

  return (
    <DashboardLayout>
      <div className="p-8 max-w-[900px] mx-auto min-h-screen">

        <Link href="/employees" className="inline-flex items-center gap-2 text-slate-500 hover:text-blue-600 transition font-bold text-[14px] mb-8">
          <ArrowRight size={18} /> العودة لقائمة الموظفين
        </Link>

        <div className="mb-10">
          <h1 className="text-3xl font-black text-slate-800 flex items-center gap-3">
            <span className="bg-emerald-100 text-emerald-600 p-2.5 rounded-2xl"><Upload size={28} /></span>
            استيراد الموظفين من Excel
          </h1>
          <p className="text-slate-500 font-bold mt-2 mr-14">رفع ملف Excel يحتوي على بيانات الموظفين لإضافتهم دفعة واحدة</p>
        </div>

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div className="bg-white rounded-[2.5rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100 p-10 space-y-8">

            {/* Download Template */}
            <div className="bg-blue-50/60 border-2 border-dashed border-blue-200 rounded-2xl p-8 text-center">
              <FileSpreadsheet size={48} className="mx-auto text-blue-500 mb-4" />
              <h3 className="text-lg font-black text-slate-800 mb-2">الخطوة 1: تجهيز الملف</h3>
              <p className="text-[13px] font-bold text-slate-500 mb-6">يمكنك تحميل نموذج فارغ، أو تحميل قاعدة بيانات الموظفين الحالية لإضافة موظفين جدد عليها ورفعها مرة أخرى.</p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <button type="button" onClick={downloadTemplate} disabled={isDownloadingTemplate}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3.5 rounded-2xl font-black text-[13px] transition-all hover:-translate-y-0.5 hover:shadow-lg flex items-center gap-2 disabled:opacity-50">
                  {isDownloadingTemplate ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />} تحميل نموذج فارغ
                </button>
                <button type="button" onClick={downloadCurrentEmployees} disabled={isDownloading}
                  className="bg-white border-2 border-blue-600 text-blue-600 hover:bg-blue-50 px-6 py-3.5 rounded-2xl font-black text-[13px] transition-all hover:-translate-y-0.5 hover:shadow-lg flex items-center gap-2 disabled:opacity-50">
                  {isDownloading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />} تصدير الموظفين الحاليين للإضافة
                </button>
              </div>
            </div>

            {/* Upload Area */}
            <div className="relative">
              <input
                ref={fileRef}
                type="file"
                aria-label="اختيار ملف Excel للاستيراد"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileSelect}
                disabled={isReadingFile}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 disabled:cursor-wait"
              />
              <div className="bg-emerald-50/60 border-2 border-dashed border-emerald-300 rounded-2xl p-10 text-center hover:border-emerald-500 transition-colors">
                {isReadingFile ? <Loader2 size={48} className="mx-auto text-emerald-500 mb-4 animate-spin" /> : <Upload size={48} className="mx-auto text-emerald-500 mb-4" />}
                <h3 className="text-lg font-black text-slate-800 mb-2">الخطوة 2: رفع الملف</h3>
                <p className="text-[13px] font-bold text-slate-500">{isReadingFile ? 'جاري قراءة الملف...' : 'اسحب الملف هنا أو اضغط لاختيار ملف Excel'}</p>
                <p className="text-[11px] text-slate-400 mt-2">الصيغة المدعومة: XLSX فقط (بحد أقصى 5 ميجابايت و 5000 صف)</p>
              </div>
            </div>

            {/* Instructions */}
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6">
              <h4 className="font-black text-amber-800 text-[14px] mb-3 flex items-center gap-2">
                <AlertTriangle size={18} /> تعليمات مهمة
              </h4>
              <ul className="space-y-2 text-[13px] font-bold text-amber-700">
                <li>• الحقول المطلوبة: <strong>الاسم بالكامل بالعربي</strong> و <strong>رقم الهوية / الإقامة</strong>، ولإضافة موظف جديد أيضاً: <strong>الجنسية</strong> و <strong>الجنس</strong> و <strong>تاريخ الميلاد</strong> و <strong>تاريخ انتهاء الهوية</strong> و <strong>تاريخ مباشرة العمل</strong></li>
                <li>• عمودا <strong>الجنسية</strong> و<strong>الجنس</strong> (ذكر أو أنثى) مطلوبان لكل موظف جديد، ولا توجد قيمة افتراضية لأي منهما. وفي صف تحديث موظف قائم تبقى القيمة المحفوظة إذا تُركت الخانة فارغة (مع تنبيه عند ترك الجنس فارغاً)</li>
                <li>• يجب أن يظهر كل رقم هوية في <strong>صف واحد فقط</strong>: إذا تكرر الرقم في الملف تُرفض كل الصفوف المكررة حتى يُزال التكرار</li>
                <li>• قبل التأكيد يُجرى <strong>فحص تجريبي</strong> لا يحفظ شيئاً، ويعرض الأخطاء والتنبيهات (آيبان غير صحيح أو مسجل لموظف آخر، صيغة رقم الهوية، راتب صفر، قسم لا يتبع الفرع، غير سعودي بلا تاريخ انتهاء عقد، أسماء غير مطابقة...)</li>
                <li>• بدل السكن يُعلَّم تلقائياً كجزء من <strong>وعاء التأمينات</strong> ويمكن تعديله من ملف الموظف</li>
                <li>• الخلايا غير الصالحة (تاريخ أو مبلغ غير مقروء) لا يتم تجاهلها: يُرفض السطر مع توضيح السبب</li>
                <li>• <strong className="text-red-600">مهم:</strong> الصف الثاني في النموذج يحتوي على بيانات توضيحية (مثال)، يجب حذفه قبل التعبئة أو استبداله ببيانات حقيقية</li>
                <li>• إذا كان رقم الهوية مسجلاً مسبقاً، سيتم <strong>تحديث بيانات الموظف والرواتب والبدلات</strong> بالقيم الجديدة بدلاً من تجاهله</li>
                <li>• الشركة والقسم والفرع والإدارة يتم ربطهم تلقائياً بالاسم (يجب أن تكون مسجلة في النظام مسبقاً). إذا تطابق اسم شركة أو فرع مع أكثر من سجل يُرفض الصف: اكتب للشركة رقم السجل التجاري أو الرقم الموحد، وللفرع رمز الفرع، أو استخدم اسماً فريداً</li>
                <li>• التواريخ <strong>ميلادية</strong> بتنسيق: <strong dir="ltr">YYYY-MM-DD</strong> مثال: <strong dir="ltr">2024-01-15</strong>. التاريخ الذي سنته قبل 1900 (مثل <span dir="ltr">1448/05/10</span>) يُعدّ هجرياً ويُرفض الصف حتى يُحوَّل إلى ميلادي</li>
                <li>• لموظف جديد: يُرفض الصف إذا كان تاريخ الميلاد في المستقبل أو كان تاريخ انتهاء العقد قبل تاريخ المباشرة، وفي صف التحديث يظهر ذلك تنبيهاً</li>
                <li>• رقم الهوية يجب كتابته كنص (لا يبدأ بصفر محذوف)</li>
                <li>• الرقم الوظيفي يُولّد تلقائياً لكل موظف</li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 2: Preview */}
        {step === 'preview' && (
          <div className="bg-white rounded-[2.5rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100 overflow-hidden">
            <div className="bg-slate-800 p-6 flex justify-between items-center gap-4 flex-wrap">
              <div className="text-white">
                <h3 className="text-lg font-black flex items-center gap-2"><FileSpreadsheet size={22} /> معاينة البيانات</h3>
                <p className="text-slate-400 text-[12px] font-bold mt-1">{fileName} — {totalRows} صف{totalRows > previewData.length ? ` (معاينة أول ${previewData.length} صف)` : ''}</p>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={resetToUpload} disabled={isUploading}
                  className="bg-slate-700 hover:bg-slate-600 text-white px-5 py-2.5 rounded-xl font-bold text-[13px] transition disabled:opacity-50">
                  تغيير الملف
                </button>
                <button type="button" onClick={handleImport} disabled={isUploading || isValidating || !dryRun || (dryRun.successCount ?? 0) === 0}
                  title={!dryRun ? 'يجب اكتمال الفحص التجريبي أولاً' : undefined}
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-2.5 rounded-xl font-black text-[13px] transition flex items-center gap-2 disabled:opacity-50">
                  {isUploading ? <><Loader2 size={16} className="animate-spin" /> جاري الاستيراد...</> : <><Upload size={16} /> تأكيد واستيراد</>}
                </button>
              </div>
            </div>

            {/* Dry-run report: shown before the import is confirmed */}
            <div className="p-6 border-b border-slate-100 space-y-4">
              {isValidating ? (
                <p className="flex items-center gap-2 text-[13px] font-bold text-slate-600"><Loader2 size={16} className="animate-spin" /> جاري فحص الملف (بدون حفظ)...</p>
              ) : dryRunError ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 bg-red-50 border border-red-200 rounded-2xl p-4 text-[13px] font-bold text-red-700">
                  <XCircle size={18} /> {dryRunError}
                  {selectedFile && (
                    <button type="button" onClick={() => runDryRun(selectedFile)} className="mr-auto px-3 py-1.5 rounded-xl bg-white border border-red-200 hover:bg-red-100 text-[12px] font-black">إعادة الفحص</button>
                  )}
                </div>
              ) : dryRun ? (
                <>
                  <div className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-2xl p-4">
                    <SearchCheck size={20} className="text-blue-600 shrink-0 mt-0.5" />
                    <div className="text-[13px] font-bold text-slate-700 space-y-1">
                      <p className="font-black text-slate-800">نتيجة الفحص التجريبي (لم يُحفظ أي شيء بعد)</p>
                      <p>
                        جاهز للاستيراد: <span className="text-emerald-700">{dryRun.successCount ?? 0}</span> (جديد {dryRun.createdCount ?? 0} · تحديث {dryRun.updatedCount ?? 0})
                        {' — '}مرفوض: <span className="text-red-600">{dryRun.errorCount ?? 0}</span>
                        {' — '}تنبيهات: <span className="text-amber-700">{dryRun.warningCount ?? 0}</span>
                      </p>
                      {(dryRun.errorCount ?? 0) > 0 && <p className="text-red-600">عند التأكيد تُستورد الصفوف السليمة فقط، وتبقى الصفوف المرفوضة دون حفظ.</p>}
                    </div>
                  </div>
                  <ErrorList errors={dryRun.errors ?? []} />
                  <WarningList warnings={dryRun.warnings ?? []} />
                </>
              ) : null}
            </div>

            <div className="p-6 overflow-x-auto max-h-[500px] overflow-y-auto">
              {previewData.length > 0 && (
                <table className="w-full text-[12px]" dir="rtl">
                  <thead>
                    <tr className="bg-slate-50 sticky top-0">
                      <th className="p-3 text-right font-black text-slate-600 border-b">#</th>
                      {previewColumns.map((key) => (
                        <th key={key} className="p-3 text-right font-black text-slate-600 border-b whitespace-nowrap">{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.map((row, idx) => (
                      // Preview rows have no id: the row number is their identity.
                      <tr key={idx} className="border-b border-slate-100 hover:bg-blue-50/30">
                        <td className="p-3 font-bold text-slate-400">{idx + 1}</td>
                        {previewColumns.map((key) => (
                          <td key={key} className="p-3 font-bold text-slate-700 whitespace-nowrap">{String(row[key] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Result */}
        {step === 'result' && result && (
          <div className="space-y-6">

            {/* Summary */}
            <div className="bg-white rounded-[2.5rem] shadow-[0_10px_40px_rgba(0,0,0,0.03)] border border-slate-100 p-10">
              <div className="text-center mb-8">
                {(result.errorCount ?? 0) === 0 ? (
                  <CheckCircle2 size={64} className="mx-auto text-emerald-500 mb-4" />
                ) : (
                  <AlertTriangle size={64} className="mx-auto text-amber-500 mb-4" />
                )}
                <h2 className="text-2xl font-black text-slate-800 mb-2">{result.message}</h2>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
                <div className="bg-slate-50 rounded-2xl p-6 text-center">
                  <p className="text-3xl font-black text-slate-800">{result.totalRows ?? 0}</p>
                  <p className="text-[12px] font-bold text-slate-500 mt-1">إجمالي الصفوف</p>
                </div>
                <div className="bg-emerald-50 rounded-2xl p-6 text-center">
                  <p className="text-3xl font-black text-emerald-600">{result.successCount ?? 0}</p>
                  <p className="text-[12px] font-bold text-emerald-600 mt-1">تمت الإضافة / التحديث بنجاح</p>
                  {(result.createdCount !== undefined || result.updatedCount !== undefined) && (
                    <p className="text-[11px] font-bold text-emerald-700/80 mt-1">جديد: {result.createdCount ?? 0} · محدَّث: {result.updatedCount ?? 0}</p>
                  )}
                </div>
                <div className="bg-red-50 rounded-2xl p-6 text-center">
                  <p className="text-3xl font-black text-red-600">{result.errorCount ?? 0}</p>
                  <p className="text-[12px] font-bold text-red-600 mt-1">مرفوض / خطأ</p>
                </div>
                <div className="bg-amber-50 rounded-2xl p-6 text-center">
                  <p className="text-3xl font-black text-amber-600">{result.warningCount ?? 0}</p>
                  <p className="text-[12px] font-bold text-amber-700 mt-1">تنبيهات للمراجعة</p>
                </div>
              </div>

              <div className="flex gap-4 justify-center">
                <Link href="/employees" className="bg-slate-900 hover:bg-blue-600 text-white px-8 py-3.5 rounded-2xl font-black text-[14px] transition flex items-center gap-2">
                  <Users size={18} /> عرض الموظفين
                </Link>
                <button type="button" onClick={resetToUpload}
                  className="bg-white border-2 border-slate-200 hover:border-blue-400 text-slate-700 px-8 py-3.5 rounded-2xl font-black text-[14px] transition flex items-center gap-2">
                  <Upload size={18} /> استيراد ملف آخر
                </button>
              </div>
            </div>

            <ErrorList errors={result.errors ?? []} />
            <WarningList warnings={result.warnings ?? []} />

            {/* Success Details */}
            {result.success && result.success.length > 0 && (
              <div className="bg-white rounded-[2rem] border border-emerald-200 overflow-hidden">
                <div className="bg-emerald-50 px-6 py-4 border-b border-emerald-200">
                  <h3 className="font-black text-emerald-700 flex items-center gap-2"><CheckCircle2 size={18} /> تم استيرادهم وتحديثهم بنجاح ({result.success.length})</h3>
                </div>
                <div className="divide-y divide-emerald-100 max-h-[300px] overflow-y-auto">
                  {result.success.map((s) => (
                    <div key={`${s.empId}-${s.row ?? ''}`} className="px-6 py-3 flex items-center gap-4 text-[13px]">
                      <span className="bg-emerald-100 text-emerald-700 px-2 py-1 rounded-lg font-black text-[11px]">{s.empId}</span>
                      <span className="font-bold text-slate-700">{s.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}

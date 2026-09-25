"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Plane, CheckCircle, Clock, PlaneTakeoff, XCircle, RefreshCw, FileText, ShieldAlert, Landmark, CalendarPlus, Printer, Ban } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError, confirmDialog, promptDialog } from '@/components/ui/feedback';
import { formatDate, formatDateTime, toDateInputValue, todayKey } from '@/lib/dates';
import {
  EXIT_REENTRY_VISA_TYPE,
  MIN_VISA_DAYS,
  VISA_MUQEEM_OPERATION_LABEL,
  VISA_MUQEEM_TYPE_LABEL,
  planExtension,
  planIssue,
  safeHijri,
  toDateKey,
  txStatusView,
  type DurationInput,
  type ReturnSuggestion,
  type VisaMuqeemOperation,
  type VisaMuqeemType,
} from '@/app/api/visas/muqeem/shared';

interface MuqeemIntegrationStatus {
  enabled: boolean;
  usable: boolean;
  canOperate: boolean;
  reason: string | null;
}

interface MuqeemTx {
  id: string;
  operation: string;
  status: string;
  externalRef: string | null;
  error: string | null;
  documentUrl: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface VisaMuqeemInfo {
  eligible: boolean;
  reason: string | null;
  company: { id: string; name: string; linked: boolean } | null;
  leave: { id: string; startDate: string; endDate: string } | null;
  suggestion: ReturnSuggestion | null;
  pendingSync: VisaMuqeemOperation | null;
  transactions: MuqeemTx[];
}

interface Visa {
  id: string;
  status: string;
  visaType: string;
  createdAt: string;
  deductedFrom?: string | null;
  attachmentUrl?: string | null;
  ticketStatus?: string | null;
  airline?: string | null;
  bookingRef?: string | null;
  flightFrom?: string | null;
  flightTo?: string | null;
  departureDate?: string | null;
  returnDate?: string | null;
  ticketAttachmentUrl?: string | null;
  externalVisaNumber?: string | null;
  visaDurationDays?: number | null;
  returnBefore?: string | null;
  visaPdfUrl?: string | null;
  issuedViaMuqeemAt?: string | null;
  muqeem?: VisaMuqeemInfo | null;
  employee?: {
    firstNameArabic?: string;
    lastNameArabic?: string;
    nationality?: string | null;
    employeeId?: string;
  } | null;
}

export default function VisasPage() {
  const [visas, setVisas] = useState<Visa[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('ALL'); // ALL, PENDING, ISSUED, CANCELLED

  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [isIssuing, setIsIssuing] = useState(false);
  const [muqeemStatus, setMuqeemStatus] = useState<MuqeemIntegrationStatus | null>(null);

  const fetchMuqeemStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/visas/muqeem');
      if (!res.ok) {
        setMuqeemStatus({ enabled: false, usable: false, canOperate: false, reason: await readApiError(res, 'تعذر التحقق من حالة الربط مع مقيم') });
        return;
      }
      setMuqeemStatus((await res.json()) as MuqeemIntegrationStatus);
    } catch {
      setMuqeemStatus({ enabled: false, usable: false, canOperate: false, reason: 'تعذر التحقق من حالة الربط مع مقيم' });
    }
  }, []);

  useEffect(() => {
    fetchMuqeemStatus();
  }, [fetchMuqeemStatus]);

  const fetchVisas = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/visas');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل التأشيرات');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data: unknown = await res.json();
      setVisas(Array.isArray(data) ? (data as Visa[]) : []);
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVisas();
  }, [fetchVisas]);

  const handleIssueVisa = async (visaId: string) => {
    if (isIssuing) return;
    if (!attachmentUrl) {
      toast.error('الرجاء إرفاق رابط أو ملف التأشيرة الصادرة أولاً!');
      return;
    }

    setIsIssuing(true);
    try {
      const res = await fetch('/api/visas/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visaId, newStatus: 'ISSUED', attachmentUrl })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر إصدار التأشيرة')); return; }
      const data = await res.json().catch(() => ({}));

      toast.success(data?.message || 'تم إصدار التأشيرة');
      setActiveUploadId(null);
      setAttachmentUrl('');
      fetchVisas(); // Refresh
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsIssuing(false);
    }
  };

  const filteredVisas = visas.filter(v => {
    if (activeTab === 'PENDING') return v.status === 'PENDING_PAYMENT' || v.status === 'PAID';
    if (activeTab === 'ISSUED') return v.status === 'ISSUED';
    if (activeTab === 'CANCELLED') return v.status === 'CANCELLED';
    return true;
  });

  const getStatusBadge = (status: string) => {
    if (status === 'ISSUED') return <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[11px] font-black flex items-center gap-1"><CheckCircle size={14}/> تم الإصدار</span>;
    // PAID: the fee request was paid by finance (payments screen); the visa still has to be issued.
    if (status === 'PAID') return <span className="bg-sky-100 text-sky-700 px-3 py-1 rounded-full text-[11px] font-black flex items-center gap-1"><CheckCircle size={14}/> تم سداد الرسوم - بانتظار الإصدار</span>;
    // CANCELLED: the related leave was cancelled before the fee was paid (its payment request is returned).
    if (status === 'CANCELLED') return <span className="bg-rose-100 text-rose-700 px-3 py-1 rounded-full text-[11px] font-black flex items-center gap-1"><XCircle size={14}/> ملغاة</span>;
    if (status === 'PENDING_PAYMENT') return <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-[11px] font-black flex items-center gap-1"><Clock size={14}/> بانتظار سداد الرسوم</span>;
    return <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-[11px] font-black flex items-center gap-1"><Clock size={14}/> بانتظار الإصدار</span>;
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-indigo-100 text-indigo-600 p-3 rounded-2xl"><Plane size={26} /></span>
              التأشيرات والتذاكر
            </h1>
            <p className="text-slate-500 font-semibold mt-2">متابعة تأشيرات الخروج والعودة والخروج النهائي المرتبطة تلقائياً بالإجازات والتصفيات.</p>
          </div>
          <button type="button" onClick={fetchVisas} disabled={isLoading} className="px-6 py-3 rounded-[1rem] bg-indigo-50 text-indigo-700 font-bold hover:bg-indigo-100 transition flex items-center gap-2 disabled:opacity-60">
             <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} /> تحديث السجل
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 bg-white p-2 rounded-full shadow-sm border border-slate-200">
          <TabButton active={activeTab === 'ALL'} onClick={() => setActiveTab('ALL')} label={`الكل (${visas.length})`} />
          <TabButton active={activeTab === 'PENDING'} onClick={() => setActiveTab('PENDING')} label={`بانتظار الإصدار (${visas.filter(v => v.status === 'PENDING_PAYMENT' || v.status === 'PAID').length})`} />
          <TabButton active={activeTab === 'ISSUED'} onClick={() => setActiveTab('ISSUED')} label={`مُصدرة (${visas.filter(v => v.status === 'ISSUED').length})`} />
          <TabButton active={activeTab === 'CANCELLED'} onClick={() => setActiveTab('CANCELLED')} label={`ملغاة (${visas.filter(v => v.status === 'CANCELLED').length})`} />
        </div>

        {/* Content */}
        {isLoading ? (
           <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري سحب بيانات التأشيرات...</div>
        ) : loadError ? (
           <div className="bg-white border border-rose-200 rounded-[2rem] p-12 text-center">
             <p className="text-rose-600 font-bold mb-4">{loadError}</p>
             <button type="button" onClick={fetchVisas} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
           </div>
        ) : filteredVisas.length === 0 ? (
           <div className="bg-white border border-slate-200 rounded-[2rem] p-12 text-center text-slate-500 font-bold">لا يوجد تأشيرات في هذا التبويب حالياً.</div>
        ) : (
          <div className="flex flex-col gap-4">
            {filteredVisas.map((visa) => (
              <div key={visa.id} className="bg-white rounded-[2rem] border border-slate-100 p-6 flex flex-col lg:flex-row gap-6 shadow-sm hover:shadow-xl hover:shadow-indigo-900/5 hover:-translate-y-1 transition-all duration-300 items-start lg:items-center">

                {/* Employee / Type Header */}
                <div className="flex justify-between items-start lg:w-1/4">
                  <div className="flex items-center gap-4">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 ${visa.visaType === 'خروج نهائي' ? 'bg-red-50 text-red-600' : 'bg-indigo-50 text-indigo-600'}`}>
                      {visa.visaType === 'خروج نهائي' ? <XCircle size={26} /> : <PlaneTakeoff size={26} />}
                    </div>
                    <div>
                      <h3 className="font-extrabold text-[16px] text-slate-800 tracking-tight leading-none mb-1.5">
                        {visa.employee?.firstNameArabic} {visa.employee?.lastNameArabic}
                      </h3>
                      <p className="font-bold text-[13px] text-slate-400">
                        {visa.employee?.nationality || '-'} | #{visa.employee?.employeeId}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Details */}
                <div className="bg-slate-50 rounded-2xl p-4 flex gap-6 lg:w-1/3 w-full justify-between items-center">
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">نوع الطلب</p>
                    <p className="font-extrabold text-[13px] text-slate-700">{visa.visaType}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">تاريخ الطلب</p>
                    <p className="font-extrabold text-[13px] text-slate-700">{formatDate(visa.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">المصدر (آلي)</p>
                    <p className="font-bold text-[12px] text-indigo-600 bg-indigo-50 inline-block px-2 py-0.5 rounded-lg">{visa.deductedFrom || 'من النظام'}</p>
                  </div>
                </div>

                {/* Actions & Status */}
                <div className="flex-1 flex flex-col w-full">
                  <div className="flex items-center justify-between lg:justify-end gap-4 w-full">
                    {getStatusBadge(visa.status)}

                  {(visa.status === 'PENDING_PAYMENT' || visa.status === 'PAID') && activeUploadId !== visa.id && (
                    <button
                      type="button"
                      onClick={() => { setActiveUploadId(visa.id); setAttachmentUrl(''); }}
                      className={muqeemUsableFor(visa, muqeemStatus)
                        ? 'text-[12px] font-black bg-white text-indigo-700 border border-indigo-200 px-5 py-2.5 rounded-xl hover:bg-indigo-50 transition'
                        : 'text-[12px] font-black bg-indigo-600 text-white px-5 py-2.5 rounded-xl hover:bg-indigo-700 transition'}
                      title="تسجيل إصدار تم خارج النظام برفع نسخة التأشيرة"
                    >
                      {muqeemUsableFor(visa, muqeemStatus) ? 'تسجيل إصدار يدوي' : 'متابعة الإصدار'} <PlaneTakeoff size={14} className="inline ml-1" />
                    </button>
                  )}
                </div>

                {visa.visaType === EXIT_REENTRY_VISA_TYPE && visa.muqeem && (
                  <MuqeemVisaPanel visa={visa} status={muqeemStatus} onChanged={fetchVisas} />
                )}

                {/* Upload Form (Expandable) */}
                {activeUploadId === visa.id && (
                  <div className="mt-4 p-4 bg-indigo-50/50 border border-indigo-100 rounded-[1rem] animate-in fade-in zoom-in duration-200">
                    <label className="text-[11px] font-extrabold text-indigo-800 block mb-2">
                       مرفق التأشيرة الصادرة <span className="text-red-500">*</span>
                    </label>
                    <div className="mb-4 bg-white rounded-xl">
                      <FileUploadField
                        name="visaAttachment"
                        value={attachmentUrl}
                        onChange={(e) => setAttachmentUrl(e.target.value)}
                        label="استعرض مساحة جهازك لرفع نسخة التأشيرة الصادرة *"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleIssueVisa(visa.id)}
                        disabled={!attachmentUrl || isIssuing}
                        className={`flex-1 text-white text-[12px] font-black py-2.5 rounded-xl transition ${attachmentUrl && !isIssuing ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-slate-300 cursor-not-allowed'}`}
                      >
                        {isIssuing ? 'جاري الحفظ...' : 'حفظ المرفق والإصدار والتحويل للمالية'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveUploadId(null)}
                        className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-[12px] font-bold rounded-xl transition"
                      >
                        إلغاء
                      </button>
                    </div>
                  </div>
                )}

                {/* View Attachment if ISSUED */}
                {visa.status === 'ISSUED' && visa.attachmentUrl && (
                  <div className="mt-4 pt-4 border-t border-slate-100">
                     <a href={visa.attachmentUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full py-2 bg-slate-50 hover:bg-slate-100 text-indigo-600 border border-slate-200 rounded-xl text-[12px] font-extrabold transition">
                        عـرض مرفق التأشيرة (المستند)
                     </a>
                  </div>
                )}

                {/* Flight Ticket Booking Section for Exit-Reentry Visas */}
                {visa.visaType === 'خروج وعودة' && visa.status === 'ISSUED' && (
                  <div className="mt-4 p-5 bg-sky-50/70 border border-sky-200 rounded-2xl space-y-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Plane size={18} className="text-sky-600" />
                      <h4 className="font-black text-sky-900 text-[13px]">حجز تذكرة الطيران</h4>
                    </div>
                    {visa.ticketStatus === 'BOOKED' ? (
                      <div className="bg-white rounded-xl p-4 border border-sky-100 space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] font-bold text-slate-500">الناقل / رقم الحجز</span>
                          <span className="font-black text-slate-800 text-[12px]">{visa.airline || '-'} | {visa.bookingRef || '-'}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] font-bold text-slate-500">المسار</span>
                          <span className="font-bold text-slate-700 text-[12px]">{visa.flightFrom || '-'} → {visa.flightTo || '-'}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] font-bold text-slate-500">تاريخ الذهاب / العودة</span>
                          <span className="font-bold text-slate-700 text-[12px]">{visa.departureDate ? formatDate(visa.departureDate) : '-'} | {visa.returnDate ? formatDate(visa.returnDate) : '-'}</span>
                        </div>
                        {visa.ticketAttachmentUrl && (
                          <div className="pt-2 border-t border-sky-100">
                             <a href={visa.ticketAttachmentUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full py-2 bg-sky-50 hover:bg-sky-100 text-sky-600 border border-sky-200 rounded-xl text-[12px] font-extrabold transition">
                                عـرض مرفق التذكرة
                             </a>
                          </div>
                        )}
                        <div className="flex items-center justify-center mt-2">
                          <span className="bg-emerald-100 text-emerald-700 px-4 py-1.5 rounded-full text-[11px] font-black flex items-center gap-1"><CheckCircle size={14}/> تم الحجز ✈️</span>
                        </div>
                      </div>
                    ) : (
                      <TicketBookingForm visa={visa} onSaved={fetchVisas} />
                    )}
                  </div>
                )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// Muqeem (مقيم): official exit/re-entry visa actions
// ---------------------------------------------------------------------------

/** True when this visa can be issued / managed through Muqeem by the current user. */
function muqeemUsableFor(visa: Visa, status: MuqeemIntegrationStatus | null): boolean {
  return !!status?.usable && !!status.canOperate && visa.visaType === EXIT_REENTRY_VISA_TYPE && !!visa.muqeem?.eligible;
}

function gregAndHijri(d: string | null | undefined): string {
  const key = toDateKey(d);
  if (!key) return '-';
  const h = safeHijri(key);
  return `${formatDate(key)}${h ? ` (${h} هـ)` : ''}`;
}

interface MuqeemPostResult {
  ok: boolean;
  status: number;
  message: string;
  alreadyDone: boolean;
  kind: string | null;
}

async function postMuqeem(body: Record<string, unknown>): Promise<MuqeemPostResult | null> {
  try {
    const res = await fetch('/api/visas/muqeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { window.location.href = '/login'; return null; }
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; alreadyDone?: boolean; details?: { muqeemKind?: string } };
    return {
      ok: res.ok,
      status: res.status,
      message: data.message || data.error || (res.ok ? 'تم' : 'تعذر تنفيذ الطلب'),
      alreadyDone: !!data.alreadyDone,
      kind: data.details?.muqeemKind ?? null,
    };
  } catch {
    toast.error('تعذر الاتصال بالخادم. لا تُعِد المحاولة قبل تحديث الصفحة والتحقق من حالة العملية.');
    return null;
  }
}

const TX_TONE_CLASS: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  pending: 'bg-sky-100 text-sky-700',
  unknown: 'bg-amber-100 text-amber-800',
  failed: 'bg-rose-100 text-rose-700',
};

const MQ_INPUT = 'px-3 py-2 bg-white border border-teal-200 rounded-xl text-[12px] font-bold text-slate-800 focus:outline-none focus:border-teal-400';

function MuqeemVisaPanel({ visa, status, onChanged }: { visa: Visa; status: MuqeemIntegrationStatus | null; onChanged: () => void }) {
  const info = visa.muqeem as VisaMuqeemInfo;
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'issue' | 'extend'>(null);
  const [visaType, setVisaType] = useState<VisaMuqeemType>(1);
  const [mode, setMode] = useState<'days' | 'date'>(info.suggestion ? 'date' : 'days');
  const [days, setDays] = useState(info.suggestion ? '' : '30');
  const [date, setDate] = useState(info.suggestion?.date ?? '');

  const employeeName = `${visa.employee?.firstNameArabic ?? ''} ${visa.employee?.lastNameArabic ?? ''}`.trim();
  const issuedViaMuqeem = visa.status === 'ISSUED' && !!visa.externalVisaNumber;
  const canOperate = !!status?.canOperate;
  const blockingTx = info.transactions.find((t) => txStatusView(t).blocking);
  const disabledReason = !status
    ? 'جاري التحقق من حالة الربط مع مقيم...'
    : status.reason ?? info.reason ??
      (blockingTx ? 'يوجد طلب سابق على مقيم لهذه التأشيرة لم تُحسم نتيجته بعد؛ لا تُعِد المحاولة قبل تسويته (أدناه).' : null) ??
      (info.pendingSync ? 'توجد نتيجة عملية مقيم لم تُطبَّق على بيانات التأشيرة بعد؛ اضغط «تحديث بيانات التأشيرة» أولاً.' : null);
  const actionsEnabled = !disabledReason && !busy;
  const durationInput: DurationInput = mode === 'days' ? { mode: 'days', days: Number(days) } : { mode: 'date', returnBefore: date };

  const openForm = (f: 'issue' | 'extend') => {
    setForm(f);
    if (f === 'extend') { setMode('days'); setDays('30'); setDate(''); }
    else { setMode(info.suggestion ? 'date' : 'days'); setDays(info.suggestion ? '' : '30'); setDate(info.suggestion?.date ?? ''); }
  };

  const finish = (r: MuqeemPostResult | null) => {
    if (!r) { onChanged(); return; }
    if (r.ok) {
      if (r.alreadyDone) toast.info(r.message); else toast.success(r.message);
      setForm(null);
    } else if (r.kind === 'UNKNOWN_OUTCOME') {
      toast.warning(r.message);
    } else {
      toast.error(r.message);
    }
    // Always refresh: the transaction badge (FAILED / UNKNOWN / SUCCEEDED) is part of the answer.
    onChanged();
  };

  const run = async (label: string, body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(label);
    try {
      finish(await postMuqeem({ visaId: visa.id, ...body }));
    } finally {
      setBusy(null);
    }
  };

  const submitIssue = async () => {
    const plan = planIssue(durationInput, todayKey());
    if (!plan.ok) { toast.error(plan.error); return; }
    const p = plan.value;
    const hijri = safeHijri(p.expectedReturnBefore);
    const durationLine = p.visaDuration !== undefined
      ? `المدة: ${p.visaDuration} يوماً (العودة قبل ${formatDate(p.expectedReturnBefore)}${hijri ? ` / ${hijri} هـ` : ''} تقريباً؛ تحسبه مقيم من تاريخ الإصدار)`
      : `العودة قبل: ${formatDate(p.expectedReturnBefore)} الموافق ${p.returnBeforeHijri} هـ (${p.days} يوماً من اليوم)`;
    const ok = await confirmDialog(
      [
        'سيتم إصدار تأشيرة خروج وعودة حقيقية في منصة مقيم (المديرية العامة للجوازات) باسم الموظف، وليس مجرد تسجيل في النظام.',
        '',
        `الموظف: ${employeeName}`,
        `حساب مقيم المستخدم: ${info.company?.name ?? '-'}`,
        `نوع التأشيرة: ${VISA_MUQEEM_TYPE_LABEL[visaType]}`,
        durationLine,
        '',
        'قد تُخصم رسوم حكومية من رصيد المنشأة في مقيم عند الإصدار. لا يمكن التراجع عن الإصدار إلا بإلغاء التأشيرة في مقيم.',
      ].join('\n'),
      { title: 'تأكيد الإصدار عبر مقيم', confirmText: 'نعم، أصدر التأشيرة في مقيم', cancelText: 'تراجع' },
    );
    if (!ok) return;
    await run('issue', { action: 'ISSUE', confirm: true, visaType, ...durationInput });
  };

  const submitExtend = async () => {
    const base = toDateKey(visa.returnBefore);
    const plan = planExtension(base, durationInput);
    if (!plan.ok || !base) { toast.error(plan.ok ? 'تاريخ العودة الحالي غير معروف' : plan.error); return; }
    const p = plan.value;
    const ok = await confirmDialog(
      [
        `سيتم تمديد تأشيرة الخروج والعودة رقم ${visa.externalVisaNumber} في منصة مقيم (إجراء حقيقي في الجوازات).`,
        '',
        `الموظف: ${employeeName}`,
        `العودة قبل حالياً: ${gregAndHijri(base)}`,
        `العودة قبل بعد التمديد: ${formatDate(p.newReturnBefore)} (${p.newReturnBeforeHijri} هـ)`,
        `مدة التمديد: ${p.extraDays} يوماً`,
        '',
        'قد تُخصم رسوم تمديد حكومية من رصيد المنشأة في مقيم.',
      ].join('\n'),
      { title: 'تأكيد التمديد عبر مقيم', confirmText: 'نعم، مدّد التأشيرة في مقيم', cancelText: 'تراجع' },
    );
    if (!ok) return;
    await run('extend', { action: 'EXTEND', confirm: true, baseReturnBefore: base, ...durationInput });
  };

  const submitCancel = async () => {
    const ok = await confirmDialog(
      [
        `سيتم إلغاء تأشيرة الخروج والعودة رقم ${visa.externalVisaNumber} في منصة مقيم (إجراء حقيقي في الجوازات) للموظف ${employeeName}.`,
        '',
        'لا يمكن التراجع عن الإلغاء من النظام: إذا احتاج الموظف للسفر لاحقاً يلزم إصدار تأشيرة جديدة قد تترتب عليها رسوم جديدة.',
        'لا يُنشئ هذا الإجراء أي استرداد للرسوم المدفوعة في النظام، وستصبح حالة التأشيرة «ملغاة».',
      ].join('\n'),
      { title: 'تأكيد إلغاء التأشيرة في مقيم', confirmText: 'نعم، ألغِ التأشيرة في مقيم', cancelText: 'تراجع', danger: true },
    );
    if (!ok) return;
    await run('cancel', { action: 'CANCEL', confirm: true });
  };

  const submitReprint = async () => {
    const ok = await confirmDialog(
      [
        `سيتم طلب نسخة جديدة من التأشيرة رقم ${visa.externalVisaNumber} من منصة مقيم وحفظها في ملف الموظف.`,
        'لا يغيّر هذا الطلب التأشيرة نفسها، ولا تذكر مواصفة مقيم رسوماً لإعادة الطباعة.',
      ].join('\n'),
      { title: 'إعادة طباعة التأشيرة من مقيم', confirmText: 'متابعة', cancelText: 'تراجع' },
    );
    if (!ok) return;
    await run('reprint', { action: 'REPRINT', confirm: true });
  };

  const reconcile = async (tx: MuqeemTx, outcome: 'SUCCEEDED' | 'FAILED') => {
    const op = VISA_MUQEEM_OPERATION_LABEL[tx.operation as VisaMuqeemOperation] ?? tx.operation;
    let externalRef: string | null = null;
    if (outcome === 'SUCCEEDED' && tx.operation === 'EXIT_REENTRY_ISSUE') {
      externalRef = await promptDialog('أدخل رقم التأشيرة كما يظهر في مقيم (تقرير الخدمات التفاعلية أو سجل تأشيرات الموظف):', {
        title: 'تسجيل الإصدار كمنفَّذ',
        placeholder: 'رقم التأشيرة',
        confirmText: 'متابعة',
        cancelText: 'تراجع',
      });
      if (externalRef === null) return;
      externalRef = externalRef.trim();
      if (!/^\d+$/.test(externalRef)) { toast.error('رقم التأشيرة يجب أن يتكون من أرقام فقط'); return; }
    }
    const ok = await confirmDialog(
      outcome === 'SUCCEEDED'
        ? `ستُسجَّل عملية «${op}» على أنها نُفِّذت فعلاً في مقيم${externalRef ? ` (رقم التأشيرة ${externalRef})` : ''}، وتُحدَّث بيانات التأشيرة في النظام وفق ذلك.\nتأكد من ذلك في مقيم قبل المتابعة.`
        : `ستُسجَّل عملية «${op}» على أنها لم تُنفَّذ في مقيم، وسيُسمح بإعادة المحاولة.\nتأكد أولاً من مقيم أنها لم تُنفَّذ؛ وإلا فقد يؤدي إعادة الطلب إلى تنفيذها مرتين ودفع الرسوم مرتين.`,
      { title: 'تسوية عملية مقيم', confirmText: 'متابعة', cancelText: 'تراجع', danger: outcome === 'FAILED' },
    );
    if (!ok) return;
    const note = await promptDialog('اكتب كيف تحققت من النتيجة في مقيم (مثال: تقرير الخدمات التفاعلية بتاريخ اليوم، رقم الطلب ...):', {
      title: 'ملاحظة التسوية (إلزامية)',
      placeholder: 'ملاحظة التحقق',
      confirmText: 'تأكيد التسوية',
      cancelText: 'تراجع',
    });
    if (note === null) return;
    if (note.trim().length < 3) { toast.error('اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم'); return; }
    await run('reconcile', { action: 'RECONCILE', muqeemTransactionId: tx.id, outcome, externalRef, note: note.trim() });
  };

  const syncFromTransactions = async () => {
    const op = info.pendingSync ? VISA_MUQEEM_OPERATION_LABEL[info.pendingSync] : '';
    const ok = await confirmDialog(
      `سيتم تحديث بيانات التأشيرة في النظام وفق نتيجة عملية «${op}» المسجلة كمنفَّذة في مقيم. لن يُرسل أي طلب إلى مقيم.`,
      { title: 'تحديث بيانات التأشيرة', confirmText: 'تحديث', cancelText: 'تراجع' },
    );
    if (!ok) return;
    await run('sync', { action: 'SYNC' });
  };

  const issuePreview = form === 'issue' ? planIssue(durationInput, todayKey()) : null;
  const extendPreview = form === 'extend' ? planExtension(visa.returnBefore, durationInput) : null;

  return (
    <div className="mt-4 p-4 bg-teal-50/60 border border-teal-200 rounded-2xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-black text-teal-900 text-[13px] flex items-center gap-2"><Landmark size={16} className="text-teal-600" /> التأشيرة الرسمية عبر منصة مقيم</h4>
        {info.company && (
          <span className={`px-2.5 py-1 rounded-full text-[10px] font-black ${info.company.linked ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-600'}`}>
            {info.company.name} · {info.company.linked ? 'مربوطة بمقيم' : 'غير مربوطة بمقيم'}
          </span>
        )}
      </div>

      {visa.externalVisaNumber && (
        <div className="bg-white rounded-xl p-3 border border-teal-100 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
          <div className="flex justify-between gap-2"><span className="font-bold text-slate-500">رقم التأشيرة</span><span className="font-black text-slate-800" dir="ltr">{visa.externalVisaNumber}</span></div>
          <div className="flex justify-between gap-2"><span className="font-bold text-slate-500">المدة</span><span className="font-black text-slate-800">{visa.visaDurationDays ? `${visa.visaDurationDays} يوماً` : '-'}</span></div>
          <div className="flex justify-between gap-2 sm:col-span-2"><span className="font-bold text-slate-500">العودة قبل</span><span className="font-black text-slate-800">{gregAndHijri(visa.returnBefore)}</span></div>
          {visa.issuedViaMuqeemAt && (
            <div className="flex justify-between gap-2 sm:col-span-2"><span className="font-bold text-slate-500">تاريخ الإصدار عبر مقيم</span><span className="font-bold text-slate-700">{formatDateTime(visa.issuedViaMuqeemAt)}</span></div>
          )}
          {visa.visaPdfUrl ? (
            <a href={visa.visaPdfUrl} target="_blank" rel="noopener noreferrer" className="sm:col-span-2 flex items-center justify-center gap-2 py-2 bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 rounded-xl font-extrabold transition">
              <FileText size={14} /> عرض نسخة التأشيرة (PDF من مقيم)
            </a>
          ) : (
            <p className="sm:col-span-2 text-[11px] font-bold text-slate-500">لا توجد نسخة PDF محفوظة؛ استخدم «إعادة طباعة» لجلبها من مقيم.</p>
          )}
        </div>
      )}

      {info.pendingSync && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 space-y-2">
          <p className="text-[11px] font-bold text-sky-900 leading-5">
            عملية «{VISA_MUQEEM_OPERATION_LABEL[info.pendingSync]}» مسجلة كمنفَّذة في مقيم (غالباً بعد تسوية) لكن بيانات التأشيرة في النظام لم تُحدَّث بعد.
          </p>
          {canOperate && (
            <button type="button" onClick={syncFromTransactions} disabled={!!busy}
              className="text-[11px] font-black bg-sky-600 text-white px-3 py-1.5 rounded-lg hover:bg-sky-700 disabled:opacity-50">
              تحديث بيانات التأشيرة
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      {canOperate && visa.status === 'PAID' && !visa.externalVisaNumber && form !== 'issue' && (
        <button type="button" onClick={() => openForm('issue')} disabled={!actionsEnabled}
          className="w-full sm:w-auto text-[12px] font-black bg-teal-600 text-white px-5 py-2.5 rounded-xl hover:bg-teal-700 transition disabled:bg-slate-300 disabled:cursor-not-allowed flex items-center justify-center gap-2">
          <Landmark size={14} /> إصدار عبر مقيم
        </button>
      )}
      {canOperate && visa.status === 'PENDING_PAYMENT' && (
        <p className="text-[11px] font-bold text-slate-600">الإصدار عبر مقيم يتاح بعد أن تؤكد الإدارة المالية سداد رسوم التأشيرة.</p>
      )}
      {canOperate && issuedViaMuqeem && !form && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => openForm('extend')} disabled={!actionsEnabled}
            className="text-[12px] font-black bg-white text-teal-700 border border-teal-300 px-4 py-2 rounded-xl hover:bg-teal-50 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
            <CalendarPlus size={14} /> تمديد
          </button>
          <button type="button" onClick={submitReprint} disabled={!actionsEnabled}
            className="text-[12px] font-black bg-white text-slate-700 border border-slate-300 px-4 py-2 rounded-xl hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
            <Printer size={14} /> {busy === 'reprint' ? 'جاري الطلب...' : 'إعادة طباعة'}
          </button>
          <button type="button" onClick={submitCancel} disabled={!actionsEnabled}
            className="text-[12px] font-black bg-white text-rose-700 border border-rose-300 px-4 py-2 rounded-xl hover:bg-rose-50 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
            <Ban size={14} /> {busy === 'cancel' ? 'جاري الإلغاء...' : 'إلغاء التأشيرة'}
          </button>
        </div>
      )}
      {(visa.status === 'PAID' || issuedViaMuqeem) && disabledReason && status && (
        <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
          <ShieldAlert size={14} className="shrink-0 mt-0.5" /> <span>إجراءات مقيم غير متاحة: {disabledReason}</span>
        </p>
      )}

      {/* Issue / extend form */}
      {form && (
        <div className="bg-white rounded-xl p-4 border border-teal-200 space-y-3">
          <p className="text-[12px] font-black text-teal-900">{form === 'issue' ? 'بيانات إصدار التأشيرة في مقيم' : `تمديد التأشيرة ${visa.externalVisaNumber}`}</p>
          {form === 'issue' && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[11px] font-bold text-slate-600">نوع التأشيرة:</span>
              {([1, 2] as VisaMuqeemType[]).map((t) => (
                <label key={t} className={`px-3 py-1.5 rounded-xl border text-[12px] font-black cursor-pointer ${visaType === t ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-700 border-slate-200'}`}>
                  <input type="radio" name={`vtype-${visa.id}`} className="sr-only" checked={visaType === t} onChange={() => setVisaType(t)} />
                  {VISA_MUQEEM_TYPE_LABEL[t]}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[11px] font-bold text-slate-600">{form === 'issue' ? 'تحديد المدة:' : 'التمديد:'}</span>
            <label className="text-[12px] font-bold text-slate-700 flex items-center gap-1">
              <input type="radio" name={`mode-${visa.id}`} checked={mode === 'days'} onChange={() => setMode('days')} /> {form === 'issue' ? 'عدد الأيام' : 'أيام إضافية'}
            </label>
            <label className="text-[12px] font-bold text-slate-700 flex items-center gap-1">
              <input type="radio" name={`mode-${visa.id}`} checked={mode === 'date'} onChange={() => setMode('date')} /> {form === 'issue' ? 'العودة قبل تاريخ' : 'تاريخ عودة جديد'}
            </label>
          </div>
          {mode === 'days' ? (
            <input type="number" min={MIN_VISA_DAYS} step={1} inputMode="numeric" aria-label="عدد الأيام" value={days} onChange={(e) => setDays(e.target.value)} className={`${MQ_INPUT} w-40`} />
          ) : (
            <input type="date" aria-label="العودة قبل" value={date} onChange={(e) => setDate(e.target.value)} className={`${MQ_INPUT} w-48`} />
          )}
          {form === 'issue' && info.suggestion && (
            <p className="text-[11px] font-bold text-slate-500">
              مقترح: {gregAndHijri(info.suggestion.date)} = {info.suggestion.source === 'leave' ? 'نهاية الإجازة المرتبطة' : 'تاريخ عودة التذكرة'} ({formatDate(info.suggestion.baseDate)}) + {info.suggestion.marginDays} يوماً احتياطاً.
            </p>
          )}
          {form === 'issue' && issuePreview && (
            issuePreview.ok ? (
              <p className="text-[11px] font-bold text-teal-800">
                {issuePreview.value.returnBeforeHijri
                  ? `سيُرسل إلى مقيم: العودة قبل ${issuePreview.value.returnBeforeHijri} هـ (${issuePreview.value.days} يوماً من اليوم).`
                  : `سيُرسل إلى مقيم: مدة ${issuePreview.value.visaDuration} يوماً (العودة قبل ${gregAndHijri(issuePreview.value.expectedReturnBefore)} تقريباً).`}
              </p>
            ) : <p className="text-[11px] font-bold text-rose-600">{issuePreview.error}</p>
          )}
          {form === 'extend' && extendPreview && (
            extendPreview.ok ? (
              <p className="text-[11px] font-bold text-teal-800">
                العودة قبل حالياً {gregAndHijri(visa.returnBefore)} ← بعد التمديد {formatDate(extendPreview.value.newReturnBefore)} ({extendPreview.value.newReturnBeforeHijri} هـ)، بزيادة {extendPreview.value.extraDays} يوماً.
              </p>
            ) : <p className="text-[11px] font-bold text-rose-600">{extendPreview.error}</p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={form === 'issue' ? submitIssue : submitExtend} disabled={!actionsEnabled}
              className="flex-1 text-white text-[12px] font-black py-2.5 rounded-xl transition bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 disabled:cursor-not-allowed">
              {busy ? 'جاري التنفيذ في مقيم...' : form === 'issue' ? 'متابعة الإصدار في مقيم' : 'متابعة التمديد في مقيم'}
            </button>
            <button type="button" onClick={() => setForm(null)} disabled={!!busy} className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-[12px] font-bold rounded-xl transition disabled:opacity-50">
              إغلاق
            </button>
          </div>
        </div>
      )}

      {/* Muqeem transactions of this visa */}
      {info.transactions.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-black text-slate-500">سجل العمليات على مقيم</p>
          {info.transactions.map((tx) => {
            const view = txStatusView(tx);
            const op = VISA_MUQEEM_OPERATION_LABEL[tx.operation as VisaMuqeemOperation] ?? tx.operation;
            return (
              <div key={tx.id} className="bg-white rounded-xl border border-slate-100 p-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] font-black text-slate-800">{op}</span>
                  <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black ${TX_TONE_CLASS[view.tone]}`}>{view.label}</span>
                </div>
                <p className="text-[11px] font-bold text-slate-500">
                  {formatDateTime(tx.createdAt)}{tx.externalRef ? ` · المرجع: ${tx.externalRef}` : ''}
                </p>
                {tx.error && tx.status !== 'SUCCEEDED' && <p className="text-[11px] font-bold text-rose-700">{tx.error}</p>}
                {tx.status === 'PENDING' && !view.needsReconcile && (
                  <p className="text-[11px] font-bold text-sky-700">الطلب قيد التنفيذ؛ لا تُعِد المحاولة، حدّث الصفحة بعد قليل.</p>
                )}
                {view.needsReconcile && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 space-y-2">
                    <p className="text-[11px] font-bold text-amber-900 leading-5">
                      نتيجة هذه العملية غير معروفة: ربما نُفِّذت في مقيم. لا تُعِد المحاولة. تحقق من «تقرير الخدمات التفاعلية» أو سجل تأشيرات الموظف في بوابة مقيم، ثم سجّل النتيجة هنا (تسوية).
                    </p>
                    {canOperate && (
                      <div className="flex flex-wrap gap-2">
                        {tx.operation !== 'EXIT_REENTRY_REPRINT' && (
                          <button type="button" disabled={!!busy} onClick={() => reconcile(tx, 'SUCCEEDED')}
                            className="text-[11px] font-black bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50">
                            نُفِّذت في مقيم
                          </button>
                        )}
                        <button type="button" disabled={!!busy} onClick={() => reconcile(tx, 'FAILED')}
                          className="text-[11px] font-black bg-white text-rose-700 border border-rose-300 px-3 py-1.5 rounded-lg hover:bg-rose-50 disabled:opacity-50">
                          لم تُنفَّذ في مقيم
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TICKET_INPUT = 'px-3 py-2 bg-white border border-sky-200 rounded-xl text-[12px] font-bold text-slate-800 focus:outline-none focus:border-sky-400';

function TicketBookingForm({ visa, onSaved }: { visa: Visa; onSaved: () => void }) {
  const [ticket, setTicket] = useState({
    airline: visa.airline || '',
    bookingRef: visa.bookingRef || '',
    flightFrom: visa.flightFrom || '',
    flightTo: visa.flightTo || '',
    departureDate: toDateInputValue(visa.departureDate),
    returnDate: toDateInputValue(visa.returnDate),
    ticketAttachmentUrl: visa.ticketAttachmentUrl || '',
  });
  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    if (isSaving) return;
    if (!ticket.airline.trim() || !ticket.bookingRef.trim()) { toast.error('يرجى إدخال شركة الطيران ورقم الحجز على الأقل'); return; }
    if (!ticket.ticketAttachmentUrl) { toast.error('يرجى إرفاق تذكرة الطيران'); return; }
    if (ticket.departureDate && ticket.returnDate && ticket.returnDate < ticket.departureDate) { toast.error('تاريخ العودة يجب أن يكون بعد تاريخ الذهاب'); return; }

    setIsSaving(true);
    try {
      const res = await fetch('/api/visas/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visaId: visa.id, action: 'BOOK_TICKET', ...ticket })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حفظ بيانات الحجز')); return; }
      const data = await res.json().catch(() => ({}));
      toast.success(data?.message || 'تم حفظ بيانات الحجز');
      onSaved();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-bold text-sky-700">يرجى إدخال بيانات حجز التذكرة للموظف:</p>
      <div className="grid grid-cols-2 gap-3">
        <input type="text" placeholder="شركة الطيران" aria-label="شركة الطيران" value={ticket.airline} onChange={(e) => setTicket({ ...ticket, airline: e.target.value })} className={TICKET_INPUT} />
        <input type="text" placeholder="رقم الحجز" aria-label="رقم الحجز" value={ticket.bookingRef} onChange={(e) => setTicket({ ...ticket, bookingRef: e.target.value })} className={TICKET_INPUT} />
        <input type="text" placeholder="من (المدينة)" aria-label="من (المدينة)" value={ticket.flightFrom} onChange={(e) => setTicket({ ...ticket, flightFrom: e.target.value })} className={TICKET_INPUT} />
        <input type="text" placeholder="إلى (المدينة)" aria-label="إلى (المدينة)" value={ticket.flightTo} onChange={(e) => setTicket({ ...ticket, flightTo: e.target.value })} className={TICKET_INPUT} />
        <input type="date" aria-label="تاريخ الذهاب" value={ticket.departureDate} onChange={(e) => setTicket({ ...ticket, departureDate: e.target.value })} className={TICKET_INPUT} />
        <input type="date" aria-label="تاريخ العودة" min={ticket.departureDate || undefined} value={ticket.returnDate} onChange={(e) => setTicket({ ...ticket, returnDate: e.target.value })} className={TICKET_INPUT} />
      </div>
      <div className="col-span-2">
        <label className="text-[11px] font-extrabold text-sky-800 block mb-1">
           مرفق تذكرة الطيران <span className="text-red-500">*</span>
        </label>
        <FileUploadField
          name={`ticketAttach-${visa.id}`}
          value={ticket.ticketAttachmentUrl}
          onChange={(e) => setTicket((prev) => ({ ...prev, ticketAttachmentUrl: e.target.value }))}
          label="رفع ملف التذكرة (PDF أو صورة)"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={isSaving}
        className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-black text-[12px] rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50"
      >
        <Plane size={14} /> {isSaving ? 'جاري الحفظ...' : 'حفظ بيانات الحجز'}
      </button>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-6 py-2.5 rounded-full text-[13px] font-black transition-all ${
        active ? 'bg-slate-900 text-white shadow-md' : 'bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'
      }`}
    >
      {label}
    </button>
  );
}

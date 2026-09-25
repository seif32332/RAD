"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Plane, CheckCircle, Clock, PlaneTakeoff, XCircle, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import { toast, readApiError } from '@/components/ui/feedback';
import { formatDate, toDateInputValue } from '@/lib/dates';

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
                      className="text-[12px] font-black bg-indigo-600 text-white px-5 py-2.5 rounded-xl hover:bg-indigo-700 transition"
                    >
                      متابعة الإصدار <PlaneTakeoff size={14} className="inline ml-1" />
                    </button>
                  )}
                </div>

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

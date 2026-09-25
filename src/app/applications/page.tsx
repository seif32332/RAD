"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { Users, FileText, CalendarCheck, FileSignature, CheckCircle, XCircle, Clock, UploadCloud, Phone, Mail, RefreshCw, ExternalLink } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import FileUploadField from '@/components/FileUploadField';
import QRCode from 'qrcode';
import { toast, readApiError } from '@/components/ui/feedback';
import Modal, { type ModalTone } from '@/components/ui/Modal';
import { formatDateShort, formatDateTime } from '@/lib/dates';
import { useRole } from '@/context/RoleContext';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';

interface ActiveJob {
  id: string;
  jobTitle: string;
  department?: { nameArabic?: string } | null;
}

interface Application {
  id: string;
  status: string;
  candidateName: string;
  candidatePhone: string;
  candidateEmail?: string | null;
  resumeUrl?: string | null;
  notes?: string | null;
  interviewDate?: string | null;
  createdAt: string;
  jobRequest?: { jobTitle?: string | null; department?: { nameArabic?: string | null } | null } | null;
}

type PipelineColor = 'indigo' | 'amber' | 'blue' | 'fuchsia' | 'emerald' | 'rose';

/** Static class lists (Tailwind cannot see dynamically built class names). */
const PIPELINE_COLORS: Record<PipelineColor, { active: string; countBorder: string }> = {
  indigo: { active: 'bg-indigo-100 border-indigo-200 text-indigo-800', countBorder: 'border-indigo-100' },
  amber: { active: 'bg-amber-100 border-amber-200 text-amber-800', countBorder: 'border-amber-100' },
  blue: { active: 'bg-blue-100 border-blue-200 text-blue-800', countBorder: 'border-blue-100' },
  fuchsia: { active: 'bg-fuchsia-100 border-fuchsia-200 text-fuchsia-800', countBorder: 'border-fuchsia-100' },
  emerald: { active: 'bg-emerald-100 border-emerald-200 text-emerald-800', countBorder: 'border-emerald-100' },
  rose: { active: 'bg-rose-100 border-rose-200 text-rose-800', countBorder: 'border-rose-100' },
};

/** Log lines appended by HR on each stage move: "[2026-09-25 14:05 · الكاتب · المرحلة] …". */
const NOTE_LOG_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /;

/** First line of what the candidate (or HR on a manual CV) wrote, e.g. "الراتب المتوقع: 4500 ر.س". */
function candidateHeadline(notes: string | null | undefined): string | null {
  const first = (notes ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first || NOTE_LOG_LINE.test(first)) return null;
  return first;
}

const STATUS_MODAL: Record<string, { title: string; tone: ModalTone; submit: string }> = {
  INTERVIEW: { title: 'تحديد موعد للمقابلة', tone: 'blue', submit: 'bg-blue-600 hover:bg-blue-700' },
  OFFERED: { title: 'طرح العرض الوظيفي للمرشح', tone: 'indigo', submit: 'bg-fuchsia-600 hover:bg-fuchsia-700' },
  HIRED: { title: 'اعتماد التوظيف ونقل الملف للأرشيف', tone: 'emerald', submit: 'bg-emerald-600 hover:bg-emerald-700' },
  REJECTED: { title: 'استبعاد نهائي من الفرز', tone: 'rose', submit: 'bg-rose-600 hover:bg-rose-700' },
};

const EMPTY_STATUS_FORM = { status: '', interviewDate: '', notes: '', offerText: '' };

const EMPTY_APP_FORM = {
  jobRequestId: '',
  candidateName: '',
  candidatePhone: '',
  candidateEmail: '',
  resumeUrl: '',
  notes: ''
};

export default function ATSApplicationsPage() {
  const { role } = useRole();
  // Every action on this page (and GET /api/applications itself) is HR-only on the server.
  const canManage = roleIn(role, ROLE_GROUPS.HR);
  const [activeTab, setActiveTab] = useState('ALL'); // ALL, APPLIED, INTERVIEW, OFFERED, HIRED, REJECTED
  const [applications, setApplications] = useState<Application[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Modal for changing status
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);
  const [statusForm, setStatusForm] = useState(EMPTY_STATUS_FORM);
  // OFFERED goes through a preview of the exact offer text before it is saved and e-mailed.
  const [offerStep, setOfferStep] = useState<'edit' | 'preview'>('edit');

  // Add Application Form
  const [showAddModal, setShowAddModal] = useState(false);
  const [appForm, setAppForm] = useState(EMPTY_APP_FORM);

  // QR Modal State
  const [showQRModal, setShowQRModal] = useState(false);
  const [qrJobId, setQrJobId] = useState('');
  // QR image generated locally, so no third-party QR service ever receives the apply link.
  const [qrImage, setQrImage] = useState<{ jobId: string; url: string } | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/applications');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        const msg = await readApiError(res, 'تعذر تحميل السير الذاتية');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      const data = await res.json();
      setApplications(Array.isArray(data?.applications) ? data.applications : []);
      if (Array.isArray(data?.activeJobs)) {
          const jobs: ActiveJob[] = data.activeJobs;
          setActiveJobs(jobs);
          setAppForm(prev => (prev.jobRequestId || jobs.length === 0 ? prev : { ...prev, jobRequestId: jobs[0].id }));
      }
    } catch {
      setLoadError('تعذر الاتصال بالخادم');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAddNewApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!appForm.jobRequestId) { toast.error('يرجى اختيار الشاغر الوظيفي المفتوح'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appForm)
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر حفظ السيرة الذاتية')); return; }
      const data = await res.json().catch(() => ({}));

      toast.success(data?.message || 'تم حفظ السيرة الذاتية');
      setShowAddModal(false);
      setAppForm(prev => ({ ...EMPTY_APP_FORM, jobRequestId: prev.jobRequestId }));
      fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedApp || isSubmitting) return;
    const isOffer = statusForm.status === 'OFFERED';
    if (isOffer && !statusForm.offerText.trim()) { toast.error('يرجى كتابة نص العرض الوظيفي'); return; }
    if (isOffer && offerStep === 'edit') { setOfferStep('preview'); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            actionType: 'UPDATE_STATUS',
            payload: {
                id: selectedApp.id,
                status: statusForm.status,
                // datetime-local value; the server interprets it as Riyadh time.
                interviewDate: statusForm.status === 'INTERVIEW' ? statusForm.interviewDate : undefined,
                notes: statusForm.notes,
                offerText: isOffer ? statusForm.offerText : undefined
            }
        })
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) { toast.error(await readApiError(res, 'تعذر تحديث حالة المرشح')); return; }
      const data = await res.json().catch(() => ({}));

      const message = data?.message || 'تم تحديث حالة المرشح';
      // The offer e-mail may fail without failing the update: show that as a warning.
      if (data?.emailStatus && data.emailStatus !== 'SENT' && data.emailStatus !== 'NOT_REQUIRED') toast.warning(message);
      else toast.success(message);
      setShowStatusModal(false);
      fetchData();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openStatusModal = (app: Application, targetStatus: string) => {
      setSelectedApp(app);
      // Never pre-filled from the stored notes: they are internal and hold what the candidate wrote.
      setStatusForm({ ...EMPTY_STATUS_FORM, status: targetStatus });
      setOfferStep('edit');
      setShowStatusModal(true);
  };

  const applyUrl = (jobId: string) => (typeof window !== 'undefined' ? `${window.location.origin}/apply/${jobId}` : '');

  useEffect(() => {
    if (!showQRModal || !qrJobId) return;
    let cancelled = false;
    QRCode.toDataURL(`${window.location.origin}/apply/${qrJobId}`, { width: 384, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQrImage({ jobId: qrJobId, url }); })
      .catch(() => { if (!cancelled) toast.error('تعذر إنشاء رمز QR'); });
    return () => { cancelled = true; };
  }, [showQRModal, qrJobId]);

  const copyApplyLink = async () => {
    const url = applyUrl(qrJobId);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('تم نسخ الرابط بنجاح!');
    } catch {
      toast.error('تعذر النسخ، يرجى نسخ الرابط يدوياً');
    }
  };

  // Filter Pipeline
  const filteredApps = activeTab === 'ALL' ? applications : applications.filter(a => a.status === activeTab);

  // Counters
  const countNew = applications.filter(a => a.status === 'APPLIED').length;
  const countInterviews = applications.filter(a => a.status === 'INTERVIEW').length;
  const countOffers = applications.filter(a => a.status === 'OFFERED').length;

  return (
    <DashboardLayout>
       <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-12 relative overflow-hidden">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-indigo-200">
          <div>
            <h1 className="text-3xl font-black text-indigo-900 tracking-tight flex items-center gap-3">
              <span className="bg-gradient-to-br from-indigo-100 to-indigo-50 text-indigo-700 p-3 rounded-2xl border border-indigo-100 shadow-sm"><FileText size={26} /></span>
              إدارة السير الذاتية وفرزها (ATS)
            </h1>
            <p className="text-indigo-800 font-bold mt-3 text-[14px] max-w-2xl leading-relaxed">
              مسار تتبع طالبي التوظيف. ابدأ من استلام السيرة الذاتية (فرز أولي)، حولها إلى قائمة (المقابلات)، ثم وجه المرشح الفائز لـ(العرض الوظيفي)، وارشف البقية.
            </p>
          </div>

          {canManage && (
          <div className="flex flex-wrap gap-3">
             <button type="button" onClick={() => {
                if (activeJobs.length > 0) {
                    setQrJobId(activeJobs[0].id);
                    setShowQRModal(true);
                } else {
                    toast.warning("لا توجد شواغر معتمدة حالياً لإنشاء رابط التقديم.");
                }
             }} className="bg-white border-2 border-indigo-200 hover:border-indigo-400 text-indigo-700 font-black text-[13px] px-6 py-3 rounded-xl transition shadow-sm flex items-center gap-2">
                 <span className="bg-indigo-100 p-1 rounded-lg">🔗</span> نشر وإنشاء باركود الوظيفة
             </button>
             <button type="button" onClick={() => setShowAddModal(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[13px] px-8 py-3.5 rounded-xl transition shadow-lg shadow-indigo-600/20 flex flex-nowrap items-center gap-2">
                <UploadCloud size={18}/> رفع سيرة ذاتية وحفظها (CV)
             </button>
          </div>
          )}
        </div>

        {/* Pipeline Tabs Menu */}
        <div className="flex flex-wrap items-center bg-white border border-slate-200 shadow-sm rounded-xl p-2 gap-2">
          <PipelineTab active={activeTab === 'ALL'} onClick={()=>setActiveTab('ALL')} label="الكل" count={applications.length} icon={<Users size={16}/>} />
          <PipelineTab active={activeTab === 'APPLIED'} onClick={()=>setActiveTab('APPLIED')} label="شاشة الفرز المبدئي" count={countNew} icon={<Clock size={16}/>} color="amber" />
          <PipelineTab active={activeTab === 'INTERVIEW'} onClick={()=>setActiveTab('INTERVIEW')} label="المقابلات المحددة" count={countInterviews} icon={<CalendarCheck size={16}/>} color="blue" />
          <PipelineTab active={activeTab === 'OFFERED'} onClick={()=>setActiveTab('OFFERED')} label="عروض وظيفية مُرسلة" count={countOffers} icon={<FileSignature size={16}/>} color="fuchsia" />
          <PipelineTab active={activeTab === 'HIRED'} onClick={()=>setActiveTab('HIRED')} label="توظيف ناجح" icon={<CheckCircle size={16}/>} color="emerald" />
          <PipelineTab active={activeTab === 'REJECTED'} onClick={()=>setActiveTab('REJECTED')} label="استبعاد ورفض" icon={<XCircle size={16}/>} color="rose" />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-slate-400 font-bold animate-pulse">جاري جلب ملفات المرشحين والسير الذاتية...</div>
        ) : loadError ? (
          <div className="py-16 text-center bg-white border border-rose-200 rounded-[2rem]">
            <p className="text-rose-600 font-bold mb-4">{loadError}</p>
            <button type="button" onClick={fetchData} className="inline-flex items-center gap-2 px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-xl font-bold text-[13px] hover:bg-rose-100 transition"><RefreshCw size={14}/> إعادة المحاولة</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
             {filteredApps.map((app) => (
                 <div key={app.id} className="bg-white rounded-[2rem] border-2 border-slate-100 overflow-hidden shadow-sm hover:border-indigo-200 hover:-translate-y-1 transition-all group flex flex-col">

                    {/* Card Status Header */}
                    <div className={`px-5 py-4 flex items-center justify-between border-b ${
                        app.status === 'APPLIED' ? 'bg-amber-50 border-amber-100 text-amber-800' :
                        app.status === 'INTERVIEW' ? 'bg-blue-50 border-blue-100 text-blue-800' :
                        app.status === 'OFFERED' ? 'bg-fuchsia-50 border-fuchsia-100 text-fuchsia-800' :
                        app.status === 'HIRED' ? 'bg-emerald-50 border-emerald-100 text-emerald-800' :
                        'bg-rose-50 border-rose-100 text-rose-800'
                    }`}>
                        <div className="flex items-center gap-2">
                            {app.status === 'APPLIED' && <Clock size={16} />}
                            {app.status === 'INTERVIEW' && <CalendarCheck size={16} />}
                            {app.status === 'OFFERED' && <FileSignature size={16} />}
                            {app.status === 'HIRED' && <CheckCircle size={16} />}
                            {app.status === 'REJECTED' && <XCircle size={16} />}
                            <span className="font-black text-[11px] uppercase tracking-wide">
                                {app.status === 'APPLIED' && 'قيد الفرز'}
                                {app.status === 'INTERVIEW' && 'مقابلة مجدولة'}
                                {app.status === 'OFFERED' && 'عرض وظيفي مُعلق'}
                                {app.status === 'HIRED' && 'تم توظيفه ✅'}
                                {app.status === 'REJECTED' && 'مُستبعد ❌'}
                            </span>
                        </div>
                        <p className="text-[10px] font-bold opacity-70">{formatDateShort(app.createdAt)}</p>
                    </div>

                    {/* Card Details */}
                    <div className="p-6 flex-1 flex flex-col">

                       <p className="text-[11px] font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded w-fit mb-3 border border-indigo-100">يحاول التقدم لـ: {app.jobRequest?.jobTitle || 'غير محدد'}</p>
                       <h3 className="font-black text-[18px] text-slate-800 mb-1">{app.candidateName}</h3>
                       {candidateHeadline(app.notes) && (
                           <p className="text-[12px] font-bold text-slate-600 line-clamp-2" title="أول سطر من طلب المرشح">{candidateHeadline(app.notes)}</p>
                       )}

                       <div className="flex flex-col gap-2 mt-4 text-[12px] font-bold text-slate-600 bg-slate-50 p-3 rounded-xl border border-slate-100">
                          <div className="flex items-center gap-2"><Phone size={14} className="text-slate-400"/> {app.candidatePhone}</div>
                          {app.candidateEmail && <div className="flex items-center gap-2 truncate"><Mail size={14} className="text-slate-400 shrink-0"/> {app.candidateEmail}</div>}
                          {app.resumeUrl && (
                            <a href={app.resumeUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 transition">
                              <ExternalLink size={14} className="shrink-0"/> عرض السيرة الذاتية
                            </a>
                          )}
                       </div>

                       {app.notes && canManage && (
                           <details className="mt-3 text-[12px]">
                               <summary className="cursor-pointer font-black text-slate-500 hover:text-indigo-700">الطلب والملاحظات الداخلية</summary>
                               <p className="mt-2 whitespace-pre-wrap break-words bg-slate-50 border border-slate-100 rounded-xl p-3 font-bold text-slate-600 max-h-48 overflow-y-auto">{app.notes}</p>
                           </details>
                       )}

                       {app.status === 'INTERVIEW' && app.interviewDate && (
                           <div className="mt-4 bg-blue-100/50 p-3 rounded-xl border border-blue-200">
                               <p className="text-[10px] font-black text-blue-800 uppercase mb-1 flex items-center gap-1"><CalendarCheck size={12}/> موعد المقابلة المعتمد</p>
                               <p className="text-[13px] font-bold text-blue-900">{formatDateTime(app.interviewDate)}</p>
                           </div>
                       )}

                       {/* Action Buttons grid (HR only) */}
                       {canManage && <div className="mt-auto pt-6 flex flex-wrap gap-2">
                          {(app.status === 'APPLIED' || app.status === 'REJECTED') && (
                              <button type="button" onClick={() => openStatusModal(app, 'INTERVIEW')} className="flex-1 min-w-[100px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-bold text-[11px] py-2 rounded-lg transition text-center">تحديد مقابلة</button>
                          )}
                          {(app.status === 'INTERVIEW') && (
                              <button type="button" onClick={() => openStatusModal(app, 'OFFERED')} className="flex-1 min-w-[100px] bg-fuchsia-100 hover:bg-fuchsia-200 text-fuchsia-800 border border-fuchsia-200 font-bold text-[11px] py-2 rounded-lg transition text-center">طرح عرض مالي</button>
                          )}
                          {(app.status === 'OFFERED') && (
                              <button type="button" onClick={() => openStatusModal(app, 'HIRED')} className="flex-1 min-w-[100px] bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-200 font-bold text-[11px] py-2 rounded-lg transition text-center">قبول التوظيف ومباشرة</button>
                          )}
                          {(app.status === 'APPLIED' || app.status === 'INTERVIEW' || app.status === 'OFFERED') && (
                              <button type="button" onClick={() => openStatusModal(app, 'REJECTED')} className="w-full bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-700 border border-slate-200 hover:border-rose-200 font-bold text-[11px] py-2 rounded-lg transition text-center mt-1">اعتذار واستبعاد</button>
                          )}
                       </div>}
                    </div>

                 </div>
             ))}

             {filteredApps.length === 0 && (
                <div className="col-span-full py-16 text-center shadow-sm text-slate-500 font-bold bg-white border border-slate-200 border-dashed rounded-[2rem]">
                    لا توجد أي سير ذاتية ضمن هذه المرحلة أو الفلتر حالياً.
                </div>
             )}
          </div>
        )}

      </div>

      {/* MODAL: ADD NEW CANDIDATE */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
           <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden border border-slate-200">
              <div className="bg-slate-50 border-b border-slate-100 p-6 flex justify-between items-center">
                 <h2 className="text-[16px] font-black text-slate-800 flex items-center gap-2"><UploadCloud size={20} className="text-indigo-600"/> إدراج وتقييد سيرة ذاتية واردة</h2>
                 <button type="button" aria-label="إغلاق" onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-rose-500 transition"><XCircle size={24}/></button>
              </div>
              <form onSubmit={handleAddNewApp} className="p-6 space-y-6">

                 <div>
                    <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اربط هذه السيرة بشاغر (تمت الموافقة عليه)</label>
                    <select required value={appForm.jobRequestId} onChange={e=>setAppForm({...appForm, jobRequestId: e.target.value})} className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[13px]">
                       {activeJobs.map(j => <option key={j.id} value={j.id}>{j.jobTitle} - {j.department?.nameArabic}</option>)}
                       {activeJobs.length === 0 && <option value="">لا توجد شواغر معتمدة للتوظيف حالياً بالمؤسسة!</option>}
                    </select>
                 </div>

                 <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">اسم المرشح بالكامل</label>
                       <input type="text" required value={appForm.candidateName} onChange={e=>setAppForm({...appForm, candidateName: e.target.value})} className="w-full p-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px]" />
                    </div>
                    <div>
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">رقم الجوال والتواصل</label>
                       <input type="tel" required value={appForm.candidatePhone} onChange={e=>setAppForm({...appForm, candidatePhone: e.target.value})} className="w-full p-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px]" dir="ltr" />
                    </div>
                    <div>
                       <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">البريد الإلكتروني (اختياري)</label>
                       <input type="email" value={appForm.candidateEmail} onChange={e=>setAppForm({...appForm, candidateEmail: e.target.value})} className="w-full p-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[14px]" dir="ltr" />
                    </div>
                 </div>

                 <FileUploadField
                    name="resumeUrl"
                    value={appForm.resumeUrl}
                    onChange={(e) => setAppForm(prev => ({ ...prev, resumeUrl: e.target.value }))}
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                    label="السيرة الذاتية (اختياري)"
                 />

                 <div>
                    <label className="text-[12px] font-extrabold text-slate-700 mb-2 block">ملاحظات ومهارات إضافية للمرشح (اختياري)</label>
                    <textarea rows={2} value={appForm.notes} onChange={e=>setAppForm({...appForm, notes: e.target.value})} className="w-full p-3.5 bg-white border border-slate-200 rounded-xl font-bold text-[12px]"></textarea>
                 </div>

                 <button type="submit" disabled={isSubmitting || activeJobs.length === 0} className="w-full py-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-[14px] shadow-lg shadow-indigo-600/30 transition">{isSubmitting ? 'جاري الحفظ...' : 'حفظ السيرة في شاشة الفرز'}</button>
              </form>
           </div>
        </div>
      )}

      {/* MODAL: UPDATE PIPELINE STATUS */}
      <Modal
        open={showStatusModal && !!selectedApp}
        onClose={() => setShowStatusModal(false)}
        busy={isSubmitting}
        title={STATUS_MODAL[statusForm.status]?.title ?? 'تحديث مرحلة المرشح'}
        description={selectedApp ? `نقل ملف (${selectedApp.candidateName}) في مسار التوظيف.` : undefined}
        icon={statusForm.status === 'INTERVIEW' ? <CalendarCheck size={20}/> : statusForm.status === 'OFFERED' ? <FileSignature size={20}/> : statusForm.status === 'HIRED' ? <CheckCircle size={20}/> : <XCircle size={20}/>}
        tone={STATUS_MODAL[statusForm.status]?.tone ?? 'slate'}
        size={statusForm.status === 'OFFERED' ? 'lg' : 'md'}
      >
        {selectedApp && (
              <form onSubmit={handleStatusUpdate} className="p-6 space-y-5">

                 {statusForm.status === 'INTERVIEW' && (
                     <div>
                        <label htmlFor="status-interview-date" className="text-[12px] font-extrabold text-slate-700 mb-2 block">اختر تاريخ ووقت المقابلة (حضوري/أونلاين)</label>
                        <input id="status-interview-date" type="datetime-local" required value={statusForm.interviewDate} onChange={e=>setStatusForm({...statusForm, interviewDate: e.target.value})} className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[14px]" dir="ltr" />
                     </div>
                 )}

                 {statusForm.status === 'OFFERED' && offerStep === 'edit' && (
                     <div>
                        <label htmlFor="status-offer-text" className="text-[12px] font-extrabold text-slate-700 mb-2 block">نص العرض الوظيفي الذي يصل إلى المرشح</label>
                        <textarea
                           id="status-offer-text"
                           rows={5}
                           maxLength={4000}
                           required
                           value={statusForm.offerText}
                           onChange={e => setStatusForm({...statusForm, offerText: e.target.value})}
                           className="w-full p-3.5 bg-white border border-fuchsia-200 rounded-xl font-bold text-[13px]"
                           placeholder="مثال: الراتب الأساسي 4000 ر.س، بدل سكن 1000 ر.س، بدل نقل 400 ر.س، المسمى: أخصائي مبيعات، تاريخ المباشرة المتوقع، مدة التجربة 90 يوماً."
                        ></textarea>
                        <p className="text-[11px] font-bold text-slate-500 mt-1">يصل هذا النص وحده إلى المرشح، ولا تُرسل معه أي ملاحظة داخلية.</p>
                     </div>
                 )}

                 {statusForm.status === 'OFFERED' && offerStep === 'preview' && (
                     <div className="space-y-3">
                        <p className="text-[12px] font-black text-slate-700">معاينة العرض قبل الحفظ والإرسال</p>
                        <div className="border border-slate-200 rounded-xl p-4 bg-white space-y-3 text-[13px] text-slate-700">
                           <p className="font-black text-indigo-700">عرض وظيفي: {selectedApp.jobRequest?.jobTitle?.trim() || 'موظف'}</p>
                           <p className="font-bold">عزيزي/عزيزتي {selectedApp.candidateName}،</p>
                           <p className="font-bold leading-relaxed">يسعدنا تقديم هذا العرض الوظيفي لك للانضمام إلى فريق عملنا بمسمى <strong>{selectedApp.jobRequest?.jobTitle?.trim() || 'موظف'}</strong> في قسم <strong>{selectedApp.jobRequest?.department?.nameArabic?.trim() || 'العام'}</strong>.</p>
                           <div className="bg-slate-50 border border-slate-100 rounded-lg p-3">
                              <p className="text-[12px] font-black text-indigo-700 mb-1">تفاصيل العرض المالي والوظيفي:</p>
                              <p className="whitespace-pre-wrap break-words font-bold">{statusForm.offerText.trim()}</p>
                           </div>
                        </div>
                        <p className="text-[12px] font-bold text-slate-600">
                           {selectedApp.candidateEmail
                             ? <>عند التأكيد يُحفظ العرض في سجل المرشح، ويحاول النظام إرساله بالبريد إلى <span dir="ltr">{selectedApp.candidateEmail}</span>. تظهر لك نتيجة الإرسال بعد الحفظ.</>
                             : 'لا يوجد بريد إلكتروني لهذا المرشح، لذلك يُحفظ العرض في سجله فقط ولن يُرسل بريد. أبلغه بالعرض بنفسك.'}
                        </p>
                     </div>
                 )}

                 {!(statusForm.status === 'OFFERED' && offerStep === 'preview') && (
                 <div>
                     <label htmlFor="status-internal-note" className="text-[12px] font-extrabold text-slate-700 mb-2 block">ملاحظة داخلية (اختياري، لا تصل إلى المرشح)</label>
                     <textarea
                        id="status-internal-note"
                        rows={3}
                        maxLength={4000}
                        value={statusForm.notes}
                        onChange={e => setStatusForm({...statusForm, notes: e.target.value})}
                        className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[13px]"
                        placeholder="تُضاف إلى سجل ملاحظات المرشح مع التاريخ واسمك، ولا تحذف ما قبلها."
                     ></textarea>
                 </div>
                 )}

                 <div className="flex gap-3">
                     {statusForm.status === 'OFFERED' && offerStep === 'preview' ? (
                       <button type="button" disabled={isSubmitting} onClick={() => setOfferStep('edit')} className="flex-1 py-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[13px] transition disabled:opacity-50">تعديل النص</button>
                     ) : (
                       <button type="button" disabled={isSubmitting} onClick={() => setShowStatusModal(false)} className="flex-1 py-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black text-[13px] transition disabled:opacity-50">تراجع</button>
                     )}
                     <button type="submit" disabled={isSubmitting} className={`flex-1 py-3.5 rounded-xl text-white font-black text-[13px] transition disabled:opacity-50 ${STATUS_MODAL[statusForm.status]?.submit ?? 'bg-slate-700 hover:bg-slate-800'}`}>
                        {isSubmitting ? 'جاري الحفظ...'
                          : statusForm.status === 'OFFERED' && offerStep === 'edit' ? 'معاينة العرض'
                          : statusForm.status === 'OFFERED' ? (selectedApp.candidateEmail ? 'تأكيد الحفظ والإرسال' : 'تأكيد الحفظ')
                          : 'تأكيد النقل والحفظ'}
                     </button>
                 </div>
              </form>
        )}
      </Modal>

      {/* QR CODE MODAL FOR PUBLIC APPLY */}
      {showQRModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md animate-in fade-in duration-200">
           <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 text-center relative pointer-events-auto">
              <button type="button" aria-label="إغلاق" onClick={() => setShowQRModal(false)} className="absolute top-4 left-4 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-full p-2 transition"><XCircle size={20}/></button>

              <div className="p-8">
                 <h2 className="text-[20px] font-black text-indigo-900 mb-1">شارك رابط التوظيف</h2>
                 <p className="text-[12px] font-bold text-slate-500 mb-6">اسمح للمرشحين بتقديم بيناتهم بشكل آلي وسريع!</p>

                 <div className="text-right mb-4">
                    <label className="text-[11px] font-extrabold text-slate-700 mb-2 block">الشاغر الوظيفي المراد نشر رابطه:</label>
                    <select aria-label="الشاغر الوظيفي" value={qrJobId} onChange={e=>setQrJobId(e.target.value)} className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-[12px] focus:outline-none">
                       {activeJobs.map(j => <option key={j.id} value={j.id}>{j.jobTitle} - {j.department?.nameArabic}</option>)}
                    </select>
                 </div>

                 {qrJobId && (
                    <div className="bg-slate-50 p-4 rounded-3xl border-2 border-dashed border-indigo-200 flex flex-col items-center mb-6">
                        {qrImage?.jobId === qrJobId ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element -- locally generated data: URL */}
                            <img
                               src={qrImage.url}
                               alt="رمز QR لرابط التقديم على الوظيفة"
                               width={192}
                               height={192}
                               className="w-48 h-48 rounded-2xl shadow-sm mb-3 bg-white"
                            />
                            <a href={qrImage.url} download={`apply-qr-${qrJobId}.png`} className="text-[11px] font-black text-indigo-600 hover:text-indigo-800 mb-2">تحميل صورة الرمز</a>
                          </>
                        ) : (
                          <div className="w-48 h-48 rounded-2xl mb-4 bg-white flex items-center justify-center text-slate-300 text-[11px] font-bold animate-pulse">جاري إنشاء الرمز...</div>
                        )}
                        <p className="text-[10px] font-bold text-indigo-400">امسح الكود بكاميرا الجوال للتقديم</p>
                    </div>
                 )}

                 <div className="bg-blue-50 border border-blue-100 p-3 rounded-xl flex items-center justify-between gap-2">
                    <input type="text" readOnly aria-label="رابط التقديم" value={applyUrl(qrJobId)} className="w-full bg-transparent text-blue-800 text-[11px] font-black focus:outline-none" dir="ltr" />
                    <button type="button" onClick={copyApplyLink} className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold shrink-0">نسخ</button>
                 </div>
              </div>
           </div>
        </div>
      )}
    </DashboardLayout>
  );
}

interface PipelineTabProps {
    active: boolean;
    onClick: () => void;
    label: string;
    count?: number;
    icon: React.ReactNode;
    color?: PipelineColor;
}

function PipelineTab({ active, onClick, label, count, icon, color = 'indigo' }: PipelineTabProps) {
    const palette = PIPELINE_COLORS[color];
    const stateClasses = active ? palette.active : 'bg-white hover:bg-slate-50 border-transparent text-slate-600';

    return (
        <button type="button" aria-pressed={active} onClick={onClick} className={`flex-1 md:flex-none flex items-center justify-between gap-3 px-5 py-3 rounded-lg border font-black text-[12px] transition ${stateClasses}`}>
            <span className="flex items-center gap-2">{icon} {label}</span>
            {count !== undefined && <span className={`bg-white px-2 py-0.5 rounded border ${palette.countBorder} shadow-sm text-[10px]`}>{count}</span>}
        </button>
    );
}

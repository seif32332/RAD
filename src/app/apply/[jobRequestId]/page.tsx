"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Building, UploadCloud, CheckCircle, FileUp, Loader2, X, FileCheck, RefreshCw } from 'lucide-react';
import { useParams } from 'next/navigation';
import { toast, readApiError } from '@/components/ui/feedback';

/** Public upload policy enforced by POST /api/upload for anonymous visitors. */
const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const FILE_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png';

interface PublicJob {
    id: string;
    jobTitle: string;
    jobType: string;
    nationality: string;
    description?: string | null;
    department?: { nameArabic?: string } | null;
}

/** Returns an Arabic error message, or null when the file is acceptable. */
function validateResumeFile(file: File): string | null {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return 'نوع الملف غير مسموح. يُسمح فقط بملفات PDF أو Word (DOC/DOCX) أو الصور (JPG/PNG).';
    }
    if (file.size === 0) return 'الملف المختار فارغ، يرجى اختيار ملف آخر.';
    if (file.size > MAX_FILE_BYTES) {
        return 'حجم الملف أكبر من الحد المسموح (5 ميجابايت). يرجى ضغط الملف أو اختيار ملف أصغر.';
    }
    return null;
}

export default function PublicJobApplyPage() {
    const params = useParams();
    const jobRequestId = typeof params?.jobRequestId === 'string' ? params.jobRequestId : '';

    const [job, setJob] = useState<PublicJob | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    /** 'unavailable' = vacancy missing/closed (404); 'error' = network/server problem (retryable). */
    const [loadState, setLoadState] = useState<'ok' | 'unavailable' | 'error'>('ok');
    const [loadMessage, setLoadMessage] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    const [form, setForm] = useState({
        candidateName: '',
        candidatePhone: '',
        candidateEmail: '',
        expectedSalary: '',
        resumeUrl: '',
        notes: ''
    });
    const [resumeFileName, setResumeFileName] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadJob = useCallback(async () => {
        if (!jobRequestId) return;
        setIsLoading(true);
        setLoadState('ok');
        try {
            const res = await fetch(`/api/apply/${encodeURIComponent(jobRequestId)}`);
            if (res.status === 404 || res.status === 400) {
                setLoadState('unavailable');
                return;
            }
            if (!res.ok) {
                setLoadMessage(await readApiError(res, 'تعذر تحميل بيانات الشاغر، يرجى المحاولة لاحقاً'));
                setLoadState('error');
                return;
            }
            const data = await res.json();
            if (data && typeof data === 'object' && typeof data.jobTitle === 'string') {
                setJob(data as PublicJob);
            } else {
                setLoadState('unavailable');
            }
        } catch {
            setLoadMessage('تعذر الاتصال بالخادم، تحقق من اتصالك بالإنترنت ثم أعد المحاولة');
            setLoadState('error');
        } finally {
            setIsLoading(false);
        }
    }, [jobRequestId]);

    useEffect(() => { loadJob(); }, [loadJob]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isSubmitting) return;
        if (isUploading) { setFormError('يرجى الانتظار حتى يكتمل رفع السيرة الذاتية'); return; }
        setFormError(null);
        setIsSubmitting(true);
        let finalNotes = form.notes;
        if (form.expectedSalary) {
            finalNotes = `الراتب المتوقع: ${form.expectedSalary} ر.س\n\n${finalNotes}`;
        }

        try {
            const res = await fetch(`/api/apply/${encodeURIComponent(jobRequestId)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    candidateName: form.candidateName,
                    candidatePhone: form.candidatePhone,
                    candidateEmail: form.candidateEmail,
                    resumeUrl: form.resumeUrl,
                    notes: finalNotes,
                })
            });
            if (!res.ok) {
                const msg = await readApiError(res, 'تعذر إرسال الطلب، يرجى المحاولة مرة أخرى');
                setFormError(msg);
                toast.error(msg);
                return;
            }

            setIsSuccess(true);
        } catch {
            const msg = 'تعذر الاتصال بالخادم، تحقق من اتصالك بالإنترنت ثم أعد المحاولة';
            setFormError(msg);
            toast.error(msg);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const input = e.target;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const problem = validateResumeFile(file);
        if (problem) {
            setUploadError(problem);
            toast.error(problem);
            return;
        }
        setUploadError(null);

        const formData = new FormData();
        formData.append('file', file);

        setIsUploading(true);
        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            if (!res.ok) {
                const msg = res.status === 413
                    ? 'حجم الملف أكبر من الحد المسموح (5 ميجابايت).'
                    : await readApiError(res, 'فشل رفع الملف، يرجى المحاولة مرة أخرى');
                setUploadError(msg);
                toast.error(msg);
                return;
            }
            const data = await res.json();
            if (typeof data?.url === 'string' && data.url) {
                setForm(prev => ({ ...prev, resumeUrl: data.url }));
                setResumeFileName(file.name);
                toast.success('تم رفع السيرة الذاتية بنجاح');
            } else {
                setUploadError('فشل رفع الملف، يرجى المحاولة مرة أخرى');
            }
        } catch {
            const msg = 'حدث خطأ أثناء رفع الملف، تحقق من اتصالك بالإنترنت';
            setUploadError(msg);
            toast.error(msg);
        } finally {
            setIsUploading(false);
        }
    };

    const clearResume = () => {
        setForm(prev => ({ ...prev, resumeUrl: '' }));
        setResumeFileName('');
        setUploadError(null);
    };

    if (isLoading) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4" dir="rtl">
                <div className="animate-pulse text-slate-400 font-bold">جاري تحميل الشاغر الوظيفي...</div>
            </div>
        );
    }

    if (loadState === 'error') {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4" dir="rtl">
                <div className="bg-white p-10 rounded-[2rem] shadow-xl text-center max-w-lg w-full">
                    <h2 className="text-2xl font-black text-slate-800 mb-2">تعذر تحميل الشاغر</h2>
                    <p className="text-slate-500 font-bold mb-6">{loadMessage}</p>
                    <button type="button" onClick={loadJob} className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-[14px] transition">
                        <RefreshCw size={16} /> إعادة المحاولة
                    </button>
                </div>
            </div>
        );
    }

    if (!job || loadState === 'unavailable') {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4" dir="rtl">
                <div className="bg-white p-10 rounded-[2rem] shadow-xl text-center max-w-lg w-full">
                    <h2 className="text-2xl font-black text-slate-800 mb-2">عذراً، الشاغر غير متاح!</h2>
                    <p className="text-slate-500 font-bold">هذا الشاغر الوظيفي إما غير موجود أو تم إغلاق التوظيف الخاص به مؤخراً.</p>
                </div>
            </div>
        );
    }

    if (isSuccess) {
         return (
             <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4" dir="rtl">
                 <div className="bg-white p-10 rounded-[2rem] border-2 border-emerald-100 shadow-xl shadow-emerald-500/10 text-center max-w-lg w-full">
                     <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6">
                         <CheckCircle size={40} />
                     </div>
                     <h2 className="text-3xl font-black text-slate-800 mb-3">تم استلام طلبك!</h2>
                     <p className="text-slate-500 font-bold leading-relaxed mb-6">
                         شكراً لتقديمك على وظيفة <span className="text-emerald-700 mx-1">{job.jobTitle}</span>. سيتم مراجعة سيرتك الذاتية من قبل فريق الموارد البشرية وفي حال مطابقة الشروط سنتواصل معك في أقرب وقت.
                     </p>
                 </div>
             </div>
         );
    }

    return (
        <div className="min-h-screen bg-slate-50 py-12 px-4 sm:px-6 lg:px-8" dir="rtl">
            <div className="max-w-2xl mx-auto space-y-8">

                {/* Header Information */}
                <div className="bg-indigo-600 rounded-[2.5rem] p-8 md:p-12 text-white shadow-xl shadow-indigo-600/20 text-center relative overflow-hidden">
                   <div className="relative z-10 block w-full">
                     <div className="w-16 h-16 bg-white/20 mx-auto rounded-full flex items-center justify-center mb-6">
                         <Building size={30} className="text-white" />
                     </div>
                     <h1 className="text-3xl md:text-5xl font-black mb-3">{job.jobTitle}</h1>
                     {job.description && (
                       <p className="text-indigo-200 font-bold text-[15px] max-w-lg mx-auto leading-relaxed border-t border-indigo-500/50 pt-4 mt-2 whitespace-pre-line">
                         {job.description}
                       </p>
                     )}

                     <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
                         <span className="bg-indigo-500 text-white px-4 py-1.5 rounded-full text-[12px] font-black tracking-wide border border-indigo-400">
                             {job.jobType === 'FULL_TIME' ? 'دوام مكتبي حضوري' : job.jobType === 'PART_TIME' ? 'دوام جزئي ومرن' : 'عن بعد من المنزل'}
                         </span>
                         <span className="bg-indigo-500 text-white px-4 py-1.5 rounded-full text-[12px] font-black tracking-wide border border-indigo-400">
                             الجنسية: {job.nationality}
                         </span>
                         {job.department?.nameArabic && (
                           <span className="bg-indigo-500 text-white px-4 py-1.5 rounded-full text-[12px] font-black tracking-wide border border-indigo-400">
                               {job.department.nameArabic}
                           </span>
                         )}
                     </div>
                   </div>
                </div>

                {/* Application Form */}
                <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-[2rem] p-8 md:p-10 shadow-sm">
                    <h3 className="font-extrabold text-[16px] text-slate-800 mb-8 border-b-2 border-indigo-100 pb-4">
                        البيانات الشخصية والمهنية للمرشح
                    </h3>

                    {formError && (
                        <div role="alert" className="mb-6 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl p-4 font-bold text-[13px]">
                            {formError}
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div className="md:col-span-2">
                            <label htmlFor="apply-name" className="text-[13px] font-extrabold text-slate-700 mb-3 block">الاسم الرباعي <span className="text-rose-500">*</span></label>
                            <input id="apply-name" type="text" required maxLength={150} autoComplete="name" value={form.candidateName} onChange={e=>setForm({...form, candidateName: e.target.value})} className="w-full p-4 bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 focus:bg-white rounded-2xl font-bold text-[14px] transition outline-none" placeholder="محمد أحمد السالم.." />
                        </div>
                        <div>
                            <label htmlFor="apply-phone" className="text-[13px] font-extrabold text-slate-700 mb-3 block">رقم الجوال لتلقي المكالمات <span className="text-rose-500">*</span></label>
                            <input id="apply-phone" type="tel" required maxLength={20} autoComplete="tel" value={form.candidatePhone} onChange={e=>setForm({...form, candidatePhone: e.target.value})} className="w-full p-4 bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 focus:bg-white rounded-2xl font-bold text-[14px] transition outline-none" dir="ltr" placeholder="05XXXXXXXX" />
                        </div>
                        <div>
                            <label htmlFor="apply-email" className="text-[13px] font-extrabold text-slate-700 mb-3 block">البريد الإلكتروني (لتلقي العروض)</label>
                            <input id="apply-email" type="email" maxLength={200} autoComplete="email" value={form.candidateEmail} onChange={e=>setForm({...form, candidateEmail: e.target.value})} className="w-full p-4 bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 focus:bg-white rounded-2xl font-bold text-[14px] transition outline-none" dir="ltr" placeholder="example@gmail.com" />
                        </div>
                    </div>


                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label htmlFor="apply-salary" className="text-[13px] font-extrabold text-slate-700 mb-3 block">الراتب المتوقع (ر.س) <span className="text-slate-400 font-bold ml-1 text-xs">(اختياري)</span></label>
                            <input id="apply-salary" type="number" value={form.expectedSalary} onChange={e=>setForm({...form, expectedSalary: e.target.value})} className="w-full p-4 bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 focus:bg-white rounded-2xl font-bold text-[14px] transition outline-none" min="0" max="10000000" placeholder="مثال: 4500" />
                        </div>
                        <div>
                            <span id="apply-resume-label" className="text-[13px] font-extrabold text-slate-700 mb-3 block">رفع السيرة الذاتية <span className="text-slate-400 font-bold ml-1 text-xs">(اختياري)</span></span>
                            <div className="flex gap-2 items-stretch">
                                <label className={`shrink-0 flex flex-col items-center justify-center bg-indigo-50 border-2 border-indigo-200 border-dashed rounded-2xl w-14 h-14 cursor-pointer hover:bg-indigo-100 transition ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                                  {isUploading ? <Loader2 className="animate-spin text-indigo-600" size={20} /> : <FileUp className="text-indigo-600" size={20} />}
                                  <input ref={fileInputRef} type="file" className="hidden" aria-labelledby="apply-resume-label" accept={FILE_ACCEPT} disabled={isUploading} onChange={handleFileUpload} />
                                </label>
                                {form.resumeUrl ? (
                                    <div className="flex-1 min-w-0 flex items-center gap-2 p-3 bg-emerald-50 border-2 border-emerald-100 rounded-2xl">
                                        <FileCheck size={18} className="text-emerald-600 shrink-0" />
                                        <span className="flex-1 min-w-0 truncate font-bold text-[13px] text-emerald-800" dir="ltr">{resumeFileName || 'تم رفع الملف'}</span>
                                        <button type="button" onClick={clearResume} aria-label="إزالة الملف" className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-emerald-700 hover:bg-emerald-100 transition">
                                            <X size={16} />
                                        </button>
                                    </div>
                                ) : (
                                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="flex-1 min-w-0 p-3 bg-slate-50 border-2 border-slate-100 hover:border-indigo-300 rounded-2xl font-bold text-[13px] text-slate-500 text-right transition">
                                        {isUploading ? 'جاري رفع الملف...' : 'اضغط لاختيار الملف'}
                                    </button>
                                )}
                            </div>
                            <p className="mt-2 text-[11px] font-bold text-slate-400">الصيغ المسموحة: PDF، DOC، DOCX، JPG، PNG — الحد الأقصى 5 ميجابايت.</p>
                            {uploadError && <p role="alert" className="mt-1 text-[12px] font-bold text-rose-600">{uploadError}</p>}
                        </div>
                    </div>

                    <div className="mb-8">
                        <label htmlFor="apply-notes" className="text-[13px] font-extrabold text-slate-700 mb-3 block">أبرز المهارات أو نبذة مختصرة عن خبرتك</label>
                        <textarea id="apply-notes" rows={3} maxLength={1800} value={form.notes} onChange={e=>setForm({...form, notes: e.target.value})} className="w-full p-4 bg-slate-50 border-2 border-slate-100 focus:border-indigo-400 focus:bg-white rounded-2xl font-bold text-[13px] transition outline-none" placeholder="اكتب نبذة عنك تقنعنا بتوظيفك..."></textarea>
                    </div>

                    <button type="submit" disabled={isSubmitting || isUploading} className="w-full py-4.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-black text-[15px] rounded-2xl transition shadow-xl shadow-slate-900/20 flex items-center justify-center gap-2">
                        {isSubmitting ? (
                            <span className="animate-pulse">جاري إرسال طلبك الآلي...</span>
                        ) : (
                            <><UploadCloud size={20} /> إرسال طلب التوظيف (تقديم)</>
                        )}
                    </button>
                    <p className="text-center mt-4 text-[11px] font-bold text-slate-400">عن طريق النقر على زر الإرسال، فإنك تقر بصحة البيانات المدخلة أعلاه ليتسنى الاتصال بك.</p>
                </form>

                {/*
                  Privacy notice (DEC-008 item 7).
                  DRAFT PENDING LEGAL REVIEW: wording to be finalised with the PDPL counsel. It deliberately
                  makes no claim about hosting location, retention period or certifications (not yet verified).
                  The employer is the data controller; Radeef processes the data on its behalf.
                */}
                <section aria-labelledby="apply-privacy-title" className="bg-white border border-slate-200 rounded-[2rem] p-6 md:p-8 text-[12px] leading-relaxed text-slate-600 font-bold">
                    <h2 id="apply-privacy-title" className="font-extrabold text-[14px] text-slate-800 mb-3">إشعار الخصوصية</h2>
                    <ul className="list-disc pr-5 space-y-2">
                        <li>
                            الجهة المسؤولة عن بياناتك (المتحكم) هي <span className="text-slate-800">صاحب العمل المعلن عن هذا الشاغر</span>،
                            ويعالج نظام «رديف» هذه البيانات نيابةً عنه وبحسب تعليماته.
                        </li>
                        <li>
                            البيانات التي نجمعها: الاسم، ورقم الجوال، والبريد الإلكتروني، والراتب المتوقع، والسيرة الذاتية المرفقة، وما تكتبه في النبذة.
                        </li>
                        <li>
                            الغرض: دراسة طلبك لهذا الشاغر والتواصل معك بشأنه فقط. يطّلع عليها المخوّلون بالتوظيف لدى صاحب العمل.
                        </li>
                        <li>
                            للاستفسار أو لطلب الاطلاع على بياناتك أو تصحيحها أو حذفها، تواصل مع إدارة الموارد البشرية لدى صاحب العمل عبر وسائل التواصل التي أعلن بها عن الشاغر.
                        </li>
                    </ul>
                </section>

            </div>
        </div>
    );
}

'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { FileSignature, Download, Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { toast, readApiError, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { NOC_PURPOSES, REQUEST_STATUS, VALIDITY, pdfUrl, processingLabel, type DocView, type ProcessingView } from '@/app/documents/_lib';

interface RequestRow {
  id: string;
  typeKey: string;
  typeLabel: string;
  source: string;
  language: string;
  status: string;
  createdAt: string;
  rejectReason: string | null;
  document: DocView | null;
  processing: ProcessingView | null;
}
interface TypeOption { key: string; labelAr: string; labelEn: string; validityDays: number | null; languages?: string[]; noc?: boolean }

export interface DocumentsCardHandle {
  /** Opens the request form; returns false when the engine is not available (caller falls back). */
  openRequest(typeKey?: string): boolean;
}

/**
 * Portal "مستنداتي": request official letters, follow them, download them. Shown only when the
 * employee's legal company is configured for the document engine; otherwise the portal keeps its
 * manual request flow (gradual rollout, see /api/documents/requests?scope=mine).
 */
const DocumentsCard = forwardRef<DocumentsCardHandle>(function DocumentsCard(_, ref) {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ typeKey: '', language: 'ar', addresseeAr: '', addresseeEn: '', nocPurpose: 'TRAVEL', nocTarget: '', nocDetails: '' });
  const selected = types.find((t) => t.key === form.typeKey) ?? null;
  const [ack, setAck] = useState<{ documentId: string; label: string; comment: string; kind: 'RECEIPT' | 'RELEASE'; decision: 'RECEIVED' | 'ACCEPTED' | 'DISPUTED' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/documents/requests?scope=mine', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setRequests(data.requests ?? []);
      setTypes(data.types?.available ?? []);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll briefly while something is being produced (the render service may be retrying).
  useEffect(() => {
    if (!requests.some((r) => r.status === 'APPROVED')) return;
    const t = setTimeout(() => void load(), 8000);
    return () => clearTimeout(t);
  }, [requests, load]);

  useImperativeHandle(ref, () => ({
    openRequest(typeKey?: string) {
      if (!types.length) return false;
      setForm((f) => ({ ...f, typeKey: typeKey && types.some((t) => t.key === typeKey) ? typeKey : types[0].key }));
      setOpen(true);
      return true;
    },
  }), [types]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/documents/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          typeKey: form.typeKey,
          language: form.language,
          addresseeAr: form.addresseeAr || undefined,
          addresseeEn: form.language === 'ar-en' ? form.addresseeEn || undefined : undefined,
          noc: selected?.noc ? { purpose: form.nocPurpose, targetAr: form.nocTarget, detailsAr: form.nocDetails.trim() || undefined } : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.clone().json().catch(() => null);
        const list: string[] = body?.details?.errors?.map((x: { message: string }) => x.message) ?? [];
        toast.error(list.length ? list.join('\n') : await readApiError(res, 'تعذر تقديم الطلب'));
        return;
      }
      const r = await res.json();
      if (r.status === 'ISSUED') toast.success('صدر المستند، ويمكنك تنزيله الآن.');
      else if (r.status === 'PENDING_APPROVAL') toast.success('رُفع الطلب للاعتماد، وستجده هنا عند صدوره.');
      else if (r.renderError) toast.info(r.renderError.message);
      setOpen(false);
      setForm({ typeKey: '', language: 'ar', addresseeAr: '', addresseeEn: '', nocPurpose: 'TRAVEL', nocTarget: '', nocDetails: '' });
      await load();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (!(await confirmDialog('إلغاء هذا الطلب؟'))) return;
    const res = await fetch(`/api/documents/requests/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
    });
    if (!res.ok) toast.error(await readApiError(res, 'تعذر الإلغاء'));
    await load();
  }

  async function acknowledge(e: React.FormEvent) {
    e.preventDefault();
    if (!ack) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(ack.documentId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', decision: ack.decision, comment: ack.comment.trim() || undefined }),
      });
      if (!res.ok) return toast.error(await readApiError(res, 'تعذر تسجيل ردك'));
      toast.success(ack.decision === 'ACCEPTED' ? 'سُجّلت موافقتك على المخالصة.' : ack.decision === 'DISPUTED' ? 'سُجّل اعتراضك، وسيتابعه قسم الموارد البشرية.' : 'سُجّل إقرارك بالاستلام.');
      setAck(null);
      await load();
    } catch {
      toast.error('تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || (!types.length && !requests.length)) return null;

  return (
    <section aria-labelledby="portal-documents-title" className="bg-white rounded-[2rem] p-5 md:p-6 border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 id="portal-documents-title" className="text-lg font-black text-slate-800 flex items-center gap-2">
          <FileSignature size={22} className="text-indigo-600" aria-hidden="true" /> مستنداتي الرسمية
        </h2>
        {types.length > 0 && (
          <button type="button" onClick={() => { setForm((f) => ({ ...f, typeKey: types[0].key })); setOpen(true); }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-[13px] font-bold transition">
            طلب مستند
          </button>
        )}
      </div>

      {requests.length === 0 ? (
        <p className="text-[13px] text-slate-500">اطلب خطاب تعريف أو شهادة، وستصدر موقعة برقم ورمز تحقق.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {requests.map((r) => {
            const st = REQUEST_STATUS[r.status] ?? REQUEST_STATUS.DRAFT;
            const proc = processingLabel(r.processing);
            return (
              <li key={r.id} className="py-3 flex flex-wrap items-center gap-3 justify-between">
                <div className="min-w-0">
                  <p className="font-bold text-slate-800 text-[14px]">{r.typeLabel} {r.language === 'ar-en' ? <span className="text-slate-400 font-normal text-xs">(عربي/إنجليزي)</span> : null}</p>
                  <p className="text-xs text-slate-500">
                    {formatDateShort(r.createdAt)}
                    {r.document ? <> · <span dir="ltr">{r.document.number}</span></> : null}
                    {r.document?.validUntil ? <> · صالح حتى {formatDateShort(r.document.validUntil)}</> : null}
                  </p>
                  {r.rejectReason ? <p className="text-xs text-red-600 mt-1">سبب الرفض: {r.rejectReason}</p> : null}
                  {r.document?.acknowledgement?.at ? (
                    <p className={`text-xs mt-1 ${r.document.acknowledgement.decision === 'DISPUTED' ? 'text-red-700' : 'text-emerald-700'}`}>
                      {r.document.acknowledgement.decision === 'ACCEPTED' ? 'وافقت على المخالصة' : r.document.acknowledgement.decision === 'DISPUTED' ? 'اعترضت على البيان' : 'أقررت بالاستلام'} في {formatDateShort(r.document.acknowledgement.at)}
                    </p>
                  ) : null}
                  {proc ? <p className="text-xs text-blue-700 mt-1">{proc}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  {r.document ? (
                    <span className={`text-[11px] font-bold px-2 py-1 rounded-lg border ${VALIDITY[r.document.validity].tone}`}>{VALIDITY[r.document.validity].label}</span>
                  ) : (
                    <span className={`text-[11px] font-bold px-2 py-1 rounded-lg border ${st.tone}`}>{st.label}</span>
                  )}
                  {r.document && r.document.validity !== 'PURGED' ? (
                    <a href={pdfUrl(r.document.id)} className="inline-flex items-center gap-1 text-indigo-700 hover:text-indigo-900 text-[13px] font-bold">
                      <Download size={16} aria-hidden="true" /> تنزيل
                    </a>
                  ) : null}
                  {r.document?.acknowledgement && !r.document.acknowledgement.at && r.document.status === 'ISSUED' ? (
                    r.document.acknowledgement.kind === 'RELEASE' ? (
                      <>
                        <button type="button" onClick={() => setAck({ documentId: r.document!.id, label: `${r.typeLabel} ${r.document!.number}`, comment: '', kind: 'RELEASE', decision: 'ACCEPTED' })}
                          className="inline-flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-[13px] font-bold">
                          <CheckCircle2 size={16} aria-hidden="true" /> أوافق على المخالصة
                        </button>
                        <button type="button" onClick={() => setAck({ documentId: r.document!.id, label: `${r.typeLabel} ${r.document!.number}`, comment: '', kind: 'RELEASE', decision: 'DISPUTED' })}
                          className="inline-flex items-center gap-1 border border-red-300 text-red-700 px-3 py-1.5 rounded-lg text-[13px] font-bold">
                          <XCircle size={16} aria-hidden="true" /> أعترض
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setAck({ documentId: r.document!.id, label: `${r.typeLabel} ${r.document!.number}`, comment: '', kind: 'RECEIPT', decision: 'RECEIVED' })}
                        className="inline-flex items-center gap-1 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg text-[13px] font-bold">
                        <CheckCircle2 size={16} aria-hidden="true" /> إقرار بالاستلام
                      </button>
                    )
                  ) : null}
                  {r.status === 'PENDING_APPROVAL' && r.source === 'PORTAL' ? (
                    <button type="button" onClick={() => void cancel(r.id)} className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600 text-[13px]">
                      <XCircle size={16} aria-hidden="true" /> إلغاء
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="طلب مستند رسمي" tone="indigo" size="md" busy={busy}
        icon={<FileSignature size={20} aria-hidden="true" />} description="يصدر باسم شركتك النظامية برقم ورمز QR للتحقق.">
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="block text-[13px] font-bold text-slate-700 mb-1">نوع المستند</span>
            <select value={form.typeKey} onChange={(e) => setForm({ ...form, typeKey: e.target.value })} required
              className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]">
              {types.map((t) => <option key={t.key} value={t.key}>{t.labelAr}</option>)}
            </select>
          </label>
          {selected?.noc ? (
            <>
              <label className="block">
                <span className="block text-[13px] font-bold text-slate-700 mb-1">الغرض</span>
                <select value={form.nocPurpose} onChange={(e) => setForm({ ...form, nocPurpose: e.target.value })} className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]">
                  {Object.entries(NOC_PURPOSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <input value={form.nocTarget} required minLength={2} maxLength={120} onChange={(e) => setForm({ ...form, nocTarget: e.target.value })}
                placeholder={NOC_PURPOSES[form.nocPurpose]?.target} className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]" />
              <input value={form.nocDetails} maxLength={200} onChange={(e) => setForm({ ...form, nocDetails: e.target.value })}
                placeholder="تفاصيل مختصرة (اختياري)، مثل مدة السفر" className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]" />
              <p className="text-xs text-slate-500">يراجع قسم الموارد البشرية النص ويعتمده قبل الإصدار.</p>
            </>
          ) : null}
          <fieldset>
            <legend className="block text-[13px] font-bold text-slate-700 mb-1">اللغة</legend>
            <div className="flex gap-4 text-[14px]">
              <label className="flex items-center gap-2"><input type="radio" name="lang" checked={form.language === 'ar'} onChange={() => setForm({ ...form, language: 'ar' })} /> عربي</label>
              <label className="flex items-center gap-2"><input type="radio" name="lang" checked={form.language === 'ar-en'} onChange={() => setForm({ ...form, language: 'ar-en' })} /> عربي وإنجليزي</label>
            </div>
          </fieldset>
          <label className="block">
            <span className="block text-[13px] font-bold text-slate-700 mb-1">موجّه إلى (اختياري)</span>
            <input value={form.addresseeAr} maxLength={120} onChange={(e) => setForm({ ...form, addresseeAr: e.target.value })}
              placeholder="إلى من يهمه الأمر" className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]" />
          </label>
          {form.language === 'ar-en' && (
            <label className="block">
              <span className="block text-[13px] font-bold text-slate-700 mb-1">Addressed to (optional)</span>
              <input dir="ltr" value={form.addresseeEn} maxLength={120} onChange={(e) => setForm({ ...form, addresseeEn: e.target.value })}
                placeholder="To Whom It May Concern" className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]" />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="px-4 py-2 rounded-xl border text-[13px] font-bold">إلغاء</button>
            <button type="submit" disabled={busy || !form.typeKey} className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-[13px] font-bold inline-flex items-center gap-2 disabled:opacity-60">
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null} تقديم الطلب
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={!!ack} onClose={() => setAck(null)} tone="indigo" size="md" busy={busy}
        title={ack?.decision === 'ACCEPTED' ? 'الموافقة على المخالصة' : ack?.decision === 'DISPUTED' ? 'الاعتراض على البيان' : 'إقرار بالاستلام'}
        description={!ack ? '' : ack.decision === 'ACCEPTED'
          ? `بالموافقة تقر باستلام صافي مستحقاتك المبينة في ${ack.label} بموجب إثبات الصرف المذكور فيه، وتبرئ ذمة الشركة وفق نص المخالصة. نزّل البيان واقرأه قبل الموافقة.`
          : ack.decision === 'DISPUTED'
            ? `اكتب سبب اعتراضك على ${ack.label}، وسيصل إلى قسم الموارد البشرية. الاعتراض لا يبرئ ذمة الشركة.`
            : `أقر باستلام ${ack.label} واطلاعي عليه. الإقرار لا يعني الموافقة على ما ورد فيه.`}>
        <form onSubmit={acknowledge} className="space-y-4">
          {ack?.kind === 'RELEASE' ? (
            <a href={pdfUrl(ack.documentId)} className="inline-flex items-center gap-1 text-indigo-700 font-bold text-[13px]"><Download size={16} aria-hidden="true" /> تنزيل البيان</a>
          ) : null}
          <label className="block">
            <span className="block text-[13px] font-bold text-slate-700 mb-1">{ack?.decision === 'DISPUTED' ? 'سبب الاعتراض' : 'ملاحظاتك (اختياري)'}</span>
            <textarea value={ack?.comment ?? ''} maxLength={2000} rows={4} required={ack?.decision === 'DISPUTED'} minLength={ack?.decision === 'DISPUTED' ? 5 : undefined}
              onChange={(e) => setAck((a) => (a ? { ...a, comment: e.target.value } : a))}
              className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]" placeholder="يطلع عليها قسم الموارد البشرية." />
          </label>
          <p className="text-xs text-slate-500">لا يمكن تعديل ردك أو ملاحظاتك بعد الإرسال.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAck(null)} disabled={busy} className="px-4 py-2 rounded-xl border text-[13px] font-bold">إلغاء</button>
            <button type="submit" disabled={busy} className={`px-5 py-2 rounded-xl text-white text-[13px] font-bold inline-flex items-center gap-2 disabled:opacity-60 ${ack?.decision === 'DISPUTED' ? 'bg-red-600' : 'bg-indigo-600'}`}>
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
              {ack?.decision === 'ACCEPTED' ? 'أوافق وأبرئ الذمة' : ack?.decision === 'DISPUTED' ? 'إرسال الاعتراض' : 'أقر بالاستلام'}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
});

export default DocumentsCard;

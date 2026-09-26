'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { FileSignature, Download, Loader2, XCircle } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { toast, readApiError, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { REQUEST_STATUS, VALIDITY, pdfUrl, processingLabel, type DocView, type ProcessingView } from '@/app/documents/_lib';

interface RequestRow {
  id: string;
  typeKey: string;
  typeLabel: string;
  language: string;
  status: string;
  createdAt: string;
  rejectReason: string | null;
  document: DocView | null;
  processing: ProcessingView | null;
}
interface TypeOption { key: string; labelAr: string; labelEn: string; validityDays: number | null }

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
  const [form, setForm] = useState({ typeKey: '', language: 'ar', addresseeAr: '', addresseeEn: '' });

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
      setForm({ typeKey: '', language: 'ar', addresseeAr: '', addresseeEn: '' });
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
                  {r.status === 'PENDING_APPROVAL' ? (
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
    </section>
  );
});

export default DocumentsCard;

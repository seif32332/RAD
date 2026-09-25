"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, RefreshCw, FileText, ChevronDown, ChevronUp, Scale } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { toast, confirmDialog } from '@/components/ui/feedback';
import { formatDateTime } from '@/lib/dates';
import { featureSettlePath } from '@/lib/muqeem/tx-rules';
import { callApi, MUQEEM_OPERATION_LABELS, type ApiResult, operationLabel, TX_STATUS_LABELS, TX_STATUS_STYLE, type MuqeemStatusCompany } from './shared';
import InteractiveReportPanel from './InteractiveReportPanel';

export interface TxItem {
  id: string;
  operation: string;
  status: string;
  companyId: string | null;
  companyName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  iqamaLast4: string | null;
  entityType: string | null;
  entityId: string | null;
  externalRef: string | null;
  httpStatus: number | null;
  errorMessage: string | null;
  requestSummary: string | null;
  responseSummary: string | null;
  documentUrl: string | null;
  requestedBy: string | null;
  createdAt: string;
  completedAt: string | null;
  needsReconciliation: boolean;
  /** Screen that settles this operation (visas / employee file / settlements); null = settle here. */
  settleAt?: string | null;
}

interface TxResponse {
  items: TxItem[];
  total: number;
  take: number;
  skip: number;
  statusCounts: Record<string, number>;
  /** UNKNOWN + PENDING older than stalePendingMinutes (same filters, any status). */
  needsReconciliationCount: number;
  canReconcile: boolean;
  stalePendingMinutes: number;
}

const PAGE = 25;

/** Feature screen that must settle this transaction (it also applies the result to the business record). */
function featureSettle(t: Pick<TxItem, 'operation' | 'employeeId' | 'settleAt'>): { path: string; label: string } | null {
  const f = featureSettlePath(t.operation, t.employeeId);
  return f ? { path: t.settleAt || f.path, label: f.label } : null;
}

/** Replaces the generic «تسوية» button for operations settled from their own screen. */
function FeatureSettleLink({ t }: { t: Pick<TxItem, 'operation' | 'employeeId' | 'settleAt'> }) {
  const f = featureSettle(t);
  if (!f) return null;
  return (
    <Link href={f.path} className="inline-flex items-center gap-1 rounded-xl bg-amber-500 px-3 py-1.5 text-[12px] font-black text-white hover:bg-amber-600">
      <Scale size={13} /> سوِّ العملية من شاشة {f.label}
    </Link>
  );
}

/** Screen where the result of a transaction is applied to its business record (visa, iqama, settlement). */
function relatedScreen(t: Pick<TxItem, 'entityType' | 'employeeId'>): { href: string; label: string } | null {
  if (t.entityType === 'VISA') return { href: '/visas', label: 'شاشة التأشيرات' };
  if (t.entityType === 'SETTLEMENT') return { href: '/settlements', label: 'شاشة تصفية المستحقات' };
  if (t.employeeId) return { href: `/employees/${t.employeeId}`, label: 'ملف الموظف' };
  return null;
}

function RelatedLink({ t }: { t: Pick<TxItem, 'entityType' | 'employeeId'> }) {
  const rel = relatedScreen(t);
  if (!rel) return null;
  return (
    <>
      {' '}
      <Link href={rel.href} className="font-black text-blue-700 hover:underline">
        فتح {rel.label}
      </Link>
    </>
  );
}

function pretty(json: string | null): string {
  if (!json) return '—';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export default function TransactionsTab({ companies, usable }: { companies: MuqeemStatusCompany[]; usable: boolean }) {
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [skip, setSkip] = useState(0);
  const [data, setData] = useState<TxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState<TxItem | null>(null);

  const query = useMemo(() => {
    const qs = new URLSearchParams({ take: String(PAGE), skip: String(skip) });
    if (status) qs.set('status', status);
    if (operation) qs.set('operation', operation);
    if (companyId) qs.set('companyId', companyId);
    return qs.toString();
  }, [status, operation, companyId, skip]);

  const apply = useCallback((res: ApiResult<TxResponse>) => {
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setData(res.data);
  }, []);

  const refresh = () => {
    setLoading(true);
    void callApi<TxResponse>(`/api/integrations/muqeem/transactions?${query}`).then(apply);
  };

  useEffect(() => {
    let active = true;
    void callApi<TxResponse>(`/api/integrations/muqeem/transactions?${query}`).then((res) => {
      if (active) apply(res);
    });
    return () => {
      active = false;
    };
  }, [query, apply]);

  const undetermined = data?.needsReconciliationCount ?? 0;

  return (
    <div className="space-y-6">
      {data && undetermined > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-[13px] font-bold leading-7 text-amber-900">
          <AlertTriangle size={20} className="mt-1 shrink-0 text-amber-600" />
          <div>
            <p className="font-black">
              {undetermined} عملية لم تُحسم نتيجتها (نتيجة غير معروفة، أو قيد التنفيذ منذ أكثر من {data.stalePendingMinutes} دقائق).
            </p>
            <p>
              انقطع الاتصال بمقيم بعد إرسال الطلب أو لم تُسجَّل نتيجته، فربما نُفّذت العملية فعلاً (وحُصّلت رسومها) وربما لا. لا يُعاد إرسال أي طلب مطابق تلقائياً.
              تحقق من تقرير الخدمات التفاعلية في مقيم قبل إعادة المحاولة، ثم سجّل النتيجة بزر «تسوية».
            </p>
            <p>عمليات التأشيرات والإقامة والجواز والخروج النهائي تُسوّى من شاشاتها، لأن التسوية هناك تُحدّث السجل المرتبط أيضاً.</p>
            {!data.canReconcile && <p className="text-amber-800">التسوية متاحة لمدير النظام وصاحب العمل والعلاقات الحكومية ومدير الموارد البشرية.</p>}
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <select
          aria-label="الحالة"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setSkip(0);
            setLoading(true);
          }}
          className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-bold"
        >
          <option value="">كل الحالات</option>
          {Object.entries(TX_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
              {data ? ` (${data.statusCounts[k] ?? 0})` : ''}
            </option>
          ))}
        </select>
        <select
          aria-label="العملية"
          value={operation}
          onChange={(e) => {
            setOperation(e.target.value);
            setSkip(0);
            setLoading(true);
          }}
          className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-bold"
        >
          <option value="">كل العمليات</option>
          {Object.keys(MUQEEM_OPERATION_LABELS).map((op) => (
            <option key={op} value={op}>
              {operationLabel(op)}
            </option>
          ))}
        </select>
        <select
          aria-label="الشركة"
          value={companyId}
          onChange={(e) => {
            setCompanyId(e.target.value);
            setSkip(0);
            setLoading(true);
          }}
          className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-bold"
        >
          <option value="">كل الشركات</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 text-[13px] font-black text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} تحديث
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-[13px] font-bold text-rose-800">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-slate-100 bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-right text-[13px]">
          <thead className="bg-slate-50 text-[12px] font-black text-slate-500">
            <tr>
              <th className="px-4 py-3">التاريخ</th>
              <th className="px-4 py-3">العملية</th>
              <th className="px-4 py-3">الموظف</th>
              <th className="px-4 py-3">الشركة</th>
              <th className="px-4 py-3">الحالة</th>
              <th className="px-4 py-3">المرجع</th>
              <th className="px-4 py-3">بواسطة</th>
              <th className="px-4 py-3">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
            {!loading && data?.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  لا توجد عمليات
                </td>
              </tr>
            )}
            {data?.items.map((t) => (
              <React.Fragment key={t.id}>
                <tr className={t.needsReconciliation ? 'bg-amber-50/70' : ''}>
                  <td className="px-4 py-3 whitespace-nowrap text-[12px]">{formatDateTime(t.createdAt)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{operationLabel(t.operation)}</td>
                  <td className="px-4 py-3">
                    {t.employeeId ? (
                      <Link href={`/employees/${t.employeeId}`} className="text-blue-700 hover:underline">
                        {t.employeeName ?? '—'}
                      </Link>
                    ) : (
                      '—'
                    )}
                    {t.iqamaLast4 && <div className="text-[11px] text-slate-400" dir="ltr">…{t.iqamaLast4}</div>}
                  </td>
                  <td className="px-4 py-3 text-[12px]">{t.companyName ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-lg border px-2.5 py-1 text-[11px] font-black ${TX_STATUS_STYLE[t.status] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                      {TX_STATUS_LABELS[t.status] ?? t.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px]" dir="ltr">{t.externalRef ?? '—'}</td>
                  <td className="px-4 py-3 text-[12px]">{t.requestedBy ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {t.needsReconciliation && data.canReconcile && <FeatureSettleLink t={t} />}
                      {t.needsReconciliation && data.canReconcile && !featureSettle(t) && (
                        <button
                          type="button"
                          onClick={() => setReconciling(t)}
                          className="inline-flex items-center gap-1 rounded-xl bg-amber-500 px-3 py-1.5 text-[12px] font-black text-white hover:bg-amber-600"
                        >
                          <Scale size={13} /> تسوية
                        </button>
                      )}
                      {t.documentUrl && (
                        <a href={t.documentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-black text-blue-700 hover:underline">
                          <FileText size={13} /> المستند
                        </a>
                      )}
                      <button
                        type="button"
                        aria-expanded={expanded === t.id}
                        onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                        className="inline-flex items-center gap-1 text-[12px] font-black text-slate-500 hover:text-slate-800"
                      >
                        {expanded === t.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />} التفاصيل
                      </button>
                    </div>
                  </td>
                </tr>
                {t.needsReconciliation && (
                  <tr className="bg-amber-50/70">
                    <td colSpan={8} className="px-4 pb-3 text-[12px] font-bold text-amber-800">
                      {t.status === 'UNKNOWN'
                        ? 'نتيجة غير معروفة: تحقق من تقرير الخدمات التفاعلية في مقيم قبل إعادة المحاولة. أي طلب مطابق محجوب حتى تتم التسوية.'
                        : `قيد التنفيذ منذ أكثر من ${data.stalePendingMinutes} دقائق: تحقق من تقرير الخدمات التفاعلية في مقيم قبل إعادة المحاولة.`}
                      {t.errorMessage ? ` (${t.errorMessage})` : ''}
                      <RelatedLink t={t} />
                    </td>
                  </tr>
                )}
                {expanded === t.id && (
                  <tr>
                    <td colSpan={8} className="bg-slate-50 px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-2 text-[12px]">
                        <div>
                          <p className="font-black text-slate-500 mb-1">ملخص الطلب</p>
                          <pre dir="ltr" className="max-h-60 overflow-auto rounded-xl bg-white p-3 text-left text-[11px] text-slate-700">{pretty(t.requestSummary)}</pre>
                        </div>
                        <div>
                          <p className="font-black text-slate-500 mb-1">ملخص الاستجابة</p>
                          <pre dir="ltr" className="max-h-60 overflow-auto rounded-xl bg-white p-3 text-left text-[11px] text-slate-700">{pretty(t.responseSummary)}</pre>
                        </div>
                        {t.errorMessage && (
                          <p className="md:col-span-2 font-bold text-rose-700">
                            الخطأ: {t.errorMessage}
                            {t.httpStatus ? ` (HTTP ${t.httpStatus})` : ''}
                          </p>
                        )}
                        <p className="md:col-span-2 text-slate-500">
                          {t.entityType ? `الكيان: ${t.entityType} ${t.entityId ?? ''} — ` : ''}
                          {t.completedAt ? `اكتملت: ${formatDateTime(t.completedAt)}` : 'لم تكتمل'}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > PAGE && (
        <div className="flex items-center justify-between text-[13px] font-bold text-slate-600">
          <span>
            {skip + 1}–{Math.min(skip + PAGE, data.total)} من {data.total}
          </span>
          <div className="flex gap-2">
            <button type="button" disabled={skip === 0 || loading} onClick={() => { setLoading(true); setSkip(Math.max(0, skip - PAGE)); }} className="rounded-xl border border-slate-200 px-4 py-2 disabled:opacity-40">
              السابق
            </button>
            <button type="button" disabled={skip + PAGE >= data.total || loading} onClick={() => { setLoading(true); setSkip(skip + PAGE); }} className="rounded-xl border border-slate-200 px-4 py-2 disabled:opacity-40">
              التالي
            </button>
          </div>
        </div>
      )}

      <InteractiveReportPanel companies={companies} usable={usable} />

      {reconciling && (
        <ReconcileModal
          tx={reconciling}
          onClose={() => setReconciling(null)}
          onDone={() => {
            setReconciling(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ReconcileModal({ tx, onClose, onDone }: { tx: TxItem; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'SUCCEEDED' | 'FAILED' | ''>('');
  const [externalRef, setExternalRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const related = relatedScreen(tx);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !outcome) return;
    if (note.trim().length < 3) {
      toast.error('اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم');
      return;
    }
    const message =
      outcome === 'SUCCEEDED'
        ? `ستُسجَّل عملية «${operationLabel(tx.operation)}» كناجحة في سجل رديف${externalRef.trim() ? ` بالمرجع ${externalRef.trim()}` : ''}.\n` +
          'لن يُرسل أي طلب إلى مقيم. تأكد أنك وجدتها في تقرير الخدمات التفاعلية.\n' +
          `التسوية هنا لا تعدّل السجل المرتبط (مثل رقم التأشيرة أو تاريخ انتهاء الإقامة)؛ افتح ${related?.label ?? 'شاشة العملية'} بعدها لتطبيق النتيجة عليه.`
        : `ستُسجَّل عملية «${operationLabel(tx.operation)}» كفاشلة، وسيصبح إرسال الطلب نفسه إلى مقيم ممكناً من جديد.\n` +
          'تأكد من تقرير الخدمات التفاعلية أنها لم تُنفَّذ فعلاً: إن كانت قد نُفّذت فإعادة الطلب قد تكرر العملية وتُحصَّل رسومها مرتين.';
    const ok = await confirmDialog(message, {
      title: 'تأكيد تسوية العملية',
      confirmText: outcome === 'SUCCEEDED' ? 'تسجيلها كناجحة' : 'تسجيلها كفاشلة',
      danger: outcome === 'FAILED',
    });
    if (!ok) return;
    setBusy(true);
    const res = await callApi<{ message: string }>(`/api/integrations/muqeem/transactions/${encodeURIComponent(tx.id)}/reconcile`, {
      json: outcome === 'SUCCEEDED' ? { status: 'SUCCEEDED', externalRef: externalRef.trim() || undefined, note: note.trim() } : { status: 'FAILED', note: note.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message);
      if (res.status === 409) onDone();
      return;
    }
    toast.success(res.data.message);
    onDone();
  };

  return (
    <Modal open onClose={onClose} busy={busy} title="تسوية عملية غير محسومة" tone="amber" icon={<Scale size={22} />} description={operationLabel(tx.operation)}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-amber-50 p-3 text-[13px] font-bold leading-7 text-amber-900">
          تحقق من تقرير الخدمات التفاعلية في مقيم قبل إعادة المحاولة. ابحث عن الطلب{tx.iqamaLast4 ? ` الخاص بالإقامة المنتهية بـ ${tx.iqamaLast4}` : ''} بتاريخ {formatDateTime(tx.createdAt)}، ثم سجّل ما وجدته.
        </p>
        {related && (
          <p className="text-[12px] font-bold leading-6 text-slate-600">
            التسوية هنا تحدّث سجل المعاملات فقط. لتطبيق النتيجة على السجل المرتبط افتح{' '}
            <Link href={related.href} className="font-black text-blue-700 hover:underline">
              {related.label}
            </Link>{' '}
            بعد التسوية (أو قم بالتسوية من هناك مباشرة).
          </p>
        )}
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-black text-slate-700 mb-1">النتيجة في مقيم</legend>
          <label className="flex items-center gap-2 text-[14px] font-bold">
            <input type="radio" name="outcome" value="SUCCEEDED" checked={outcome === 'SUCCEEDED'} onChange={() => setOutcome('SUCCEEDED')} />
            نُفّذت (موجودة في تقرير الخدمات التفاعلية)
          </label>
          <label className="flex items-center gap-2 text-[14px] font-bold">
            <input type="radio" name="outcome" value="FAILED" checked={outcome === 'FAILED'} onChange={() => setOutcome('FAILED')} />
            لم تُنفَّذ (غير موجودة في التقرير)
          </label>
        </fieldset>
        {outcome === 'SUCCEEDED' && (
          <label className="block space-y-1">
            <span className="text-[13px] font-black text-slate-700">رقم المرجع في مقيم (رقم التأشيرة / الطلب) — اختياري</span>
            <input
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              dir="ltr"
              maxLength={100}
              className="w-full h-11 rounded-xl border border-slate-200 px-3 font-mono text-[14px]"
            />
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-[13px] font-black text-slate-700">ملاحظة (إلزامية)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="مثال: وُجد الطلب رقم ... في تقرير الخدمات التفاعلية بتاريخ ..."
            className="w-full rounded-xl border border-slate-200 p-3 text-[14px] font-bold"
          />
        </label>
        <div className="flex gap-3">
          <button type="submit" disabled={busy || !outcome} className="inline-flex h-11 items-center gap-2 rounded-xl bg-amber-600 px-6 text-[14px] font-black text-white hover:bg-amber-700 disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" />} متابعة
          </button>
          <button type="button" onClick={onClose} disabled={busy} className="h-11 rounded-xl bg-slate-100 px-6 text-[14px] font-black text-slate-700 hover:bg-slate-200">
            إلغاء
          </button>
        </div>
      </form>
    </Modal>
  );
}

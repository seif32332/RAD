'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileSignature, Settings, RefreshCw, Download, Eye, Loader2, Search, CheckCircle2, XCircle, RotateCcw, Ban, ShieldCheck } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Modal from '@/components/ui/Modal';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, readApiError, confirmDialog, promptDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { VALIDITY, pdfUrl, processingLabel, type DocView, type ProcessingView } from './_lib';

interface Overview {
  types: { key: string; labelAr: string }[];
  pending: { id: string; typeLabel: string; source: string; createdAt: string; company: string; name: string; employeeNumber: string }[];
  processing: { id: string; typeLabel: string; name: string; employeeNumber: string; job: ProcessingView | null }[];
  issued: (DocView & { typeLabel: string; company: string; name: string; employeeNumber: string })[];
}
interface Detail {
  id: string; typeLabel: string; status: string; company: string; name: string; employeeNumber: string; source: string;
  params: { language?: string; addresseeAr?: string; addresseeEn?: string } | null;
  snapshot: { sha256: string; createdAt: string; data: Record<string, unknown> | null } | null;
  approvals: { decision: string; decidedAt: string; invalidatedAt: string | null; invalidReason: string | null; note: string | null }[];
  canDecide: boolean;
}
interface EmployeeOption { id: string; employeeId?: string | null; firstNameArabic?: string | null; lastNameArabic?: string | null; isTerminated?: boolean | null }
interface Acceptance { id: string; typeLabel: string; company: string; validFrom: string; validUntil: string | null; scopeJson: string | null }

const FIELD_LABELS: Record<string, string> = {
  fullNameAr: 'الاسم', fullNameEn: 'الاسم بالإنجليزية', employeeNumber: 'الرقم الوظيفي', nationalityAr: 'الجنسية', nationalityEn: 'Nationality',
  idKind: 'نوع الهوية', idNumber: 'رقم الهوية/الإقامة', passportNumber: 'رقم الجواز', jobTitleAr: 'المسمى الوظيفي', jobTitleEn: 'Job title',
  joinDate: 'تاريخ المباشرة', legalNameAr: 'الشركة النظامية', legalNameEn: 'Company (EN)', crNumber: 'السجل التجاري', unifiedNumber: 'الرقم الموحد',
  startDate: 'بداية الخدمة', endDate: 'نهاية الخدمة', inService: 'على رأس العمل',
};

function SnapshotView({ data }: { data: Record<string, unknown> }) {
  const sections: [string, string][] = [['employee', 'بيانات الموظف'], ['company', 'الجهة المُصدرة'], ['service', 'مدة الخدمة']];
  const salary = data.salary as { rows: { labelAr: string; amount: string }[]; total: string } | undefined;
  return (
    <div className="space-y-4 text-[13px]">
      {sections.map(([key, title]) => {
        const obj = data[key] as Record<string, unknown> | undefined;
        if (!obj) return null;
        return (
          <div key={key}>
            <h4 className="font-bold text-slate-700 mb-1">{title}</h4>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(obj).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="text-slate-500">{FIELD_LABELS[k] ?? k}</dt>
                  <dd className="text-slate-900" dir="auto">{v === null || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'نعم' : 'لا') : String(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        );
      })}
      {salary ? (
        <div>
          <h4 className="font-bold text-slate-700 mb-1">الراتب الشهري</h4>
          <table className="w-full text-[13px]">
            <tbody>
              {salary.rows.map((r) => <tr key={r.labelAr}><td className="py-0.5">{r.labelAr}</td><td className="text-left" dir="ltr">{r.amount}</td></tr>)}
              <tr className="font-bold border-t"><td className="py-1">الإجمالي</td><td className="text-left" dir="ltr">{salary.total}</td></tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function DocumentsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [issue, setIssue] = useState({ employeeId: '', typeKey: '', language: 'ar', addresseeAr: '', addresseeEn: '' });
  const [acceptances, setAcceptances] = useState<Acceptance[]>([]);

  const load = useCallback(async (query = '') => {
    try {
      const res = await fetch(`/api/documents/requests?scope=staff${query ? `&q=${encodeURIComponent(query)}` : ''}`, { cache: 'no-store' });
      if (res.status === 401) return window.location.assign('/login');
      if (!res.ok) return setError(await readApiError(res, 'تعذر تحميل المستندات'));
      setError(null);
      setData(await res.json());
    } catch {
      setError('تعذر الاتصال بالخادم');
    }
  }, []);

  const loadAcceptances = useCallback(async () => {
    const res = await fetch('/api/documents/settings?mine=acceptances', { cache: 'no-store' });
    if (res.ok) setAcceptances((await res.json()).acceptances ?? []);
  }, []);

  useEffect(() => {
    void load();
    void loadAcceptances();
  }, [load, loadAcceptances]);

  // /documents?issueFor=<employeeId>&type=<typeKey>: from a manual letter request in the HR queue.
  const [prefill, setPrefill] = useState<{ employeeId: string; typeKey: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const employeeId = p.get('issueFor');
    if (employeeId) setPrefill({ employeeId, typeKey: p.get('type') ?? '' });
  }, []);
  useEffect(() => {
    if (!prefill || !data) return;
    const typeKey = data.types.some((t) => t.key === prefill.typeKey) ? prefill.typeKey : data.types[0]?.key ?? '';
    setIssue((s) => ({ ...s, employeeId: prefill.employeeId, typeKey }));
    setPrefill(null);
    void openIssue(prefill.employeeId, typeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, data]);

  async function act(url: string, body: unknown, ok: string | null) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const b = await res.clone().json().catch(() => null);
        const list: string[] = b?.details?.errors?.map((x: { message: string }) => x.message) ?? [];
        toast.error(list.length ? list.join('\n') : await readApiError(res, 'تعذر تنفيذ الإجراء'));
        return null;
      }
      const r = await res.json();
      if (r.renderError) toast.warning(r.renderError.message);
      else if (ok) toast.success(ok);
      await load(q);
      return r;
    } catch {
      toast.error('تعذر الاتصال بالخادم');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(id: string) {
    const res = await fetch(`/api/documents/requests/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return toast.error(await readApiError(res, 'تعذر تحميل الطلب'));
    setDetail(await res.json());
  }

  async function approve() {
    if (!detail?.snapshot) return;
    const r = await act(`/api/documents/requests/${detail.id}`, { action: 'approve', snapshotSha256: detail.snapshot.sha256 }, 'اعتُمد الطلب وصدر المستند.');
    if (r) setDetail(null);
    else void openDetail(detail.id); // the data may have changed: show the current snapshot
  }

  async function reject() {
    if (!detail) return;
    const reason = await promptDialog('سبب الرفض (يظهر للموظف):');
    if (!reason) return;
    if (await act(`/api/documents/requests/${detail.id}`, { action: 'reject', reason }, 'رُفض الطلب.')) setDetail(null);
  }

  async function revoke(id: string, number: string) {
    const reason = await promptDialog(`سبب إلغاء المستند ${number}:`);
    if (!reason) return;
    await act(`/api/documents/${id}`, { action: 'revoke', reason }, 'أُلغي المستند، وستعرض صفحة التحقق أنه ملغى.');
  }

  async function reissue(id: string, number: string) {
    if (!(await confirmDialog(`إصدار نسخة جديدة برقم جديد من بيانات الموظف الحالية؟ سيصبح المستند ${number} مستبدلاً.`))) return;
    await act(`/api/documents/${id}`, { action: 'reissue' }, 'صدر مستند جديد واستُبدل القديم.');
  }

  async function openIssue(employeeId?: string, typeKey?: string) {
    setIssueOpen(true);
    if (!employees.length) {
      const res = await fetch('/api/employees?fields=basic', { cache: 'no-store' });
      if (res.ok) {
        const list: unknown = await res.json();
        setEmployees(Array.isArray(list) ? (list as EmployeeOption[]) : []);
      }
    }
    setIssue((s) => ({ ...s, employeeId: employeeId ?? s.employeeId, typeKey: typeKey || s.typeKey || data?.types[0]?.key || '' }));
  }

  async function submitIssue(e: React.FormEvent) {
    e.preventDefault();
    const r = await act('/api/documents/requests', {
      employeeId: issue.employeeId, typeKey: issue.typeKey, language: issue.language,
      addresseeAr: issue.addresseeAr || undefined, addresseeEn: issue.language === 'ar-en' ? issue.addresseeEn || undefined : undefined,
    }, null);
    if (r) {
      setIssueOpen(false);
      if (r.status === 'ISSUED') toast.success('صدر المستند.');
      else if (r.status === 'PENDING_APPROVAL') toast.info('الطلب بانتظار الاعتماد: لا يوجد تفويض مسبق ساري للموقّع.');
    }
  }

  async function accept(a: Acceptance) {
    if (!(await confirmDialog(`قبول تفويض طباعة توقيعك على «${a.typeLabel}» لشركة ${a.company} دون اعتمادك لكل مستند؟ يمكن للمالك إلغاؤه في أي وقت.`))) return;
    const res = await fetch('/api/documents/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept', authorizationId: a.id }) });
    if (!res.ok) return toast.error(await readApiError(res, 'تعذر قبول التفويض'));
    toast.success('قُبل التفويض.');
    void loadAcceptances();
  }

  return (
    <DashboardLayout>
      <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-black text-slate-800 flex items-center gap-2"><FileSignature className="text-indigo-600" aria-hidden /> المستندات الرسمية</h1>
          <div className="flex gap-2">
            <button type="button" onClick={() => void load(q)} className="px-3 py-2 rounded-xl border text-[13px] font-bold inline-flex items-center gap-1"><RefreshCw size={15} aria-hidden /> تحديث</button>
            <Link href="/documents/settings" className="px-3 py-2 rounded-xl border text-[13px] font-bold inline-flex items-center gap-1"><Settings size={15} aria-hidden /> الإعدادات</Link>
            <button type="button" onClick={() => void openIssue()} disabled={!data?.types.length} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-[13px] font-bold disabled:opacity-50">إصدار مستند</button>
          </div>
        </div>

        {error ? <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">{error}</p> : null}

        {acceptances.length > 0 && (
          <section className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
            <h2 className="font-black text-indigo-900 flex items-center gap-2 mb-2"><ShieldCheck size={18} aria-hidden /> تفويضات بانتظار قبولك</h2>
            <ul className="space-y-2">
              {acceptances.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <span>{a.typeLabel} · {a.company} · من {formatDateShort(a.validFrom)}{a.validUntil ? ` إلى ${formatDateShort(a.validUntil)}` : ''}</span>
                  <button type="button" onClick={() => void accept(a)} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold">قبول</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!data ? (
          !error && <div className="flex justify-center py-16"><Loader2 className="animate-spin text-slate-400" aria-label="جارٍ التحميل" /></div>
        ) : (
          <>
            <section className="rounded-2xl border bg-white p-4">
              <h2 className="font-black text-slate-800 mb-3">بانتظار الاعتماد <span className="text-slate-400 font-normal">({data.pending.length})</span></h2>
              {data.pending.length === 0 ? <p className="text-[13px] text-slate-500">لا توجد طلبات بانتظار الاعتماد.</p> : (
                <ul className="divide-y">
                  {data.pending.map((r) => (
                    <li key={r.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <span><b>{r.typeLabel}</b> · {r.name} <span className="text-slate-400">({r.employeeNumber})</span> · {r.company} · {formatDateShort(r.createdAt)}{r.source === 'PORTAL' ? ' · من البوابة' : ''}</span>
                      <button type="button" onClick={() => void openDetail(r.id)} className="px-3 py-1.5 rounded-lg border font-bold inline-flex items-center gap-1"><Eye size={14} aria-hidden /> مراجعة</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.processing.length > 0 && (
              <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <h2 className="font-black text-amber-900 mb-3">قيد الإصدار / تعذر إصدارها</h2>
                <ul className="divide-y divide-amber-100">
                  {data.processing.map((r) => (
                    <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <span><b>{r.typeLabel}</b> · {r.name} · <span dir="ltr">{r.job?.number}</span> · {processingLabel(r.job)}{r.job?.lastError ? ` (${r.job.lastError})` : ''}</span>
                      <button type="button" disabled={busy} onClick={() => void act(`/api/documents/requests/${r.id}`, { action: 'retry' }, 'صدر المستند.')} className="px-3 py-1.5 rounded-lg border bg-white font-bold inline-flex items-center gap-1"><RotateCcw size={14} aria-hidden /> إعادة المحاولة</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="rounded-2xl border bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 className="font-black text-slate-800">المستندات الصادرة</h2>
                <form onSubmit={(e) => { e.preventDefault(); void load(q); }} className="flex items-center gap-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="رقم المستند أو الموظف" className="border rounded-lg px-3 py-1.5 text-[13px]" />
                  <button type="submit" className="px-3 py-1.5 rounded-lg border" aria-label="بحث"><Search size={15} aria-hidden /></button>
                </form>
              </div>
              {data.issued.length === 0 ? <p className="text-[13px] text-slate-500">لا توجد مستندات.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead className="text-slate-500 text-right">
                      <tr><th className="py-2">الرقم</th><th>النوع</th><th>الموظف</th><th>الشركة</th><th>الإصدار</th><th>الحالة</th><th></th></tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.issued.map((d) => (
                        <tr key={d.id}>
                          <td className="py-2" dir="ltr">{d.number}</td>
                          <td>{d.typeLabel}</td>
                          <td>{d.name} <span className="text-slate-400">({d.employeeNumber})</span></td>
                          <td>{d.company}</td>
                          <td>{formatDateShort(d.issuedAt)}</td>
                          <td><span className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${VALIDITY[d.validity].tone}`}>{VALIDITY[d.validity].label}</span></td>
                          <td className="whitespace-nowrap text-left">
                            {d.validity !== 'PURGED' && <a href={pdfUrl(d.id)} className="inline-flex items-center gap-1 text-indigo-700 font-bold ml-3"><Download size={14} aria-hidden /> تنزيل</a>}
                            {d.status === 'ISSUED' && (
                              <>
                                <button type="button" onClick={() => void reissue(d.id, d.number)} className="inline-flex items-center gap-1 text-slate-600 ml-3"><RotateCcw size={14} aria-hidden /> إعادة إصدار</button>
                                <button type="button" onClick={() => void revoke(d.id, d.number)} className="inline-flex items-center gap-1 text-red-600"><Ban size={14} aria-hidden /> إلغاء</button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.typeLabel} — ${detail.name}` : ''} tone="indigo" size="xl" busy={busy}
        description="راجع البيانات التالية: الاعتماد يخص هذه البيانات بالضبط، وإن تغيّرت قبل الإصدار يلزم اعتماد جديد.">
        {detail?.snapshot?.data ? (
          <div className="space-y-4">
            <p className="text-[13px] text-slate-500">
              {detail.company} · اللغة: {detail.params?.language === 'ar-en' ? 'عربي وإنجليزي' : 'عربي'}
              {detail.params?.addresseeAr ? ` · موجّه إلى: ${detail.params.addresseeAr}` : ''}
            </p>
            <SnapshotView data={detail.snapshot.data} />
            {detail.approvals.some((a) => a.invalidatedAt) && (
              <p className="text-[12px] text-amber-700">أُبطل اعتماد سابق لأن بيانات الموظف تغيّرت بعده.</p>
            )}
            {detail.canDecide ? (
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" disabled={busy} onClick={() => void reject()} className="px-4 py-2 rounded-xl border text-red-700 font-bold inline-flex items-center gap-1"><XCircle size={16} aria-hidden /> رفض</button>
                <button type="button" disabled={busy} onClick={() => void approve()} className="px-5 py-2 rounded-xl bg-emerald-600 text-white font-bold inline-flex items-center gap-1">
                  {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <CheckCircle2 size={16} aria-hidden />} اعتماد وإصدار
                </button>
              </div>
            ) : null}
          </div>
        ) : <p className="text-[13px] text-slate-500">لا توجد بيانات.</p>}
      </Modal>

      <Modal open={issueOpen} onClose={() => setIssueOpen(false)} title="إصدار مستند لموظف" tone="indigo" size="md" busy={busy}>
        <form onSubmit={submitIssue} className="space-y-4">
          <SearchableSelect name="employeeId" label="الموظف" required value={issue.employeeId}
            onChange={(e) => setIssue({ ...issue, employeeId: e.target.value })}
            options={employees.map((e) => ({ value: e.id, label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} (${e.employeeId ?? ''})${e.isTerminated ? ' — منتهية خدمته' : ''}` }))} />
          <label className="block">
            <span className="block text-[13px] font-bold text-slate-700 mb-1">نوع المستند</span>
            <select value={issue.typeKey} onChange={(e) => setIssue({ ...issue, typeKey: e.target.value })} required className="w-full border rounded-xl px-3 py-2.5 text-[14px]">
              {data?.types.map((t) => <option key={t.key} value={t.key}>{t.labelAr}</option>)}
            </select>
          </label>
          <div className="flex gap-4 text-[14px]">
            <label className="flex items-center gap-2"><input type="radio" checked={issue.language === 'ar'} onChange={() => setIssue({ ...issue, language: 'ar' })} /> عربي</label>
            <label className="flex items-center gap-2"><input type="radio" checked={issue.language === 'ar-en'} onChange={() => setIssue({ ...issue, language: 'ar-en' })} /> عربي وإنجليزي</label>
          </div>
          <input value={issue.addresseeAr} maxLength={120} onChange={(e) => setIssue({ ...issue, addresseeAr: e.target.value })} placeholder="موجّه إلى (اختياري): إلى من يهمه الأمر" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
          {issue.language === 'ar-en' && <input dir="ltr" value={issue.addresseeEn} maxLength={120} onChange={(e) => setIssue({ ...issue, addresseeEn: e.target.value })} placeholder="Addressed to (optional)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setIssueOpen(false)} className="px-4 py-2 rounded-xl border text-[13px] font-bold">إلغاء</button>
            <button type="submit" disabled={busy || !issue.employeeId} className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-[13px] font-bold disabled:opacity-50">إصدار</button>
          </div>
        </form>
      </Modal>
    </DashboardLayout>
  );
}

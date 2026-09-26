'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileSignature, Settings, RefreshCw, Download, Eye, Loader2, Search, CheckCircle2, XCircle, RotateCcw, Ban, ShieldCheck } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import Modal from '@/components/ui/Modal';
import SearchableSelect from '@/components/SearchableSelect';
import { toast, readApiError, confirmDialog, promptDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { SETTLEMENT_PAYMENT_METHODS, type SettlementPaymentMethod } from '@/lib/settlement-payment';
import { NOC_PURPOSES, VALIDITY, acknowledgementLabel, pdfUrl, processingLabel, type DocView, type ProcessingView } from './_lib';

interface TypeInfo { key: string; labelAr: string; languages: string[]; warningText: boolean; settlement: boolean; addressable: boolean; auto?: boolean; terminationNotice?: boolean; fromRecord?: boolean; noc?: boolean; promotion?: boolean; candidate?: boolean }
interface OfferOptions { candidates: { id: string; label: string; jobTitle: string; status: string }[]; companies: { id: string; label: string }[] }
interface InvestigationOption { id: string; label: string; closedAt: string }
const NOTICE_REASONS: Record<string, string> = {
  NOTICE: 'إنهاء بإشعار', NON_RENEWAL: 'عدم تجديد العقد', PROBATION: 'إنهاء خلال فترة التجربة', ARTICLE_80: 'فصل وفق المادة 80 (بعد تحقيق)',
};
interface SettlementOption { id: string; label: string; paidAt: string | null; hasProof: boolean }
interface Overview {
  types: TypeInfo[];
  pending: { id: string; typeLabel: string; source: string; createdAt: string; company: string; name: string; employeeNumber: string }[];
  processing: { id: string; typeLabel: string; name: string; employeeNumber: string; job: ProcessingView | null }[];
  issued: (DocView & { typeLabel: string; company: string; name: string; employeeNumber: string; candidate?: boolean })[];
}
interface Detail {
  id: string; typeLabel: string; status: string; company: string; name: string; employeeNumber: string; source: string;
  params: { language?: string; addresseeAr?: string; addresseeEn?: string } | null;
  snapshot: { sha256: string; createdAt: string; data: Record<string, unknown> | null } | null;
  approvals: { decision: string; decidedAt: string; invalidatedAt: string | null; invalidReason: string | null; note: string | null }[];
  canDecide: boolean;
  /** Maker-checker type written by the viewer: someone else approves it. */
  ownRequest?: boolean;
}
interface EmployeeOption { id: string; employeeId?: string | null; firstNameArabic?: string | null; lastNameArabic?: string | null; isTerminated?: boolean | null }
interface Acceptance { id: string; typeLabel: string; company: string; validFrom: string; validUntil: string | null; scopeJson: string | null }

const FIELD_LABELS: Record<string, string> = {
  fullNameAr: 'الاسم', fullNameEn: 'الاسم بالإنجليزية', employeeNumber: 'الرقم الوظيفي', nationalityAr: 'الجنسية', nationalityEn: 'Nationality',
  idKind: 'نوع الهوية', idNumber: 'رقم الهوية/الإقامة', passportNumber: 'رقم الجواز', jobTitleAr: 'المسمى الوظيفي', jobTitleEn: 'Job title',
  joinDate: 'تاريخ المباشرة', legalNameAr: 'الشركة النظامية', legalNameEn: 'Company (EN)', crNumber: 'السجل التجاري', unifiedNumber: 'الرقم الموحد',
  startDate: 'بداية الخدمة', endDate: 'نهاية الخدمة', inService: 'على رأس العمل', lastWorkingDate: 'آخر يوم عمل',
};

const SOURCE_LABEL: Record<string, string> = { PORTAL: ' · من البوابة', SYSTEM: ' · مقترح تلقائياً بعد صرف التسوية' };

function SnapshotView({ data }: { data: Record<string, unknown> }) {
  const sections: [string, string][] = [['employee', 'بيانات الموظف'], ['company', 'الجهة المُصدرة'], ['service', 'مدة الخدمة'], ['clearance', 'إخلاء الطرف']];
  const salary = data.salary as { rows: { labelAr: string; amount: string }[]; total: string } | undefined;
  const warning = data.warning as { subjectAr: string; bodyAr: string; incidentDate: string | null } | undefined;
  const noc = data.noc as { purpose: string; targetAr: string; detailsAr: string | null } | undefined;
  const offer = data.offer as { jobTitleAr: string; salary: { rows: { labelAr: string; amount: string }[]; total: string }; startDate: string; probationDays: number; annualLeaveDays: number; notesAr: string | null } | undefined;
  const cand = data.candidate as { nameAr: string } | undefined;
  const change = data.change as { effectiveDate: string; fromJobTitleAr: string; toJobTitleAr: string | null; fromBasicSalary: string; toBasicSalary: string | null; reasonAr: string | null } | undefined;
  const notice = data.notice as { reason: string; lastWorkingDate: string; noticeDays: number | null; detailsAr: string | null; investigation: { subjectAr: string; closedDate: string } | null } | undefined;
  type Row = { labelAr: string; amount: string };
  const st = data.settlement as {
    kind: string; reasonAr: string | null; entitlements: Row[]; deductions: Row[]; totalEntitlements: string; totalDeductions: string; net: string;
    payment: { method: string; reference: string; paidDate: string; receiptSha256: string | null };
  } | undefined;
  return (
    <div className="space-y-4 text-[13px]">
      {st ? (
        <div className="rounded-xl border p-3">
          <h4 className="font-bold text-slate-700 mb-1">{st.kind === 'END_OF_SERVICE' ? 'تسوية نهاية الخدمة' : 'تسوية إجازة'}{st.reasonAr ? ` · ${st.reasonAr}` : ''}</h4>
          <table className="w-full">
            <tbody>
              {st.entitlements.map((r) => <tr key={r.labelAr}><td className="py-0.5">{r.labelAr}</td><td className="text-left" dir="ltr">{r.amount}</td></tr>)}
              <tr className="font-bold border-t"><td className="py-1">إجمالي المستحقات</td><td className="text-left" dir="ltr">{st.totalEntitlements}</td></tr>
              {st.deductions.map((r) => <tr key={r.labelAr}><td className="py-0.5">{r.labelAr}</td><td className="text-left" dir="ltr">-{r.amount}</td></tr>)}
              <tr className="font-black border-t"><td className="py-1">الصافي المصروف</td><td className="text-left" dir="ltr">{st.net}</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-slate-600">إثبات الصرف: {SETTLEMENT_PAYMENT_METHODS[st.payment.method as SettlementPaymentMethod]?.ar ?? st.payment.method} · <span dir="ltr">{st.payment.reference}</span> · {st.payment.paidDate}
            {st.payment.receiptSha256 ? <> · بصمة الإيصال <span dir="ltr">{st.payment.receiptSha256.slice(0, 16)}</span></> : ' · بلا ملف إيصال'}</p>
        </div>
      ) : null}
      {offer ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <h4 className="font-bold text-emerald-900 mb-1">العرض كما سيُطبع ويُرسل للمرشح {cand ? `(${cand.nameAr})` : ''}</h4>
          <p>الوظيفة: <b>{offer.jobTitleAr}</b> · المباشرة {offer.startDate} · التجربة {offer.probationDays} يوماً · الإجازة {offer.annualLeaveDays} يوماً</p>
          <table className="w-full mt-1"><tbody>
            {offer.salary.rows.map((r) => <tr key={r.labelAr}><td>{r.labelAr}</td><td className="text-left" dir="ltr">{r.amount}</td></tr>)}
            <tr className="font-bold border-t"><td>الإجمالي</td><td className="text-left" dir="ltr">{offer.salary.total}</td></tr>
          </tbody></table>
          {offer.notesAr ? <p className="text-slate-600 mt-1">{offer.notesAr}</p> : null}
        </div>
      ) : null}
      {change ? (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
          <h4 className="font-bold text-indigo-900 mb-1">القرار كما سيُطبع ويُنفَّذ على ملف الموظف في {change.effectiveDate}</h4>
          {change.toJobTitleAr ? <p>المسمى: {change.fromJobTitleAr} ← <b>{change.toJobTitleAr}</b></p> : null}
          {change.toBasicSalary ? <p>الراتب الأساسي: <span dir="ltr">{change.fromBasicSalary}</span> ← <b dir="ltr">{change.toBasicSalary}</b></p> : null}
          {change.reasonAr ? <p className="text-slate-600">{change.reasonAr}</p> : null}
        </div>
      ) : null}
      {noc ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <h4 className="font-bold text-amber-900 mb-1">عدم الممانعة كما ستُطبع (كتبها الموظف؛ الاعتماد يشملها حرفياً)</h4>
          <p>{NOC_PURPOSES[noc.purpose]?.label ?? noc.purpose}: <b>{noc.targetAr}</b>{noc.detailsAr ? ` · ${noc.detailsAr}` : ''}</p>
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
          <h4 className="font-bold text-red-900 mb-1">قرار الإنهاء كما سيُطبع (الاعتماد يشمله حرفياً)</h4>
          <p>السبب: <b>{NOTICE_REASONS[notice.reason] ?? notice.reason}</b>{notice.noticeDays ? ` · مدة الإشعار ${notice.noticeDays} يوماً` : ''} · آخر يوم عمل <b>{notice.lastWorkingDate}</b></p>
          {notice.investigation ? <p className="text-slate-700">التحقيق: {notice.investigation.subjectAr} (انتهى {notice.investigation.closedDate})</p> : null}
          {notice.detailsAr ? <p className="mt-2 whitespace-pre-wrap leading-7 text-slate-900">{notice.detailsAr}</p> : null}
        </div>
      ) : null}
      {warning ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <h4 className="font-bold text-amber-900 mb-1">نص الإنذار كما سيُطبع (الاعتماد يشمله حرفياً)</h4>
          <p className="font-bold text-slate-800">الموضوع: {warning.subjectAr}</p>
          {warning.incidentDate ? <p className="text-slate-600">تاريخ الواقعة: {warning.incidentDate}</p> : null}
          <p className="mt-2 whitespace-pre-wrap leading-7 text-slate-900">{warning.bodyAr}</p>
        </div>
      ) : null}
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
  const [issue, setIssue] = useState({ employeeId: '', typeKey: '', language: 'ar', addresseeAr: '', addresseeEn: '', subjectAr: '', bodyAr: '', incidentDate: '', settlementId: '' });
  const issueType = data?.types.find((t) => t.key === issue.typeKey) ?? null;
  const [settlements, setSettlements] = useState<SettlementOption[] | null>(null);
  const [noc, setNoc] = useState({ purpose: 'TRAVEL', targetAr: '', detailsAr: '' });
  const [ofr, setOfr] = useState({ jobApplicationId: '', legalCompanyId: '', jobTitleAr: '', jobTitleEn: '', basicSalary: '', housing: '', transport: '', other: '', startDate: '', probationDays: '90', annualLeaveDays: '21', notesAr: '' });
  const [offerOptions, setOfferOptions] = useState<OfferOptions | null>(null);
  // Job offer: open applications + legal companies within scope.
  useEffect(() => {
    if (!issueType?.candidate || offerOptions) return;
    void (async () => {
      const res = await fetch('/api/documents/requests?scope=candidates', { cache: 'no-store' });
      if (!res.ok) return;
      const o: OfferOptions = await res.json();
      setOfferOptions(o);
      setOfr((s) => ({ ...s, legalCompanyId: s.legalCompanyId || o.companies[0]?.id || '' }));
    })();
  }, [issueType?.candidate, offerOptions]);
  const [promo, setPromo] = useState({ newJobTitleAr: '', newJobTitleEn: '', newBasicSalary: '', effectiveDate: '', reasonAr: '' });
  const [notice, setNotice] = useState({ reason: 'NOTICE', lastWorkingDate: '', noticeDays: '60', investigationId: '', detailsAr: '' });
  const [investigations, setInvestigations] = useState<InvestigationOption[] | null>(null);
  // Article 80: pick one of the employee's concluded investigations.
  useEffect(() => {
    if (!issueType?.terminationNotice || notice.reason !== 'ARTICLE_80' || !issue.employeeId) return setInvestigations(null);
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/documents/requests?scope=investigations&employeeId=${encodeURIComponent(issue.employeeId)}`, { cache: 'no-store' });
      const list: InvestigationOption[] = res.ok ? (await res.json()).investigations ?? [] : [];
      if (!alive) return;
      setInvestigations(list);
      setNotice((s) => ({ ...s, investigationId: list.some((x) => x.id === s.investigationId) ? s.investigationId : list[0]?.id ?? '' }));
    })();
    return () => {
      alive = false;
    };
  }, [issueType?.terminationNotice, notice.reason, issue.employeeId]);
  // Settlement statement: pick one of the employee's paid settlements.
  useEffect(() => {
    if (!issueType?.settlement || !issue.employeeId) return setSettlements(null);
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/documents/requests?scope=settlements&employeeId=${encodeURIComponent(issue.employeeId)}`, { cache: 'no-store' });
      const list: SettlementOption[] = res.ok ? (await res.json()).settlements ?? [] : [];
      if (!alive) return;
      setSettlements(list);
      setIssue((s) => ({ ...s, settlementId: list.some((x) => x.id === s.settlementId) ? s.settlementId : list[0]?.id ?? '' }));
    })();
    return () => {
      alive = false;
    };
  }, [issueType?.settlement, issue.employeeId]);
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
    const typeKey = data.types.some((t) => t.key === prefill.typeKey) ? prefill.typeKey : data.types.find((t) => !t.auto)?.key ?? '';
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

  async function copyCandidateLink(id: string) {
    const res = await fetch(`/api/documents/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'candidateLink' }) });
    if (!res.ok) return toast.error(await readApiError(res, 'تعذر جلب الرابط'));
    const { url } = (await res.json()) as { url: string };
    try {
      await navigator.clipboard.writeText(url);
      toast.success('نُسخ رابط المرشح؛ أرسله له بقناة موثوقة.');
    } catch {
      await promptDialog('رابط المرشح (انسخه):', { defaultValue: url });
    }
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
    setIssue((s) => ({ ...s, employeeId: employeeId ?? s.employeeId, typeKey: typeKey || s.typeKey || data?.types.find((t) => !t.auto)?.key || '' }));
  }

  async function submitIssue(e: React.FormEvent) {
    e.preventDefault();
    const language = issueType?.languages.includes(issue.language) ? issue.language : 'ar';
    if (issueType?.candidate) {
      const num = (v: string) => (v ? Number(v) : undefined);
      const r = await act('/api/documents/requests', {
        typeKey: issue.typeKey, language, jobApplicationId: ofr.jobApplicationId,
        offer: {
          legalCompanyId: ofr.legalCompanyId, jobTitleAr: ofr.jobTitleAr, jobTitleEn: ofr.jobTitleEn.trim() || undefined,
          basicSalary: Number(ofr.basicSalary), housingAllowance: num(ofr.housing), transportAllowance: num(ofr.transport), otherAllowances: num(ofr.other),
          startDate: ofr.startDate, probationDays: Number(ofr.probationDays), annualLeaveDays: Number(ofr.annualLeaveDays), notesAr: ofr.notesAr.trim() || undefined,
        },
      }, null);
      if (r) {
        setIssueOpen(false);
        toast.info('العرض بانتظار اعتماد شخص آخر؛ بعد صدوره يصل المرشح رابطه الخاص.');
      }
      return;
    }
    const r = await act('/api/documents/requests', {
      employeeId: issue.employeeId, typeKey: issue.typeKey, language,
      addresseeAr: issueType?.addressable ? issue.addresseeAr || undefined : undefined,
      addresseeEn: issueType?.addressable && language === 'ar-en' ? issue.addresseeEn || undefined : undefined,
      warning: issueType?.warningText ? { subjectAr: issue.subjectAr, bodyAr: issue.bodyAr, incidentDate: issue.incidentDate || undefined } : undefined,
      settlementId: issueType?.settlement ? issue.settlementId || undefined : undefined,
      promotion: issueType?.promotion
        ? {
            newJobTitleAr: promo.newJobTitleAr.trim() || undefined,
            newJobTitleEn: promo.newJobTitleEn.trim() || undefined,
            newBasicSalary: promo.newBasicSalary ? Number(promo.newBasicSalary) : undefined,
            effectiveDate: promo.effectiveDate,
            reasonAr: promo.reasonAr.trim() || undefined,
          }
        : undefined,
      noc: issueType?.noc ? { purpose: noc.purpose, targetAr: noc.targetAr, detailsAr: noc.detailsAr.trim() || undefined } : undefined,
      terminationNotice: issueType?.terminationNotice
        ? {
            reason: notice.reason,
            lastWorkingDate: notice.lastWorkingDate,
            noticeDays: notice.reason === 'ARTICLE_80' || !notice.noticeDays ? undefined : Number(notice.noticeDays),
            investigationId: notice.reason === 'ARTICLE_80' ? notice.investigationId || undefined : undefined,
            detailsAr: notice.detailsAr.trim() || undefined,
          }
        : undefined,
    }, null);
    if (r) {
      setIssueOpen(false);
      if (issueType?.warningText) setIssue((s) => ({ ...s, subjectAr: '', bodyAr: '', incidentDate: '' }));
      if (r.status === 'ISSUED') toast.success('صدر المستند.');
      else if (r.status === 'PENDING_APPROVAL') {
        toast.info(issueType?.warningText || issueType?.terminationNotice || issueType?.promotion ? 'بانتظار اعتماد شخص آخر، ولن يراه الموظف قبل صدوره.' : 'الطلب بانتظار الاعتماد: لا يوجد تفويض مسبق ساري للموقّع.');
      }
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
                      <span><b>{r.typeLabel}</b> · {r.name} <span className="text-slate-400">({r.employeeNumber})</span> · {r.company} · {formatDateShort(r.createdAt)}{SOURCE_LABEL[r.source] ?? ''}</span>
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
                      <tr><th className="py-2">الرقم</th><th>النوع</th><th>الموظف</th><th>الشركة</th><th>الإصدار</th><th>الحالة</th><th>الاستلام</th><th></th></tr>
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
                          <td className="text-[12px]">
                            {(() => {
                              const l = acknowledgementLabel(d.acknowledgement);
                              if (!l) return '—';
                              return (
                                <span className={l.tone} title={d.acknowledgement?.comment ?? undefined}>
                                  {l.text}{d.acknowledgement?.at ? ` · ${formatDateShort(d.acknowledgement.at)}` : ''}{d.acknowledgement?.comment ? ' · له ملاحظات' : ''}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="whitespace-nowrap text-left">
                            {d.validity !== 'PURGED' && <a href={pdfUrl(d.id)} className="inline-flex items-center gap-1 text-indigo-700 font-bold ml-3"><Download size={14} aria-hidden /> تنزيل</a>}
                            {d.status === 'ISSUED' && (
                              <>
                                {d.candidate ? (
                                  <button type="button" onClick={() => void copyCandidateLink(d.id)} className="inline-flex items-center gap-1 text-indigo-700 ml-3">نسخ رابط المرشح</button>
                                ) : null}
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
            {detail.ownRequest && detail.status === 'PENDING_APPROVAL' ? (
              <p className="text-[12px] text-slate-600 border-t pt-2">أنت كاتب هذا الطلب؛ يعتمده شخص آخر من الموارد البشرية أو الموقّع.</p>
            ) : null}
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

      <Modal open={issueOpen} onClose={() => setIssueOpen(false)} title={issueType?.candidate ? 'إصدار عرض وظيفي لمرشح' : 'إصدار مستند لموظف'} tone="indigo" size={issueType?.warningText || issueType?.candidate ? 'lg' : 'md'} busy={busy}>
        <form onSubmit={submitIssue} className="space-y-4">
          {!issueType?.candidate && (
            <SearchableSelect name="employeeId" label="الموظف" required value={issue.employeeId}
              onChange={(e) => setIssue({ ...issue, employeeId: e.target.value })}
              options={employees.map((e) => ({ value: e.id, label: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''} (${e.employeeId ?? ''})${e.isTerminated ? ' — منتهية خدمته' : ''}` }))} />
          )}
          <label className="block">
            <span className="block text-[13px] font-bold text-slate-700 mb-1">نوع المستند</span>
            <select value={issue.typeKey} onChange={(e) => setIssue({ ...issue, typeKey: e.target.value })} required className="w-full border rounded-xl px-3 py-2.5 text-[14px]">
              {data?.types.filter((t) => !t.auto && !t.fromRecord).map((t) => <option key={t.key} value={t.key}>{t.labelAr}</option>)}
            </select>
          </label>
          {issueType?.candidate ? (
            <>
              <SearchableSelect name="jobApplicationId" label="المرشح (من طلبات التوظيف)" required value={ofr.jobApplicationId}
                onChange={(e) => {
                  const c = offerOptions?.candidates.find((x) => x.id === e.target.value);
                  setOfr({ ...ofr, jobApplicationId: e.target.value, jobTitleAr: ofr.jobTitleAr || c?.jobTitle || '' });
                }}
                options={(offerOptions?.candidates ?? []).map((c) => ({ value: c.id, label: c.label }))} />
              <select value={ofr.legalCompanyId} required onChange={(e) => setOfr({ ...ofr, legalCompanyId: e.target.value })} className="w-full border rounded-xl px-3 py-2.5 text-[14px]" aria-label="الشركة النظامية">
                {(offerOptions?.companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <input value={ofr.jobTitleAr} required maxLength={120} onChange={(e) => setOfr({ ...ofr, jobTitleAr: e.target.value })} placeholder="المسمى الوظيفي" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
              <input dir="ltr" value={ofr.jobTitleEn} maxLength={120} onChange={(e) => setOfr({ ...ofr, jobTitleEn: e.target.value })} placeholder="Job title (English, for a bilingual offer)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
              <div className="grid grid-cols-2 gap-2">
                <input type="number" min={1} step="0.01" required value={ofr.basicSalary} onChange={(e) => setOfr({ ...ofr, basicSalary: e.target.value })} placeholder="الراتب الأساسي" className="border rounded-xl px-3 py-2 text-[14px]" />
                <input type="number" min={0} step="0.01" value={ofr.housing} onChange={(e) => setOfr({ ...ofr, housing: e.target.value })} placeholder="بدل السكن" className="border rounded-xl px-3 py-2 text-[14px]" />
                <input type="number" min={0} step="0.01" value={ofr.transport} onChange={(e) => setOfr({ ...ofr, transport: e.target.value })} placeholder="بدل النقل" className="border rounded-xl px-3 py-2 text-[14px]" />
                <input type="number" min={0} step="0.01" value={ofr.other} onChange={(e) => setOfr({ ...ofr, other: e.target.value })} placeholder="بدلات أخرى" className="border rounded-xl px-3 py-2 text-[14px]" />
              </div>
              <div className="grid grid-cols-3 gap-2 text-[12px]">
                <label>تاريخ المباشرة<input type="date" required value={ofr.startDate} onChange={(e) => setOfr({ ...ofr, startDate: e.target.value })} className="block w-full border rounded-xl px-2 py-2 text-[14px]" /></label>
                <label>التجربة (أيام)<input type="number" min={0} max={180} required value={ofr.probationDays} onChange={(e) => setOfr({ ...ofr, probationDays: e.target.value })} className="block w-full border rounded-xl px-2 py-2 text-[14px]" /></label>
                <label>الإجازة السنوية<input type="number" min={21} max={60} required value={ofr.annualLeaveDays} onChange={(e) => setOfr({ ...ofr, annualLeaveDays: e.target.value })} className="block w-full border rounded-xl px-2 py-2 text-[14px]" /></label>
              </div>
              <input value={ofr.notesAr} maxLength={300} onChange={(e) => setOfr({ ...ofr, notesAr: e.target.value })} placeholder="شرط أو ميزة إضافية (اختياري)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
            </>
          ) : null}
          {issueType?.promotion ? (
            <>
              <p className="text-[12px] text-slate-600">اترك ما لا يتغير فارغاً. بعد اعتماد شخص آخر يصدر القرار، ويُطبَّق على ملف الموظف في تاريخ السريان.</p>
              <input value={promo.newJobTitleAr} maxLength={120} onChange={(e) => setPromo({ ...promo, newJobTitleAr: e.target.value })} placeholder="المسمى الوظيفي الجديد" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
              {promo.newJobTitleAr ? <input dir="ltr" value={promo.newJobTitleEn} maxLength={120} onChange={(e) => setPromo({ ...promo, newJobTitleEn: e.target.value })} placeholder="New job title (English, optional)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" /> : null}
              <input type="number" min={1} step="0.01" value={promo.newBasicSalary} onChange={(e) => setPromo({ ...promo, newBasicSalary: e.target.value })} placeholder="الراتب الأساسي الجديد (ريال)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
              <label className="block">
                <span className="block text-[13px] font-bold text-slate-700 mb-1">تاريخ السريان</span>
                <input type="date" required value={promo.effectiveDate} onChange={(e) => setPromo({ ...promo, effectiveDate: e.target.value })} className="border rounded-xl px-3 py-2 text-[14px]" />
              </label>
              <input value={promo.reasonAr} maxLength={200} onChange={(e) => setPromo({ ...promo, reasonAr: e.target.value })} placeholder="السبب (اختياري)، مثل: تقديراً لأدائه المتميز" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
            </>
          ) : null}
          {issueType?.noc ? (
            <>
              <select value={noc.purpose} onChange={(e) => setNoc({ ...noc, purpose: e.target.value })} className="w-full border rounded-xl px-3 py-2.5 text-[14px]">
                {Object.entries(NOC_PURPOSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <input value={noc.targetAr} required minLength={2} maxLength={120} onChange={(e) => setNoc({ ...noc, targetAr: e.target.value })}
                placeholder={NOC_PURPOSES[noc.purpose]?.target} className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
              <input value={noc.detailsAr} maxLength={200} onChange={(e) => setNoc({ ...noc, detailsAr: e.target.value })}
                placeholder="تفاصيل مختصرة (اختياري)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
            </>
          ) : null}
          {issueType?.terminationNotice ? (
            <>
              <label className="block">
                <span className="block text-[13px] font-bold text-slate-700 mb-1">سبب الإنهاء</span>
                <select value={notice.reason} onChange={(e) => setNotice({ ...notice, reason: e.target.value })} className="w-full border rounded-xl px-3 py-2.5 text-[14px]">
                  {Object.entries(NOTICE_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {notice.reason === 'ARTICLE_80' ? (
                investigations && investigations.length === 0 ? (
                  <p className="text-[13px] text-red-700">لا يوجد تحقيق منتهٍ لهذا الموظف؛ الفصل وفق المادة 80 يستند إلى تحقيق.</p>
                ) : (
                  <select value={notice.investigationId} required onChange={(e) => setNotice({ ...notice, investigationId: e.target.value })} className="w-full border rounded-xl px-3 py-2.5 text-[14px]">
                    {(investigations ?? []).map((i) => <option key={i.id} value={i.id}>{i.label} · {formatDateShort(i.closedAt)}</option>)}
                  </select>
                )
              ) : (
                <label className="block">
                  <span className="block text-[13px] font-bold text-slate-700 mb-1">مدة الإشعار (أيام)</span>
                  <input type="number" min={notice.reason === 'PROBATION' ? 0 : 1} max={365} value={notice.noticeDays} required={notice.reason !== 'PROBATION'}
                    onChange={(e) => setNotice({ ...notice, noticeDays: e.target.value })} className="border rounded-xl px-3 py-2 text-[14px] w-32" />
                </label>
              )}
              <label className="block">
                <span className="block text-[13px] font-bold text-slate-700 mb-1">آخر يوم عمل</span>
                <input type="date" value={notice.lastWorkingDate} required onChange={(e) => setNotice({ ...notice, lastWorkingDate: e.target.value })} className="border rounded-xl px-3 py-2 text-[14px]" />
              </label>
              <textarea value={notice.detailsAr} maxLength={1500} rows={4} onChange={(e) => setNotice({ ...notice, detailsAr: e.target.value })}
                className="w-full border rounded-xl px-3 py-2.5 text-[14px] leading-7" placeholder="توضيح إضافي (اختياري)، يُطبع كما هو ويعتمده شخص آخر غيرك." />
            </>
          ) : null}
          {issueType?.warningText ? (
            <>
              <input value={issue.subjectAr} maxLength={120} required onChange={(e) => setIssue({ ...issue, subjectAr: e.target.value })} placeholder="موضوع الإنذار، مثل: التأخر المتكرر عن الدوام" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
              <label className="block">
                <span className="block text-[13px] font-bold text-slate-700 mb-1">نص الإنذار</span>
                <textarea value={issue.bodyAr} maxLength={3000} minLength={20} required rows={8} onChange={(e) => setIssue({ ...issue, bodyAr: e.target.value })}
                  className="w-full border rounded-xl px-3 py-2.5 text-[14px] leading-7" placeholder="اكتب الواقعة والمطلوب من الموظف. سطر فارغ يبدأ فقرة جديدة." />
                <span className="block text-[11px] text-slate-500 mt-1">{issue.bodyAr.length} / 3000 · يُطبع كما هو دون تشكيل، ويعتمده شخص آخر غيرك قبل صدوره.</span>
              </label>
              <label className="block">
                <span className="block text-[13px] font-bold text-slate-700 mb-1">تاريخ الواقعة (اختياري)</span>
                <input type="date" value={issue.incidentDate} onChange={(e) => setIssue({ ...issue, incidentDate: e.target.value })} className="border rounded-xl px-3 py-2 text-[14px]" />
              </label>
            </>
          ) : null}
          {issueType?.settlement ? (
            <label className="block">
              <span className="block text-[13px] font-bold text-slate-700 mb-1">التسوية المصروفة</span>
              {settlements && settlements.length === 0 ? (
                <p className="text-[13px] text-amber-700">لا توجد تسوية مصروفة لهذا الموظف.</p>
              ) : (
                <select value={issue.settlementId} required onChange={(e) => setIssue({ ...issue, settlementId: e.target.value })} className="w-full border rounded-xl px-3 py-2.5 text-[14px]">
                  {(settlements ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.label}{s.paidAt ? ` · صُرفت ${formatDateShort(s.paidAt)}` : ''}{s.hasProof ? '' : ' · بلا إثبات صرف'}</option>
                  ))}
                </select>
              )}
            </label>
          ) : null}
          {issueType && issueType.languages.includes('ar-en') ? (
            <div className="flex gap-4 text-[14px]">
              <label className="flex items-center gap-2"><input type="radio" checked={issue.language === 'ar'} onChange={() => setIssue({ ...issue, language: 'ar' })} /> عربي</label>
              <label className="flex items-center gap-2"><input type="radio" checked={issue.language === 'ar-en'} onChange={() => setIssue({ ...issue, language: 'ar-en' })} /> عربي وإنجليزي</label>
            </div>
          ) : null}
          {issueType?.addressable !== false && (
            <input value={issue.addresseeAr} maxLength={120} onChange={(e) => setIssue({ ...issue, addresseeAr: e.target.value })} placeholder="موجّه إلى (اختياري): إلى من يهمه الأمر" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />
          )}
          {issueType?.addressable !== false && issue.language === 'ar-en' && issueType?.languages.includes('ar-en') && <input dir="ltr" value={issue.addresseeEn} maxLength={120} onChange={(e) => setIssue({ ...issue, addresseeEn: e.target.value })} placeholder="Addressed to (optional)" className="w-full border rounded-xl px-3 py-2.5 text-[14px]" />}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setIssueOpen(false)} className="px-4 py-2 rounded-xl border text-[13px] font-bold">إلغاء</button>
            <button type="submit" disabled={busy || (issueType?.candidate ? !ofr.jobApplicationId : !issue.employeeId)} className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-[13px] font-bold disabled:opacity-50">إصدار</button>
          </div>
        </form>
      </Modal>
    </DashboardLayout>
  );
}

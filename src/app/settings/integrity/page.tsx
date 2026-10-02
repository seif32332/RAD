"use client";

// لوحة سلامة البيانات (P1-FND-INV، ARCHITECTURE_INVARIANTS §4.3 القاعدة 6): الاختلافات المفتوحة حسب
// الخطورة والشركة، والأقدم، والمتنازل عنه هذا الشهر، ونتيجة آخر تشغيل لكل ثابت، مع الشرح والتنازل.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, RefreshCw, PlayCircle } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, readApiError, promptDialog, confirmDialog } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface Discrepancy {
  id: string;
  ruleId: string;
  checkId: string;
  companyId: string | null;
  subjectEmployeeId: string | null;
  entityType: string;
  entityId: string;
  period: string | null;
  severity: string;
  blocking: boolean;
  blocks: string[];
  status: string;
  pendingAction: string | null;
  detectedAt: string;
  occurrences: number;
  explanation: string | null;
  waiverReason: string | null;
  selfActSingleOperator: boolean;
  ownerConfirmation: string | null;
  version: number;
}

interface InvariantInfo {
  id: string;
  titleAr: string;
  severity: string;
  integrity: boolean;
  measured: boolean;
  lastRun: { status: string; startedAt: string; found: number; error: string | null } | null;
}

interface Dashboard {
  summary: { openBySeverity: Record<string, number>; waivedThisMonth: number; oldestOpenAt: string | null };
  invariants: InvariantInfo[];
  discrepancies: Discrepancy[];
  companies: { id: string; nameArabic: string }[];
  seesTenantLevel: boolean;
}

const SEVERITY_LABELS: Record<string, string> = { BLOCKING: 'موقِف', HIGH: 'عالٍ', WARNING: 'تنبيه', INFO: 'معلومة' };
const SEVERITY_STYLES: Record<string, string> = {
  BLOCKING: 'bg-rose-50 text-rose-700 border-rose-200',
  HIGH: 'bg-amber-50 text-amber-700 border-amber-200',
  WARNING: 'bg-sky-50 text-sky-700 border-sky-200',
  INFO: 'bg-slate-50 text-slate-600 border-slate-200',
};
const STATUS_LABELS: Record<string, string> = { OPEN: 'مفتوح', EXPLAINED: 'مشروح', RESOLVED: 'معالَج', WAIVED: 'متنازل عنه', AUTO_CLOSED: 'أُغلق آلياً' };
const PENDING_LABELS: Record<string, string> = { EXPLANATION: 'شرح بانتظار شخص ثانٍ', WAIVER: 'تنازل بانتظار شخص ثانٍ' };

export default function IntegrityPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/integrity');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل لوحة سلامة البيانات'));
      setData((await res.json()) as Dashboard);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بالخادم');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const companyName = useMemo(() => {
    const m = new Map((data?.companies ?? []).map((c) => [c.id, c.nameArabic]));
    return (id: string | null) => (id ? m.get(id) ?? id : 'على مستوى النظام');
  }, [data]);

  const titleOf = useMemo(() => {
    const m = new Map((data?.invariants ?? []).map((i) => [i.id, i.titleAr]));
    return (id: string) => m.get(id) ?? id;
  }, [data]);

  async function act(d: Discrepancy, action: string, extra: Record<string, unknown> = {}) {
    setBusy(d.id);
    try {
      const res = await fetch(`/api/settings/integrity/${d.id}`, {
        method: 'POST',
        // No Idempotency-Key: the server derives it from (action, discrepancy, version, user), so a
        // double click replays and two people never share a key.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, expectedVersion: d.version, ...extra }),
      });
      if (!res.ok) throw new Error(await readApiError(res, 'تعذر تنفيذ الإجراء'));
      toast.success('تم تسجيل الإجراء');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بالخادم');
    } finally {
      setBusy(null);
    }
  }

  async function explain(d: Discrepancy) {
    const explanation = await promptDialog('اكتب شرح الاختلاف (سببه وما يثبته)', { title: 'شرح الاختلاف', placeholder: 'مثال: البنك رفض التحويل لأن الآيبان مغلق' });
    if (!explanation) return;
    const reference = await promptDialog('مرجع الشرح (رقم رد البنك، رقم القرار، رقم المعاملة...)', { title: 'مرجع الشرح' });
    if (!reference) return;
    await act(d, 'explain', { explanation, reference });
  }

  async function waive(d: Discrepancy) {
    const reason = await promptDialog('سبب التنازل (يحتاج اعتماد شخص ثانٍ ويُنبَّه المالك)', { title: 'طلب تنازل', danger: true });
    if (!reason) return;
    await act(d, 'waive', { reason });
  }

  async function resolve(d: Discrepancy) {
    const resolution = await promptDialog('ما الذي صُحّح؟ (يُتحقق من اختفاء الاختلاف قبل الإغلاق)', { title: 'تسجيل المعالجة' });
    if (!resolution) return;
    const resolutionRef = await promptDialog('مرجع المعالجة (رقم القيد أو العملية)', { title: 'مرجع المعالجة' });
    if (!resolutionRef) return;
    await act(d, 'resolve', { resolution, resolutionRef });
  }

  async function runNow() {
    if (!(await confirmDialog('تشغيل فحوص السلامة الآن على شركاتك؟ قد يستغرق ذلك بعض الوقت.'))) return;
    setBusy('run');
    try {
      const res = await fetch('/api/settings/integrity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reconcile' }) });
      if (!res.ok) throw new Error(await readApiError(res, 'تعذر تشغيل الفحوص'));
      toast.success('اكتمل تشغيل الفحوص');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'تعذر الاتصال بالخادم');
    } finally {
      setBusy(null);
    }
  }

  const sev = data?.summary.openBySeverity ?? {};

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
              <span className="bg-rose-50 text-rose-600 p-3 rounded-2xl"><ShieldAlert size={26} /></span>
              سلامة البيانات
            </h1>
            <p className="text-slate-500 font-bold mt-2 text-[14px]">
              الاختلافات التي تكتشفها فحوص السلامة. الموقِف منها يمنع اعتماد المسير أو الصرف في نطاقه حتى يُعالَج أو يُشرح بشخص ثانٍ أو يُتنازل عنه بشخصين.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={load} className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl font-bold text-[13px] text-slate-700 hover:bg-slate-50"><RefreshCw size={14} /> تحديث</button>
            <button type="button" disabled={busy === 'run'} onClick={runNow} className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white rounded-xl font-bold text-[13px] hover:bg-slate-800 disabled:opacity-50"><PlayCircle size={14} /> تشغيل الفحوص الآن</button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {['BLOCKING', 'HIGH', 'WARNING'].map((s) => (
            <div key={s} className={`border rounded-2xl p-4 ${SEVERITY_STYLES[s]}`}>
              <p className="text-[12px] font-black">مفتوح · {SEVERITY_LABELS[s]}</p>
              <p className="text-2xl font-black mt-1">{sev[s] ?? 0}</p>
            </div>
          ))}
          <div className="border border-slate-200 rounded-2xl p-4 bg-white">
            <p className="text-[12px] font-black text-slate-500">متنازل عنه هذا الشهر</p>
            <p className="text-2xl font-black mt-1 text-slate-800">{data?.summary.waivedThisMonth ?? 0}</p>
          </div>
          <div className="border border-slate-200 rounded-2xl p-4 bg-white">
            <p className="text-[12px] font-black text-slate-500">أقدم اختلاف مفتوح</p>
            <p className="text-[15px] font-black mt-2 text-slate-800">{data?.summary.oldestOpenAt ? formatDateShort(data.summary.oldestOpenAt) : '—'}</p>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-100 text-[12px] font-black text-slate-500">
                  <th className="p-4">الخطورة</th>
                  <th className="p-4">الثابت</th>
                  <th className="p-4">الشركة</th>
                  <th className="p-4">السجل</th>
                  <th className="p-4">الحالة</th>
                  <th className="p-4">منذ</th>
                  <th className="p-4">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-[13px]">
                {loading ? (
                  <tr><td colSpan={7} className="p-10 text-center text-slate-400 font-bold animate-pulse">جاري التحميل...</td></tr>
                ) : !data || data.discrepancies.length === 0 ? (
                  <tr><td colSpan={7} className="p-10 text-center text-slate-500 font-bold">لا توجد اختلافات مفتوحة.</td></tr>
                ) : data.discrepancies.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/50 align-top">
                    <td className="p-4">
                      <span className={`inline-block border rounded-lg px-2 py-1 text-[11px] font-black ${SEVERITY_STYLES[d.severity] ?? ''}`}>{SEVERITY_LABELS[d.severity] ?? d.severity}</span>
                      {d.blocking && <p className="text-[11px] text-rose-600 font-bold mt-1">يوقف: {d.blocks.join('، ')}</p>}
                    </td>
                    <td className="p-4">
                      <p className="font-black text-slate-800">{d.ruleId}</p>
                      <p className="text-slate-500 font-bold">{titleOf(d.ruleId)}</p>
                      <p className="text-[11px] text-slate-400" dir="ltr">{d.checkId}</p>
                    </td>
                    <td className="p-4 font-bold text-slate-700">{companyName(d.companyId)}</td>
                    <td className="p-4 text-[12px] text-slate-600" dir="ltr">{d.entityType} · {d.entityId.slice(0, 8)}{d.period ? ` · ${d.period}` : ''}</td>
                    <td className="p-4 font-bold">
                      {STATUS_LABELS[d.status] ?? d.status}
                      {d.pendingAction && <p className="text-[11px] text-amber-600">{d.ownerConfirmation === 'PENDING' ? 'بانتظار تأكيد المالك' : PENDING_LABELS[d.pendingAction]}</p>}
                      {d.selfActSingleOperator && <p className="text-[11px] text-slate-500">مشغّل وحيد</p>}
                    </td>
                    <td className="p-4 text-slate-600">{formatDateShort(d.detectedAt)}{d.occurrences > 1 ? ` (تكرر ${d.occurrences})` : ''}</td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-1.5">
                        {d.status === 'OPEN' && !d.pendingAction && (
                          <>
                            <button type="button" disabled={busy === d.id} onClick={() => explain(d)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 font-bold text-[12px] hover:bg-slate-50">شرح</button>
                            <button type="button" disabled={busy === d.id} onClick={() => waive(d)} className="px-2.5 py-1.5 rounded-lg border border-rose-200 text-rose-700 font-bold text-[12px] hover:bg-rose-50">تنازل</button>
                          </>
                        )}
                        {d.status === 'OPEN' && d.pendingAction && d.ownerConfirmation !== 'PENDING' && (
                          <>
                            <button type="button" disabled={busy === d.id} onClick={() => act(d, d.pendingAction === 'EXPLANATION' ? 'approve-explanation' : 'approve-waiver')} className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-bold text-[12px] hover:bg-emerald-700">اعتماد</button>
                            <button type="button" disabled={busy === d.id} onClick={() => act(d, 'reject')} className="px-2.5 py-1.5 rounded-lg border border-slate-200 font-bold text-[12px] hover:bg-slate-50">رفض</button>
                          </>
                        )}
                        {['OPEN', 'EXPLAINED', 'WAIVED'].includes(d.status) && (
                          <button type="button" disabled={busy === d.id} onClick={() => resolve(d)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 font-bold text-[12px] hover:bg-slate-50">عولج</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-[2rem] p-6 shadow-sm">
          <h2 className="font-black text-slate-800 mb-4">الثوابت وآخر تشغيل</h2>
          <div className="grid md:grid-cols-2 gap-2 text-[13px]">
            {(data?.invariants ?? []).map((i) => (
              <div key={i.id} className="flex items-start justify-between gap-3 border-b border-slate-100 py-2">
                <div>
                  <span className="font-black text-slate-800">{i.id}</span>{' '}
                  <span className="text-slate-500 font-bold">{i.titleAr}</span>
                  {i.integrity && <span className="mr-2 text-[11px] text-rose-600 font-black">ثابت سلامة</span>}
                </div>
                <div className="text-[12px] font-bold text-slate-500 whitespace-nowrap">
                  {!i.measured ? 'لا يُقاس بعد' : !i.lastRun ? 'لم يُشغَّل' : i.lastRun.status === 'FAILED' ? <span className="text-rose-600">فشل التشغيل</span> : `${formatDateShort(i.lastRun.startedAt)} · ${i.lastRun.found}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

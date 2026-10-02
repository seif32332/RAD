"use client";

// طلبات التغيير المالي (P1-PAY-B, BR-PAY-009): every change of an employee's salary, allowances, IBAN or
// payment method waits here for a second person. The requester and the employee himself never decide
// (the server refuses, with the reason); an import run is approved together by its batch.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, RefreshCw, XCircle, Ban, Layers } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { toast, confirmDialog, promptDialog, readApiError } from '@/components/ui/feedback';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

interface Change {
  id: string;
  field: 'COMPENSATION' | 'BANK_IDENTITY';
  source: string;
  status: string;
  effectiveDate: string;
  compensation: { basicSalary: number; allowances: Array<{ name: string; amount: number }> } | null;
  bank: { paymentMethod: string; bankName: string | null; ibanMasked: string | null } | null;
  before: { basicSalary?: number; allowances?: Array<{ name: string; amount: number }>; paymentMethod?: string; bankName?: string | null; ibanMasked?: string | null } | null;
  note: string | null;
  batchKey: string | null;
  requestedAt: string;
  decisionSelfAct: boolean;
  employee: { id: string; code: string; name: string } | null;
}

const STATUS_LABELS: Record<string, string> = {
  LEGACY_UNVERIFIED: 'بانتظار تأكيد الموظف',
  PENDING: 'بانتظار الاعتماد',
  PENDING_EFFECT: 'معتمد، يُطبَّق في تاريخ نفاذه',
  APPLIED: 'مطبَّق',
  REJECTED: 'مرفوض',
  CANCELLED: 'ملغى',
};
const SOURCE_LABELS: Record<string, string> = { FORM: 'إضافة موظف', IMPORT: 'استيراد', ONBOARDING: 'مباشرة عمل', EDIT: 'تعديل الملف', PORTAL: 'بوابة الموظف' };
const METHOD_LABELS: Record<string, string> = { BANK_TRANSFER: 'تحويل بنكي', WPS: 'حماية الأجور', CASH: 'نقداً' };

const total = (c: { basicSalary?: number; allowances?: Array<{ amount: number }> } | null | undefined) =>
  c ? (c.basicSalary ?? 0) + (c.allowances ?? []).reduce((s, a) => s + a.amount, 0) : null;
const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

function describe(c: Change): { before: string; after: string } {
  if (c.field === 'COMPENSATION') {
    const after = c.compensation
      ? `أساسي ${formatMoney(c.compensation.basicSalary)}${c.compensation.allowances.length ? ` + ${c.compensation.allowances.map((a) => `${a.name} ${formatMoney(a.amount)}`).join('، ')}` : ''} (الإجمالي ${formatMoney(total(c.compensation))})`
      : '—';
    const before = c.before ? `أساسي ${formatMoney(c.before.basicSalary ?? 0)} (الإجمالي ${formatMoney(total(c.before))})` : 'لا أجر مسجل';
    return { before, after };
  }
  const fmt = (b: { paymentMethod?: string; bankName?: string | null; ibanMasked?: string | null } | null) =>
    b ? [METHOD_LABELS[b.paymentMethod ?? ''] ?? b.paymentMethod, b.bankName, b.ibanMasked].filter(Boolean).join(' — ') : 'لا هوية بنكية مسجلة';
  return { before: fmt(c.before), after: fmt(c.bank) };
}

export default function FinancialChangesPage() {
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/financial-changes', { cache: 'no-store' });
      if (!res.ok) throw new Error(await readApiError(res, 'تعذر تحميل طلبات التغيير المالي'));
      setChanges((await res.json()).changes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const batches = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of changes) if (c.batchKey && c.status === 'PENDING') m.set(c.batchKey, (m.get(c.batchKey) ?? 0) + 1);
    return [...m.entries()];
  }, [changes]);

  async function act(c: Change, action: 'APPROVE' | 'REJECT' | 'CANCEL') {
    let note: string | null = null;
    if (action === 'REJECT' || action === 'CANCEL') {
      note = await promptDialog(action === 'REJECT' ? 'سبب الرفض' : 'سبب الإلغاء');
      if (note === null) return;
    } else if (!(await confirmDialog(`اعتماد تغيير ${c.field === 'COMPENSATION' ? 'الأجر' : 'الهوية البنكية'} لـ ${c.employee?.name ?? 'الموظف'}؟`))) {
      return;
    }
    setBusy(c.id);
    try {
      const res = await fetch(`/api/financial-changes/${c.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${c.id}:${action}` },
        body: JSON.stringify({ action, note }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      toast.success((await res.json()).message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  async function approveBatch(batchKey: string, count: number) {
    if (!(await confirmDialog(`اعتماد ${count} طلب تغيير مالي من دفعة الاستيراد نفسها؟ يُعتمد كل طلب على حدة، ويُرفض ما قدّمته أنت أو ما يخصك.`))) return;
    setBusy(batchKey);
    try {
      const res = await fetch('/api/financial-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'APPROVE', batchKey }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const body = await res.json();
      const refused = (body.results ?? []).filter((r: { ok: boolean }) => !r.ok);
      if (refused.length) toast.warning(`${body.message}. لم يُعتمد ${refused.length}: ${refused[0].error}`);
      else toast.success(body.message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  return (
    <DashboardLayout>
      <div className="p-4 md:p-6 space-y-4" dir="rtl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-black text-slate-800">طلبات التغيير المالي</h1>
            <p className="text-sm text-slate-600">
              كل تغيير على الراتب أو البدلات أو الآيبان أو طريقة الصرف يعتمده شخص ثانٍ غير مقدّم الطلب وغير الموظف نفسه، ويُطبَّق من تاريخ نفاذه.
            </p>
          </div>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold" disabled={loading}>
            <RefreshCw size={16} /> تحديث
          </button>
        </div>

        {batches.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {batches.map(([key, count]) => (
              <button key={key} type="button" disabled={busy === key} onClick={() => void approveBatch(key, count)} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
                <Layers size={16} /> اعتماد دفعة استيراد ({count})
              </button>
            ))}
          </div>
        )}

        {error && <p className="rounded-lg bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-500">جارٍ التحميل…</p>
        ) : changes.length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-6 text-center text-sm text-slate-600">لا توجد طلبات تغيير مالي مفتوحة</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-700">
                <tr>
                  <th className="p-3 text-right">الموظف</th>
                  <th className="p-3 text-right">التغيير</th>
                  <th className="p-3 text-right">قبل</th>
                  <th className="p-3 text-right">بعد</th>
                  <th className="p-3 text-right">النفاذ</th>
                  <th className="p-3 text-right">الحالة</th>
                  <th className="p-3 text-right">العمر</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => {
                  const d = describe(c);
                  return (
                    <tr key={c.id} className="border-t align-top">
                      <td className="p-3 font-bold">
                        {c.employee?.name ?? '—'}
                        <div className="text-xs text-slate-500">{c.employee?.code}</div>
                      </td>
                      <td className="p-3">
                        {c.field === 'COMPENSATION' ? 'الأجر' : 'الهوية البنكية'}
                        <div className="text-xs text-slate-500">{SOURCE_LABELS[c.source] ?? c.source}</div>
                      </td>
                      <td className="p-3 text-slate-600">{d.before}</td>
                      <td className="p-3 font-bold text-slate-800">{d.after}</td>
                      <td className="p-3">{formatDate(c.effectiveDate)}</td>
                      <td className="p-3">{STATUS_LABELS[c.status] ?? c.status}</td>
                      <td className="p-3">{ageDays(c.requestedAt)} يوم</td>
                      <td className="p-3">
                        <div className="flex gap-2">
                          {c.status === 'PENDING' && (
                            <>
                              <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'APPROVE')} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-xs font-bold text-white disabled:opacity-50">
                                <CheckCircle size={14} /> اعتماد
                              </button>
                              <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'REJECT')} className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2 py-1 text-xs font-bold text-white disabled:opacity-50">
                                <XCircle size={14} /> رفض
                              </button>
                            </>
                          )}
                          {['PENDING', 'PENDING_EFFECT', 'LEGACY_UNVERIFIED'].includes(c.status) && (
                            <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'CANCEL')} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-bold disabled:opacity-50">
                              <Ban size={14} /> إلغاء
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

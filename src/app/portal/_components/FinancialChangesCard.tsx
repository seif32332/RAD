"use client";

// The employee's own financial change requests (P1-PAY-B, BR-PAY-009): his IBAN changes and their state,
// and the confirmation of a migrated legacy IBAN request (req-to-be §17 C11: he sees the FULL IBAN and
// the bank before confirming; nothing expires). Hidden when there is nothing to show.

import React, { useCallback, useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { confirmDialog, readApiError, toast } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';

interface Change {
  id: string;
  field: 'COMPENSATION' | 'BANK_IDENTITY';
  status: string;
  effectiveDate: string;
  bank: { bankName: string | null; ibanMasked: string | null } | null;
  ibanToConfirm: string | null;
  requestedById: string | null;
}

const STATUS: Record<string, string> = {
  LEGACY_UNVERIFIED: 'بانتظار تأكيدك',
  PENDING: 'بانتظار اعتماد شخص ثانٍ',
  PENDING_EFFECT: 'معتمد، يُطبَّق في تاريخه',
  APPLIED: 'طُبِّق',
  REJECTED: 'رُفض',
  CANCELLED: 'أُلغي',
};

export default function FinancialChangesCard() {
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/financial-changes', { cache: 'no-store' });
      if (!res.ok) return;
      setChanges(((await res.json()).changes ?? []).filter((c: Change) => c.field === 'BANK_IDENTITY').slice(0, 5));
    } catch {
      /* the card stays hidden */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(c: Change, action: 'CONFIRM' | 'CANCEL') {
    const text = action === 'CONFIRM' ? `تأكيد أن هذا آيبانك: ${c.ibanToConfirm ?? ''}${c.bank?.bankName ? ` (${c.bank.bankName})` : ''}؟ يعتمده بعد ذلك شخص ثانٍ.` : 'سحب طلب تغيير الآيبان؟';
    if (!(await confirmDialog(text))) return;
    setBusy(c.id);
    try {
      const res = await fetch('/api/portal/financial-changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id, action }) });
      if (!res.ok) throw new Error(await readApiError(res));
      toast.success((await res.json()).message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  if (!changes.length) return null;
  return (
    <section className="rounded-2xl border bg-white p-4 space-y-3" dir="rtl" aria-label="طلبات تغيير الآيبان">
      <h2 className="flex items-center gap-2 text-base font-black text-slate-800">
        <Landmark size={18} className="text-indigo-500" /> طلبات تغيير الآيبان
      </h2>
      <ul className="space-y-2">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-3 text-sm">
            <div>
              <div className="font-bold" dir="ltr">{c.status === 'LEGACY_UNVERIFIED' ? c.ibanToConfirm : c.bank?.ibanMasked}</div>
              <div className="text-xs text-slate-600">
                {c.bank?.bankName ?? ''} · {STATUS[c.status] ?? c.status} · {formatDateShort(c.effectiveDate)}
              </div>
            </div>
            <div className="flex gap-2">
              {c.status === 'LEGACY_UNVERIFIED' && (
                <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'CONFIRM')} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white disabled:opacity-50">
                  تأكيد
                </button>
              )}
              {['LEGACY_UNVERIFIED', 'PENDING'].includes(c.status) && (
                <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'CANCEL')} className="rounded-lg border px-3 py-1 text-xs font-bold disabled:opacity-50">
                  سحب
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

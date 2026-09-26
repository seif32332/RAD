'use client';

import React, { useState } from 'react';
import { SETTLEMENT_PAYMENT_METHODS, type SettlementPaymentMethod } from '@/lib/settlement-payment';

export interface PaymentProofValue {
  paymentMethod: SettlementPaymentMethod | '';
  paymentReference: string;
  paidAt: string; // YYYY-MM-DD
}

export const EMPTY_PAYMENT_PROOF: PaymentProofValue = { paymentMethod: '', paymentReference: '', paidAt: '' };

export const paymentProofComplete = (v: PaymentProofValue) => !!v.paymentMethod && v.paymentReference.trim().length >= 2 && !!v.paidAt;

/**
 * Payment proof of a settlement (method, reference, actual day). Required when finance confirms a
 * settlement payment: the settlement statement's discharge refers to exactly this payment.
 */
export default function SettlementPaymentProofFields({ value, onChange, disabled }: { value: PaymentProofValue; onChange: (v: PaymentProofValue) => void; disabled?: boolean }) {
  const [today] = useState(() => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)); // Riyadh day, for the date picker's max
  const refLabel = value.paymentMethod ? SETTLEMENT_PAYMENT_METHODS[value.paymentMethod].referenceAr : 'رقم التحويل أو السند';
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="block text-[13px] font-extrabold text-slate-700 mb-1">إثبات الصرف (يظهر في بيان التسوية والمخالصة) <span className="text-red-500">*</span></legend>
      <div className="flex flex-wrap gap-3 text-[13px]">
        {(Object.keys(SETTLEMENT_PAYMENT_METHODS) as SettlementPaymentMethod[]).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            <input type="radio" name="paymentMethod" required checked={value.paymentMethod === m} onChange={() => onChange({ ...value, paymentMethod: m })} />
            {SETTLEMENT_PAYMENT_METHODS[m].ar}
          </label>
        ))}
      </div>
      <input value={value.paymentReference} required minLength={2} maxLength={60} dir="auto" placeholder={refLabel} aria-label={refLabel}
        onChange={(e) => onChange({ ...value, paymentReference: e.target.value })}
        className="w-full border border-slate-300 rounded-xl px-3 py-2.5 text-[14px]" />
      <label className="block text-[12px] font-bold text-slate-600">
        تاريخ الصرف الفعلي
        <input type="date" value={value.paidAt} required max={today} onChange={(e) => onChange({ ...value, paidAt: e.target.value })}
          className="mt-1 block border border-slate-300 rounded-xl px-3 py-2 text-[14px]" />
      </label>
    </fieldset>
  );
}

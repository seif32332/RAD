"use client";

// «نشاط المنشأة في نطاقات»: a select of the Nitaqat register (NitaqatActivity, with its evidence status),
// stored in Company.nitaqatActivityKey. Replaces the phase-1 free-text field, which stays visible read-only
// when it has a value. Only SUPER_ADMIN / COMPANY_ADMIN may change it (the API enforces it:
// src/app/api/companies/_workforce.ts). The edit page does not load the key itself: this component reads
// the stored key from GET /api/companies/[id] and writes formData.nitaqatActivityKey only when the user
// changes the select (undefined = unchanged for the API).
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ExternalLink } from 'lucide-react';

export interface NitaqatActivityOption {
  key: string;
  nameAr: string;
  code: string | null;
  sizeSegment: string | null;
  status: string;
}

const STATUS_TEXT: Record<string, string> = {
  VERIFIED_PRIMARY: 'موثّق من الدليل',
  AMBIGUOUS: 'يحتاج مطابقة مع ملحق الدليل',
  PROVISIONAL: 'مؤقت',
  USER_INPUT: 'إدخال المنشأة',
};

export function activityOptionLabel(a: NitaqatActivityOption): string {
  return `${a.nameAr}${a.sizeSegment ? ` — ${a.sizeSegment}` : ''}${a.code ? ` (${a.code})` : ''} · ${STATUS_TEXT[a.status] ?? a.status}`;
}

export function NitaqatActivitySelect({
  mode,
  value,
  legacyText,
  canEdit,
  onChange,
}: {
  mode: 'new' | 'edit';
  /** formData.nitaqatActivityKey: undefined until the user changes it. */
  value: string | undefined;
  legacyText: string;
  canEdit: boolean;
  onChange: (key: string) => void;
}) {
  const params = useParams<{ id?: string }>();
  const companyId = mode === 'edit' && typeof params?.id === 'string' ? params.id : null;
  const [options, setOptions] = useState<NitaqatActivityOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [storedKey, setStoredKey] = useState<string>('');

  useEffect(() => {
    let active = true;
    fetch('/api/workforce/nitaqat?lite=1', { cache: 'no-store' })
      .then(async (r) => {
        if (!active) return;
        if (!r.ok) {
          setOptionsError(r.status === 403 ? 'قائمة أنشطة نطاقات متاحة لأدوار محرك القرارات' : 'تعذر تحميل أنشطة نطاقات');
          setOptions([]);
          return;
        }
        const j = (await r.json()) as { activities: NitaqatActivityOption[] };
        setOptions(j.activities);
      })
      .catch(() => active && setOptionsError('تعذر تحميل أنشطة نطاقات'));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!companyId) return;
    let active = true;
    fetch(`/api/companies/${encodeURIComponent(companyId)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!active || !r.ok) return;
        const j = (await r.json()) as { nitaqatActivityKey?: string | null };
        setStoredKey(j.nitaqatActivityKey ?? '');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [companyId]);

  const current = value ?? storedKey;
  const selected = options?.find((o) => o.key === current) ?? null;
  const unknownStored = !!current && !!options && !selected;

  return (
    <div className="flex flex-col gap-2 md:col-span-2">
      <label htmlFor="company-field-nitaqatActivityKey" className="text-[12px] font-extrabold text-slate-800">
        نشاط المنشأة في نطاقات (منحنى النطاقات الرسمي)
      </label>
      <select
        id="company-field-nitaqatActivityKey"
        name="nitaqatActivityKey"
        value={current}
        disabled={!canEdit || options === null}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-5 py-4 text-[16px] sm:text-[14px] font-black bg-[#F4F4F6] border-2 border-transparent focus:bg-white rounded-[1.25rem] focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 text-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <option value="">{options === null ? 'جارٍ التحميل…' : '— لم يُحدَّد —'}</option>
        {unknownStored && <option value={current}>{`${current} (غير موجود في السجل)`}</option>}
        {(options ?? []).map((o) => (
          <option key={o.key} value={o.key}>
            {activityOptionLabel(o)}
          </option>
        ))}
      </select>
      {selected?.status === 'AMBIGUOUS' && <p className="text-[11px] font-bold text-amber-700">ثوابت هذا النشاط تحتاج مطابقة مع ملحق الدليل: نتيجة النطاق تقديرية.</p>}
      {optionsError && <p className="text-[11px] font-bold text-slate-500">{optionsError}</p>}
      <p className="text-[11px] font-bold text-slate-500 leading-relaxed">
        يُستخدم في «مخطط السعودة» لحساب حدود النطاقات Y = m·ln(X) + c.{' '}
        <Link href="/workforce/nitaqat-register" className="inline-flex items-center gap-1 text-blue-700 hover:underline">
          سجل نطاقات والتوطين <ExternalLink size={11} aria-hidden="true" />
        </Link>
      </p>
      {legacyText.trim() && (
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="company-field-nitaqatActivity" className="text-[11px] font-extrabold text-slate-500">
            النشاط المكتوب سابقاً (نص للمرجع، للقراءة فقط)
          </label>
          <input
            id="company-field-nitaqatActivity"
            name="nitaqatActivity"
            type="text"
            value={legacyText}
            readOnly
            className="w-full px-5 py-3 text-[13px] font-bold bg-slate-50 border border-slate-200 rounded-[1rem] text-slate-600"
          />
        </div>
      )}
    </div>
  );
}

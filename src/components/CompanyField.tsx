"use client";

import React, { useEffect, useState } from 'react';

export interface CompanyOption {
  id: string;
  nameArabic: string;
}

/**
 * The companies the signed-in user may pick (GET /api/companies is already limited to the user's
 * company scope). Forms that create a company-keyed record show <CompanyField> and send the chosen id
 * only when there is more than one; with exactly one the server fills it in (record-company.ts).
 */
export function useSelectableCompanies(): CompanyOption[] {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/companies');
        if (!res.ok) return;
        const d: unknown = await res.json();
        if (!cancelled && Array.isArray(d)) setCompanies(d as CompanyOption[]);
      } catch {
        /* the server still answers with a clear message when the company is missing */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return companies;
}

const DEFAULT_CLASS = 'w-full px-5 py-3.5 bg-white border border-slate-200 focus:border-teal-500 rounded-2xl font-bold text-[14px] focus:outline-none focus:ring-4 focus:ring-teal-50 transition-all shadow-sm';

/** «الشركة» select, rendered only when the user can choose between several companies. Required. */
export function CompanyField({ companies, value, onChange, id = 'record-company', className = DEFAULT_CLASS }: {
  companies: CompanyOption[];
  value: string;
  onChange: (id: string) => void;
  id?: string;
  className?: string;
}) {
  if (companies.length < 2) return null;
  return (
    <div>
      <label htmlFor={id} className="text-[12px] font-extrabold text-slate-700 mb-2 block">الشركة</label>
      <select id={id} required value={value} onChange={(e) => onChange(e.target.value)} className={className}>
        <option value="">اختر الشركة...</option>
        {companies.map((c) => <option key={c.id} value={c.id}>{c.nameArabic}</option>)}
      </select>
    </div>
  );
}

/** Body fragment: the chosen company, only when one was chosen (JSON.stringify keeps it out otherwise). */
export function companyBody(companies: CompanyOption[], value: string): { companyId?: string } {
  return companies.length > 1 && value ? { companyId: value } : {};
}

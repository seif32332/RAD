'use client';

// Portal card «بيان المكافآت الشاملة» (SPEC §9): the employee's own total for the current year with a link
// to the full statement (/portal/total-rewards). Renders nothing unless the owner enabled the statement
// (GET /api/portal/total-rewards answers { enabled: false }) or when the request fails.
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, Gift } from 'lucide-react';
import { formatMoney } from '@/lib/money';
import type { TotalRewardsStatement } from '@/lib/workforce/total-rewards';

export type PortalTotalRewardsResponse =
  | { enabled: false; message: string }
  | { enabled: true; statement: TotalRewardsStatement; years: { first: number; last: number }; payrollYears: number[] };

export default function TotalRewardsCard() {
  const [data, setData] = useState<PortalTotalRewardsResponse | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/portal/total-rewards', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as PortalTotalRewardsResponse;
        if (active) setData(json);
      })
      .catch(() => {
        // Optional card: hidden when unavailable.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!data || !data.enabled) return null;
  const s = data.statement;
  return (
    <section aria-labelledby="portal-total-rewards-title">
      <Link
        href="/portal/total-rewards"
        className="group flex items-center gap-4 rounded-[1.75rem] border border-emerald-100 bg-gradient-to-l from-emerald-50 to-white p-4 md:p-5 shadow-sm hover:shadow-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        <span aria-hidden="true" className="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
          <Gift size={24} />
        </span>
        <span className="min-w-0 flex-1">
          <span id="portal-total-rewards-title" className="block text-[15px] md:text-[16px] font-black text-slate-800">
            بيان المكافآت الشاملة {s.year}
          </span>
          {s.available ? (
            <span className="block text-[12.5px] font-bold text-slate-600">
              كلفة المنشأة عليك حتى الآن: <span dir="ltr" className="tabular-nums font-black text-emerald-700">{formatMoney(s.totals.total)}</span> ر.س
            </span>
          ) : (
            <span className="block text-[12.5px] font-bold text-slate-500">راتبك ومزاياك وما تدفعه المنشأة عنك، في صفحة واحدة</span>
          )}
        </span>
        <ChevronLeft size={20} className="text-slate-400 group-hover:text-emerald-600 shrink-0" aria-hidden="true" />
      </Link>
    </section>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileSignature, Download } from 'lucide-react';
import { formatDateShort } from '@/lib/dates';
import { VALIDITY, pdfUrl, type DocView } from '@/app/documents/_lib';

interface Row extends DocView { typeLabel: string }

/**
 * Official documents of one employee on his profile (issued letters + pending ones), read from the
 * same staff endpoint as /documents, filtered by employee. Hidden when the role issues no type.
 */
export default function EmployeeDocumentsCard({ employeeId }: { employeeId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/documents/requests?scope=staff&employeeId=${encodeURIComponent(employeeId)}`, { cache: 'no-store' });
      if (!res.ok || !alive) return;
      const data = await res.json();
      setRows(data.issued ?? []);
      setPending((data.pending ?? []).length);
    })();
    return () => {
      alive = false;
    };
  }, [employeeId]);

  if (!rows) return null;

  return (
    <div className="bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.03)] p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
          <FileSignature size={20} className="text-indigo-600" aria-hidden="true" /> المستندات الرسمية
        </h3>
        <Link href="/documents" className="text-[13px] font-bold text-indigo-700">إصدار أو إدارة</Link>
      </div>
      {pending > 0 && <p className="text-[13px] text-amber-700 mb-2">{pending} طلب بانتظار الاعتماد.</p>}
      {rows.length === 0 ? (
        <p className="text-[13px] text-slate-500">لم يصدر أي مستند رسمي لهذا الموظف.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-[13px]">
          {rows.map((d) => (
            <li key={d.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <span><b>{d.typeLabel}</b> · <span dir="ltr">{d.number}</span> · {formatDateShort(d.issuedAt)}</span>
              <span className="flex items-center gap-3">
                <span className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${VALIDITY[d.validity].tone}`}>{VALIDITY[d.validity].label}</span>
                {d.validity !== 'PURGED' && (
                  <a href={pdfUrl(d.id)} className="inline-flex items-center gap-1 text-indigo-700 font-bold"><Download size={14} aria-hidden="true" /> تنزيل</a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

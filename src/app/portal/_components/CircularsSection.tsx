"use client";

// Published circulars / administrative decisions (GET /api/owner-portal/circulars returns only
// PUBLISHED rows to non-owners). Each circular can be expanded to read its full content.

import React, { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, DownloadCloud, Info, RefreshCw } from 'lucide-react';
import { readApiError } from '@/components/ui/feedback';
import { formatDateShort } from '@/lib/dates';
import { safeHref } from '../_lib';
import { redirectToLogin } from './redirect-to-login';

interface Circular {
  id: string;
  title: string;
  content: string;
  issuedBy?: string | null;
  status?: string | null;
  datePublished: string;
  attachmentUrl?: string | null;
}

const INITIAL_VISIBLE = 5;

/** null = redirected to the login page. */
async function fetchPublishedCirculars(): Promise<{ ok: true; items: Circular[] } | { ok: false; error: string } | null> {
  try {
    const res = await fetch('/api/owner-portal/circulars', { cache: 'no-store' });
    if (res.status === 401) {
      redirectToLogin();
      return null;
    }
    if (!res.ok) return { ok: false, error: await readApiError(res, 'تعذر تحميل التعاميم') };
    const data: unknown = await res.json();
    // The owner also receives drafts from this endpoint: the portal only lists published ones.
    return { ok: true, items: Array.isArray(data) ? (data as Circular[]).filter((c) => !c.status || c.status === 'PUBLISHED') : [] };
  } catch {
    return { ok: false, error: 'تعذر الاتصال بالخادم' };
  }
}

export default function CircularsSection({ compact = false }: { compact?: boolean }) {
  const [items, setItems] = useState<Circular[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchPublishedCirculars().then((r) => {
      if (cancelled || r === null) return;
      if (r.ok) {
        setError(null);
        setItems(r.items);
      } else {
        setError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const visible = items ? (showAll ? items : items.slice(0, INITIAL_VISIBLE)) : [];

  return (
    <section aria-label="التعاميم والقرارات الإدارية" className={compact ? '' : 'md:col-span-2 xl:col-span-3 mt-4'}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
          <Info className="text-indigo-400" size={20} /> التعاميم والقرارات الإدارية
        </h3>
        {items && items.length > INITIAL_VISIBLE && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[12px] font-bold text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full hover:bg-indigo-100">
            {showAll ? 'عرض أقل' : `عرض الكل (${items.length})`}
          </button>
        )}
      </div>
      <div className="bg-white border border-slate-200 rounded-[2rem] p-2">
        {error ? (
          <div className="text-center py-8 flex flex-col items-center gap-3">
            <p className="font-bold text-rose-500 text-[13px]">{error}</p>
            <button type="button" onClick={() => {
                setError(null);
                setItems(null);
                setReloadKey((k) => k + 1);
              }} className="flex items-center gap-2 text-[12px] font-black text-slate-600 bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-xl">
              <RefreshCw size={14} /> إعادة المحاولة
            </button>
          </div>
        ) : items === null ? (
          <div className="text-center py-8 font-bold text-slate-400 text-[13px]">جاري تحميل التعاميم...</div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 font-bold text-slate-400 text-[13px]">لا توجد تعاميم أو قرارات إدارية جديدة في الوقت الحالي.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((c) => {
              const open = expanded === c.id;
              const href = safeHref(c.attachmentUrl);
              return (
                <li key={c.id} className="p-5 hover:bg-slate-50 rounded-2xl transition">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : c.id)}
                      aria-expanded={open}
                      className="flex items-start gap-4 text-right flex-1 min-w-0"
                    >
                      <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0 border border-indigo-100/50">
                        <AlertTriangle size={20} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-extrabold text-[15px] text-slate-800 mb-1 flex items-center gap-2">
                          {c.title}
                          {open ? <ChevronUp size={16} className="text-slate-400 shrink-0" /> : <ChevronDown size={16} className="text-slate-400 shrink-0" />}
                        </p>
                        <p className={`font-semibold text-[13px] text-slate-500 whitespace-pre-line ${open ? '' : 'line-clamp-2 md:line-clamp-1'}`}>{c.content}</p>
                        {open && c.issuedBy && <p className="text-[11px] font-bold text-slate-400 mt-2">صادر عن: {c.issuedBy}</p>}
                      </div>
                    </button>
                    <div className="flex flex-col md:items-end shrink-0 gap-1">
                      <div className="bg-slate-100 text-slate-500 text-[11px] font-black px-3 py-1.5 rounded-lg flex items-center justify-center">
                        {formatDateShort(c.datePublished)}
                      </div>
                      {href && (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold text-blue-600 hover:underline flex items-center gap-1">
                          <DownloadCloud size={12} /> تحميل المرفق
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

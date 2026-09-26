"use client";

// «تقرير PDF» (SPEC §11 «تقارير PDF»): asks the server for an internal PDF report of the view on screen and
// downloads it. GET /api/workforce/report?kind=…&query, or POST with `body` (the page's own request body).
// When the report service is not configured the server answers 503 «خدمة التقارير غير مهيأة — استخدم تصدير
// Excel»; that message (or any other error) is shown as a toast. `endpoint` serves the portal statement.
import { useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { readApiError, toast } from '@/components/ui/feedback';

type QueryValue = string | number | boolean | null | undefined;

const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50';

/** File name from Content-Disposition (RFC 5987 filename* first). */
function fileNameOf(h: string | null): string | null {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall back to the ASCII name */
    }
  }
  return /filename="([^"]+)"/i.exec(h)?.[1] ?? null;
}

export default function PdfReportButton({
  kind,
  query,
  body,
  disabled,
  label = 'تقرير PDF',
  endpoint = '/api/workforce/report',
  className = BUTTON_CLASS,
}: {
  kind?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  disabled?: boolean;
  label?: string;
  endpoint?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const u = new URLSearchParams(kind ? { kind } : {});
      for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined && v !== '' && v !== false) u.set(k, v === true ? '1' : String(v));
      const qs = u.toString();
      const url = qs ? `${endpoint}?${qs}` : endpoint;
      const res = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, 'تعذر تجهيز التقرير'));
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = fileNameOf(res.headers.get('Content-Disposition')) ?? `radeef-${kind ?? 'report'}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      toast.error('تعذر تجهيز التقرير: تعذر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={run} disabled={disabled || busy} aria-busy={busy} className={className}>
      {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />} {busy ? 'جارٍ تجهيز التقرير…' : label}
    </button>
  );
}

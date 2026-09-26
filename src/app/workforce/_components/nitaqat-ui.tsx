"use client";

// Shared Nitaqat UI of the workforce pages: band badge, band gauge (Red -> Platinum with the thresholds
// and the current %), register status badge. Display only: every number comes from the API.
import React from 'react';
import type { NitaqatBand } from '@/lib/workforce/nitaqat';

export const BAND_TEXT: Record<NitaqatBand, string> = {
  RED: 'أحمر',
  LOW_GREEN: 'أخضر منخفض',
  MEDIUM_GREEN: 'أخضر متوسط',
  HIGH_GREEN: 'أخضر مرتفع',
  PLATINUM: 'بلاتيني',
};

const BAND_BADGE: Record<NitaqatBand, string> = {
  RED: 'bg-rose-100 text-rose-800 border-rose-300',
  LOW_GREEN: 'bg-lime-100 text-lime-800 border-lime-300',
  MEDIUM_GREEN: 'bg-green-100 text-green-800 border-green-300',
  HIGH_GREEN: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  PLATINUM: 'bg-slate-800 text-white border-slate-800',
};

const BAND_FILL: Record<NitaqatBand, string> = {
  RED: 'bg-rose-400',
  LOW_GREEN: 'bg-lime-400',
  MEDIUM_GREEN: 'bg-green-500',
  HIGH_GREEN: 'bg-emerald-700',
  PLATINUM: 'bg-slate-700',
};

export function BandBadge({ band, className = '' }: { band: NitaqatBand | null | undefined; className?: string }) {
  if (!band) return <span className={`inline-flex rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-500 ${className}`}>غير محسوب</span>;
  return <span className={`inline-flex whitespace-nowrap rounded-lg border px-2 py-0.5 text-[11.5px] font-black ${BAND_BADGE[band]} ${className}`}>{BAND_TEXT[band]}</span>;
}

const ROW_STATUS: Record<string, { text: string; cls: string }> = {
  VERIFIED_PRIMARY: { text: 'موثّق من الدليل', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  AMBIGUOUS: { text: 'يحتاج مطابقة مع ملحق الدليل', cls: 'bg-amber-50 text-amber-900 border-amber-300' },
  PROVISIONAL: { text: 'مؤقت', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  USER_INPUT: { text: 'إدخال المنشأة', cls: 'bg-blue-50 text-blue-800 border-blue-200' },
  PARTIAL: { text: 'موثّق جزئياً', cls: 'bg-teal-50 text-teal-800 border-teal-200' },
};

/** Status of a register row (NitaqatActivity / NitaqatCurve / LocalizationDecision). */
export function RowStatusBadge({ status }: { status: string | null | undefined }) {
  const s = ROW_STATUS[(status ?? '').toUpperCase()] ?? { text: status || '—', cls: 'bg-slate-100 text-slate-700 border-slate-300' };
  return <span className={`inline-flex whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10.5px] font-black ${s.cls}`}>{s.text}</span>;
}

/**
 * Horizontal gauge 0–100% (RTL: 0 on the right). Segments between the thresholds are coloured by band;
 * the marker is the current Saudization %. Thresholds outside 0–100 are clamped for drawing only.
 */
export function BandGauge({ pct, thresholds, label }: { pct: number; thresholds: ReadonlyArray<{ band: NitaqatBand; y: number }>; label: string }) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const cuts = [...thresholds].sort((a, b) => a.y - b.y);
  const segments: Array<{ band: NitaqatBand; from: number; to: number }> = [];
  let from = 0;
  let band: NitaqatBand = 'RED';
  for (const t of cuts) {
    segments.push({ band, from, to: clamp(t.y) });
    from = clamp(t.y);
    band = t.band;
  }
  segments.push({ band, from, to: 100 });
  const summary = `${label}: ${pct}%. ${cuts.map((c) => `${BAND_TEXT[c.band]} من ${c.y}%`).join('، ')}`;
  return (
    <figure className="w-full" aria-label={summary} role="img">
      <div className="relative h-5 w-full overflow-hidden rounded-full bg-slate-100" dir="rtl">
        {segments
          .filter((s) => s.to > s.from)
          .map((s) => (
            <div key={`${s.band}-${s.from}`} className={`absolute top-0 h-full ${BAND_FILL[s.band]} opacity-80`} style={{ right: `${s.from}%`, width: `${s.to - s.from}%` }} />
          ))}
        <div className="absolute top-[-2px] h-[calc(100%+4px)] w-1 rounded bg-slate-950 shadow" style={{ right: `calc(${clamp(pct)}% - 2px)` }} aria-hidden="true" />
      </div>
      <div className="relative mt-1 h-4 text-[10px] font-bold text-slate-500" dir="rtl" aria-hidden="true">
        {cuts.map((c) => (
          <span key={c.band} className="absolute whitespace-nowrap tabular-nums" style={{ right: `${clamp(c.y)}%`, transform: 'translateX(50%)' }} dir="ltr">
            {Math.round(c.y * 10) / 10}
          </span>
        ))}
      </div>
    </figure>
  );
}

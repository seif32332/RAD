// Money helpers. Amounts are stored as Float (SAR); every computed amount must be
// rounded to halalas with roundMoney() before it is stored or summed further.

export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse user input into a finite number (or `fallback`). Accepts "1,234.50" and Arabic-Indic digits. */
export function toNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (v === null || v === undefined) return fallback;
  const s = String(v)
    .trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[,٬\s]/g, '')
    .replace(/٫/g, '.');
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export function sumMoney(values: Array<number | null | undefined>): number {
  let cents = 0;
  for (const v of values) cents += Math.round((v ?? 0) * 100);
  return cents / 100;
}

export function formatMoney(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

'use strict';
/**
 * Optional commercial fields per tenant (DEC-007). Empty by default: nothing is pre-filled and
 * nothing in the panel acts on them (no invoicing, no automatic suspension). They exist so the
 * operator can record what each customer actually pays next to its active-employee count.
 *
 *   price               number >= 0 (per billing cycle), or null
 *   currency            ISO 4217 code (e.g. SAR), or null
 *   billing_cycle       monthly | quarterly | semiannual | annual | biennial | custom, or null
 *   paid_until          YYYY-MM-DD, or null (informational only; the license end date is separate)
 *   vat_rate            percent 0..100, or null (the rate is NOT assumed: VAT registration is UNKNOWN)
 *   price_includes_vat  true | false | null
 */
const { ValidationError, validateOptionalDateKey } = require('./validate');

const BILLING_CYCLES = Object.freeze(['monthly', 'quarterly', 'semiannual', 'annual', 'biennial', 'custom']);
const COMMERCIAL_FIELDS = Object.freeze(['price', 'currency', 'billing_cycle', 'paid_until', 'vat_rate', 'price_includes_vat']);

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function optionalNumber(value, label, { min, max }) {
  if (isEmpty(value)) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${label} غير صالح (${min}..${max})`);
  return Math.round(n * 100) / 100;
}

/** Validate a partial/complete commercial payload. Returns an object with ALL six fields. */
function validateCommercial(input) {
  const body = input && typeof input === 'object' ? input : {};
  const currency = isEmpty(body.currency) ? null : String(body.currency).trim().toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new ValidationError('العملة يجب أن تكون رمزاً من 3 أحرف (مثل SAR)');
  const cycle = isEmpty(body.billing_cycle) ? null : String(body.billing_cycle).trim().toLowerCase();
  if (cycle !== null && !BILLING_CYCLES.includes(cycle)) throw new ValidationError('دورة الفوترة غير صالحة');
  let includesVat = null;
  if (body.price_includes_vat === true || body.price_includes_vat === 'true' || body.price_includes_vat === 1) includesVat = true;
  else if (body.price_includes_vat === false || body.price_includes_vat === 'false' || body.price_includes_vat === 0) includesVat = false;
  else if (!isEmpty(body.price_includes_vat)) throw new ValidationError('قيمة "السعر شامل الضريبة" غير صالحة');
  return {
    price: optionalNumber(body.price, 'السعر', { min: 0, max: 10_000_000 }),
    currency,
    billing_cycle: cycle,
    paid_until: validateOptionalDateKey(isEmpty(body.paid_until) ? null : String(body.paid_until).trim()),
    vat_rate: optionalNumber(body.vat_rate, 'نسبة الضريبة', { min: 0, max: 100 }),
    price_includes_vat: includesVat,
  };
}

/** Registry row -> API view (SQLite stores the boolean as 0/1/NULL). */
function commercialView(row) {
  if (!row) return null;
  return {
    price: row.price ?? null,
    currency: row.currency ?? null,
    billing_cycle: row.billing_cycle ?? null,
    paid_until: row.paid_until ?? null,
    vat_rate: row.vat_rate ?? null,
    price_includes_vat: row.price_includes_vat === null || row.price_includes_vat === undefined ? null : !!row.price_includes_vat,
  };
}

module.exports = { BILLING_CYCLES, COMMERCIAL_FIELDS, validateCommercial, commercialView };

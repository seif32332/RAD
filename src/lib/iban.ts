// Saudi IBAN validation (pure, client-safe: no server imports).
//
// Format checked here (ISO 13616 structure for Saudi Arabia):
//   SA kk bb aaaaaaaaaaaaaaaaaa  -> 24 characters: "SA", 2 check digits, 2-digit bank code, 18-digit account.
// The check digits are verified with the ISO 7064 MOD 97-10 rule used by every IBAN.
//
// Everything here is a DATA-QUALITY WARNING for HR (employee form / Excel import): a failed check
// never blocks a save. The bank code is only extracted; it is not mapped to a bank name because
// no verified code list is shipped with the app.

export const SAUDI_IBAN_LENGTH = 24;

export type IbanIssue = 'EMPTY' | 'COUNTRY' | 'LENGTH' | 'CHARACTERS' | 'CHECKSUM';

export interface SaudiIbanResult {
  /** True when the IBAN passes every check. */
  valid: boolean;
  /** Upper-cased value without spaces / dashes ('' for blank input). */
  normalized: string;
  /** 2-digit bank code (characters 5-6) when the structure allows reading it. */
  bankCode: string | null;
  issue: IbanIssue | null;
  /** Arabic warning text for the UI / import report (null when valid). */
  message: string | null;
}

const ISSUE_MESSAGES: Record<IbanIssue, string> = {
  EMPTY: 'رقم الآيبان فارغ',
  COUNTRY: 'رقم الآيبان السعودي يجب أن يبدأ بـ SA',
  LENGTH: `رقم الآيبان السعودي يتكون من ${SAUDI_IBAN_LENGTH} خانة (SA + 22 رقماً)`,
  CHARACTERS: 'رقم الآيبان السعودي يجب أن يحتوي على أرقام فقط بعد SA',
  CHECKSUM: 'رقم الآيبان غير صحيح (خانات التحقق لا تطابق)',
};

/** Removes spaces, dashes and bidi marks, converts Arabic-Indic digits and upper-cases. */
export function normalizeIban(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[‎‏‪-‮\s-]/g, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toUpperCase();
}

/**
 * ISO 7064 MOD 97-10 remainder of an IBAN (country + check digits moved to the end, letters
 * A..Z -> 10..35). A valid IBAN gives 1. Returns NaN for characters outside [0-9A-Z].
 */
export function ibanMod97(iban: string): number {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    let digits: string;
    if (code >= 48 && code <= 57) digits = ch;
    else if (code >= 65 && code <= 90) digits = String(code - 55);
    else return Number.NaN;
    for (const d of digits) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem;
}

/** The 2 check digits for `country` + `bban` (e.g. to build synthetic test IBANs). */
export function ibanCheckDigits(country: string, bban: string): string {
  const rem = ibanMod97(`${country.toUpperCase()}00${bban.toUpperCase()}`);
  return String(98 - rem).padStart(2, '0');
}

/** Validates a Saudi IBAN. Blank input -> issue EMPTY (callers usually skip blank values). */
export function validateSaudiIban(v: unknown): SaudiIbanResult {
  const normalized = normalizeIban(v);
  const fail = (issue: IbanIssue, bankCode: string | null = null): SaudiIbanResult => ({
    valid: false,
    normalized,
    bankCode,
    issue,
    message: ISSUE_MESSAGES[issue],
  });
  if (!normalized) return fail('EMPTY');
  if (!normalized.startsWith('SA')) return fail('COUNTRY');
  if (!/^SA[0-9]*$/.test(normalized)) return fail('CHARACTERS');
  if (normalized.length !== SAUDI_IBAN_LENGTH) return fail('LENGTH');
  const bankCode = normalized.slice(4, 6);
  if (ibanMod97(normalized) !== 1) return fail('CHECKSUM', bankCode);
  return { valid: true, normalized, bankCode, issue: null, message: null };
}

/** Arabic warning for a non-blank IBAN that fails validation; null when blank or valid. */
export function ibanWarning(v: unknown): string | null {
  const r = validateSaudiIban(v);
  if (r.valid || r.issue === 'EMPTY') return null;
  return r.message;
}

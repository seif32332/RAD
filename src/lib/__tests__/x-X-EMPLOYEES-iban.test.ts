import { describe, expect, it } from 'vitest';
import { ibanCheckDigits, ibanMod97, ibanWarning, normalizeIban, validateSaudiIban, SAUDI_IBAN_LENGTH } from '@/lib/iban';

/** Independent ISO 7064 MOD 97-10 check digits with BigInt (does not reuse the implementation). */
function refCheckDigits(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return String(BigInt(98) - (BigInt(rearranged) % BigInt(97))).padStart(2, '0');
}

/** Synthetic Saudi IBAN: bank code + 18-digit account made up for the test (not a real account). */
function syntheticIban(bankCode: string, account: string): string {
  const bban = `${bankCode}${account}`;
  return `SA${refCheckDigits('SA', bban)}${bban}`;
}

const VALID_A = syntheticIban('80', '000000000000001234');
const VALID_B = syntheticIban('10', '999999999999999999');
const VALID_C = syntheticIban('05', '000000000000000000');

describe('synthetic fixtures', () => {
  it('are 24 characters and agree with the implementation check digits', () => {
    for (const iban of [VALID_A, VALID_B, VALID_C]) {
      expect(iban).toHaveLength(SAUDI_IBAN_LENGTH);
      expect(ibanCheckDigits('SA', iban.slice(4))).toBe(iban.slice(2, 4));
      expect(ibanMod97(iban)).toBe(1);
    }
  });
});

describe('normalizeIban', () => {
  it('removes spaces / dashes / bidi marks, upper-cases and converts Arabic-Indic digits', () => {
    expect(normalizeIban(' sa12 3456-78 ')).toBe('SA12345678');
    expect(normalizeIban('‎SA١٢٣')).toBe('SA123');
    expect(normalizeIban('SA۱۲')).toBe('SA12');
  });
  it('non-strings -> empty', () => {
    expect(normalizeIban(null)).toBe('');
    expect(normalizeIban(123)).toBe('');
  });
});

describe('validateSaudiIban', () => {
  it('accepts synthetic valid IBANs (also when typed with spaces / lower case)', () => {
    const r = validateSaudiIban(VALID_A);
    expect(r).toEqual({ valid: true, normalized: VALID_A, bankCode: '80', issue: null, message: null });
    const spaced = VALID_B.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(validateSaudiIban(spaced).valid).toBe(true);
    expect(validateSaudiIban(VALID_C).bankCode).toBe('05');
  });

  it('rejects a wrong check digit (single digit typo)', () => {
    const last = VALID_A.slice(-1);
    const typo = VALID_A.slice(0, -1) + (last === '9' ? '8' : String(Number(last) + 1));
    const r = validateSaudiIban(typo);
    expect(r.valid).toBe(false);
    expect(r.issue).toBe('CHECKSUM');
    expect(r.bankCode).toBe('80');
    expect(r.message).toMatch(/[؀-ۿ]/);
  });

  it('rejects swapped adjacent digits', () => {
    // positions 10/11 are "00" in VALID_A's account; swap two different digits instead.
    const swapped = VALID_A.slice(0, 20) + VALID_A[21] + VALID_A[20] + VALID_A.slice(22);
    expect(swapped).not.toBe(VALID_A);
    expect(validateSaudiIban(swapped).issue).toBe('CHECKSUM');
  });

  it('rejects other countries, wrong length and letters in the Saudi BBAN', () => {
    expect(validateSaudiIban('AE070331234567890123456').issue).toBe('COUNTRY');
    expect(validateSaudiIban(VALID_A.slice(0, 23)).issue).toBe('LENGTH');
    expect(validateSaudiIban(`${VALID_A}0`).issue).toBe('LENGTH');
    expect(validateSaudiIban('SA12AB000000000000001234').issue).toBe('CHARACTERS');
  });

  it('blank -> EMPTY', () => {
    expect(validateSaudiIban('').issue).toBe('EMPTY');
    expect(validateSaudiIban('   ').issue).toBe('EMPTY');
    expect(validateSaudiIban(undefined).issue).toBe('EMPTY');
  });
});

describe('ibanWarning (form / import helper)', () => {
  it('null for blank or valid, Arabic text otherwise', () => {
    expect(ibanWarning('')).toBeNull();
    expect(ibanWarning(null)).toBeNull();
    expect(ibanWarning(VALID_B)).toBeNull();
    expect(ibanWarning('SA00')).toMatch(/24/);
    expect(ibanWarning('GB00XXXX')).toMatch(/SA/);
  });
});

describe('ibanMod97', () => {
  it('returns NaN for characters outside 0-9A-Z', () => {
    expect(Number.isNaN(ibanMod97('SA12$$'))).toBe(true);
  });
});

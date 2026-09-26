// THE nationality classifier (PURE, client-safe). Every "is this employee Saudi / GCC?" question in
// Radeef must go through this module (docs/workforce-engine/SPEC.md §4 "الجنسية").
//
// Before this module there were three detectors that disagreed:
// - src/lib/gosi.ts isSaudiForGosi: substring 'سعودي' (Arabic) + exact 'saudi' / 'saudi arabia' / 'sa' /
//   'ksa' / 'السعودية', rejecting anything containing 'غير' or 'non-saudi'.
// - src/lib/leave.ts isSaudiNationality: exact list only ('سعودي', 'سعودية', 'السعودية', 'saudi',
//   'saudi arabia', 'sa', 'ksa').
// - src/lib/employee-shared.ts isSaudiNationalityValue: exact alias list incl. 'saudi arabian' and 'سعودى'
//   (now delegates to isSaudiNational).
//
// Matching rule (after normalization, see below): a value is a country's nationality when it is one of the
// country's exact aliases (EXACT), or when EVERY word of it belongs to that country's vocabulary (the
// country / nationality words and their accepted companions, e.g. 'المملكه العربيه السعوديه', 'saudi
// national', 'KSA - Saudi') plus a few neutral words ('مواطن', 'الجنسيه', 'national', 'citizen', 'of'...),
// with at least one core nationality word. Any other word rejects the match: another nationality or
// country ('مصري سعودي المولد', 'Saudi-born Egyptian'), birth / origin words ('born', 'مولود', 'المولد',
// 'اصل'), negations ('غير سعودي', 'non saudi', 'not saudi') and unknown words ('بسعودي').
//
// NOT a strict superset of the old detectors. Every EXACT value either old detector accepted is still Saudi,
// and so is every value the old GOSI substring rule accepted whose other words are Saudi companions
// ('سعودي الجنسية', 'مواطن سعودي', 'المملكة العربية السعودية', 'سعودي/ة'). The GOSI substring rule also accepted
// ANY text containing 'سعودي' (e.g. 'بسعودي', 'مصري سعودي المولد'); such values are now NOT Saudi.
// Decision on 'بسعودي': it is not a nationality form (it reads as the preposition ب + 'سعودي', and ب is not
// a neighbouring key of any letter of 'سعودي' on the Arabic keyboard), so it is not treated as a typo of
// 'سعودي'. Values that mention Saudi without being classified Saudi are reported by
// mentionsSaudiAmbiguously() (workforce engine flag NATIONALITY_AMBIGUOUS) so HR corrects the record
// instead of the classification guessing. Every changed value is listed in NATIONALITY_RECLASSIFIED below
// and covered by src/lib/__tests__/wf-nationality.test.ts.
//
// Normalization (for matching only; the stored value is never rewritten here): trim, lowercase, remove
// tatweel and Arabic diacritics, unify alef forms (أ إ آ ٱ -> ا), alef maqsura -> ya (ى -> ي), ta marbuta ->
// ha (ة -> ه), collapse whitespace, treat '-', '_', '.', ',', '،', '(' , ')' , '/' , '\' as spaces.

/** GCC member states, ISO 3166-1 alpha-2. */
export type GccCountryCode = 'SA' | 'AE' | 'KW' | 'BH' | 'QA' | 'OM';

/** Classification used by the workforce engine and Nitaqat: Saudi, other GCC national, or expatriate. */
export type NationalityClass = 'SAUDI' | 'GCC' | 'EXPAT';

// Written with escapes: combining marks typed literally are easily reordered by editors, which silently
// changes the ranges (e.g. into one that covers every Arabic letter).
const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;

/** Normalized form used for matching (see header). Blank / non-string -> ''. */
export function normalizeNationalityKey(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[-_.()/\\,،]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Negations: 'غير سعودي', 'non saudi', 'not saudi', 'ليس سعودي'. */
function isNegated(key: string): boolean {
  return /(^|\s)(غير|ليس|ليست)(\s|$)/.test(key) || key.indexOf('غير') === 0 || /\bnon ?\w/.test(key) || /\bnot\b/.test(key);
}

/** Exact normalized aliases per country (English and Arabic). Arabic ones are already normalized. */
const EXACT: Record<GccCountryCode, ReadonlyArray<string>> = {
  SA: ['sa', 'ksa', 'sau', 'saudi', 'saudi arabia', 'saudi arabian', 'kingdom of saudi arabia'],
  AE: ['ae', 'uae', 'are', 'emirati', 'emirates', 'united arab emirates', 'u a e'],
  KW: ['kw', 'kwt', 'kuwait', 'kuwaiti'],
  BH: ['bh', 'bhr', 'bahrain', 'bahraini'],
  QA: ['qa', 'qat', 'qatar', 'qatari'],
  OM: ['om', 'omn', 'oman', 'omani'],
};

/**
 * Words allowed next to any nationality word ('مواطن سعودي', 'سعودي الجنسيه', 'Saudi national', 'سعودي/ة'
 * -> 'سعودي ه'). Birth / origin words are deliberately absent.
 */
const NEUTRAL_WORDS: ReadonlySet<string> = new Set(['مواطن', 'مواطنه', 'الجنسيه', 'جنسيه', 'ه', 'national', 'citizen', 'nationality', 'of', 'the']);

/** Per country: core nationality / country words (at least one required) and accepted companion words. */
const VOCAB: Record<GccCountryCode, { core: ReadonlySet<string>; extra: ReadonlySet<string> }> = {
  SA: {
    core: new Set(['سعودي', 'سعوديه', 'السعودي', 'السعوديه', 'saudi', 'ksa']),
    extra: new Set(['المملكه', 'العربيه', 'kingdom', 'arabia', 'arabian', 'sa', 'sau']),
  },
  AE: {
    core: new Set(['اماراتي', 'اماراتيه', 'الاماراتي', 'الاماراتيه', 'الامارات', 'امارات', 'emirati', 'emirates', 'uae']),
    extra: new Set(['دوله', 'العربيه', 'المتحده', 'united', 'arab', 'state', 'ae']),
  },
  KW: {
    core: new Set(['كويتي', 'كويتيه', 'الكويتي', 'الكويتيه', 'الكويت', 'kuwait', 'kuwaiti']),
    extra: new Set(['دوله', 'state', 'kw', 'kwt']),
  },
  BH: {
    core: new Set(['بحريني', 'بحرينيه', 'البحريني', 'البحرينيه', 'البحرين', 'bahrain', 'bahraini']),
    extra: new Set(['مملكه', 'المملكه', 'kingdom', 'bh', 'bhr']),
  },
  QA: {
    core: new Set(['قطري', 'قطريه', 'القطري', 'القطريه', 'قطر', 'qatar', 'qatari']),
    extra: new Set(['دوله', 'state', 'qa', 'qat']),
  },
  OM: {
    core: new Set(['عماني', 'عمانيه', 'العماني', 'العمانيه', 'عمان', 'oman', 'omani']),
    extra: new Set(['سلطنه', 'sultanate', 'om', 'omn']),
  },
};

/** Generic GCC national (no country). */
const GCC_GENERIC_CORE: ReadonlySet<string> = new Set(['خليجي', 'خليجيه', 'gcc']);

const ORDER: ReadonlyArray<GccCountryCode> = ['SA', 'AE', 'KW', 'BH', 'QA', 'OM'];

/** Every word is in `core` ∪ `extra` ∪ NEUTRAL_WORDS and at least one is in `core`. */
function wordsMatch(words: ReadonlyArray<string>, core: ReadonlySet<string>, extra?: ReadonlySet<string>): boolean {
  let hasCore = false;
  for (const w of words) {
    if (core.has(w)) hasCore = true;
    else if (!(extra?.has(w) || NEUTRAL_WORDS.has(w))) return false;
  }
  return hasCore;
}

/** GCC country code of a nationality (any accepted spelling), or null when not a GCC nationality. */
export function gccCountryCode(nationality: unknown): GccCountryCode | null {
  const key = normalizeNationalityKey(nationality);
  if (!key || isNegated(key)) return null;
  for (const c of ORDER) if (EXACT[c].includes(key)) return c;
  const words = key.split(' ');
  for (const c of ORDER) if (wordsMatch(words, VOCAB[c].core, VOCAB[c].extra)) return c;
  // A generic 'خليجي' / 'GCC national' has no country: see isGccNonSaudi.
  return null;
}

/** THE Saudi test. */
export function isSaudiNational(nationality: unknown): boolean {
  return gccCountryCode(nationality) === 'SA';
}

/** GCC national OTHER than Saudi (UAE, Kuwait, Bahrain, Qatar, Oman, or a generic 'خليجي' / 'GCC national'). */
export function isGccNonSaudi(nationality: unknown): boolean {
  const code = gccCountryCode(nationality);
  if (code) return code !== 'SA';
  const key = normalizeNationalityKey(nationality);
  if (!key || isNegated(key)) return false;
  return wordsMatch(key.split(' '), GCC_GENERIC_CORE);
}

/** Any GCC national INCLUDING Saudi. */
export function isGccNational(nationality: unknown): boolean {
  return isSaudiNational(nationality) || isGccNonSaudi(nationality);
}

/** SAUDI / GCC (non-Saudi GCC) / EXPAT. Blank nationality -> EXPAT (callers flag the missing value). */
export function nationalityClass(nationality: unknown): NationalityClass {
  if (isSaudiNational(nationality)) return 'SAUDI';
  if (isGccNonSaudi(nationality)) return 'GCC';
  return 'EXPAT';
}

const NEGATION_WORDS: ReadonlySet<string> = new Set(['غير', 'ليس', 'ليست', 'non', 'not', 'nonsaudi']);

/**
 * The value mentions Saudi ('سعودي' / 'saudi' / 'ksa' anywhere) but is NOT classified Saudi and is not a
 * plain negation ('غير سعودي', 'Non-Saudi'): e.g. 'بسعودي', 'Saudi-born Egyptian', 'مصري سعودي المولد'.
 * The record should be corrected (workforce flag NATIONALITY_AMBIGUOUS); the classification does not guess.
 */
export function mentionsSaudiAmbiguously(nationality: unknown): boolean {
  const key = normalizeNationalityKey(nationality);
  if (!key || !/سعودي|saudi|\bksa\b/.test(key) || isSaudiNational(nationality)) return false;
  const words = key.split(' ');
  const plainNegation = words.some((w) => NEGATION_WORDS.has(w)) && words.every((w) => NEGATION_WORDS.has(w) || VOCAB.SA.core.has(w) || VOCAB.SA.extra.has(w) || NEUTRAL_WORDS.has(w));
  return !plainNegation;
}

/**
 * Values whose classification changed when the detectors were unified (documentation + tests).
 * `before` = [gosi.ts isSaudiForGosi (also payroll-core isSaudiNational), leave.ts isSaudiNationality].
 */
export const NATIONALITY_RECLASSIFIED: ReadonlyArray<{ value: string; before: [boolean, boolean]; now: boolean }> = [
  { value: 'سعودى', before: [false, false], now: true }, // alef maqsura spelling (employee-shared already accepted it)
  { value: 'Saudi Arabian', before: [false, false], now: true }, // employee-shared already accepted it
  { value: 'Saudi national', before: [false, false], now: true },
  { value: 'KSA - Saudi', before: [false, false], now: true },
  { value: 'سعوديه', before: [true, false], now: true }, // ta marbuta written as ha
  { value: 'سعودي الجنسية', before: [true, false], now: true },
  { value: 'مواطن سعودي', before: [true, false], now: true },
  { value: 'المملكة العربية السعودية', before: [true, false], now: true },
  { value: 'سعودي/ة', before: [true, false], now: true },
  { value: 'سُعُودِي', before: [false, false], now: true }, // diacritics
  { value: 'سعـودي', before: [false, false], now: true }, // tatweel
  { value: 'Not Saudi', before: [false, false], now: false },
  // true -> false: the old GOSI rule accepted any text containing 'سعودي' (see the header).
  { value: 'بسعودي', before: [true, false], now: false },
  { value: 'مصري سعودي المولد', before: [true, false], now: false },
  { value: 'سعودي الأصل', before: [true, false], now: false },
  { value: 'مولود سعودي', before: [true, false], now: false },
  { value: 'Saudi-born Egyptian', before: [false, false], now: false },
];

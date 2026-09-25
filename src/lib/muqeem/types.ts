// Request / response types of the Muqeem operations used by Radeef, transcribed from the official
// OpenAPI spec (docs/integrations/muqeem/muqeem-api.json, "Muqeem API" v1.9). Property names are
// kept EXACTLY as in the spec (including Muqeem's own typos such as `transaltedResidentName`).
// Client-safe: no server imports.
//
// Conventions:
//   - IqamaNumber: 10 digits starting with 2 (^2[0-9]{9}$).
//   - HijriDate: Umm al-Qura 'yyyy-MM-dd' (see hijri.ts). GregorianDate: 'yyyy-MM-dd'.
//   - Response fields marked "required" in the spec are non-optional here, but Muqeem may still omit
//     them: always read responses defensively.
import { hijriToGregorian, parseMuqeemGregorian } from './hijri';

/** 'yyyy-MM-dd' Umm al-Qura date, e.g. '1448-04-15'. */
export type HijriDate = string;
/** 'yyyy-MM-dd' Gregorian date, e.g. '2026-09-26'. */
export type GregorianDate = string;

/** Generic code/label pair used by Muqeem responses (LookupVM). */
export interface MuqeemLookupVM {
  ar?: string;
  code?: string;
  en?: string;
}

// ---------------------------------------------------------------------------
// Authentication  POST /api/authenticate
// ---------------------------------------------------------------------------

/** LoginVM. username: ^[_.@A-Za-z0-9-]*$, 1-50 chars; password 1-50 chars. */
export interface MuqeemLoginRequest {
  username: string;
  password: string;
}

/** JWTToken. */
export interface MuqeemAuthResponse {
  id_token: string;
}

// ---------------------------------------------------------------------------
// Lookups  GET /api/lookups/{cities|countries|marital-statuses}
// ---------------------------------------------------------------------------

export const MUQEEM_LOOKUP_TYPES = ['cities', 'countries', 'marital-statuses'] as const;
export type MuqeemLookupType = (typeof MUQEEM_LOOKUP_TYPES)[number];

/** CityResponseVM / CountryResponseVM / MaritalStatusResponseVM share this shape. */
export interface MuqeemLookupItem {
  code?: string;
  nameAr?: string;
  nameEn?: string;
}
export type MuqeemCity = MuqeemLookupItem;
export type MuqeemCountry = MuqeemLookupItem;
export type MuqeemMaritalStatus = MuqeemLookupItem;

export function isMuqeemLookupType(v: unknown): v is MuqeemLookupType {
  return typeof v === 'string' && (MUQEEM_LOOKUP_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Exit / re-entry visa  POST /api/v1/exit-reentry/{issue|extend|cancel|reprint}
// ---------------------------------------------------------------------------

/** 1 = single (one exit and one entry), 2 = multiple. */
export type ExitReentryVisaType = 1 | 2;

/**
 * ERVisaIssuanceRequestVM. Required: iqamaNumber, visaType. Give either visaDuration (days, >= 7)
 * or returnBefore (Hijri date). The spec types returnBefore as a Java HijrahDate object, but its
 * documented format/example is a 'yyyy-MM-dd' Hijri string: we send the string.
 */
export interface ExitReentryIssueRequest {
  iqamaNumber: string;
  visaType: ExitReentryVisaType;
  visaDuration?: number;
  returnBefore?: HijriDate;
}

/** ERVisaIssuanceResponseVM. `ervisaPDF` is the visa document as base64 (PDF). */
export interface ExitReentryIssueResponse {
  iqamaNumber: string;
  residentName: string;
  translatedResidentName: string;
  visaDuration: number;
  visaNumber: string;
  visaType: string;
  ervisaPDF?: string;
  travelBeforeGregorian?: GregorianDate;
  travelBeforeHijri?: HijriDate;
  visaReturnBeforeGregorianDate?: GregorianDate;
  visaReturnBeforeHijriDate?: HijriDate;
}

/** ERVisaExtendRequestVM (all required; visaDuration >= 7 extra days, returnBefore = new Hijri date). */
export interface ExitReentryExtendRequest {
  iqamaNumber: string;
  visaNumber: string;
  visaDuration: number;
  returnBefore: HijriDate;
}

/** ERVisaExtendResponseVM. serviceCost is the fee Muqeem charged (SAR). */
export interface ExitReentryExtendResponse {
  iqamaExpiryDateG: string;
  iqamaExpiryDateH: string;
  iqamaNumber: string;
  passportExpiryDateG: string;
  passportExpiryDateH: string;
  passportNumber: string;
  residentName: string;
  serviceCost: number;
  visaDurationBeforeExtension: number;
  visaNumber: string;
  visaType: MuqeemLookupVM;
  requestedExtendedDuration?: number;
  returnBeforeAfterExtensionG?: string;
  returnBeforeAfterExtensionH?: string;
  returnBeforeBeforeExtensionG?: string;
  returnBeforeBeforeExtensionH?: string;
  travelBeforeDateG?: string;
  travelBeforeDateH?: string;
}

/** ERVisaCancellationRequestVM. */
export interface ExitReentryCancelRequest {
  iqamaNumber: string;
  erVisaNumber: string;
}

/** ERVisaCancellationResponseVM (the spec lists both spellings of translatedResidentName). */
export interface ExitReentryCancelResponse {
  iqamaNumber: string;
  residentName: string;
  transaltedResidentName?: string;
  translatedResidentName: string;
  visaNumber: string;
  visaStatus: string;
}

/** ReprintERVisaRequestVM. */
export interface ExitReentryReprintRequest {
  iqamaNumber: string;
  visaNumber: string;
}

/** ReprintERVisaResponseVM (no required fields in the spec). */
export interface ExitReentryReprintResponse {
  ervisaPDF?: string;
  iqamaNumber?: string;
  residentName?: string;
  visaNumber?: string;
}

// ---------------------------------------------------------------------------
// Final exit visa  POST /api/v1/final-exit/{issue|cancel}
// ---------------------------------------------------------------------------

/** FEVisaIssuanceRequestVM. visaType is optional and undocumented beyond int32. */
export interface FinalExitIssueRequest {
  iqamaNumber: string;
  visaType?: number;
}

export interface FinalExitVisaCancellation {
  iqamaNumber: string;
  residentName: string;
  visaNumber: string;
  visaStatus: string;
}

/** FEVisa. */
export interface FinalExitVisa {
  exitBeforeG: string;
  exitBeforeH: string;
  feVisaCancellation?: FinalExitVisaCancellation;
  issuanceDateG: string;
  issuanceDateH: string;
  visaNumber: string;
  visaType: string;
}

/** MainResident (nationality / occupation are plain strings here, unlike LookupVM elsewhere). */
export interface FinalExitMainResident {
  finalExitVisa: FinalExitVisa;
  iqamaNumber: string;
  nationality: string;
  occupation: string;
  passportNumber: string;
  residentName: string;
  visaNumber: string;
}

/** FEVisaIssuanceResponseVM. */
export interface FinalExitIssueResponse {
  mainResident: FinalExitMainResident;
}

/** FEVisaCancellationRequestVM. */
export interface FinalExitCancelRequest {
  iqamaNumber: string;
  feVisaNumber: string;
  visaType?: number;
}

/** FEVisaCancellationResponseVM. */
export interface FinalExitCancelResponse {
  mainResident?: FinalExitMainResident;
}

// ---------------------------------------------------------------------------
// Iqama renewal  POST /api/v1/iqama/renew
// ---------------------------------------------------------------------------

export const IQAMA_DURATIONS_MONTHS = ['3', '6', '9', '12', '15', '18', '21', '24'] as const;
export type IqamaDurationMonths = (typeof IQAMA_DURATIONS_MONTHS)[number];

/** RenewIqamaRequestVM. iqamaDuration is a STRING of months (3/6/.../24). */
export interface IqamaRenewRequest {
  iqamaNumber: string;
  iqamaDuration: IqamaDurationMonths;
}

/** RenewIqamaResponseVM. */
export interface IqamaRenewResponse {
  iqamaNumber: string;
  newIqamaExpiryDateGre: string;
  newIqamaExpiryDateHij: string;
  residentName: string;
  transaltedResidentName?: string;
  translatedResidentName: string;
  versionNumber: string;
}

// ---------------------------------------------------------------------------
// Update information (passport)  POST /api/v1/update-information/{renew|extend}
// Both answer a bare JSON boolean; the client turns `false` into a REJECTED MuqeemError.
// ---------------------------------------------------------------------------

/** UIRenewPassportRequestVM: a NEW passport replaces the old one. */
export interface PassportRenewRequest {
  iqamaNumber: string;
  passportNumber: string;
  newPassportNumber: string;
  newPassportIssueDate: GregorianDate;
  newPassportExpiryDate: GregorianDate;
  /** City name where the new passport was issued. */
  newPassportIssueLocation: string;
}

/** UIExtendPassportValidityRequestVM: same passport, new expiry date. */
export interface PassportExtendRequest {
  iqamaNumber: string;
  passportNumber: string;
  newPassportExpiryDate: GregorianDate;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Spring `pageable` query parameters (page is 0-based). */
export interface MuqeemPageable {
  page?: number;
  size?: number;
  sort?: string[];
}

/**
 * ActiveResidentsReportRequestVM. moiNumber: ^(1|2|7)[0-9]{9}$. The client fills moiNumber from
 * the company. THE RESPONSE HAS NO SCHEMA IN THE SPEC: it is returned as `unknown`, use
 * normalizeActiveResidents().
 */
export interface ActiveResidentsReportRequest extends MuqeemPageable {
  withDependents?: boolean;
}

/**
 * InteractiveServicesReportRequestVM. operatorId: ^[1-2][0-9]{9}$ ("company identity number issued
 * by MOI" per the spec text, but the pattern only admits 1xxxxxxxxx / 2xxxxxxxxx, i.e. a person's
 * ID: to be confirmed with Elm). `user` defaults to the linked Muqeem username.
 */
export interface InteractiveServicesReportRequest extends MuqeemPageable {
  fromDate: GregorianDate;
  toDate: GregorianDate;
  operatorId: string;
  user?: string;
}

/** InteractiveServicesReportResponseVM: one row per service request made on Muqeem. */
export interface InteractiveServicesReportRow {
  company: string;
  date: string;
  description: string;
  errorMessage: string;
  iqamaNumber: string;
  requestNumber: string;
  type: string;
  user: string;
}

// ---------------------------------------------------------------------------
// Active residents report: tolerant normalizer
// ---------------------------------------------------------------------------

/** One resident, normalized from the (undocumented) active residents report. */
export interface NormalizedResident {
  iqamaNumber: string | null;
  name: string | null;
  translatedName: string | null;
  nationality: string | null;
  occupation: string | null;
  /** Iqama expiry (UTC midnight), from a Gregorian field or converted from a Hijri one. */
  iqamaExpiry: Date | null;
  passportNumber: string | null;
  passportExpiry: Date | null;
  /** Number of dependents when the row reports it (count or array), else null. */
  dependentsCount: number | null;
  /** The original row, untouched. */
  raw: unknown;
}

type Row = Record<string, unknown>;

const ROW_ARRAY_KEYS = ['content', 'data', 'residents', 'items', 'result', 'results', 'records', 'activeResidents'];

/** Finds the array of rows in a report response: raw itself, or raw.content / .data / .residents / .items ... */
export function findResidentRows(raw: unknown, depth = 0): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object' || depth > 2) return [];
  const o = raw as Row;
  for (const k of ROW_ARRAY_KEYS) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  for (const k of ROW_ARRAY_KEYS) {
    if (o[k] && typeof o[k] === 'object') {
      const nested = findResidentRows(o[k], depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** First non-empty value among `keys`, rendered as text (LookupVM -> ar || en || code). */
function textOf(row: Row, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Row;
      for (const sub of ['ar', 'nameAr', 'arabicName', 'en', 'nameEn', 'englishName', 'code']) {
        const s = o[sub];
        if (typeof s === 'string' && s.trim()) return s.trim();
      }
    }
  }
  return null;
}

function dateOf(row: Row, gregorianKeys: readonly string[], hijriKeys: readonly string[]): Date | null {
  for (const k of gregorianKeys) {
    const d = parseMuqeemGregorian(row[k]);
    if (d) return d;
  }
  for (const k of hijriKeys) {
    const v = row[k];
    if (typeof v === 'string') {
      const d = hijriToGregorian(v);
      if (d) return d;
    }
  }
  return null;
}

const K = {
  iqama: ['iqamaNumber', 'iqama_number', 'residentIqamaNumber', 'iqamaNo', 'residentId', 'idNumber'],
  name: ['residentName', 'name', 'residentNameAr', 'arabicName', 'fullName', 'employeeName'],
  translatedName: ['translatedResidentName', 'transaltedResidentName', 'translatedName', 'residentNameEn', 'englishName', 'nameEn'],
  nationality: ['nationality', 'nationalityName', 'nationalityAr', 'nationalityDesc', 'country'],
  occupation: ['occupation', 'occupationName', 'occupationAr', 'occupationDesc', 'profession', 'job'],
  iqamaExpG: ['iqamaExpiryDateG', 'iqamaExpiryDate', 'iqamaExpiryDateGre', 'iqama_expiry_date', 'iqamaExpiry', 'idExpiryDate', 'iqamaExpiryDateGregorian'],
  iqamaExpH: ['iqamaExpiryDateH', 'iqamaExpiryDateHij', 'iqamaExpiryDateHijri'],
  passport: ['passportNumber', 'passport_number', 'passportNo'],
  passportExpG: ['passportExpiryDateG', 'passportExpiryDate', 'passport_expiry_date', 'passportExpiry', 'passportExpiryDateGregorian'],
  passportExpH: ['passportExpiryDateH', 'passportExpiryDateHijri'],
  dependents: ['dependents', 'dependentsList', 'numberOfDependents', 'dependentsCount', 'noOfDependents'],
} as const;

/** Normalizes one report row (tolerant to naming variants). */
export function normalizeResident(raw: unknown): NormalizedResident {
  const row: Row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Row) : {};
  let dependentsCount: number | null = null;
  for (const k of K.dependents) {
    const v = row[k];
    if (Array.isArray(v)) {
      dependentsCount = v.length;
      break;
    }
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) {
      dependentsCount = n;
      break;
    }
  }
  return {
    iqamaNumber: textOf(row, K.iqama),
    name: textOf(row, K.name),
    translatedName: textOf(row, K.translatedName),
    nationality: textOf(row, K.nationality),
    occupation: textOf(row, K.occupation),
    iqamaExpiry: dateOf(row, K.iqamaExpG, K.iqamaExpH),
    passportNumber: textOf(row, K.passport),
    passportExpiry: dateOf(row, K.passportExpG, K.passportExpH),
    dependentsCount,
    raw,
  };
}

/**
 * Normalizes the active residents report (POST /api/v1/report/active-residents-report).
 *
 * WARNING: the spec documents NO response schema for this endpoint. The array is searched in raw,
 * raw.content (Spring Page), raw.data, raw.residents, raw.items ..., and each field is read from
 * several candidate names (see K above). The real shape MUST be validated against a live Muqeem
 * response before relying on it; rows without an iqama number are dropped.
 */
export function normalizeActiveResidents(raw: unknown): NormalizedResident[] {
  return findResidentRows(raw)
    .map(normalizeResident)
    .filter((r) => !!r.iqamaNumber);
}

/** Total element count when the report is a Spring Page ({ totalElements }), else null. */
export function activeResidentsTotal(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Row;
  for (const k of ['totalElements', 'total', 'totalCount', 'count']) {
    if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k] as number;
  }
  return null;
}

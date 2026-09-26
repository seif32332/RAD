// Internal PDF reports of the workforce decision engine («محرك القرارات», SPEC §11 «تقارير PDF»), rendered by
// radeef-render (Typst) through the document engine's renderer (src/lib/documents/renderer.ts).
//
// Policy agreed with the document engine: these are INTERNAL planning reports, NOT official documents: no
// number, no QR / verification, no IssuedDocument row. Every page footer says «تقرير داخلي لأغراض التخطيط —
// ليس مستنداً رسمياً», the estimate disclaimer, the time of the calculation and the engine version.
//
// Data flow: the API route produces the SAME view objects the pages receive (same runners / handlers, after the
// privacy restriction of the viewer's role) -> build*Report() (PURE: selects and formats, no arithmetic on the
// figures except what the page itself shows, e.g. a sum of listed lines is never computed here) -> finalize
// (sanitize to the printable character set, strip Arabic marks, numerals) -> render. Deterministic: same view +
// same generatedAt (the calculation time, = PDF creation timestamp) -> same bytes.
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { companyBranding } from '@/lib/documents/service';
import { RenderError, renderServiceConfig, typstServiceRenderer, type DocumentRenderer } from '@/lib/documents/renderer';
import { sha256Hex, stripArabicMarks } from '@/lib/documents/core';
import { DOCUMENT_TEXT_RE } from '@/lib/documents/types';
import { canSeeDisability, redactSnapshotJson } from '@/lib/workforce/privacy';
import { ENGINE_VERSION, ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { BAND_LABELS, type NitaqatBand } from '@/lib/workforce/nitaqat';
import { arabicMonths } from '@/lib/workforce/planning';
import { TERMINATION_REASON_LABELS } from '@/lib/settlement';
import { attachmentDisposition, stripBidiControls } from '@/lib/workforce/export-xlsx';

// ---------------------------------------------------------------------------
// Report model (what the template lays out; every value already a display string)
// ---------------------------------------------------------------------------

export const REPORT_KINDS = ['true-cost', 'exit-cost', 'saudization', 'plan', 'total-rewards', 'hire-scenario', 'sensitivity'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_TITLES: Record<ReportKind, string> = {
  'true-cost': 'تقرير الكلفة الحقيقية',
  'exit-cost': 'تقرير كلفة الإنهاء',
  saudization: 'تقرير السعودة',
  plan: 'خطة القوى العاملة',
  'total-rewards': 'بيان المكافآت الشاملة',
  'hire-scenario': 'تقرير سيناريوهات التوظيف',
  sensitivity: 'حساسية القرار',
};

/** ASCII file-name stem per kind (the Arabic title goes in filename*). */
export const REPORT_FILE_STEMS: Record<ReportKind, string> = {
  'true-cost': 'workforce-true-cost',
  'exit-cost': 'workforce-exit-cost',
  saudization: 'workforce-saudization',
  plan: 'workforce-plan',
  'total-rewards': 'workforce-total-rewards',
  'hire-scenario': 'workforce-hire-scenario',
  sensitivity: 'workforce-sensitivity',
};

/** Footer notice on every page (printed without Arabic marks, like all report text). */
export const INTERNAL_REPORT_NOTICE = 'تقرير داخلي لأغراض التخطيط — ليس مستنداً رسمياً';
export const MULTI_COMPANY_LABEL = 'عدة شركات';
/** Letterhead when the view only has employees without a legal company (default branding). */
export const UNSPECIFIED_COMPANY_LABEL = 'عدة شركات/غير محدد';
export const REPORT_SERVICE_NOT_CONFIGURED = 'خدمة التقارير غير مهيأة — استخدم تصدير Excel';
export const REPORT_SERVICE_UNAVAILABLE = 'خدمة التقارير غير متاحة حالياً، حاول لاحقاً';

export type Numerals = 'latn' | 'arab';

export type ReportCell = string;
export interface ReportColumn { label: string; num: boolean; w: 'auto' | '1fr' | '2fr' | '3fr' }
export interface ReportRow { cells: ReportCell[]; style: 'normal' | 'total' | 'muted' | 'risk' }
export type ReportBlock =
  | { type: 'kpis'; items: Array<{ label: string; value: string; num: boolean; hint: string | null }> }
  | { type: 'table'; columns: ReportColumn[]; rows: ReportRow[]; caption: string | null }
  | { type: 'bullets'; tone: 'info' | 'warn' | 'risk' | 'ok'; items: string[] }
  | { type: 'callout'; tone: 'info' | 'warn' | 'risk' | 'ok'; title: string | null; text: string }
  | { type: 'para'; text: string };
export interface ReportSection { title: string; note: string | null; blocks: ReportBlock[] }
export interface ReportSourceRow { label: string; value: string; valueNum: boolean; effective: string; status: string; url: string | null }
export interface SignatureItem { role: string; name: string; date: string; note: string | null; signLabel: string }

/** Output of a build*Report(): the content, before branding, footer and sanitization. */
export interface ReportModel {
  kind: ReportKind;
  title: string;
  subtitle: string | null;
  meta: Array<{ label: string; value: string; num: boolean }>;
  lead: string | null;
  sections: ReportSection[];
  sources: ReportSourceRow[];
  approval: { title: string; status: string | null; items: SignatureItem[] } | null;
  /** Audit / file name scope (ids only, never names). */
  scope: Record<string, string | number | boolean | null>;
}

/** data.json sent to radeef-render (templates/main.typ + layout.typ). */
export interface ReportData {
  kind: ReportKind;
  title: string;
  subtitle: string | null;
  numerals: Numerals;
  pageNumbering: '1' | '١';
  lead: string | null;
  brand: { primaryColor: string; companyName: string; multi: boolean; hasLogo: boolean; contact: string | null };
  meta: ReportModel['meta'];
  footer: { badge: string; internal: string; disclaimer: string; generated: string; engineLabel: string; engine: string; pageLabel: string; ofLabel: string };
  sections: ReportSection[];
  sources: { title: string; note: string | null; empty: string; columns: string[]; rows: ReportSourceRow[] };
  approval: ReportModel['approval'];
}

// ---------------------------------------------------------------------------
// Formatting (numbers are formatted here; the template formats nothing)
// ---------------------------------------------------------------------------

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** Digits of number tokens -> Arabic-Indic (with ٬ and ٫ as separators) when the brand asks for them. */
export function localizeDigits(s: string, numerals: Numerals): string {
  if (numerals !== 'arab') return s;
  return s.replace(/\d+(?:[.,]\d+)*/g, (tok) => tok.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]).replace(/,/g, '٬').replace(/\./g, '٫'));
}

const n2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nMax2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Latin-digit formatters; localizeDigits() is applied once, at finalize time. */
const fmt = {
  /** SAR amount, 2 decimals, exactly the view's value (e.g. "12,345.60"); "—" when absent. */
  money: (v: number | null | undefined): string => (isNum(v) ? n2.format(Math.round(v * 100) / 100 + 0) : '—'),
  int: (v: number | null | undefined): string => (isNum(v) ? n0.format(v) : '—'),
  /** Up to 2 decimals ("0.5", "12.75"). */
  dec: (v: number | null | undefined): string => (isNum(v) ? nMax2.format(v) : '—'),
  pct: (v: number | null | undefined): string => (isNum(v) ? `${nMax2.format(v)}%` : '—'),
  date: (v: string | null | undefined): string => (v ? String(v).slice(0, 10) : '—'),
};

/** 'YYYY-MM-DD HH:mm' in Asia/Riyadh (UTC+3, no DST) of the calculation time. */
export function riyadhDateTime(d: Date): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

export function riyadhDay(d: Date): string {
  return riyadhDateTime(d).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sanitization to the printable set (DOCUMENT_TEXT_RE; anything else would be 422 UNSUPPORTED_CHARACTERS)
// ---------------------------------------------------------------------------

const SYMBOL_MAP: Record<string, string> = {
  '×': 'x', '÷': '/', '−': '-', '‐': '-', '‑': '-', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '±': '+/-',
  '←': '<-', '→': '->', '↔': '<->', '·': ' - ', '•': '-', '●': '-', '▪': '-', '✓': '', '✔': '', '✗': '', '°': ' ',
  '٪': '%', '′': "'", '″': '"', '„': '"', '‚': "'", '‹': '<', '›': '>', '\t': ' ',
};
/** Spaces and invisible format characters (NBSP, thin spaces, ZWJ/ZWNJ, bidi marks, BOM). */
const SPACE_LIKE = /[  -   　]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿­]/g;
const ALLOWED_CHAR = new RegExp(DOCUMENT_TEXT_RE.source.replace(/^\^\[/, '^[').replace(/\]\*\$$/, ']$'));

/**
 * One string as the renderer can print it: Arabic marks removed, CRLF -> LF, known symbols mapped to ASCII,
 * accented Latin letters reduced to their base letter, invisible characters dropped, any other letter or digit
 * of another script replaced by "?" and any other symbol (emoji…) dropped; bounded to the service's 20,000
 * characters per string.
 */
export function sanitizeReportText(input: string): string {
  let s = stripArabicMarks(String(input)).replace(/\r\n?/g, '\n').replace(SPACE_LIKE, ' ').replace(INVISIBLE, '');
  let out = '';
  for (const ch of s) {
    if (ALLOWED_CHAR.test(ch)) { out += ch; continue; }
    const mapped = SYMBOL_MAP[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base && [...base].every((c) => ALLOWED_CHAR.test(c))) { out += base; continue; }
    if (/[\p{L}\p{N}]/u.test(ch)) out += '?';
  }
  s = out;
  return s.length > 20_000 ? `${s.slice(0, 19_990)}…` : s;
}

/** Keys whose values are technical (never localized). */
const TECHNICAL_KEYS = new Set(['kind', 'primaryColor', 'pageNumbering', 'numerals', 'engine', 'url', 'type', 'tone', 'style', 'w']);

/** Deep copy with every string sanitized, and number tokens localized (except technical keys). */
export function sanitizeReportData<T>(value: T, numerals: Numerals, key = ''): T {
  if (typeof value === 'string') {
    const s = sanitizeReportText(value);
    return (TECHNICAL_KEYS.has(key) ? s : localizeDigits(s, numerals)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeReportData(v, numerals, key)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeReportData(v, numerals, k)])) as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Labels (the lib layer does not import src/app: small copies of the pages' wording)
// ---------------------------------------------------------------------------

export const STATUS_LABELS_AR: Record<string, string> = {
  VERIFIED_PRIMARY: 'موثق من المصدر الرسمي',
  CORROBORATED_SECONDARY: 'مؤكد ثانويا',
  PROVISIONAL: 'مؤقت',
  CONFLICTING: 'متعارض',
  USER_INPUT: 'إدخال المنشأة',
  MISSING: 'غير مدخل',
  DERIVED: 'محسوب',
  AMBIGUOUS: 'يحتاج مطابقة مع ملحق الدليل',
};
const statusAr = (s: string | null | undefined) => (s ? (STATUS_LABELS_AR[s] ?? s) : '—');

const SCENARIO_AR: Record<string, string> = { low: 'منخفض', base: 'أساسي', high: 'مرتفع' };
const SEVERITY_AR: Record<string, string> = { ERROR: 'خطأ', WARNING: 'تنبيه', INFO: 'معلومة' };
const KIND_AR: Record<string, string> = { COST: 'كلفة', SUBSIDY: 'دعم مشروط', MEMO: 'للعلم (لا يجمع)', PLAN: 'الخطة' };
const NAT_AR: Record<string, string> = { SAUDI: 'سعودي', GCC: 'خليجي', EXPAT: 'وافد' };
const UNIT_AR: Record<string, string> = {
  SAR: 'ريال', SAR_MONTH: 'ريال شهريا', SAR_YEAR: 'ريال سنويا', PERCENT: '%', DAYS: 'يوم', DAYS_YEAR: 'يوم سنويا', MONTHS: 'شهر',
  WEEKS: 'أسبوع', HOURS: 'ساعة', WORKERS: 'عامل', FLAG: '', COUNT_YEAR: 'مرة سنويا',
};
const band = (b: string | null | undefined) => (b ? (BAND_LABELS[b as NitaqatBand] ?? b) : '—');
/** Arabic count of days: يوم واحد، يومان، 3–10 أيام، 11 يوما فأكثر. */
function arabicDays(n: number): string {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  return n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوما`;
}

function ruleValue(value: number | null | undefined, unit: string | null | undefined): { value: string; num: boolean } {
  if (!isNum(value)) return { value: '—', num: false };
  if (unit === 'FLAG') return { value: value ? 'مفعل' : 'غير مفعل', num: false };
  if (unit === 'PERCENT') return { value: fmt.pct(value), num: true };
  const u = unit ? (UNIT_AR[unit] ?? '') : '';
  return u ? { value: `${nMax2.format(value)} ${u}`, num: false } : { value: nMax2.format(value), num: true };
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

const col = (label: string, num = false, w: ReportColumn['w'] = num ? 'auto' : '1fr'): ReportColumn => ({ label, num, w });
const row = (cells: ReportCell[], style: ReportRow['style'] = 'normal'): ReportRow => ({ cells, style });
const table = (columns: ReportColumn[], rows: ReportRow[], caption: string | null = null): ReportBlock => ({ type: 'table', columns, rows, caption });
const kpi = (label: string, value: string, hint: string | null = null, num = true) => ({ label, value, num, hint });
const bullets = (items: string[], tone: 'info' | 'warn' | 'risk' | 'ok' = 'info'): ReportBlock[] => (items.length ? [{ type: 'bullets', tone, items }] : []);
const section = (title: string, blocks: ReportBlock[], note: string | null = null): ReportSection => ({ title, note, blocks });

// ---------------------------------------------------------------------------
// Sources («المصادر والحالات»)
// ---------------------------------------------------------------------------

export interface EvidenceLike {
  key: string;
  label: string;
  value: number | null;
  unit: string | null;
  status: string;
  sourceUrl: string | null;
  effectiveFrom: string | null;
  sourceQuote?: string | null;
}

/** Evidence rows, one per (key, effective date), sorted by label then date. */
export function sourceRows(evidence: ReadonlyArray<EvidenceLike | null | undefined>): ReportSourceRow[] {
  const seen = new Map<string, ReportSourceRow & { sortKey: string }>();
  for (const e of evidence) {
    if (!e) continue;
    const id = `${e.key}|${e.effectiveFrom ?? ''}`;
    if (seen.has(id)) continue;
    const v = ruleValue(e.value, e.unit);
    seen.set(id, {
      label: e.label || e.key,
      value: v.value === '—' && e.sourceQuote && (e.key.startsWith('ASSUMPTION:') || e.key.startsWith('COMPANY:')) ? e.sourceQuote : v.value,
      valueNum: v.value === '—' && e.sourceQuote && (e.key.startsWith('ASSUMPTION:') || e.key.startsWith('COMPANY:')) ? false : v.num,
      effective: fmt.date(e.effectiveFrom),
      status: statusAr(e.status),
      url: e.sourceUrl && /^https?:\/\//i.test(e.sourceUrl) ? e.sourceUrl : null,
      sortKey: `${e.label || e.key}|${e.effectiveFrom ?? ''}`,
    });
  }
  return [...seen.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'ar')).map(({ sortKey: _s, ...r }) => r);
}

/** Rule refs used by a calculation whose evidence is not already listed (key shown as the label). */
function refRows(refs: ReadonlyArray<{ key: string; effectiveFrom: string | null; status: string; value: number | null }> | undefined, listed: ReadonlyArray<ReportSourceRow>, labels: Map<string, string>): ReportSourceRow[] {
  const have = new Set(listed.map((r) => `${r.label}|${r.effective}`));
  const out: ReportSourceRow[] = [];
  for (const r of refs ?? []) {
    const label = labels.get(r.key) ?? r.key;
    const effective = fmt.date(r.effectiveFrom);
    if (have.has(`${label}|${effective}`)) continue;
    have.add(`${label}|${effective}`);
    out.push({ label, value: isNum(r.value) ? fmt.dec(r.value) : '—', valueNum: isNum(r.value), effective, status: statusAr(r.status), url: null });
  }
  return out;
}

function evidenceOfExplanations(explanations: Record<string, { rules?: EvidenceLike[] } | undefined> | null | undefined): EvidenceLike[] {
  return Object.values(explanations ?? {}).flatMap((x) => x?.rules ?? []);
}

// ---------------------------------------------------------------------------
// (a) «تقرير الكلفة الحقيقية» — view = GET /api/workforce/overview response (+ optional employee detail)
// ---------------------------------------------------------------------------

interface Triple { cost: number; subsidy: number; net: number }
interface GroupRowView { id: string; name: string; headcount: number; month1: Triple; window: Triple; next12: Triple; next36: Triple }

export interface TrueCostReportView {
  overview: {
    engineVersion: string;
    startMonth: string;
    horizon: number;
    scenario: string;
    kpis: { thisMonth: Triple; next12: Triple; next36: Triple; window: Triple; headcount: number; saudi: number; gcc: number; expat: number; eosbLiabilityEmployer: number; eosbLiabilityResignation: number };
    composition: Array<{ key: string; label: string; kind: string; amount: number; month1: number }>;
    byCompany: GroupRowView[];
    byDepartment: GroupRowView[];
    legalCompanies: Array<{ companyId: string; name: string; headcount: number; saudi: number; gcc: number; expat: number; exempt: number; within: number; above: number; industrialZero: boolean; monthlyLevy: number; rawSaudiRatioPct: number | null }>;
    upcomingEvents: Array<{ label: string; effectiveFrom: string; appliesFromMonth: string; value: number | null; previousValue: number | null; unit: string | null; status: string; estimatedMonthlyImpact: number | null; affected: number | null; impactBasis: string }>;
    dataQuality: Array<{ code: string; severity: string; count: number; employees: number; message: string }>;
  };
  /** Rule evidence of the run (explanations of the cost lines) and the exact rule versions used. */
  evidence: EvidenceLike[];
  rulesUsed: Array<{ key: string; effectiveFrom: string | null; status: string; value: number | null }>;
  employee?: {
    summary: { name: string; employeeNo: string | null; companyName: string | null; departmentName: string | null; nationalityClass: string; month1: Triple; next12: Triple; next36: Triple; eosbLiabilityEmployer: number };
    months: Array<{ month: string; active: boolean; basicSalary: number; totals: Triple; memo: number; lines: Array<{ label: string; amount: number; basis: string; status: string; kind: string; note?: string }> }>;
  } | null;
}

export function buildTrueCostReport(v: TrueCostReportView): ReportModel {
  const o = v.overview;
  const h = o.horizon;
  const groupTable = (rows: GroupRowView[], first: string) =>
    table(
      [col(first, false, '2fr'), col('العدد', true), col('الشهر الأول (بعد الدعم)', true), col(`كلفة ${h} شهرا`, true), col('الدعم', true), col(`الصافي ${h} شهرا`, true)],
      rows.map((g) => row([g.name, fmt.int(g.headcount), fmt.money(g.month1.net), fmt.money(g.window.cost), fmt.money(g.window.subsidy), fmt.money(g.window.net)])),
    );
  const sections: ReportSection[] = [
    section('المؤشرات الرئيسية', [
      {
        type: 'kpis',
        items: [
          kpi('هذا الشهر: الكلفة قبل الدعم', fmt.money(o.kpis.thisMonth.cost), `بعد الدعم ${fmt.money(o.kpis.thisMonth.net)}`),
          kpi(`${h} شهرا: الكلفة قبل الدعم`, fmt.money(o.kpis.window.cost), `الدعم ${fmt.money(o.kpis.window.subsidy)}`),
          kpi(`${h} شهرا: بعد الدعم`, fmt.money(o.kpis.window.net), null),
          kpi('36 شهرا: بعد الدعم', fmt.money(o.kpis.next36.net), `قبل الدعم ${fmt.money(o.kpis.next36.cost)}`),
          kpi('القوى العاملة هذا الشهر', fmt.int(o.kpis.headcount), `سعودي ${fmt.int(o.kpis.saudi)} - خليجي ${fmt.int(o.kpis.gcc)} - وافد ${fmt.int(o.kpis.expat)}`),
          kpi('مكافأة نهاية الخدمة المستحقة (إنهاء صاحب العمل)', fmt.money(o.kpis.eosbLiabilityEmployer), 'المادة 84، في اليوم السابق للشهر الأول'),
          kpi('مكافأة نهاية الخدمة المستحقة (استقالة)', fmt.money(o.kpis.eosbLiabilityResignation), 'المادة 85'),
        ],
      },
    ], 'المبالغ بالريال. الدعم (دعم هدف) مشروط بقبول هدف ويظهر سالبا.'),
    section('تركيبة الكلفة', [
      table(
        [col('البند', false, '2fr'), col('النوع'), col('الشهر الأول', true), col(`مجموع ${h} شهرا`, true)],
        o.composition.map((c) => row([c.label, KIND_AR[c.kind] ?? c.kind, fmt.money(c.month1), fmt.money(c.amount)], c.kind === 'MEMO' ? 'muted' : 'normal')),
        'بنود «للعلم» (مخصص الإجازة) لا تدخل في المجموع لأن الراتب يستمر أثناء الإجازة.',
      ),
    ]),
    section('الكلفة حسب الشركة', [groupTable(o.byCompany, 'الشركة')]),
    section('الكلفة حسب الإدارة', [groupTable(o.byDepartment, 'الإدارة')]),
    section('الشركات القانونية وشرائح المقابل المالي', [
      table(
        [col('الشركة', false, '2fr'), col('العدد', true), col('سعودي', true), col('خليجي', true), col('وافد', true), col('معفى', true), col('شريحة 700', true), col('شريحة 800', true), col('المقابل الشهري', true), col('النسبة الخام', true)],
        o.legalCompanies.map((c) => row([c.industrialZero ? `${c.name} (صناعي مرخص: المقابل ملغى)` : c.name, fmt.int(c.headcount), fmt.int(c.saudi), fmt.int(c.gcc), fmt.int(c.expat), fmt.int(c.exempt), fmt.int(c.within), fmt.int(c.above), fmt.money(c.monthlyLevy), fmt.pct(c.rawSaudiRatioPct)])),
        'هذا الشهر. شريحة المقابل المالي حسب عدد السعوديين مقابل الوافدين في الكيان (وليس لون النطاق). النسبة الخام ليست نسبة نطاقات الموزونة.',
      ),
    ]),
    section(`تغييرات نظامية قادمة (ضمن ${h} شهرا)`, o.upcomingEvents.length
      ? [table(
          [col('التغيير', false, '2fr'), col('السريان', true), col('يطبق من', true), col('من', true), col('إلى', true), col('الحالة'), col('الأثر الشهري التقديري', true), col('المتأثرون', true)],
          o.upcomingEvents.map((e) => row([e.label, fmt.date(e.effectiveFrom), e.appliesFromMonth, ruleValue(e.previousValue, e.unit).value, ruleValue(e.value, e.unit).value, statusAr(e.status), fmt.money(e.estimatedMonthlyImpact), fmt.int(e.affected)])),
        )]
      : [{ type: 'para', text: 'لا تغييرات نظامية مسجلة ضمن الفترة.' }]),
    section('جودة البيانات', o.dataQuality.length
      ? [table(
          [col('الملاحظة', false, '3fr'), col('المستوى'), col('العدد', true), col('الموظفون', true)],
          o.dataQuality.map((d) => row([d.message, SEVERITY_AR[d.severity] ?? d.severity, fmt.int(d.count), fmt.int(d.employees)], d.severity === 'ERROR' ? 'risk' : 'normal')),
          'ملخص بالعدد فقط؛ أسماء الموظفين وروابط الإصلاح في شاشة لوحة القرار.',
        )]
      : [{ type: 'callout', tone: 'ok', title: null, text: 'لا ملاحظات على جودة البيانات.' }]),
  ];

  if (v.employee) {
    const e = v.employee;
    const first = e.months.find((m) => m.active) ?? e.months[0];
    sections.push(
      section(`تفصيل موظف: ${e.summary.name}${e.summary.employeeNo ? ` (${e.summary.employeeNo})` : ''}`, [
        {
          type: 'kpis',
          items: [
            kpi('الشهر الأول بعد الدعم', fmt.money(e.summary.month1.net)),
            kpi('12 شهرا بعد الدعم', fmt.money(e.summary.next12.net)),
            kpi('36 شهرا بعد الدعم', fmt.money(e.summary.next36.net)),
            kpi('نهاية الخدمة المستحقة الآن', fmt.money(e.summary.eosbLiabilityEmployer)),
          ],
        },
        ...(first
          ? [table(
              [col(`بنود الشهر ${first.month}`, false, '2fr'), col('المبلغ', true), col('المعادلة', false, '2fr'), col('الحالة')],
              first.lines.map((l) => row([l.note ? `${l.label} (${l.note})` : l.label, fmt.money(l.amount), l.basis, statusAr(l.status)], l.kind === 'MEMO' ? 'muted' : 'normal')),
            )]
          : []),
        table(
          [col('الشهر', true), col('الأساسي', true), col('الكلفة', true), col('الدعم', true), col('الصافي', true), col('للعلم', true)],
          e.months.map((m) => row([m.month, fmt.money(m.basicSalary), fmt.money(m.totals.cost), fmt.money(m.totals.subsidy), fmt.money(m.totals.net), fmt.money(m.memo)], m.active ? 'normal' : 'muted')),
        ),
      ], [e.summary.companyName, e.summary.departmentName, NAT_AR[e.summary.nationalityClass] ?? e.summary.nationalityClass].filter(Boolean).join(' - ')),
    );
  }

  const listed = sourceRows(v.evidence);
  return {
    kind: 'true-cost',
    title: REPORT_TITLES['true-cost'],
    subtitle: `كل الشركات - ${h} شهرا من ${o.startMonth} - السيناريو ${SCENARIO_AR[o.scenario] ?? o.scenario}`,
    meta: [
      { label: 'بداية التوقع', value: o.startMonth, num: true },
      { label: 'الأفق', value: `${h} شهرا`, num: false },
      { label: 'السيناريو', value: SCENARIO_AR[o.scenario] ?? o.scenario, num: false },
    ],
    lead: null,
    sections,
    sources: [...listed, ...refRows(v.rulesUsed, listed, new Map(v.evidence.map((e) => [e.key, e.label])))],
    approval: null,
    scope: { months: h, scenario: o.scenario, employeeId: null },
  };
}

// ---------------------------------------------------------------------------
// (b) «تقرير كلفة الإنهاء» — view = POST /api/workforce/exit-cost response
// ---------------------------------------------------------------------------

export interface ExitCostReportView {
  employee: { id: string; name: string; employeeNo: string | null; legalCompanyId: string | null };
  reasonMapping: { exitReason: string; terminationReason: string; certain: boolean; note: string | null };
  warnings: string[];
  assumptionEvidence: Record<string, EvidenceLike>;
  reason: string;
  lastWorkingDate: string;
  yearsOfService: number;
  wageUsed: number;
  lines: Array<{ key: string; label: string; amount: number; basis: string; status: string; ruleKeys: string[]; kind: string; note?: string }>;
  totals: { payable: number; offsets: number; netToEmployee: number; risk: number; sunkFees: number; replacement: number; ongoingMonthlyDelta: number };
  settlementScreenTotal: number;
  lastMonth: { workingDays: number; salary: number; settlementTotalIfUnpaid: number; paidByPayroll: boolean | null };
  levyImpact: { month: string; before: LevySnap; after: LevySnap; deltaMonthly: number } | null;
  flags: Array<{ code: string; severity: string; message: string; lineKey?: string }>;
  explanations: Record<string, { rules?: EvidenceLike[] } | undefined>;
  rulesUsed: Array<{ key: string; effectiveFrom: string | null; status: string; value: number | null }>;
}
interface LevySnap { saudi: number; expat: number; within: number; above: number; exempt: number; monthlyLevy: number }

const COUNSEL_BADGE = 'مؤقت - بانتظار تأكيد المستشار';
/** Settlement TerminationReason labels (src/lib/settlement.ts, the settlement screen's wording). */
const TERMINATION_AR: Record<string, string> = TERMINATION_REASON_LABELS;

export function buildExitCostReport(v: ExitCostReportView): ReportModel {
  const counsel = (l: ExitCostReportView['lines'][number]) => l.status === 'PROVISIONAL' && (l.ruleKeys.includes('LAW:ART87') || v.flags.some((f) => f.code === 'COUNSEL_PENDING' && f.lineKey === l.key));
  const lineTable = (kind: string, title: string, style: ReportRow['style'] = 'normal') => {
    const ls = v.lines.filter((l) => l.kind === kind);
    return table(
      [col(title, false, '2fr'), col('المبلغ', true), col('المعادلة', false, '2fr'), col('الحالة')],
      ls.length
        ? ls.map((l) => row([[l.label, counsel(l) ? `(${COUNSEL_BADGE})` : null, l.note ?? null].filter(Boolean).join(' '), fmt.money(l.amount), l.basis, statusAr(l.status)], style))
        : [row(['لا بنود', '—', '—', '—'], 'muted')],
    );
  };
  const sections: ReportSection[] = [
    section('الخلاصة', [
      {
        type: 'kpis',
        items: [
          kpi('المستحقات (مكافأة وإشعار وإجازة)', fmt.money(v.totals.payable)),
          kpi('المقاصة (سلف وإشعار على الموظف)', fmt.money(v.totals.offsets)),
          kpi('الصافي للموظف', fmt.money(v.totals.netToEmployee), 'المستحقات + المقاصة'),
          kpi('المستحق عند التصفية (دون راتب الشهر الأخير)', fmt.money(v.settlementScreenTotal)),
          kpi('رسوم مدفوعة مقدما لا تسترد', fmt.money(v.totals.sunkFees), 'للعلم'),
          kpi('كلفة الإحلال', fmt.money(v.totals.replacement)),
          kpi('أثر المقابل المالي شهريا', fmt.money(v.totals.ongoingMonthlyDelta), 'لبقية الوافدين'),
        ],
      },
      ...(v.lastMonth.salary > 0
        ? [{
            type: 'para' as const,
            text: `إن لم يصرف راتب الشهر الأخير: + ${fmt.money(v.lastMonth.salary)} (${arabicDays(v.lastMonth.workingDays)}) = ${fmt.money(v.lastMonth.settlementTotalIfUnpaid)}${v.lastMonth.paidByPayroll === true ? '؛ مسير ذلك الشهر معتمد أو مصروف، فشاشة التصفية لا تضيفه.' : v.lastMonth.paidByPayroll === false ? '؛ لا يوجد مسير معتمد لذلك الشهر، فشاشة التصفية تضيفه.' : '.'}`,
          }]
        : []),
      { type: 'para', text: 'لا تشمل الأرقام الإضافي غير المصروف ولا البنود اليدوية التي تضيفها شاشة التصفية.' },
    ]),
    section('المستحقات', [lineTable('PAYABLE', 'البند')], 'تدفعها المنشأة بسبب الخروج'),
    section('المقاصة', [lineTable('OFFSET', 'البند')], 'تنقص ما يدفع'),
    section('مخاطر نظامية: المادة 77 (لا تجمع مع المستحقات)', [
      { type: 'callout', tone: 'risk', title: `التعرض التقديري: ${fmt.money(v.totals.risk)}`, text: 'التعويض عن الإنهاء غير المشروع لا يستحق إلا إذا نوزع في الإنهاء وحكم بأنه لسبب غير مشروع: 15 يوما عن كل سنة في العقد غير محدد المدة أو باقي مدة العقد المحدد، وبحد أدنى أجر شهرين. يعرض للتقدير فقط ولا يضاف إلى المستحقات ولا إلى الصافي.' },
      lineTable('RISK', 'البند', 'risk'),
    ]),
    section('رسوم مدفوعة مقدما (للعلم)', [lineTable('SUNK', 'البند', 'muted')], 'رسوم حكومية مدفوعة لا تسترد، ولا تدخل في المستحقات'),
    section('كلفة الإحلال', [lineTable('REPLACEMENT', 'البند')], 'من افتراضات المنشأة أو من إدخال المستخدم لهذا الحساب'),
    section('أثر الخروج على المقابل المالي والتركيبة', [
      lineTable('ONGOING', 'البند'),
      ...(v.levyImpact
        ? [table(
            [col(v.levyImpact.month, true, '1fr'), col('سعودي', true), col('وافد', true), col('شريحة 700', true), col('شريحة 800', true), col('معفى', true), col('المقابل الشهري', true)],
            [
              { t: 'قبل الخروج', s: v.levyImpact.before },
              { t: 'بعد الخروج', s: v.levyImpact.after },
            ].map((r) => row([r.t, fmt.int(r.s.saudi), fmt.int(r.s.expat), fmt.int(r.s.within), fmt.int(r.s.above), fmt.int(r.s.exempt), fmt.money(r.s.monthlyLevy)])),
          )]
        : []),
    ]),
  ];
  const notes = [
    ...v.warnings,
    ...v.flags.map((f) => `${f.code === 'COUNSEL_PENDING' ? COUNSEL_BADGE : (SEVERITY_AR[f.severity] ?? f.severity)}: ${f.message}`),
  ];
  if (notes.length) sections.push(section('ملاحظات الحساب', bullets(notes, 'warn')));

  const evidence = [...evidenceOfExplanations(v.explanations), ...Object.values(v.assumptionEvidence ?? {}).filter((e) => v.lines.some((l) => l.ruleKeys.includes(e.key)))];
  const listed = sourceRows(evidence);
  return {
    kind: 'exit-cost',
    title: REPORT_TITLES['exit-cost'],
    subtitle: `${v.employee.name}${v.employee.employeeNo ? ` (${v.employee.employeeNo})` : ''}`,
    meta: [
      { label: 'أساس التسوية', value: `${TERMINATION_AR[v.reason] ?? v.reason}${v.reasonMapping.certain ? '' : ' (غير مؤكد)'}`, num: false },
      { label: 'آخر يوم عمل', value: fmt.date(v.lastWorkingDate), num: true },
      { label: 'سنوات الخدمة', value: fmt.dec(v.yearsOfService), num: true },
      { label: 'الأجر المستخدم', value: fmt.money(v.wageUsed), num: true },
    ],
    lead: null,
    sections,
    sources: [...listed, ...refRows(v.rulesUsed, listed, new Map(evidence.map((e) => [e.key, e.label])))],
    approval: null,
    scope: { employeeId: v.employee.id, exitReason: v.reasonMapping.exitReason, lastWorkingDate: fmt.date(v.lastWorkingDate) },
  };
}

// ---------------------------------------------------------------------------
// (c) «تقرير السعودة» — view = GET /api/workforce/saudization (+ POST …/saudization/solve)
// ---------------------------------------------------------------------------

interface EstimateView {
  status: string;
  message: string | null;
  activity: { nameAr: string; code: string | null; status: string } | null;
  year: number;
  counts: { x: number; saudiWeighted: number; expats: number; saudiPersons: number; gccPersons: number; undocumented: number };
  pct: number;
  band: string | null;
  smallEntity: boolean;
  thresholdsByYear: Array<{ year: number; band: string; thresholds: Array<{ band: string; y: number }> }>;
  margin: {
    up: { band: string; pctGap: number | null; saudiHires: number | null } | null;
    down: { band: string; pctCushion: number | null; expatsBeforeDrop: number | null; saudiExitsBeforeDrop: number | null } | null;
  };
  consequences: { items: string[]; conflict?: string } | null;
  breakdown: Array<{ label: string; persons: number; weight: number }>;
  average26w: { weeks: number; pct: number; band: string | null } | null;
  flags: Array<{ severity: string; message: string }>;
  evidence: EvidenceLike[];
  assumptions: string[];
  restricted?: boolean;
  undocumentedCount?: number;
}
interface ComplianceItemView {
  groupNameAr: string;
  statusLabel: string;
  sourceUrl: string | null;
  decisionNo: string | null;
  phase: { pct: number; effectiveFrom: string } | null;
  applies: boolean;
  appliesReason: string | null;
  minWage: number | null;
  total: number;
  saudisCounted: number;
  actualPct: number | null;
  requiredPct: number | null;
  requiredText: string | null;
  compliant: boolean | null;
  shortfallReplacements: number;
  status: string;
}
export interface SaudizationReportView {
  date: string;
  companies: Array<{
    companyId: string;
    companyName: string;
    estimate: EstimateView;
    compliance: { items: ComplianceItemView[]; unknownOccupation: { count: number } };
    alerts: Array<{ severity: string; message: string }>;
  }>;
  solve?: {
    companyName: string;
    result: {
      status: string;
      message: string | null;
      targetBand: string;
      byDate: string;
      before: SolveSnap | null;
      after: SolveSnap | null;
      documentations: number;
      raises: number;
      hires: number | null;
      actions: SolveActionView[];
      totals: { monthlyCost: number | null; monthlyNetAvg: number | null; oneOffCost: number | null };
      alternative: { replacements: number | null; actions: SolveActionView[]; totals: { monthlyCost: number | null; monthlyNetAvg: number | null; oneOffCost: number | null }; after: SolveSnap | null } | null;
      costHorizonMonths: number | null;
      flags: Array<{ severity: string; message: string }>;
      evidence: EvidenceLike[];
    };
  } | null;
}
interface SolveSnap { pct: number; band: string; x: number; saudiWeighted: number; expats: number }
interface SolveActionView { rank: number; kind: string; name: string | null; count: number; weightGain: number | null; pctAfter: number | null; bandAfter: string | null; monthlyCost: number | null; monthlyNetAvg: number | null; oneOffCost: number | null; note: string | null }

const SOLVER_KIND_AR: Record<string, string> = { DOCUMENT: 'توثيق العقد في قوى', RAISE: 'رفع الأجر إلى 4,000', HIRE: 'تعيين سعودي', REPLACE: 'إحلال سعودي محل وافد' };

function solverTable(actions: SolveActionView[]): ReportBlock {
  return table(
    [col('#', true), col('الإجراء', false, '2fr'), col('العدد', true), col('أثر الوزن', true), col('النسبة بعده', true), col('النطاق بعده'), col('الكلفة الشهرية', true), col('متوسط الصافي شهريا', true), col('لمرة واحدة', true)],
    actions.map((a) => row([
      fmt.int(a.rank),
      [SOLVER_KIND_AR[a.kind] ?? a.kind, a.name, a.note].filter(Boolean).join(' - '),
      fmt.int(a.count), fmt.dec(a.weightGain), fmt.pct(a.pctAfter), band(a.bandAfter), fmt.money(a.monthlyCost), fmt.money(a.monthlyNetAvg), fmt.money(a.oneOffCost),
    ])),
  );
}

export function buildSaudizationReport(v: SaudizationReportView): ReportModel {
  const sections: ReportSection[] = [];
  const evidence: EvidenceLike[] = [];
  const decisionSources: ReportSourceRow[] = [];
  for (const c of v.companies) {
    const e = c.estimate;
    evidence.push(...(e.evidence ?? []));
    const blocks: ReportBlock[] = [];
    if (e.status !== 'OK') blocks.push({ type: 'callout', tone: 'warn', title: null, text: e.message ?? 'لا يمكن تقدير النطاق' });
    blocks.push({
      type: 'kpis',
      items: [
        kpi('النطاق التقديري', band(e.band), e.smallEntity ? 'كيان بخمسة عمال فأقل' : null, false),
        kpi('نسبة التوطين الموزونة', fmt.pct(e.pct)),
        kpi('عدد العاملين المحتسبين (X)', fmt.int(e.counts.x)),
        kpi('السعوديون الموزونون', fmt.dec(e.counts.saudiWeighted), `أفراد ${fmt.int(e.counts.saudiPersons)} - خليجي ${fmt.int(e.counts.gccPersons)}`),
        kpi('الوافدون', fmt.int(e.counts.expats)),
        kpi('عقود غير موثقة في قوى', fmt.int(e.restricted ? (e.undocumentedCount ?? e.counts.undocumented) : e.counts.undocumented), 'لا تحتسب'),
        ...(e.average26w ? [kpi('متوسط 26 أسبوعا', fmt.pct(e.average26w.pct), `${band(e.average26w.band)} - ${e.average26w.weeks} أسبوعا`)] : []),
      ],
    });
    if (e.thresholdsByYear?.length) {
      const bands = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'];
      blocks.push(table(
        [col('السنة', true), col('النطاق بالعمالة الحالية'), ...bands.map((b) => col(`حد ${band(b)}`, true))],
        e.thresholdsByYear.map((t) => row([String(t.year), band(t.band), ...bands.map((b) => fmt.pct(t.thresholds.find((x) => x.band === b)?.y ?? null))], t.year === e.year ? 'total' : 'normal')),
        'الحد الأدنى لكل نطاق Y = m ln(X) + c بثوابت نشاط الكيان لكل سنة (2026-2028).',
      ));
    }
    const margin: string[] = [];
    if (e.margin?.up) margin.push(`للصعود إلى ${band(e.margin.up.band)}: ينقص ${fmt.dec(e.margin.up.pctGap)} نقطة، أي ${e.margin.up.saudiHires === null ? 'عدد كبير من' : fmt.int(e.margin.up.saudiHires)} تعيين سعودي بوزن 1.`);
    if (e.margin?.down) margin.push(`قبل الهبوط إلى ${band(e.margin.down.band)}: هامش ${fmt.dec(e.margin.down.pctCushion)} نقطة؛ يمكن إضافة ${e.margin.down.expatsBeforeDrop === null ? 'عدد كبير من' : fmt.int(e.margin.down.expatsBeforeDrop)} وافد، أو خروج ${fmt.int(e.margin.down.saudiExitsBeforeDrop)} سعودي بوزن 1.`);
    blocks.push(...bullets(margin, 'info'));
    if (e.breakdown?.length) {
      blocks.push(table([col('الفئة', false, '2fr'), col('الأفراد', true), col('الوزن', true)], e.breakdown.map((b) => row([b.label, fmt.int(b.persons), fmt.dec(b.weight)]))));
    }
    if (e.consequences) blocks.push(...bullets([...e.consequences.items, ...(e.consequences.conflict ? [e.consequences.conflict] : [])], e.band === 'RED' ? 'risk' : 'info'));
    const items = c.compliance.items;
    if (items.length) {
      blocks.push(table(
        [col('قرار التوطين', false, '2fr'), col('المطلوب', true), col('الحالي', true), col('العدد', true), col('السعوديون المحتسبون', true), col('الحد الأدنى للأجر', true), col('الالتزام'), col('ينقص (إحلالا)', true)],
        items.map((i) => row([
          `${i.groupNameAr}${i.applies ? '' : ` (${i.appliesReason ?? 'لا ينطبق'})`}${i.requiredText ? ` - ${i.requiredText}` : ''}`,
          fmt.pct(i.requiredPct), fmt.pct(i.actualPct), fmt.int(i.total), fmt.int(i.saudisCounted), fmt.money(i.minWage),
          i.compliant === null ? '—' : i.compliant ? 'ملتزم' : 'غير ملتزم', fmt.int(i.shortfallReplacements),
        ], i.applies && i.compliant === false ? 'risk' : i.applies ? 'normal' : 'muted')),
        c.compliance.unknownOccupation.count ? `${fmt.int(c.compliance.unknownOccupation.count)} موظف بلا مهنة مسجلة لا تمكن مطابقتهم بقرارات التوطين.` : null,
      ));
      for (const i of items) {
        decisionSources.push({ label: `قرار توطين: ${i.groupNameAr}${i.decisionNo ? ` (${i.decisionNo})` : ''}`, value: fmt.pct(i.phase?.pct ?? i.requiredPct), valueNum: true, effective: fmt.date(i.phase?.effectiveFrom ?? null), status: i.statusLabel || statusAr(i.status), url: i.sourceUrl && /^https?:\/\//i.test(i.sourceUrl) ? i.sourceUrl : null });
      }
    }
    blocks.push(...bullets(c.alerts.map((a) => `${SEVERITY_AR[a.severity] ?? a.severity}: ${a.message}`), c.alerts.some((a) => a.severity === 'ERROR') ? 'risk' : 'warn'));
    blocks.push(...bullets(e.flags.filter((f) => f.severity !== 'INFO').map((f) => f.message), 'warn'));
    sections.push(section(c.companyName, blocks, e.activity ? `النشاط: ${e.activity.nameAr}${e.activity.code ? ` (${e.activity.code})` : ''} - ${statusAr(e.activity.status)} - سنة الثوابت ${e.year}` : 'لم يحدد نشاط نطاقات'));
  }

  const s = v.solve;
  if (s) {
    const r = s.result;
    evidence.push(...(r.evidence ?? []));
    const blocks: ReportBlock[] = [];
    if (r.message) blocks.push({ type: 'callout', tone: r.status === 'UNREACHABLE' ? 'risk' : 'info', title: null, text: r.message });
    blocks.push(table(
      [col('', false, '1fr'), col('النسبة', true), col('النطاق'), col('X', true), col('السعوديون الموزونون', true), col('الوافدون', true)],
      [
        ...(r.before ? [row(['قبل الخطة', fmt.pct(r.before.pct), band(r.before.band), fmt.int(r.before.x), fmt.dec(r.before.saudiWeighted), fmt.int(r.before.expats)])] : []),
        ...(r.after ? [row(['بعد الخطة', fmt.pct(r.after.pct), band(r.after.band), fmt.int(r.after.x), fmt.dec(r.after.saudiWeighted), fmt.int(r.after.expats)], 'total')] : []),
      ],
    ));
    blocks.push({
      type: 'kpis',
      items: [
        kpi('توثيق عقود', fmt.int(r.documentations), 'دون كلفة'),
        kpi('رفع أجور', fmt.int(r.raises)),
        kpi('تعيينات سعودية', r.hires === null ? '—' : fmt.int(r.hires)),
        kpi('الكلفة الشهرية للخطة', fmt.money(r.totals.monthlyCost), r.costHorizonMonths ? `متوسط الصافي ${fmt.money(r.totals.monthlyNetAvg)} على ${arabicMonths(r.costHorizonMonths, true)}` : null),
      ],
    });
    if (r.actions.length) blocks.push(solverTable(r.actions));
    if (r.alternative) {
      blocks.push({ type: 'para', text: `البديل: إحلال ${r.alternative.replacements === null ? '—' : fmt.int(r.alternative.replacements)} سعودي محل وافدين (الأقل كلفة أولا)، الكلفة الشهرية ${fmt.money(r.alternative.totals.monthlyCost)}.` });
      if (r.alternative.actions.length) blocks.push(solverTable(r.alternative.actions));
    }
    blocks.push(...bullets(r.flags.filter((f) => f.severity !== 'INFO').map((f) => f.message), 'warn'));
    sections.push(section(`الوصول إلى نطاق ${band(r.targetBand)} بحلول ${r.byDate}: ${s.companyName}`, blocks, 'إجراءات افتراضية لا تكتب في بيانات الموظفين. الكلفة من محرك الكلفة الحقيقية بعد دعم هدف وأثر المقابل المالي.'));
  }

  const listed = sourceRows(evidence);
  return {
    kind: 'saudization',
    title: REPORT_TITLES.saudization,
    subtitle: `بتاريخ ${v.date}`,
    meta: [
      { label: 'التاريخ', value: v.date, num: true },
      { label: 'الشركات', value: fmt.int(v.companies.length), num: true },
      ...(s ? [{ label: 'النطاق المستهدف', value: band(s.result.targetBand), num: false }] : []),
    ],
    lead: null,
    sections,
    sources: [...listed, ...decisionSources],
    approval: null,
    scope: { date: v.date, companies: v.companies.length, targetBand: s?.result.targetBand ?? null },
  };
}

// ---------------------------------------------------------------------------
// (d) «خطة القوى العاملة» — view = GET /api/workforce/plans/[id] (+ GET …/actual)
// ---------------------------------------------------------------------------

interface PlanWindowView extends Triple { months: number; totalBeforeHrdf: number; totalAfterHrdf: number; baseline: Triple; deltaAfterHrdf: number; exitOneOff: number; exitAccrualRelease: number; attrition: Triple; levy: number }
export interface PlanReportView {
  plan: {
    id: string; name: string; status: string; statusLabel: string; companyId: string | null; companyName: string | null; fromMonth: string; months: number; attritionPct: number | null; notes: string | null;
    createdByName: string | null; createdAt: string; submittedAt: string | null; submittedByName: string | null; decidedByName: string | null; decidedAt: string | null; decisionLabel: string | null; decisionNote: string | null;
    archivedByName: string | null; archivedAt: string | null;
  };
  positions: Array<{ id: string; kind: string; kindLabel: string; title: string; nationalityClass: string | null; basicSalary: number | null; housingAllowance: number | null; startMonth: string | null; exitEmployeeId: string | null; exitMonth: string | null; exitReason: string | null }>;
  raises: Array<{ id: string; scope: string; scopeLabel: string; scopeId: string | null; pct: number | null; amount: number | null; effectiveMonth: string }>;
  names: { employees: Record<string, string>; departments: Record<string, string>; companies: Record<string, string> };
  frozen: boolean;
  projection: {
    engineVersion: string; planEngineVersion: string; scenario: string; fromMonth: string; months: number; monthKeys: string[];
    series: Array<Triple & { month: string; headcount: { total: number; saudi: number; gcc: number; expat: number; hires: number; plannedExits: number }; expectedLeavers: number; totalBeforeHrdf: number; totalAfterHrdf: number; baseline: Triple & { headcount: number } }>;
    totals: Partial<Record<'12' | '24' | '36' | 'horizon', PlanWindowView>>;
    attrition: { pct: number; source: string; basis: string };
    items: Array<{ positionId: string; kind: string; title: string; employeeName: string | null; start: string | null; exit: string | null; computed: boolean; firstMonthCost: number; windows: Partial<Record<'12' | '24' | '36' | 'horizon', Triple>>; exitCost: { reasonLabel: string; payable: number; accrualRelease: number; risk: number; netToEmployee: number; yearsOfService: number } | null }>;
    raises: Array<{ raiseId: string; employees: number; basicDeltaMonthly: number; basicDeltaTotal: number }>;
    companies: Array<{ companyId: string; name: string; years: Array<{ yearIndex: number; month: string; nitaqat: { plan: { band: string | null; pct: number; message: string | null }; baseline: { band: string | null; pct: number }; change: string | null } | null; levy: { plan: { levyTotal: number }; baseline: { levyTotal: number } } }> }>;
    flags: Array<{ severity: string; message: string }>;
    explanations: Record<string, { rules?: EvidenceLike[] } | undefined>;
    rulesUsed: Array<{ key: string; effectiveFrom: string | null; status: string; value: number | null }>;
    assumptions: string[];
  };
  actual?: {
    warning: string | null;
    result: {
      asOf: string;
      months: Array<{ month: string; planned: number; actual: number; variance: number; variancePct: number | null; plannedHeadcount: number; actualHeadcount: number; partial: boolean }>;
      monthsWithoutPayroll: string[];
      cumulative: { planned: number; actual: number; variance: number; variancePct: number | null; partial: boolean; months: number };
      drivers: Array<{ key: string; label: string; amount: number; count: number; people: Array<{ name: string; amount: number }> }>;
    };
  } | null;
}

const WINDOW_LABELS: Record<string, string> = { '12': '12 شهرا', '24': '24 شهرا', '36': '36 شهرا', horizon: 'مدة الخطة' };

export function buildPlanReport(v: PlanReportView): ReportModel {
  const p = v.projection;
  const plan = v.plan;
  const winKeys = (['12', '24', '36'] as const).filter((k) => p.totals[k]);
  const sections: ReportSection[] = [];
  const horizon = p.totals.horizon ?? p.totals[winKeys[winKeys.length - 1] ?? '12'];
  sections.push(section('ملخص التوقع', [
    {
      type: 'kpis',
      items: [
        kpi('إجمالي الخطة بعد الدعم', fmt.money(horizon?.totalAfterHrdf), WINDOW_LABELS.horizon),
        kpi('ما تضيفه الخطة', fmt.money(horizon?.deltaAfterHrdf), 'مقارنة بالقوى الحالية دونها'),
        kpi('القوى الحالية دون الخطة', fmt.money(horizon?.baseline.net)),
        kpi('الدوران', fmt.pct(p.attrition.pct), p.attrition.basis),
      ],
    },
    table(
      [col('الأفق'), col('قبل الدعم', true), col('بعد الدعم', true), col('لمرة واحدة (الخروج)', true), col('استرداد المخصص', true), col('دون الخطة', true), col('ما تضيفه الخطة', true)],
      [...winKeys, ...(p.totals.horizon && !winKeys.some((k) => Number(k) === p.months) ? (['horizon'] as const) : [])].map((k) => {
        const w = p.totals[k]!;
        return row([WINDOW_LABELS[k], fmt.money(w.totalBeforeHrdf), fmt.money(w.totalAfterHrdf), fmt.money(w.exitOneOff), fmt.money(w.exitAccrualRelease), fmt.money(w.baseline.net), fmt.money(w.deltaAfterHrdf)], 'normal');
      }),
      v.frozen ? 'التوقع المجمد عند الاعتماد.' : 'التوقع معاد حسابه من البيانات الحالية.',
    ),
  ]));

  const empName = (id: string | null) => (id ? (v.names.employees[id] ?? id) : null);
  sections.push(section('الوظائف المخططة والخروج', v.positions.length
    ? [table(
        [col('النوع'), col('المسمى', false, '2fr'), col('الجنسية'), col('الأساسي', true), col('السكن', true), col('البداية', true), col('المغادر'), col('شهر الخروج', true)],
        v.positions.map((x) => row([x.kindLabel, x.title, x.nationalityClass ? (NAT_AR[x.nationalityClass] ?? x.nationalityClass) : '—', fmt.money(x.basicSalary), fmt.money(x.housingAllowance), x.startMonth ?? '—', empName(x.exitEmployeeId) ?? '—', x.exitMonth ?? '—'])),
      ),
      table(
        [col('البند', false, '2fr'), col('البداية', true), col('الخروج', true), col('الشهر الأول', true), col('طوال الخطة بعد الدعم', true), col('مستحقات الخروج', true), col('خطر المادة 77 (لا يجمع)', true)],
        p.items.map((i) => row([i.title + (i.employeeName ? ` - ${i.employeeName}` : ''), i.start ?? '—', i.exit ?? '—', fmt.money(i.firstMonthCost), fmt.money(i.windows.horizon?.net ?? null), fmt.money(i.exitCost?.payable ?? null), fmt.money(i.exitCost?.risk ?? null)], i.computed ? 'normal' : 'muted')),
        'خطر المادة 77 يعرض للتقدير ولا يدخل إجمالي الخطة.',
      )]
    : [{ type: 'para', text: 'لا بنود في الخطة.' }]));

  const raiseScope = (r: PlanReportView['raises'][number]) => {
    if (!r.scopeId) return r.scopeLabel;
    const n = r.scope === 'EMPLOYEE' ? v.names.employees[r.scopeId] : r.scope === 'DEPARTMENT' ? v.names.departments[r.scopeId] : r.scope === 'COMPANY' ? v.names.companies[r.scopeId] : null;
    return `${r.scopeLabel}: ${n ?? r.scopeId}`;
  };
  sections.push(section('الزيادات المخططة', v.raises.length
    ? [table(
        [col('النطاق', false, '2fr'), col('النسبة', true), col('المبلغ', true), col('السريان', true), col('الموظفون', true), col('زيادة الأساسي شهريا', true), col('طوال الخطة', true)],
        v.raises.map((r) => {
          const res = p.raises.find((x) => x.raiseId === r.id);
          return row([raiseScope(r), fmt.pct(r.pct), fmt.money(r.amount), r.effectiveMonth, fmt.int(res?.employees ?? null), fmt.money(res?.basicDeltaMonthly ?? null), fmt.money(res?.basicDeltaTotal ?? null)]);
        }),
      )]
    : [{ type: 'para', text: 'لا زيادات مخططة.' }]));

  sections.push(section('الكلفة والعدد شهرا بشهر', [
    table(
      [col('الشهر', true), col('العدد', true), col('سعودي', true), col('وافد', true), col('تعيينات', true), col('قبل الدعم', true), col('بعد الدعم', true), col('دون الخطة', true)],
      p.series.map((m) => row([m.month, fmt.int(m.headcount.total), fmt.int(m.headcount.saudi), fmt.int(m.headcount.expat), fmt.int(m.headcount.hires), fmt.money(m.totalBeforeHrdf), fmt.money(m.totalAfterHrdf), fmt.money(m.baseline.net)])),
      'العدد المسمى؛ الدوران المتوقع عدد إحصائي لا يحذف من العدد.',
    ),
  ]));

  const nit = p.companies.flatMap((c) => c.years.map((y) => ({ c, y })));
  sections.push(section('نطاقات والمقابل المالي نهاية كل سنة', nit.length
    ? [table(
        [col('الشركة', false, '2fr'), col('نهاية السنة', true), col('النطاق بالخطة'), col('النسبة بالخطة', true), col('دون الخطة'), col('النسبة دونها', true), col('المقابل بالخطة', true), col('المقابل دونها', true)],
        nit.map(({ c, y }) => row([c.name, y.month, y.nitaqat ? band(y.nitaqat.plan.band) : '—', fmt.pct(y.nitaqat?.plan.pct ?? null), y.nitaqat ? band(y.nitaqat.baseline.band) : '—', fmt.pct(y.nitaqat?.baseline.pct ?? null), fmt.money(y.levy.plan.levyTotal), fmt.money(y.levy.baseline.levyTotal)], y.nitaqat?.change === 'DOWN' ? 'risk' : 'normal')),
        'تقدير لحظي بالعمالة والأجور المخططة؛ المرجع الرسمي منصة قوى.',
      )]
    : [{ type: 'para', text: 'لا تقدير نطاقات لهذه الخطة.' }]));

  if (v.actual) {
    const a = v.actual.result;
    const blocks: ReportBlock[] = [];
    if (v.actual.warning) blocks.push({ type: 'callout', tone: 'warn', title: null, text: v.actual.warning });
    if (a.months.length) {
      blocks.push({
        type: 'kpis',
        items: [
          kpi('المخطط تراكميا', fmt.money(a.cumulative.planned), `${arabicMonths(a.cumulative.months)} حتى ${a.asOf}`),
          kpi('الفعلي تراكميا', fmt.money(a.cumulative.actual)),
          kpi('الفرق', fmt.money(a.cumulative.variance), fmt.pct(a.cumulative.variancePct)),
        ],
      });
      blocks.push(table(
        [col('الشهر', true), col('المخطط', true), col('الفعلي', true), col('الفرق', true), col('%', true), col('العدد المخطط', true), col('سطور المسير', true)],
        a.months.map((m) => row([m.partial ? `${m.month} (جزئي)` : m.month, fmt.money(m.planned), fmt.money(m.actual), fmt.money(m.variance), fmt.pct(m.variancePct), fmt.int(m.plannedHeadcount), fmt.int(m.actualHeadcount)])),
      ));
      blocks.push(table(
        [col('سبب الفرق', false, '2fr'), col('المبلغ', true), col('العدد', true), col('أكبر الأسماء', false, '2fr')],
        a.drivers.map((d) => row([d.label, fmt.money(d.amount), fmt.int(d.count), d.people.slice(0, 3).map((x) => `${x.name} (${fmt.money(x.amount)})`).join('، ') || '—'])),
        'مجموع الأسباب يساوي الفرق تماما.',
      ));
    } else {
      blocks.push({ type: 'para', text: 'لا توجد أشهر لها مسير معتمد أو مصروف حتى الآن للمقارنة.' });
    }
    if (a.monthsWithoutPayroll.length) blocks.push({ type: 'para', text: `أشهر بلا مسير معتمد (لم تقارن): ${a.monthsWithoutPayroll.join('، ')}` });
    sections.push(section('المخطط مقابل الفعلي', blocks, 'المخطط: الرواتب والبدلات وحصة صاحب العمل في التأمينات. الفعلي: إجمالي المسير المعتمد أو المصروف + حصة صاحب العمل.'));
  }

  const flags = p.flags.filter((f) => f.severity !== 'INFO').map((f) => f.message);
  if (flags.length) sections.push(section('تنبيهات الخطة', bullets(flags, 'warn')));
  if (p.assumptions?.length) sections.push(section('الافتراضات', bullets(p.assumptions, 'info')));

  const at = (iso: string | null) => (iso ? riyadhDateTime(new Date(iso)) : '—');
  const approvalItems: SignatureItem[] = [
    { role: 'أعدها', name: plan.createdByName ?? '—', date: at(plan.createdAt), note: null, signLabel: 'التوقيع' },
    { role: 'قدمها للاعتماد', name: plan.submittedAt ? (plan.submittedByName ?? 'غير معروف') : 'لم تقدم', date: at(plan.submittedAt), note: null, signLabel: 'التوقيع' },
    { role: plan.decisionLabel ? `القرار: ${plan.decisionLabel}` : 'الاعتماد', name: plan.decidedByName ?? 'لم يقرر بعد', date: at(plan.decidedAt), note: plan.decisionNote, signLabel: 'التوقيع' },
  ];
  if (plan.archivedAt) approvalItems.push({ role: 'أرشفها', name: plan.archivedByName ?? '—', date: at(plan.archivedAt), note: null, signLabel: 'التوقيع' });

  const evidence = evidenceOfExplanations(p.explanations);
  const listed = sourceRows(evidence);
  return {
    kind: 'plan',
    title: REPORT_TITLES.plan,
    subtitle: `${plan.name} - ${plan.statusLabel}`,
    meta: [
      { label: 'الشركة', value: plan.companyName ?? 'كل الشركات', num: false },
      { label: 'البداية', value: plan.fromMonth, num: true },
      { label: 'المدة', value: arabicMonths(plan.months), num: false },
      { label: 'الحالة', value: plan.statusLabel, num: false },
      { label: 'الدوران السنوي', value: plan.attritionPct === null ? 'الدوران الفعلي' : fmt.pct(plan.attritionPct), num: plan.attritionPct !== null },
      { label: 'السيناريو', value: SCENARIO_AR[p.scenario] ?? p.scenario, num: false },
    ],
    lead: null,
    sections,
    sources: [...listed, ...refRows(p.rulesUsed, listed, new Map(evidence.map((e) => [e.key, e.label])))],
    approval: { title: 'حالة الاعتماد', status: `الحالة: ${plan.statusLabel}. المعتمد لا يكون من أعد الخطة أو قدمها أو شارك في إعدادها.`, items: approvalItems },
    scope: { planId: plan.id, status: plan.status, asOf: v.actual?.result.asOf ?? null },
  };
}

// ---------------------------------------------------------------------------
// (e) «بيان المكافآت الشاملة» — view = GET /api/workforce/total-rewards or /api/portal/total-rewards
// ---------------------------------------------------------------------------

export interface TotalRewardsReportView {
  statement: {
    year: number;
    employee: { id: string; name: string; employeeNo: string | null; jobTitle: string | null; joinDate: string; companyName: string | null };
    coveredMonths: number[];
    through: string | null;
    available: boolean;
    reason: string | null;
    lines: Array<{ key: string; label: string; amount: number; kind: string; sourceLabel: string; explanation: string; basis: string; available: boolean; items?: Array<{ label: string; amount: number; note?: string }> }>;
    totals: { cash: number; employerPaid: number; accrued: number; total: number };
    notes: string[];
  };
}

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const TR_KIND_AR: Record<string, string> = { CASH: 'ما صرف لك', EMPLOYER: 'ما دفعته المنشأة عنك', ACCRUAL: 'ما تراكم لك', MEMO: 'للعلم' };

export function buildTotalRewardsReport(v: TotalRewardsReportView, audience: 'EMPLOYEE' | 'HR'): ReportModel {
  const s = v.statement;
  const sections: ReportSection[] = [];
  if (!s.available) {
    sections.push(section('البيان', [{ type: 'callout', tone: 'info', title: null, text: s.reason ?? 'لا توجد بيانات لهذه السنة' }]));
  } else {
    sections.push(section('كلفة المنشأة عليك', [
      {
        type: 'kpis',
        items: [
          kpi('ما صرف لك', fmt.money(s.totals.cash)),
          kpi('ما دفعته المنشأة عنك', fmt.money(s.totals.employerPaid)),
          kpi('ما تراكم لك', fmt.money(s.totals.accrued)),
          kpi('الإجمالي', fmt.money(s.totals.total), 'كلفة المنشأة عليك'),
        ],
      },
    ], `عن الأشهر المشمولة: ${s.coveredMonths.map((m) => MONTHS_AR[m - 1]).join('، ')}${s.through ? ` حتى ${s.through}` : ''}`));
    for (const kind of ['CASH', 'EMPLOYER', 'ACCRUAL', 'MEMO']) {
      const ls = s.lines.filter((l) => l.kind === kind);
      if (!ls.length) continue;
      const rows: ReportRow[] = [];
      for (const l of ls) {
        rows.push(row([l.label, l.available ? fmt.money(l.amount) : 'غير متوفر', l.sourceLabel, l.basis || l.explanation], kind === 'MEMO' ? 'muted' : 'normal'));
        for (const it of l.items ?? []) rows.push(row([`- ${it.label}${it.note ? ` (${it.note})` : ''}`, fmt.money(it.amount), '', ''], 'muted'));
      }
      const total = kind === 'CASH' ? s.totals.cash : kind === 'EMPLOYER' ? s.totals.employerPaid : kind === 'ACCRUAL' ? s.totals.accrued : null;
      if (total !== null) rows.push(row(['المجموع', fmt.money(total), '', ''], 'total'));
      sections.push(section(TR_KIND_AR[kind], [table([col('البند', false, '2fr'), col('المبلغ', true), col('المصدر'), col('الأساس', false, '2fr')], rows)], kind === 'MEMO' ? 'للعلم فقط: لا تدخل في الإجمالي' : null));
    }
  }
  if (s.notes.length) sections.push(section('ملاحظات', bullets(s.notes, 'info')));
  return {
    kind: 'total-rewards',
    title: REPORT_TITLES['total-rewards'],
    subtitle: `${s.employee.name} - سنة ${s.year}`,
    meta: [
      { label: 'الموظف', value: s.employee.name, num: false },
      { label: 'الرقم الوظيفي', value: s.employee.employeeNo ?? '—', num: true },
      { label: 'المسمى الوظيفي', value: s.employee.jobTitle ?? '—', num: false },
      { label: 'تاريخ المباشرة', value: s.employee.joinDate, num: true },
      { label: 'الشركة', value: s.employee.companyName ?? '—', num: false },
      { label: 'السنة', value: String(s.year), num: true },
    ],
    lead: audience === 'EMPLOYEE'
      ? 'هذا البيان يوضح ما تنفقه المنشأة عليك خلال السنة: ما صرف لك، وما دفعته عنك، وما تراكم لك. المبالغ من مسيرات الرواتب المعتمدة وتقديرات المحرك، وهو للعلم وليس مستندا رسميا.'
      : 'بيان المكافآت الشاملة للموظف كما يظهر له في البوابة، للمراجعة والطباعة من الموارد البشرية.',
    sections,
    sources: s.lines.map((l) => ({ label: l.label, value: l.available ? fmt.money(l.amount) : 'غير متوفر', valueNum: l.available, effective: s.through ?? '—', status: l.sourceLabel, url: null })),
    approval: null,
    scope: { employeeId: s.employee.id, year: s.year, audience },
  };
}

// ---------------------------------------------------------------------------
// Hire scenarios («سيناريوهات التوظيف») — view = POST /api/workforce/hire-scenario response
// ---------------------------------------------------------------------------

export interface HireScenarioReportView {
  horizon: number;
  assumptionEvidence: Record<string, EvidenceLike>;
  result: {
    startMonth: string;
    company: { id: string; name: string };
    nitaqatBefore: { status: string; pct: number; band: string | null; x: number; message: string | null };
    candidates: Array<{
      index: number; kind: string; label: string;
      windows: Record<'12' | '24' | '36', Triple & { levyOthers: number; total: number }>;
      firstMonthCost: number;
      lines: Array<{ key: string; label: string; kind: string; w12: number; w24: number; w36: number; basis: string; status: string; ruleKeys: string[]; note?: string }>;
      nitaqat: { status: string; before?: { pct: number; band: string | null }; after?: { pct: number; band: string | null }; candidateWeight?: number; message?: string };
      localization: Array<{ groupNameAr: string; requiredPct: number | null; before: { pct: number | null; compliant: boolean | null }; after: { pct: number | null; compliant: boolean | null } }>;
      capacity: { note: string } | null;
      notes: string[];
      explanations: Record<string, { rules?: EvidenceLike[] } | undefined>;
      rulesUsed: Array<{ key: string; effectiveFrom: string | null; status: string; value: number | null }>;
    }>;
    assumptions: string[];
  };
}

export function buildHireScenarioReport(v: HireScenarioReportView): ReportModel {
  const r = v.result;
  const h = String(v.horizon) as '12' | '24' | '36';
  const sections: ReportSection[] = [
    section('المقارنة', [
      table(
        [col('البديل', false, '2fr'), col('الشهر الأول', true), col(`الكلفة ${h} شهرا`, true), col('الدعم', true), col('أثر المقابل على الآخرين', true), col('للمقارنة', true), col('النطاق بعده')],
        r.candidates.map((c) => {
          const w = c.windows[h];
          const after = c.nitaqat.status === 'OK' && c.nitaqat.after ? `${band(c.nitaqat.after.band)} (${fmt.pct(c.nitaqat.after.pct)})` : '—';
          return row([c.label, fmt.money(c.firstMonthCost), fmt.money(w.cost), fmt.money(w.subsidy), fmt.money(w.levyOthers), fmt.money(w.total), after]);
        }),
        `النطاق الحالي: ${r.nitaqatBefore.band ? `${band(r.nitaqatBefore.band)} (${fmt.pct(r.nitaqatBefore.pct)})` : (r.nitaqatBefore.message ?? '—')}. «للمقارنة» = الصافي بعد دعم هدف + أثر المقابل المالي على بقية الوافدين.`,
      ),
    ]),
  ];
  const evidence: EvidenceLike[] = [];
  const refs: HireScenarioReportView['result']['candidates'][number]['rulesUsed'] = [];
  for (const c of r.candidates) {
    evidence.push(...evidenceOfExplanations(c.explanations));
    refs.push(...c.rulesUsed);
    const keys = new Set(c.lines.flatMap((l) => l.ruleKeys));
    evidence.push(...Object.values(v.assumptionEvidence ?? {}).filter((e) => keys.has(e.key)));
    sections.push(section(c.label, [
      table(
        [col('البند', false, '2fr'), col('12 شهرا', true), col('24 شهرا', true), col('36 شهرا', true), col('الأساس', false, '2fr')],
        c.lines.map((l) => row([l.note ? `${l.label} (${l.note})` : l.label, fmt.money(l.w12), fmt.money(l.w24), fmt.money(l.w36), l.basis], l.kind === 'MEMO' ? 'muted' : 'normal')),
      ),
      ...(c.localization.length
        ? [table(
            [col('قرار التوطين', false, '2fr'), col('المطلوب', true), col('قبل', true), col('بعد', true), col('الالتزام بعده')],
            c.localization.map((l) => row([l.groupNameAr, fmt.pct(l.requiredPct), fmt.pct(l.before.pct), fmt.pct(l.after.pct), l.after.compliant === null ? '—' : l.after.compliant ? 'ملتزم' : 'غير ملتزم'])),
          )]
        : []),
      ...bullets([...(c.nitaqat.status !== 'OK' && c.nitaqat.message ? [c.nitaqat.message] : []), ...(c.capacity ? [c.capacity.note] : []), ...c.notes], 'info'),
    ]));
  }
  if (r.assumptions.length) sections.push(section('الافتراضات', bullets(r.assumptions, 'info')));
  const listed = sourceRows(evidence);
  return {
    kind: 'hire-scenario',
    title: REPORT_TITLES['hire-scenario'],
    subtitle: `${r.company.name} - من ${r.startMonth}`,
    meta: [
      { label: 'بداية التوقع', value: r.startMonth, num: true },
      { label: 'الأفق', value: `${h} شهرا`, num: false },
      { label: 'البدائل', value: fmt.int(r.candidates.length), num: true },
    ],
    lead: null,
    sections,
    sources: [...listed, ...refRows(refs, listed, new Map(evidence.map((e) => [e.key, e.label])))],
    approval: null,
    scope: { companyId: r.company.id, candidates: r.candidates.map((c) => c.kind).join(','), months: v.horizon },
  };
}

// ---------------------------------------------------------------------------
// (f) «حساسية القرار» — view = POST /api/workforce/sensitivity response ({ result, evidence })
// ---------------------------------------------------------------------------

export interface SensitivityReportView {
  result: {
    decision: string;
    title: string;
    metricLabel: string;
    horizonMonths: number;
    outcomes: Array<{
      id: string;
      label: string;
      base: number;
      scenarios: Record<'low' | 'base' | 'high', number>;
      /** scenarios.high − scenarios.low and scenarios.low / high − base, computed by the engine (sensitivity.ts). */
      scenarioSpread?: number;
      scenarioDeltas?: { low: number; high: number };
      factors: Array<{ key: string; label: string; lowText: string; baseText: string; highText: string; low: number; high: number; lowDelta: number; highDelta: number; swing: number }>;
    }>;
    skipped: Array<{ label: string; reason: string }>;
    ranges: Array<{ label: string; unit: string | null; low: number; base: number; high: number; origin: string }>;
    notes: string[];
    runs: number;
    /** Approved plan: the totals frozen at approval and live − approved, both computed by the API. */
    reference?: { label: string; createdAt: string; values: Record<string, number | null>; diffs?: Record<string, number | null> } | null;
  };
  evidence: EvidenceLike[];
}

const DECISION_AR: Record<string, string> = { HIRE: 'سيناريو توظيف', EXIT: 'كلفة الإنهاء والإحلال', PLAN: 'خطة القوى العاملة' };

export function buildSensitivityReport(v: SensitivityReportView): ReportModel {
  const r = v.result;
  const signed = (n: number | null | undefined) => (isNum(n) && n > 0 ? `+${fmt.money(n)}` : fmt.money(n));
  const ref = r.reference ?? null;
  // Every difference is the engine's / API's figure (scenarioDeltas, reference.diffs): printed, never recomputed.
  const sections: ReportSection[] = r.outcomes.map((o) => {
    const approved = ref?.values[o.id];
    const refBlock: ReportBlock[] = ref && isNum(approved)
      ? [{
          type: 'kpis',
          items: [
            kpi('المعتمد', fmt.money(approved), `${ref.label} (${fmt.date(ref.createdAt)})`),
            kpi('الحساب الحي', fmt.money(o.base), 'بالبيانات الحالية؛ الحساسية تقاس حوله'),
            kpi('الفرق (الحي - المعتمد)', signed(ref.diffs?.[o.id] ?? null), null),
          ],
        }]
      : [];
    return section(o.label, [
      ...refBlock,
      {
        type: 'kpis',
        items: [
          kpi('الأساسي', fmt.money(o.base), r.metricLabel),
          kpi('السيناريو المنخفض', fmt.money(o.scenarios.low), `الفرق ${signed(o.scenarioDeltas?.low ?? null)}`),
          kpi('السيناريو المرتفع', fmt.money(o.scenarios.high), `الفرق ${signed(o.scenarioDeltas?.high ?? null)}`),
        ],
      },
      o.factors.length
        ? table(
            [col('العامل', false, '2fr'), col('منخفض'), col('أساسي'), col('مرتفع'), col('النتيجة عند المنخفض', true), col('النتيجة عند المرتفع', true), col('الفرق (منخفض)', true), col('الفرق (مرتفع)', true), col('المدى', true)],
            o.factors.map((f) => row([f.label, f.lowText, f.baseText, f.highText, fmt.money(f.low), fmt.money(f.high), signed(f.lowDelta), signed(f.highDelta), fmt.money(f.swing)])),
            'عامل واحد في كل مرة وبقية المدخلات على الأساسي؛ مرتبة من الأكبر أثرا.',
          )
        : { type: 'para', text: 'لا عوامل متغيرة لهذا القرار.' },
    ]);
  });
  if (r.ranges.length) {
    sections.push(section('النطاقات المستخدمة', [
      table(
        [col('الافتراض', false, '2fr'), col('منخفض', true), col('أساسي', true), col('مرتفع', true), col('المصدر')],
        r.ranges.map((x) => row([x.label, fmt.dec(x.low), fmt.dec(x.base), fmt.dec(x.high), x.origin === 'REQUEST' ? 'لهذا الحساب فقط' : 'افتراضات المنشأة'])),
      ),
    ]));
  }
  const extra = [...r.notes, ...r.skipped.map((x) => `${x.label}: ${x.reason}`)];
  if (extra.length) sections.push(section('ملاحظات', bullets(extra, 'info')));
  return {
    kind: 'sensitivity',
    title: REPORT_TITLES.sensitivity,
    subtitle: r.title,
    meta: [
      { label: 'القرار', value: DECISION_AR[r.decision] ?? r.decision, num: false },
      { label: 'المؤشر', value: r.metricLabel, num: false },
      { label: 'الأفق', value: arabicMonths(r.horizonMonths), num: false },
    ],
    lead: null,
    sections,
    sources: sourceRows(v.evidence ?? []),
    approval: null,
    scope: { decision: r.decision, runs: r.runs },
  };
}

// ---------------------------------------------------------------------------
// Privacy (defence in depth: the views are already restricted per role by the API)
// ---------------------------------------------------------------------------

/**
 * The view as printed for `viewerRole`: outside the HR group (canSeeDisability) the same deep redaction as a
 * saved snapshot read by that viewer — sensitive employee fields dropped, every HRDF category list replaced by
 * the neutral text. The API views are already restricted; this guarantees nothing slips into a PDF.
 */
export function viewForRole<T>(view: T, viewerRole: string | null | undefined): T {
  return canSeeDisability(viewerRole) ? view : (redactSnapshotJson(view) as T);
}

// ---------------------------------------------------------------------------
// Branding, finalization and rendering
// ---------------------------------------------------------------------------

export interface ReportBranding {
  companyId: string | null;
  companyName: string;
  multiCompany: boolean;
  primaryColor: string;
  numerals: Numerals;
  contact: string | null;
  logo: Buffer | null;
}

const DEFAULT_COLOR = '#0F4C81';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Brand of the letterhead company (companyBranding; never BrandProfile directly). null company = defaults. */
export async function reportBranding(companyId: string | null, companyName: string | null, multiCompany: boolean): Promise<ReportBranding> {
  const base: ReportBranding = { companyId, companyName: multiCompany ? MULTI_COMPANY_LABEL : (companyName ?? MULTI_COMPANY_LABEL), multiCompany, primaryColor: DEFAULT_COLOR, numerals: 'latn', contact: null, logo: null };
  if (!companyId) return base;
  const { brand, logo } = await companyBranding(companyId);
  const pngOk = !!logo && logo.length <= 2 * 1024 * 1024 && logo.subarray(0, 8).equals(PNG_SIG);
  return {
    ...base,
    primaryColor: /^#[0-9A-Fa-f]{6}$/.test(brand.primaryColor) ? brand.primaryColor : DEFAULT_COLOR,
    numerals: brand.numerals === 'arab' ? 'arab' : 'latn',
    contact: multiCompany ? null : [brand.addressAr, brand.phone, brand.email].filter((x): x is string => !!x && !!x.trim()).join(' - ') || null,
    logo: pngOk ? logo : null,
  };
}

/** data.json for the template: branding, footer, sources header, then sanitized and localized. PURE. */
export function finalizeReportData(model: ReportModel, b: Omit<ReportBranding, 'logo'> & { hasLogo: boolean }, generatedAt: Date): ReportData {
  const data: ReportData = {
    kind: model.kind,
    title: model.title,
    subtitle: model.subtitle,
    numerals: b.numerals,
    pageNumbering: b.numerals === 'arab' ? '١' : '1',
    lead: model.lead,
    brand: { primaryColor: b.primaryColor, companyName: b.companyName, multi: b.multiCompany, hasLogo: b.hasLogo, contact: b.contact },
    meta: model.meta,
    footer: {
      badge: 'تقرير داخلي',
      internal: INTERNAL_REPORT_NOTICE,
      disclaimer: ESTIMATE_DISCLAIMER,
      generated: `وقت الحساب: ${riyadhDateTime(generatedAt)} بتوقيت الرياض`,
      engineLabel: 'نسخة المحرك',
      engine: ENGINE_VERSION,
      pageLabel: 'صفحة',
      ofLabel: 'من',
    },
    sections: model.sections,
    sources: {
      title: 'المصادر والحالات',
      note: 'القواعد والقيم التي استخدمها الحساب: القيمة، وتاريخ السريان، والحالة، ورابط المصدر.',
      empty: 'لا قواعد نظامية في هذا الحساب.',
      columns: ['القاعدة أو البند', 'القيمة', 'السريان', 'الحالة'],
      rows: model.sources,
    },
    approval: model.approval,
  };
  return sanitizeReportData(data, b.numerals);
}

/** Thrown when RENDER_SERVICE_URL / RENDER_SERVICE_TOKEN are not set (the API answers 503). */
export class ReportServiceNotConfiguredError extends Error {
  readonly code = 'REPORT_SERVICE_NOT_CONFIGURED';
  constructor() {
    super(REPORT_SERVICE_NOT_CONFIGURED);
  }
}

export function reportServiceConfigured(): boolean {
  return renderServiceConfig() !== null;
}

/** Template bundle (main.typ + layout.typ). Literal paths: traced into the standalone build. */
export async function loadReportTemplates(): Promise<Record<string, Buffer>> {
  const [main, layout] = await Promise.all([
    readFile(path.join(process.cwd(), 'src', 'lib', 'workforce', 'templates', 'main.typ')),
    readFile(path.join(process.cwd(), 'src', 'lib', 'workforce', 'templates', 'layout.typ')),
  ]);
  return { 'main.typ': main, 'layout.typ': layout };
}

export const REPORT_TEMPLATE_VERSION = 1;

export interface RenderedReport {
  pdf: Buffer;
  sha256: string;
  data: ReportData;
  fileName: string;
  fileNameAr: string;
}

/**
 * Renders a report model with the branding of the letterhead company. `generatedAt` = the calculation time
 * (also the PDF creation timestamp: same view + same time -> same bytes). Throws
 * ReportServiceNotConfiguredError when the service is not configured, RenderError otherwise.
 */
export async function renderWorkforceReport(model: ReportModel, branding: ReportBranding, generatedAt: Date, renderer?: DocumentRenderer): Promise<RenderedReport> {
  const config = renderServiceConfig();
  if (!renderer && !config) throw new ReportServiceNotConfiguredError();
  const { logo, ...b } = branding;
  const data = finalizeReportData(model, { ...b, hasLogo: !!logo }, generatedAt);
  const seconds = Math.floor(generatedAt.getTime() / 1000);
  if (seconds < 946_684_800 || seconds > 4_102_444_800) throw new RenderError('وقت الحساب خارج النطاق المسموح', 'INVALID_TIMESTAMP', false);
  const out = await (renderer ?? typstServiceRenderer(config)).render({
    templateRef: `typst:wf-${model.kind}/ar@${REPORT_TEMPLATE_VERSION}`,
    template: await loadReportTemplates(),
    data,
    assets: logo ? { 'logo.png': logo } : {},
    creationTimestamp: seconds,
    pdfStandard: 'a-2b',
  });
  const day = riyadhDay(generatedAt);
  return {
    pdf: out.pdf,
    sha256: out.pdfSha256 || sha256Hex(out.pdf),
    data,
    fileName: `${REPORT_FILE_STEMS[model.kind]}-${day}.pdf`,
    fileNameAr: stripBidiControls(`${REPORT_TITLES[model.kind]} ${day}.pdf`),
  };
}

/** Content-Disposition with an ASCII fallback and the Arabic name (RFC 6266 / 5987). */
export function pdfContentDisposition(fileName: string, fileNameAr: string): string {
  return attachmentDisposition(fileName, fileNameAr);
}

export { RenderError };

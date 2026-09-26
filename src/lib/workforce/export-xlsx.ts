// Excel exports of the workforce decision engine («التقارير والتصدير», SPEC §11). Pure-ish: builds exceljs
// workbooks in memory; no Prisma, no clock (the caller passes `generatedAt`).
//
// Every builder takes the SAME view object the page / JSON API shows (after the privacy redaction of the
// viewer and the benchmarks suppression): a workbook never carries more detail than the screen. Every
// workbook has:
//   - a first sheet «ملخص»: title, company / scope, period, scenario, engine version, generated-at (Riyadh),
//     the estimate disclaimer, the Qiwa note, the privacy note of a restricted view, and the sheet list;
//   - data sheets: right-to-left, frozen header row, column widths, real numbers (#,##0.00 "SAR" for money,
//     0.00"%" for percentages), real dates (yyyy-mm-dd) and months (yyyy-mm), statuses as Arabic words with
//     PROVISIONAL / CONFLICTING / MISSING highlighted;
//   - a last sheet «المصادر والحالات»: every rule / assumption / company setting behind the numbers (key,
//     label, value, unit, effective date, status, source URL, quote): the Excel form of «لماذا هذا الرقم؟».
// Labels are Arabic copies of src/app/api/workforce/_lib/shared.ts (the lib layer does not import src/app
// at runtime; wf-export.test.ts keeps them in sync). Type-only imports of the API view shapes are erased.
import ExcelJS from 'exceljs';
import { ENGINE_VERSION, ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { BAND_LABELS, type NitaqatBand } from '@/lib/workforce/nitaqat';
import { CANDIDATE_KIND_LABELS, type HireScenarioResult } from '@/lib/workforce/hiring';
import { DECISION_STATUS_LABELS, type ParsedDecision, type SolveResult, type SolverActionKind } from '@/lib/workforce/saudization';
import { TERMINATION_REASON_LABELS } from '@/lib/settlement';
import { PLAN_EXIT_REASON_LABELS, PLAN_NATIONALITY_LABELS, type PlanProjection, type PlanVsActualResult, type PlanWindowKey } from '@/lib/workforce/planning';
import { COMPLEMENTARY_SUPPRESSED_TEXT, INSUFFICIENT_DATA, type BenchmarkMetric, type BenchmarksResult, type BreakdownRow, type BmUnit, type SeriesPoint } from '@/lib/workforce/benchmarks';
import type { SensitivityResult } from '@/lib/workforce/sensitivity';
import type { CostLineKind, EmployeeLiabilities, EmployeeMonth, ExitCostResult, ExitLineKind, MoneyTriple, RuleEvidence, RuleVersionRef, Scenario, WfFlag, WindowTotals } from '@/lib/workforce/types';
import type { CompositionItem, DataQualityDetail, EmployeeSummary, GroupRow, OverviewResponse, RuleDomainView } from '@/app/api/workforce/_lib/views';
import type { CompanySaudization } from '@/app/api/workforce/_lib/saudization';

// ---------------------------------------------------------------------------
// Constants and label copies (kept in sync with src/app/api/workforce/_lib/shared.ts by wf-export.test.ts)
// ---------------------------------------------------------------------------

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MONEY_FMT = '#,##0.00 "SAR"';
export const PCT_FMT = '0.00"%"';
export const INT_FMT = '#,##0';
export const NUM_FMT = '#,##0.00';
export const DATE_FMT = 'yyyy-mm-dd';
export const MONTH_FMT = 'yyyy-mm';
export const DATETIME_FMT = 'yyyy-mm-dd hh:mm';
export const SUMMARY_SHEET = 'ملخص';
export const SOURCES_SHEET = 'المصادر والحالات';

/** Copy of shared.ts QIWA_NOTE. */
export const XLSX_QIWA_NOTE = 'المرجع الرسمي لنطاقات المنشأة والمقابل المالي منصة قوى (qiwa.sa).';

/** Copy of shared.ts STATUS_LABELS, plus the register row statuses (Nitaqat / localization registers). */
export const XLSX_STATUS_LABELS: Record<string, string> = {
  VERIFIED_PRIMARY: 'موثّق من المصدر الرسمي',
  CORROBORATED_SECONDARY: 'مؤكَّد ثانوياً',
  PROVISIONAL: 'مؤقت',
  CONFLICTING: 'متعارض',
  USER_INPUT: 'إدخال المنشأة',
  MISSING: 'غير مُدخل',
  DERIVED: 'محسوب',
  AMBIGUOUS: 'يحتاج مطابقة مع ملحق الدليل',
  PARTIAL: 'موثّق جزئياً',
};

/** Statuses highlighted in every status cell. */
const STATUS_FILL: Record<string, string> = {
  PROVISIONAL: 'FFFEF3C7',
  AMBIGUOUS: 'FFFEF3C7',
  PARTIAL: 'FFFEF3C7',
  CONFLICTING: 'FFFFE4E6',
  MISSING: 'FFE2E8F0',
};
export const HIGHLIGHTED_STATUSES = Object.keys(STATUS_FILL);

/** Copy of shared.ts UNIT_LABELS. */
export const XLSX_UNIT_LABELS: Record<string, string> = {
  SAR: 'ريال',
  SAR_MONTH: 'ريال شهرياً',
  SAR_YEAR: 'ريال سنوياً',
  PERCENT: '%',
  DAYS: 'يوم',
  DAYS_YEAR: 'يوم سنوياً',
  MONTHS: 'شهر',
  WEEKS: 'أسبوع',
  HOURS: 'ساعة',
  WORKERS: 'عامل',
  FLAG: '',
  COUNT_YEAR: 'مرة سنوياً',
};

/** Copy of shared.ts DOMAIN_LABELS. */
export const XLSX_DOMAIN_LABELS: Record<string, string> = {
  GOSI: 'التأمينات الاجتماعية',
  LABOR_LAW: 'نظام العمل',
  EXPAT_FEES: 'رسوم الوافدين',
  HRDF: 'دعم هدف',
  NITAQAT: 'نطاقات',
};

/** Copies of shared.ts SCENARIO_LABELS / NATIONALITY_LABELS / LEVY_TIER_LABELS / SEVERITY_LABELS. */
export const XLSX_SCENARIO_LABELS: Record<Scenario, string> = { low: 'منخفض', base: 'أساسي', high: 'مرتفع' };
export const XLSX_NATIONALITY_LABELS: Record<string, string> = { SAUDI: 'سعودي', GCC: 'خليجي', EXPAT: 'وافد' };
export const XLSX_LEVY_TIER_LABELS: Record<string, string> = {
  EXEMPT: 'معفى (منشأة صغيرة)',
  WITHIN: '700 (ضمن عدد السعوديين)',
  ABOVE: '800 (زائد عن عدد السعوديين)',
  INDUSTRIAL_ZERO: 'معفى (صناعي مرخّص)',
};
export const XLSX_SEVERITY_LABELS: Record<string, string> = { ERROR: 'خطأ', WARNING: 'تنبيه', INFO: 'معلومة' };

const LINE_KIND_LABELS: Record<CostLineKind, string> = { COST: 'كلفة', SUBSIDY: 'دعم هدف (سالب مشروط)', MEMO: 'للعلم (خارج الإجمالي)' };
const REGIME_LABELS: Record<string, string> = { OLD: 'قديم', NEW: 'جديد', UNKNOWN: 'غير مؤكد' };
const BAND_TEXT = (b: NitaqatBand | string | null | undefined) => (b ? (BAND_LABELS[b as NitaqatBand] ?? String(b)) : 'غير محسوب');
const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? 'غير معروف' : b ? 'نعم' : 'لا');

// ---------------------------------------------------------------------------
// Generic sheet model
// ---------------------------------------------------------------------------

export type ColKind = 'text' | 'money' | 'number' | 'int' | 'pct' | 'date' | 'month' | 'datetime' | 'status' | 'url' | 'bool';
export type Scalar = string | number | boolean | Date | null | undefined;
/** A cell whose format differs from its column (e.g. a mixed label / value table). */
export interface TypedCell {
  v: Scalar;
  kind: ColKind;
}
export type XCell = Scalar | TypedCell;

export interface XCol {
  header: string;
  kind?: ColKind;
  width?: number;
}

export interface XSheet {
  name: string;
  columns: XCol[];
  rows: XCell[][];
  /** Row indexes (0-based in `rows`) shown bold as totals. */
  totalRows?: ReadonlyArray<number>;
  /** Lines written under the table (after an empty row). */
  notes?: ReadonlyArray<string>;
}

export interface SourceRow {
  key: string;
  label: string;
  value: number | null;
  unit: string | null;
  effectiveFrom: string | null;
  status: string;
  sourceUrl: string | null;
  note: string | null;
}

export interface WorkbookMeta {
  /** Arabic title (sheet «ملخص» and the file name). */
  title: string;
  /** Company / scope lines. */
  scope: string;
  period: string;
  engineVersion: string;
  generatedAt: Date;
  scenario?: Scenario | null;
  /** Viewer outside the HR group: the restricted (disability-free) form was exported. */
  restricted?: boolean;
  /** Extra label / value rows of the summary. */
  extra?: ReadonlyArray<[string, XCell]>;
  notes?: ReadonlyArray<string>;
}

export interface BuiltWorkbook {
  workbook: ExcelJS.Workbook;
  title: string;
  /** Data rows per sheet (summary excluded), for the EXPORT audit row. */
  sheets: Array<{ name: string; rows: number }>;
}

export interface ExportContext {
  generatedAt: Date;
  /** Viewer may see disability data (privacy.ts canSeeDisability). */
  canSeeDisability: boolean;
}

const RIYADH_OFFSET_MS = 3 * 3600_000;

/** Riyadh wall-clock time as a Date (Excel dates carry no zone: the cell shows the Riyadh time). */
export function riyadhWallClock(d: Date): Date {
  return new Date(d.getTime() + RIYADH_OFFSET_MS);
}

function isTyped(c: XCell): c is TypedCell {
  return !!c && typeof c === 'object' && !(c instanceof Date) && 'kind' in c;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function asDate(v: Scalar): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && DATE_RE.test(v)) {
    const d = new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function asMonth(v: Scalar): Date | null {
  if (typeof v === 'string' && MONTH_RE.test(v)) return new Date(`${v}-01T00:00:00.000Z`);
  return asDate(v);
}

export function statusLabel(s: string | null | undefined): string {
  const k = (s ?? '').toUpperCase();
  return XLSX_STATUS_LABELS[k] ?? (s || '—');
}

const numeric = (v: Scalar): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Bidi override / isolate marks and C0 / DEL control characters. A name carrying U+202E (RIGHT-TO-LEFT OVERRIDE)
 * would otherwise reorder what the reader sees in a cell or a file name; control characters are invalid in the
 * sheet XML. Shared with report-pdf.ts (file names).
 */
export const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\x00-\x1f\x7f]/g;

/** Text without bidi / control characters (tab, CR and LF become a space so words stay apart). */
export function stripBidiControls(input: string): string {
  return String(input).replace(/[\t\r\n]+/g, ' ').replace(BIDI_CONTROL_RE, '');
}

/** RFC 5987 ext-value encoding (UTF-8 percent-encoding; ' ( ) * ! are encoded too, unlike encodeURIComponent). */
export function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987> (shared by the Excel and PDF routes). */
export function attachmentDisposition(asciiName: string, utf8Name: string): string {
  const ascii = asciiName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987Encode(stripBidiControls(utf8Name))}`;
}

/**
 * The free-text search of a true-cost export as stored in the EXPORT audit row: whether one was given and its
 * length, never the text (it may be an employee's name).
 */
export function auditSearchText(q: string | null | undefined): { qProvided: boolean; qLength: number } {
  const t = typeof q === 'string' ? q : '';
  return { qProvided: t.length > 0, qLength: t.length };
}

/** Arabic label of an exit reason: an Employee.exitReason or a settlement TerminationReason (raw code if unknown). */
export function exitReasonText(code: string | null | undefined): string {
  if (!code) return '—';
  return (PLAN_EXIT_REASON_LABELS as Record<string, string>)[code] ?? (TERMINATION_REASON_LABELS as Record<string, string>)[code] ?? code;
}

function writeCell(cell: ExcelJS.Cell, raw: XCell, colKind: ColKind): void {
  const kind = isTyped(raw) ? raw.kind : colKind;
  const v = isTyped(raw) ? raw.v : raw;
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) {
    cell.value = null;
    return;
  }
  switch (kind) {
    case 'money':
    case 'pct':
    case 'int':
    case 'number':
      if (numeric(v)) {
        cell.value = v;
        cell.numFmt = kind === 'money' ? MONEY_FMT : kind === 'pct' ? PCT_FMT : kind === 'int' ? INT_FMT : NUM_FMT;
        return;
      }
      break;
    case 'date': {
      const d = asDate(v);
      if (d) {
        cell.value = d;
        cell.numFmt = DATE_FMT;
        return;
      }
      break;
    }
    case 'month': {
      const d = asMonth(v);
      if (d) {
        cell.value = d;
        cell.numFmt = MONTH_FMT;
        return;
      }
      break;
    }
    case 'datetime':
      if (v instanceof Date) {
        cell.value = v;
        cell.numFmt = DATETIME_FMT;
        return;
      }
      break;
    case 'status': {
      const code = String(v).toUpperCase();
      cell.value = stripBidiControls(statusLabel(String(v)));
      const fill = STATUS_FILL[code];
      if (fill) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.font = { bold: true };
      }
      return;
    }
    case 'url': {
      const s = String(v);
      if (/^https?:\/\//i.test(s)) {
        cell.value = { text: s, hyperlink: s };
        cell.font = { color: { argb: 'FF1D4ED8' }, underline: true };
        return;
      }
      cell.value = stripBidiControls(s);
      return;
    }
    case 'bool':
      cell.value = yesNo(v as boolean);
      return;
    default:
      break;
  }
  if (typeof v === 'boolean') cell.value = yesNo(v);
  else if (v instanceof Date) {
    cell.value = v;
    cell.numFmt = DATE_FMT;
  } else cell.value = typeof v === 'number' ? v : stripBidiControls(String(v));
}

const DEFAULT_WIDTH: Record<ColKind, number> = { text: 24, money: 17, number: 12, int: 10, pct: 11, date: 12, month: 10, datetime: 18, status: 20, url: 40, bool: 9 };

function sheetName(wb: ExcelJS.Workbook, name: string): string {
  const base = name.replace(/[\\/*?:[\]]/g, '-').slice(0, 31) || 'ورقة';
  let n = base;
  let i = 2;
  while (wb.getWorksheet(n)) n = `${base.slice(0, 28)} ${i++}`;
  return n;
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    c.border = { bottom: { style: 'thin' } };
  });
}

/** Adds one data sheet (RTL, frozen header, widths, formats). Returns the number of data rows. */
export function addTableSheet(wb: ExcelJS.Workbook, s: XSheet): { name: string; rows: number } {
  const name = sheetName(wb, s.name);
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1, xSplit: 0 }] });
  ws.columns = s.columns.map((c) => ({ width: c.width ?? DEFAULT_WIDTH[c.kind ?? 'text'] }));
  const header = ws.getRow(1);
  s.columns.forEach((c, i) => (header.getCell(i + 1).value = stripBidiControls(c.header)));
  styleHeader(header);
  const totals = new Set(s.totalRows ?? []);
  s.rows.forEach((r, ri) => {
    const row = ws.getRow(ri + 2);
    s.columns.forEach((c, ci) => writeCell(row.getCell(ci + 1), r[ci], c.kind ?? 'text'));
    if (totals.has(ri)) {
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (!cell.fill || (cell.fill as ExcelJS.FillPattern).pattern !== 'solid') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        cell.border = { top: { style: 'thin' } };
      });
    }
  });
  if (s.columns.length && s.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
  if (s.notes?.length) {
    let at = s.rows.length + 3;
    for (const n of s.notes) {
      const c = ws.getCell(at++, 1);
      c.value = stripBidiControls(n);
      c.font = { italic: true, color: { argb: 'FF475569' } };
    }
  }
  return { name, rows: s.rows.length };
}

/**
 * Company settings («إعدادات الكلفة») of the companies in the export's scope only: the selected company, and
 * otherwise the settings companies of the reported employees. The engine also loads the other employees of a
 * legal company (levy tiers), so companySettingsUsed can name companies outside a branch / department scope.
 */
export function settingsInScope<C extends { companyId: string }>(tc: { companySettingsUsed: ReadonlyArray<C>; employees: ReadonlyArray<{ settingsCompanyId: string | null }> }, companyId: string | null): C[] {
  const ids = companyId ? new Set([companyId]) : new Set(tc.employees.map((e) => e.settingsCompanyId).filter((x): x is string => !!x));
  return tc.companySettingsUsed.filter((c) => ids.has(c.companyId));
}

/** RuleEvidence -> source rows (deduplicated, sorted by key then effective date then label). */
export function evidenceToSources(ev: ReadonlyArray<RuleEvidence | null | undefined>): SourceRow[] {
  const seen = new Map<string, SourceRow>();
  for (const e of ev) {
    if (!e) continue;
    const row: SourceRow = { key: e.key, label: e.label, value: e.value, unit: e.unit, effectiveFrom: e.effectiveFrom, status: e.status, sourceUrl: e.sourceUrl, note: e.sourceQuote };
    const k = `${e.key}|${e.effectiveFrom ?? ''}|${e.label}|${e.sourceQuote ?? ''}`;
    if (!seen.has(k)) seen.set(k, row);
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key) || (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? '') || a.label.localeCompare(b.label, 'ar'));
}

function addSourcesSheet(wb: ExcelJS.Workbook, sources: ReadonlyArray<SourceRow>, notes: ReadonlyArray<string> = []): { name: string; rows: number } {
  return addTableSheet(wb, {
    name: SOURCES_SHEET,
    columns: [
      { header: 'المفتاح', width: 34 },
      { header: 'البند', width: 50 },
      { header: 'القيمة', kind: 'number', width: 14 },
      { header: 'الوحدة', width: 14 },
      { header: 'يسري من', kind: 'date' },
      { header: 'الحالة', kind: 'status' },
      { header: 'رابط المصدر', kind: 'url', width: 48 },
      { header: 'الاقتباس أو الملاحظة', width: 70 },
    ],
    rows: sources.map((s) => [s.key, s.label, s.value, s.unit ? (XLSX_UNIT_LABELS[s.unit] ?? s.unit) : null, s.effectiveFrom, s.status, s.sourceUrl, s.note]),
    notes: [
      'الحالات: موثّق من المصدر الرسمي، مؤكَّد ثانوياً، مؤقت، متعارض، إدخال المنشأة، غير مُدخل، محسوب. المؤقت والمتعارض وغير المُدخل مظلّلة.',
      ...notes,
    ],
  });
}

function addSummarySheet(wb: ExcelJS.Workbook, meta: WorkbookMeta): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(SUMMARY_SHEET, { views: [{ rightToLeft: true }] });
  ws.columns = [{ width: 36 }, { width: 110 }];
  const t = ws.getRow(1);
  t.getCell(1).value = stripBidiControls(meta.title);
  t.font = { bold: true, size: 15, color: { argb: 'FF312E81' } };
  t.height = 26;
  ws.mergeCells(1, 1, 1, 2);
  const put = (label: string, value: XCell, kind: ColKind = 'text') => {
    const row = ws.addRow([stripBidiControls(label)]);
    row.getCell(1).font = { bold: true };
    writeCell(row.getCell(2), value, kind);
    row.getCell(2).alignment = { wrapText: true, vertical: 'top', horizontal: 'right' };
  };
  put('المصدر', 'محرك القرارات — رديف');
  put('الشركة / النطاق', meta.scope);
  put('الفترة', meta.period);
  if (meta.scenario) put('السيناريو', XLSX_SCENARIO_LABELS[meta.scenario]);
  put('نسخة المحرك', meta.engineVersion);
  put('تاريخ الإنشاء (توقيت الرياض)', riyadhWallClock(meta.generatedAt), 'datetime');
  for (const [l, v] of meta.extra ?? []) put(l, v);
  put('تنبيه', ESTIMATE_DISCLAIMER);
  put('المرجع الرسمي', XLSX_QIWA_NOTE);
  if (meta.restricted) put('الخصوصية', 'نسخة مقيّدة: بيانات الإعاقة (بيانات صحية) لا تظهر لغير الموارد البشرية؛ فئات دعم هدف بنص محايد، والأوزان مجمّعة دون أفراد.');
  for (const n of meta.notes ?? []) put('ملاحظة', n);
  return ws;
}

function finishSummary(ws: ExcelJS.Worksheet, sheets: ReadonlyArray<{ name: string; rows: number }>): void {
  ws.addRow([]);
  const h = ws.addRow(['محتويات الملف', 'عدد الصفوف']);
  h.font = { bold: true };
  for (const s of sheets) {
    const r = ws.addRow([stripBidiControls(s.name), s.rows]);
    r.getCell(2).numFmt = INT_FMT;
    r.getCell(2).alignment = { horizontal: 'right' };
  }
}

/** Summary + data sheets + sources, in this order. */
export function assembleWorkbook(meta: WorkbookMeta, sheets: ReadonlyArray<XSheet>, sources: ReadonlyArray<SourceRow>, sourceNotes: ReadonlyArray<string> = []): BuiltWorkbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radeef';
  wb.created = meta.generatedAt;
  wb.modified = meta.generatedAt;
  wb.title = stripBidiControls(meta.title);
  const summary = addSummarySheet(wb, meta);
  const out: Array<{ name: string; rows: number }> = [];
  for (const s of sheets) out.push(addTableSheet(wb, s));
  out.push(addSourcesSheet(wb, sources, sourceNotes));
  finishSummary(summary, out);
  return { workbook: wb, title: meta.title, sheets: out };
}

// ---------------------------------------------------------------------------
// Small shared tables
// ---------------------------------------------------------------------------

const money = (v: number | null | undefined): TypedCell => ({ v: v ?? null, kind: 'money' });
const int = (v: number | null | undefined): TypedCell => ({ v: v ?? null, kind: 'int' });
const pct = (v: number | null | undefined): TypedCell => ({ v: v ?? null, kind: 'pct' });
const num = (v: number | null | undefined): TypedCell => ({ v: v ?? null, kind: 'number' });

const TRIPLE_COLS: XCol[] = [
  { header: 'الكلفة قبل الدعم', kind: 'money' },
  { header: 'دعم هدف', kind: 'money' },
  { header: 'بعد الدعم', kind: 'money' },
];
const triple = (t: MoneyTriple | null | undefined): XCell[] => [t?.cost ?? null, t?.subsidy ?? null, t?.net ?? null];

function seriesSheet(series: ReadonlyArray<{ month: string; cost: number; subsidy: number; net: number; headcount: number }>): XSheet {
  return {
    name: 'السلسلة الشهرية',
    columns: [{ header: 'الشهر', kind: 'month' }, { header: 'العدد', kind: 'int' }, ...TRIPLE_COLS],
    rows: series.map((s) => [s.month, s.headcount, s.cost, s.subsidy, s.net]),
  };
}

function compositionSheet(items: ReadonlyArray<CompositionItem>, horizon: number): XSheet {
  return {
    name: 'تركيبة الكلفة',
    columns: [{ header: 'البند', width: 34 }, { header: 'النوع', width: 22 }, { header: `مجموع ${horizon} شهراً`, kind: 'money' }, { header: 'الشهر الأول', kind: 'money' }],
    rows: items.map((c) => [c.label, LINE_KIND_LABELS[c.kind] ?? c.kind, c.amount, c.month1]),
    notes: ['بند «للعلم» لا يدخل في الإجمالي (مخصص الإجازة: الأجر يُدفع أثناءها). دعم هدف سطر سالب مشروط بقبول الطلب.'],
  };
}

function groupSheet(name: string, rows: ReadonlyArray<GroupRow>, horizon: number): XSheet {
  return {
    name,
    columns: [
      { header: 'الاسم', width: 30 },
      { header: 'العدد', kind: 'int' },
      { header: 'الشهر الأول قبل الدعم', kind: 'money' },
      { header: 'الشهر الأول بعد الدعم', kind: 'money' },
      { header: `${horizon} شهراً قبل الدعم`, kind: 'money' },
      { header: `دعم هدف (${horizon} شهراً)`, kind: 'money' },
      { header: `${horizon} شهراً بعد الدعم`, kind: 'money' },
      // The fixed 12 / 36-month columns, except the one the selected horizon already shows.
      ...(horizon === 12 ? [] : [{ header: '12 شهراً بعد الدعم', kind: 'money' as const }]),
      ...(horizon === 36 ? [] : [{ header: '36 شهراً بعد الدعم', kind: 'money' as const }]),
    ],
    rows: rows.map((g) => [g.name, g.headcount, g.month1.cost, g.month1.net, g.window.cost, g.window.subsidy, g.window.net, ...(horizon === 12 ? [] : [g.next12.net]), ...(horizon === 36 ? [] : [g.next36.net])]),
  };
}

function flagsSheet(name: string, flags: ReadonlyArray<{ severity: string; message: string; code?: string; subject?: string | null }>, subjectHeader?: string): XSheet {
  const cols: XCol[] = [...(subjectHeader ? [{ header: subjectHeader, width: 26 }] : []), { header: 'الخطورة', width: 10 }, { header: 'الرمز', width: 30 }, { header: 'الرسالة', width: 100 }];
  return { name, columns: cols, rows: flags.map((f) => [...(subjectHeader ? [f.subject ?? null] : []), XLSX_SEVERITY_LABELS[f.severity] ?? f.severity, f.code ?? null, f.message]) };
}

const kv = (rows: ReadonlyArray<[string, XCell]>, name: string, notes?: string[]): XSheet => ({
  name,
  columns: [
    { header: 'البند', width: 48 },
    { header: 'القيمة', width: 30 },
  ],
  rows: rows.map(([l, v]) => [l, v]),
  notes,
});

// ---------------------------------------------------------------------------
// (a) Overview «لوحة القرار»
// ---------------------------------------------------------------------------

export function buildOverviewWorkbook(v: OverviewResponse, sources: ReadonlyArray<RuleEvidence>, ctx: ExportContext): BuiltWorkbook {
  const h = v.horizon;
  const k = v.kpis;
  const kpiRows: XCell[][] = [
    ['هذا الشهر', ...triple(k.thisMonth)],
    ['12 شهراً', ...triple(k.next12)],
    ['24 شهراً', ...triple(k.next24)],
    ['36 شهراً', ...triple(k.next36)],
    [`الأفق المختار (${h} شهراً)`, ...triple(k.window)],
  ];
  const sheets: XSheet[] = [
    { name: 'المؤشرات', columns: [{ header: 'الفترة', width: 26 }, ...TRIPLE_COLS], rows: kpiRows },
    compositionSheet(v.composition, h),
    groupSheet('حسب الشركة', v.byCompany, h),
    groupSheet('حسب الفرع', v.byBranch, h),
    groupSheet('حسب الإدارة', v.byDepartment, h),
    seriesSheet(v.series),
    {
      name: 'شرائح المقابل المالي',
      columns: [
        { header: 'الشركة القانونية', width: 30 },
        { header: 'صناعي مرخّص', kind: 'bool' },
        { header: 'العدد', kind: 'int' },
        { header: 'سعوديون', kind: 'int' },
        { header: 'خليجيون', kind: 'int' },
        { header: 'وافدون', kind: 'int' },
        { header: 'معفون', kind: 'int' },
        { header: 'شريحة 700', kind: 'int' },
        { header: 'شريحة 800', kind: 'int' },
        { header: 'المقابل المالي الشهري', kind: 'money' },
        { header: 'نسبة السعوديين الخام', kind: 'pct' },
      ],
      rows: v.legalCompanies.map((c) => [c.name, c.isIndustrialLicensed, c.headcount, c.saudi, c.gcc, c.expat, c.exempt, c.within, c.above, c.monthlyLevy, c.rawSaudiRatioPct]),
      notes: ['نسبة السعوديين الخام = السعوديون ÷ (السعوديون + الوافدون)، وليست نسبة نطاقات الموزونة (انظر «مخطط السعودة»).'],
    },
    {
      name: 'التغييرات القادمة',
      columns: [
        { header: 'البند', width: 40 },
        { header: 'المفتاح', width: 30 },
        { header: 'يسري من', kind: 'date' },
        { header: 'يُطبَّق من شهر', kind: 'month' },
        { header: 'القيمة السابقة', kind: 'number' },
        { header: 'القيمة الجديدة', kind: 'number' },
        { header: 'الوحدة', width: 12 },
        { header: 'الأثر الشهري التقديري', kind: 'money' },
        { header: 'المتأثرون', kind: 'int' },
        { header: 'أساس التقدير', width: 60 },
        { header: 'الحالة', kind: 'status' },
        { header: 'المصدر', kind: 'url' },
      ],
      rows: v.upcomingEvents.map((e) => [e.label, e.key, e.effectiveFrom, e.appliesFromMonth, e.previousValue, e.value, e.unit ? (XLSX_UNIT_LABELS[e.unit] ?? e.unit) : null, e.estimatedMonthlyImpact, e.affected, e.impactBasis, e.status, e.sourceUrl]),
    },
    dataQualitySheet(v.dataQuality),
  ];
  return assembleWorkbook(
    {
      title: `لوحة القرار — ${h} شهراً`,
      scope: 'كل الموظفين (كل الشركات)',
      period: `${h} شهراً من ${v.startMonth}`,
      engineVersion: v.engineVersion,
      generatedAt: ctx.generatedAt,
      scenario: v.scenario,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['عدد الموظفين (الشهر الأول)', int(k.headcount)],
        ['السعوديون / الخليجيون / الوافدون', `${k.saudi} / ${k.gcc} / ${k.expat}`],
        ['مكافأة نهاية الخدمة المستحقة (إنهاء صاحب العمل)', money(k.eosbLiabilityEmployer)],
        ['مكافأة نهاية الخدمة المستحقة (الاستقالة)', money(k.eosbLiabilityResignation)],
        ['عدد القواعد المستخدمة', int(v.rulesUsed)],
      ],
    },
    sheets,
    evidenceToSources(sources),
  );
}

function dataQualitySheet(items: ReadonlyArray<DataQualityDetail>): XSheet {
  return {
    name: 'جودة البيانات',
    columns: [
      { header: 'الرمز', width: 30 },
      { header: 'الخطورة', width: 10 },
      { header: 'التنبيهات', kind: 'int' },
      { header: 'الموظفون', kind: 'int' },
      { header: 'الرسالة', width: 70 },
      { header: 'أمثلة', width: 60 },
      { header: 'الشركات', width: 40 },
    ],
    rows: items.map((d) => [d.code, XLSX_SEVERITY_LABELS[d.severity] ?? d.severity, d.count, d.employees, d.message, d.sample.map((s) => s.name).join('، '), d.companies.map((c) => c.name).join('، ')]),
  };
}

// ---------------------------------------------------------------------------
// (a) True cost «الكلفة الحقيقية»
// ---------------------------------------------------------------------------

export interface TrueCostEmployeeDetailView {
  summary: EmployeeSummary;
  months: ReadonlyArray<EmployeeMonth>;
  liabilities: EmployeeLiabilities;
  flags: ReadonlyArray<WfFlag>;
}

export interface TrueCostExportView {
  engineVersion: string;
  startMonth: string;
  horizon: 12 | 24 | 36;
  scenario: Scenario;
  scopeText: string;
  totals: WindowTotals;
  headcount: number;
  series: ReadonlyArray<{ month: string; cost: number; subsidy: number; net: number; headcount: number }>;
  composition: ReadonlyArray<CompositionItem>;
  byCompany: ReadonlyArray<GroupRow>;
  byBranch: ReadonlyArray<GroupRow>;
  byDepartment: ReadonlyArray<GroupRow>;
  /** Every employee of the scope (search / flagged filter applied), in the page's sort order. */
  employees: ReadonlyArray<EmployeeSummary>;
  /** One employee (redacted per viewer): month × line sheets. */
  detail: TrueCostEmployeeDetailView | null;
}

export function buildTrueCostWorkbook(v: TrueCostExportView, sources: ReadonlyArray<RuleEvidence>, ctx: ExportContext): BuiltWorkbook {
  const h = v.horizon;
  const totals: XSheet = {
    name: 'الإجماليات',
    columns: [{ header: 'الفترة', width: 22 }, ...TRIPLE_COLS],
    rows: [
      ['الشهر الأول', ...triple(v.totals.month1)],
      ['12 شهراً', ...triple(v.totals.next12)],
      ['24 شهراً', ...triple(v.totals.next24)],
      ['36 شهراً', ...triple(v.totals.next36)],
    ],
  };
  const sheets: XSheet[] = [totals];
  if (v.detail) sheets.push(...employeeDetailSheets(v.detail, h));
  else {
    sheets.push(
      compositionSheet(v.composition, h),
      groupSheet('حسب الشركة', v.byCompany, h),
      groupSheet('حسب الفرع', v.byBranch, h),
      groupSheet('حسب الإدارة', v.byDepartment, h),
      employeesSheet(v.employees),
    );
  }
  sheets.push(seriesSheet(v.series));
  const d = v.detail?.summary;
  return assembleWorkbook(
    {
      title: d ? `الكلفة الحقيقية — ${d.name}` : 'الكلفة الحقيقية',
      scope: v.scopeText,
      period: `36 شهراً من ${v.startMonth} (الأفق المعروض ${h} شهراً)`,
      engineVersion: v.engineVersion,
      generatedAt: ctx.generatedAt,
      scenario: v.scenario,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['عدد الموظفين (الشهر الأول)', int(v.headcount)],
        ...(d
          ? ([
              ['الرقم الوظيفي', d.employeeNo ?? '—'],
              ['الجنسية', XLSX_NATIONALITY_LABELS[d.nationalityClass] ?? d.nationalityClass],
              ['الشركة / الفرع / الإدارة', [d.companyName ?? 'بلا شركة قانونية', d.branchName, d.departmentName].filter(Boolean).join(' / ')],
              ['نهاية العمل داخل الفترة', d.exitDate ? { v: d.exitDate, kind: 'date' } : 'لا'],
            ] as Array<[string, XCell]>)
          : [['موظفو الملف', int(v.employees.length)] as [string, XCell]]),
      ],
    },
    sheets,
    evidenceToSources(sources),
  );
}

function employeesSheet(rows: ReadonlyArray<EmployeeSummary>): XSheet {
  return {
    name: 'الموظفون',
    columns: [
      { header: 'الرقم الوظيفي', width: 13 },
      { header: 'الاسم', width: 28 },
      { header: 'الجنسية', width: 9 },
      { header: 'الشركة', width: 24 },
      { header: 'الفرع', width: 18 },
      { header: 'الإدارة', width: 18 },
      { header: 'نهاية العمل', kind: 'date' },
      { header: 'الشهر الأول قبل الدعم', kind: 'money' },
      { header: '12 شهراً قبل الدعم', kind: 'money' },
      { header: '12 شهراً بعد الدعم', kind: 'money' },
      { header: '24 شهراً قبل الدعم', kind: 'money' },
      { header: '24 شهراً بعد الدعم', kind: 'money' },
      { header: '36 شهراً قبل الدعم', kind: 'money' },
      { header: '36 شهراً بعد الدعم', kind: 'money' },
      { header: 'شريحة المقابل المالي', width: 22 },
      { header: 'نظام التأمينات', width: 10 },
      { header: 'مكافأة نهاية الخدمة المستحقة', kind: 'money' },
      { header: 'الملاحظات', width: 60 },
    ],
    rows: rows.map((e) => [
      e.employeeNo,
      e.name,
      XLSX_NATIONALITY_LABELS[e.nationalityClass] ?? e.nationalityClass,
      e.companyName,
      e.branchName,
      e.departmentName,
      e.exitDate,
      e.month1.cost,
      e.next12.cost,
      e.next12.net,
      e.next24.cost,
      e.next24.net,
      e.next36.cost,
      e.next36.net,
      e.levyTier ? (XLSX_LEVY_TIER_LABELS[e.levyTier] ?? e.levyTier) : null,
      e.gosiRegime ? (REGIME_LABELS[e.gosiRegime] ?? e.gosiRegime) : null,
      e.eosbLiabilityEmployer,
      e.flags.map((f) => f.message).join('؛ '),
    ]),
  };
}

function employeeDetailSheets(d: TrueCostEmployeeDetailView, horizon: number): XSheet[] {
  const months = d.months.slice(0, horizon);
  const keys: Array<{ key: string; label: string }> = [];
  for (const m of months) for (const l of m.lines) if (!keys.some((k) => k.key === l.key)) keys.push({ key: l.key, label: l.label });
  const pivot: XSheet = {
    name: 'الأشهر × البنود',
    columns: [
      { header: 'الشهر', kind: 'month' },
      { header: 'يعمل', kind: 'bool' },
      { header: 'نسبة أيام الشهر', kind: 'number' },
      { header: 'الأساسي', kind: 'money' },
      ...keys.map((k) => ({ header: k.label, kind: 'money' as const })),
      ...TRIPLE_COLS,
      { header: 'للعلم (خارج الإجمالي)', kind: 'money' },
    ],
    rows: months.map((m) => [
      m.month,
      m.active,
      m.factor,
      m.basicSalary,
      ...keys.map((k) => {
        const ls = m.lines.filter((l) => l.key === k.key);
        return ls.length ? ls.reduce((s, l) => s + l.amount, 0) : null;
      }),
      ...triple(m.totals),
      m.memo,
    ]),
  };
  const lines: XSheet = {
    name: 'تفاصيل البنود',
    columns: [
      { header: 'الشهر', kind: 'month' },
      { header: 'البند', width: 28 },
      { header: 'النوع', width: 22 },
      { header: 'المبلغ', kind: 'money' },
      { header: 'الحساب بالأرقام', width: 60 },
      { header: 'الحالة', kind: 'status' },
      { header: 'ملاحظة', width: 50 },
      { header: 'القواعد', width: 40 },
    ],
    rows: months.flatMap((m) => m.lines.map((l) => [m.month, l.label, LINE_KIND_LABELS[l.kind] ?? l.kind, l.amount, l.basis, l.status, l.note ?? null, l.ruleKeys.join('، ')])),
  };
  const liab = kv(
    [
      ['مكافأة نهاية الخدمة إن أنهى صاحب العمل (بداية الفترة)', money(d.liabilities.eosbEmployerAtStart)],
      ['مكافأة نهاية الخدمة إن استقال (بداية الفترة)', money(d.liabilities.eosbResignationAtStart)],
      ['مكافأة نهاية الخدمة إن أنهى صاحب العمل (نهاية الفترة)', money(d.liabilities.eosbEmployerAtEnd)],
      ['مكافأة نهاية الخدمة إن استقال (نهاية الفترة)', money(d.liabilities.eosbResignationAtEnd)],
      ['الأجر المستخدم', money(d.liabilities.wageAtStart)],
    ],
    'الالتزامات',
  );
  return [pivot, lines, liab, flagsSheet('ملاحظات الموظف', d.flags.map((f) => ({ severity: f.severity, code: f.code, message: f.message })))];
}

// ---------------------------------------------------------------------------
// (b) Exit cost «كلفة الإنهاء والإحلال»
// ---------------------------------------------------------------------------

export type ExitCostExportView = ExitCostResult & {
  employee: { id: string; name: string; employeeNo: string | null; legalCompanyId: string | null };
  reasonMapping: { exitReason: string; terminationReason: string; certain: boolean; note: string | null };
  warnings: ReadonlyArray<string>;
  assumptionEvidence: Record<string, RuleEvidence>;
};

const EXIT_SECTIONS: Array<{ kind: ExitLineKind; title: string; inNet: string; subtotal: string; total: (t: ExitCostResult['totals']) => number }> = [
  { kind: 'PAYABLE', title: 'المستحقات', inNet: 'نعم', subtotal: 'مجموع المستحقات', total: (t) => t.payable },
  { kind: 'OFFSET', title: 'المقاصّة', inNet: 'نعم', subtotal: 'مجموع المقاصّة', total: (t) => t.offsets },
  { kind: 'RISK', title: 'المخاطر (المادة 77)', inNet: 'لا — سيناريو خطر منفصل لا يُجمع', subtotal: 'خطر المادة 77 (خارج أي إجمالي)', total: (t) => t.risk },
  { kind: 'SUNK', title: 'رسوم مدفوعة مقدماً', inNet: 'لا — معلومة', subtotal: 'مجموع الرسوم غير المستهلكة', total: (t) => t.sunkFees },
  { kind: 'REPLACEMENT', title: 'الإحلال', inNet: 'لا — كلفة البديل', subtotal: 'مجموع كلفة الإحلال', total: (t) => t.replacement },
  { kind: 'ONGOING', title: 'الأثر الشهري المستمر', inNet: 'لا — شهرياً', subtotal: 'التغير الشهري في المقابل المالي', total: (t) => t.ongoingMonthlyDelta },
];

export const EXIT_NET_LABEL = 'صافي ما يُدفع للموظف (المستحقات + المقاصّة)';

export function buildExitCostWorkbook(v: ExitCostExportView, sources: ReadonlyArray<RuleEvidence>, ctx: ExportContext): BuiltWorkbook {
  const rows: XCell[][] = [];
  const totalRows: number[] = [];
  const section = (s: (typeof EXIT_SECTIONS)[number]) => {
    const lines = v.lines.filter((l) => l.kind === s.kind);
    if (!lines.length && s.kind !== 'PAYABLE' && s.kind !== 'RISK') return;
    for (const l of lines) rows.push([s.title, l.label, l.amount, l.basis, l.status, s.inNet, l.note ?? null]);
    totalRows.push(rows.length);
    rows.push([s.title, s.subtotal, s.total(v.totals), null, null, s.inNet, null]);
  };
  section(EXIT_SECTIONS[0]);
  section(EXIT_SECTIONS[1]);
  totalRows.push(rows.length);
  rows.push(['الصافي', EXIT_NET_LABEL, v.totals.netToEmployee, null, null, 'هذا هو الإجمالي', null]);
  rows.push([null, null, null, null, null, null, null]);
  for (const s of EXIT_SECTIONS.slice(2)) section(s);
  const main: XSheet = {
    name: 'كلفة الإنهاء',
    columns: [
      { header: 'القسم', width: 20 },
      { header: 'البند', width: 40 },
      { header: 'المبلغ', kind: 'money' },
      { header: 'الحساب بالأرقام', width: 50 },
      { header: 'الحالة', kind: 'status' },
      { header: 'في صافي ما يُدفع؟', width: 30 },
      { header: 'ملاحظة', width: 50 },
    ],
    rows,
    totalRows,
    notes: [
      'خطر المادة 77 (التعويض عن الإنهاء غير المشروع) سيناريو خطر منفصل: لا يُجمع مع المستحقات ولا مع أي إجمالي.',
      'الرسوم المدفوعة مقدماً معلومة لا تُسترد؛ وكلفة الإحلال افتراضات المنشأة؛ والأثر المستمر شهري لبقية الوافدين.',
    ],
  };
  const lm = v.lastMonth;
  const settlement = kv(
    [
      ['المستحق عند التصفية (دون راتب الشهر الأخير)', money(v.settlementScreenTotal)],
      ['أيام الشهر الأخير', int(lm.workingDays)],
      ['راتب أيام الشهر الأخير', money(lm.salary)],
      ['إجمالي التصفية إن لم يُصرف راتب الشهر الأخير', money(lm.settlementTotalIfUnpaid)],
      ['هل غطّى مسير معتمد أو مصروف الشهر الأخير؟', yesNo(lm.paidByPayroll)],
      ...(v.levyImpact
        ? ([
            ['شهر أثر المقابل المالي', { v: v.levyImpact.month, kind: 'month' }],
            ['المقابل المالي الشهري للكيان قبل الخروج', money(v.levyImpact.before.monthlyLevy)],
            ['المقابل المالي الشهري للكيان بعد الخروج', money(v.levyImpact.after.monthlyLevy)],
            ['التغير الشهري للمقابل المالي لبقية الوافدين', money(v.levyImpact.deltaMonthly)],
          ] as Array<[string, XCell]>)
        : []),
    ],
    'التسوية والمقابل المالي',
    ['الإضافي غير المصروف والبنود اليدوية لا تدخل هنا؛ تضيفها شاشة التصفية.'],
  );
  const flags = flagsSheet('التنبيهات', [...v.warnings.map((w) => ({ severity: 'WARNING', code: 'WARNING', message: w })), ...v.flags.map((f) => ({ severity: f.severity, code: f.code, message: f.message }))]);
  return assembleWorkbook(
    {
      title: `كلفة الإنهاء — ${v.employee.name}`,
      scope: `${v.employee.name}${v.employee.employeeNo ? ` (${v.employee.employeeNo})` : ''}`,
      period: `آخر يوم عمل ${v.lastWorkingDate}`,
      engineVersion: v.engineVersion,
      generatedAt: ctx.generatedAt,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['سبب الخروج', exitReasonText(v.reasonInput)],
        ['أساس التسوية المستخدم', exitReasonText(v.reason)],
        ...(v.reasonNote ? ([['ملاحظة المطابقة', v.reasonNote]] as Array<[string, XCell]>) : []),
        ['آخر يوم عمل', { v: v.lastWorkingDate, kind: 'date' }],
        ['سنوات الخدمة', num(v.yearsOfService)],
        ['الأجر المستخدم', money(v.wageUsed)],
        [EXIT_NET_LABEL, money(v.totals.netToEmployee)],
        ['خطر المادة 77 (منفصل، لا يُجمع)', money(v.totals.risk)],
      ],
    },
    [main, settlement, flags],
    evidenceToSources([...Object.values(v.explanations).flatMap((e) => e?.rules ?? []), ...Object.values(v.assumptionEvidence)]),
  );
}

// ---------------------------------------------------------------------------
// (c) Saudization «مخطط السعودة»
// ---------------------------------------------------------------------------

export interface SaudizationExportView {
  date: string;
  canSeeNames: boolean;
  companies: ReadonlyArray<CompanySaudization>;
}

const SOLVER_KIND_LABELS: Record<SolverActionKind, string> = { DOCUMENT: 'توثيق عقد في قوى', RAISE: 'رفع الأجر المسجّل إلى 4,000', HIRE: 'تعيين سعودي', REPLACE: 'إحلال سعودي محل وافد' };
const EST_STATUS_LABELS: Record<string, string> = { OK: 'محسوب', NO_ACTIVITY: 'لم يُحدَّد نشاط نطاقات', NO_EMPLOYEES: 'لا عاملين' };
const SOLVE_STATUS_LABELS: Record<string, string> = { OK: 'خطة للوصول', ALREADY_REACHED: 'النطاق محقق', UNREACHABLE: 'غير قابل للوصول ضمن الحد', NO_ACTIVITY: 'لم يُحدَّد نشاط', NO_EMPLOYEES: 'لا عاملين' };

export function buildSaudizationWorkbook(v: SaudizationExportView, solve: { companyName: string; result: SolveResult } | null, ctx: ExportContext): BuiltWorkbook {
  const est: XSheet = {
    name: 'التقدير',
    columns: [
      { header: 'الشركة', width: 28 },
      { header: 'النشاط', width: 34 },
      { header: 'حالة النشاط', kind: 'status' },
      { header: 'الحالة', width: 18 },
      { header: 'النطاق', width: 14 },
      { header: 'نسبة التوطين', kind: 'pct' },
      { header: 'X (العاملون المحتسبون)', kind: 'int' },
      { header: 'السعوديون الموزونون', kind: 'number' },
      { header: 'الوافدون', kind: 'int' },
      { header: 'السعوديون', kind: 'int' },
      { header: 'الخليجيون', kind: 'int' },
      { header: 'عقود غير موثّقة', kind: 'int' },
      { header: 'سنة الثوابت', kind: 'int' },
      { header: 'النطاق التالي', width: 14 },
      { header: 'نقاط حتى التالي', kind: 'number' },
      { header: 'تعيينات حتى التالي', kind: 'int' },
      { header: 'النطاق الأدنى', width: 14 },
      { header: 'نقاط الأمان', kind: 'number' },
      { header: 'وافدون قبل الهبوط', kind: 'int' },
      { header: 'خروج سعوديين قبل الهبوط', kind: 'int' },
      { header: 'متوسط 26 أسبوعاً', kind: 'pct' },
      { header: 'نطاق المتوسط', width: 14 },
      { header: 'رسالة', width: 50 },
    ],
    rows: v.companies.map((c) => {
      const e = c.estimate;
      return [
        c.companyName,
        e.activity ? `${e.activity.nameAr}${e.activity.code ? ` (${e.activity.code})` : ''}` : null,
        e.activity?.status ?? null,
        EST_STATUS_LABELS[e.status] ?? e.status,
        e.status === 'OK' ? BAND_TEXT(e.band) : null,
        e.status === 'OK' ? e.pct : null,
        e.counts.x,
        e.counts.saudiWeighted,
        e.counts.expats,
        e.counts.saudiPersons,
        e.counts.gccPersons,
        e.counts.undocumented,
        e.curveYear,
        e.margin.up ? BAND_TEXT(e.margin.up.band) : null,
        e.margin.up?.pctGap ?? null,
        e.margin.up?.saudiHires ?? null,
        e.margin.down ? BAND_TEXT(e.margin.down.band) : null,
        e.margin.down?.pctCushion ?? null,
        e.margin.down?.expatsBeforeDrop ?? null,
        e.margin.down?.saudiExitsBeforeDrop ?? null,
        e.average26w?.pct ?? null,
        e.average26w ? BAND_TEXT(e.average26w.band) : null,
        e.message,
      ];
    }),
  };
  const weights: XSheet = {
    name: 'الأوزان',
    columns: [{ header: 'الشركة', width: 28 }, { header: 'الفئة', width: 52 }, { header: 'الأفراد', kind: 'int' }, { header: 'مجموع الوزن', kind: 'number' }],
    rows: v.companies.flatMap((c) => c.estimate.breakdown.map((b) => [c.companyName, b.label, b.persons, b.weight])),
    notes: ctx.canSeeDisability ? [] : ['نسخة مقيّدة: جانب السعوديين سطر واحد (كل الفئات موزونة) دون تفصيل الفئات المرجّحة الخاصة.'],
  };
  const bandCols = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const;
  const thresholds: XSheet = {
    name: 'الحدود حسب السنة',
    columns: [{ header: 'الشركة', width: 28 }, { header: 'السنة', kind: 'int' }, { header: 'النطاق بالعمالة الحالية', width: 18 }, ...bandCols.map((b) => ({ header: `حد ${BAND_LABELS[b]}`, kind: 'pct' as const }))],
    rows: v.companies.flatMap((c) => c.estimate.thresholdsByYear.map((y) => [c.companyName, y.year, BAND_TEXT(y.band), ...bandCols.map((b) => y.thresholds.find((t) => t.band === b)?.y ?? null)])),
    notes: ['الحد الأدنى لكل نطاق Y = m·ln(X) + c بثوابت نشاط الشركة للسنة؛ الكيان بخمسة عمال فأقل أخضر أو أحمر فقط.'],
  };
  const alerts: XSheet = {
    name: 'التنبيهات',
    columns: [{ header: 'الشركة', width: 28 }, { header: 'الخطورة', width: 10 }, { header: 'الرمز', width: 28 }, { header: 'الرسالة', width: 100 }],
    rows: v.companies.flatMap((c) => [
      ...c.alerts.map((a) => [c.companyName, XLSX_SEVERITY_LABELS[a.severity] ?? a.severity, a.code, a.message]),
      ...c.estimate.flags.map((f) => [c.companyName, XLSX_SEVERITY_LABELS[f.severity] ?? f.severity, f.code, f.message]),
      ...c.compliance.flags.map((f) => [c.companyName, XLSX_SEVERITY_LABELS[f.severity] ?? f.severity, f.code, f.message]),
    ]),
  };
  const compliance: XSheet = {
    name: 'قرارات التوطين',
    columns: [
      { header: 'الشركة', width: 26 },
      { header: 'مجموعة المهن', width: 30 },
      { header: 'حالة القرار', width: 16 },
      { header: 'ساري', kind: 'bool' },
      { header: 'ينطبق', kind: 'bool' },
      { header: 'سبب عدم الانطباق', width: 40 },
      { header: 'العاملون في المهن', kind: 'int' },
      { header: 'السعوديون المحتسبون', kind: 'int' },
      { header: 'دون الحد الأدنى للأجر', kind: 'int' },
      { header: 'غير موثّقين', kind: 'int' },
      { header: 'النسبة الحالية', kind: 'pct' },
      { header: 'النسبة المطلوبة', kind: 'pct' },
      { header: 'المطلوب', width: 40 },
      { header: 'ملتزم', kind: 'bool' },
      { header: 'النقص (إحلالاً)', kind: 'int' },
      { header: 'الحد الأدنى للأجر', kind: 'money' },
      { header: 'حجم المنشأة الأدنى', kind: 'int' },
      { header: 'مراحل قادمة', width: 40 },
      { header: 'المصدر', kind: 'url' },
    ],
    rows: v.companies.flatMap((c) =>
      c.compliance.items.map((i) => [
        c.companyName,
        i.groupNameAr,
        i.statusLabel,
        i.inEffect,
        i.applies,
        i.applies ? null : i.appliesReason,
        i.total,
        i.saudisCounted,
        i.saudisBelowMinWage,
        i.saudisUndocumented,
        i.actualPct,
        i.requiredPct,
        i.requiredText,
        i.compliant,
        i.shortfallReplacements,
        i.minWage,
        i.minEstablishmentSize,
        i.upcoming.map((u) => `${u.pct}% من ${u.effectiveFrom}`).join('، ') || null,
        i.sourceUrl,
      ]),
    ),
  };
  const sheets: XSheet[] = [est, weights, thresholds, compliance, alerts];
  const extra: Array<[string, XCell]> = [
    ['تاريخ التقدير', { v: v.date, kind: 'date' }],
    ['عدد الشركات', int(v.companies.length)],
  ];
  const evidence: RuleEvidence[] = v.companies.flatMap((c) => c.estimate.evidence);
  if (solve) {
    const r = solve.result;
    const act = (a: SolveResult['actions'][number], prefix = ''): XCell[] => [a.rank, `${prefix}${SOLVER_KIND_LABELS[a.kind] ?? a.kind}`, a.name, a.count, a.weightGain, a.pctAfter, a.bandAfter ? BAND_TEXT(a.bandAfter) : null, a.monthlyCost, a.monthlyNetAvg, a.oneOffCost, a.note];
    const rows: XCell[][] = r.actions.map((a) => act(a));
    const totalRows = [rows.length];
    rows.push([null, 'مجموع الخطة', null, null, null, r.after?.pct ?? null, r.after ? BAND_TEXT(r.after.band) : null, r.totals.monthlyCost, r.totals.monthlyNetAvg, r.totals.oneOffCost, null]);
    if (r.alternative) {
      rows.push([null, null, null, null, null, null, null, null, null, null, null]);
      for (const a of r.alternative.actions) rows.push(act(a, 'بديل: '));
      totalRows.push(rows.length);
      rows.push([null, 'مجموع البديل (إحلال)', null, r.alternative.replacements, null, r.alternative.after?.pct ?? null, r.alternative.after ? BAND_TEXT(r.alternative.after.band) : null, r.alternative.totals.monthlyCost, r.alternative.totals.monthlyNetAvg, r.alternative.totals.oneOffCost, null]);
    }
    sheets.push({
      name: 'الحل الآلي',
      columns: [
        { header: 'الترتيب', kind: 'int' },
        { header: 'الإجراء', width: 30 },
        { header: 'الموظف', width: 26 },
        { header: 'العدد', kind: 'int' },
        { header: 'أثر الوزن', kind: 'number' },
        { header: 'النسبة بعده', kind: 'pct' },
        { header: 'النطاق بعده', width: 14 },
        { header: 'الكلفة الشهرية (الشهر الأول)', kind: 'money' },
        { header: 'متوسط الكلفة الشهرية بعد الدعم', kind: 'money' },
        { header: 'لمرة واحدة', kind: 'money' },
        { header: 'ملاحظة', width: 60 },
      ],
      rows,
      totalRows,
      notes: [...r.assumptions, ...(ctx.canSeeDisability ? [] : ['نسخة مقيّدة: التوثيق ورفع الأجور سطر واحد لكل منهما دون أسماء ولا أثر وزن لكل فرد.'])],
    });
    extra.push(
      ['الحل الآلي: الشركة', solve.companyName],
      ['الحل الآلي: النطاق المستهدف', BAND_TEXT(r.targetBand)],
      ['الحل الآلي: بحلول', { v: r.byDate, kind: 'date' }],
      ['الحل الآلي: النتيجة', SOLVE_STATUS_LABELS[r.status] ?? r.status],
      ['الحل الآلي: قبل', r.before ? `${r.before.pct}% ${BAND_TEXT(r.before.band)} (X = ${r.before.x})` : '—'],
      ['الحل الآلي: بعد', r.after ? `${r.after.pct}% ${BAND_TEXT(r.after.band)} (X = ${r.after.x})` : '—'],
      ['الحل الآلي: التعيينات', r.hires === null ? 'غير قابل للوصول ضمن الحد' : int(r.hires)],
    );
    evidence.push(...r.evidence);
  }
  const one = v.companies.length === 1 ? v.companies[0].companyName : null;
  return assembleWorkbook(
    {
      title: one ? `مخطط السعودة — ${one}` : 'مخطط السعودة',
      scope: one ?? `كل الشركات القانونية (${v.companies.length})`,
      period: `تقدير لحظي في ${v.date}`,
      engineVersion: ENGINE_VERSION,
      generatedAt: ctx.generatedAt,
      restricted: !ctx.canSeeDisability,
      extra,
      notes: ['قوى تعتمد متوسط 26 أسبوعاً؛ التقدير هنا لحظي ويظهر المتوسط للمقارنة.'],
    },
    sheets,
    evidenceToSources(evidence),
  );
}

// ---------------------------------------------------------------------------
// (d) Hire scenario «سيناريوهات التوظيف» (side by side)
// ---------------------------------------------------------------------------

export interface HireExportView {
  result: HireScenarioResult;
  assumptionEvidence: Record<string, RuleEvidence>;
  horizon: number;
}

export function buildHireScenarioWorkbook(v: HireExportView, ctx: ExportContext): BuiltWorkbook {
  const r = v.result;
  const cands = r.candidates;
  const row = (label: string, f: (c: (typeof cands)[number]) => XCell): XCell[] => [label, ...cands.map(f)];
  const rows: XCell[][] = [row('النوع', (c) => CANDIDATE_KIND_LABELS[c.kind] ?? c.kind)];
  const totalRows: number[] = [];
  for (const w of [12, 24, 36] as const) {
    rows.push(row(`الكلفة قبل الدعم (${w} شهراً)`, (c) => money(c.windows[w].cost)));
    rows.push(row(`دعم هدف (${w} شهراً)`, (c) => money(c.windows[w].subsidy)));
    rows.push(row(`بعد الدعم (${w} شهراً)`, (c) => money(c.windows[w].net)));
    rows.push(row(`أثر المقابل المالي على بقية الوافدين (${w} شهراً)`, (c) => money(c.windows[w].levyOthers)));
    totalRows.push(rows.length);
    rows.push(row(`رقم المقارنة (${w} شهراً)`, (c) => money(c.windows[w].total)));
  }
  rows.push(row('كلفة الشهر الأول', (c) => money(c.firstMonthCost)));
  rows.push(row('المقابل المالي للمرشح (الشهر الأول)', (c) => money(c.levy.ownFirstMonth)));
  rows.push(row('أثر الشريحة على بقية الوافدين (الشهر الأول)', (c) => money(c.levy.othersFirstMonth)));
  rows.push(row('ملاحظة الشريحة', (c) => c.levy.tierNote));
  rows.push(row('النطاق قبل', (c) => (c.nitaqat.status === 'OK' ? BAND_TEXT(c.nitaqat.before.band) : c.nitaqat.message)));
  rows.push(row('النسبة قبل', (c) => pct(c.nitaqat.status === 'OK' ? c.nitaqat.before.pct : null)));
  rows.push(row('النطاق بعد', (c) => (c.nitaqat.status === 'OK' ? BAND_TEXT(c.nitaqat.after.band) : null)));
  rows.push(row('النسبة بعد', (c) => pct(c.nitaqat.status === 'OK' ? c.nitaqat.after.pct : null)));
  rows.push(row('وزن المرشح في نطاقات', (c) => num(c.nitaqat.status === 'OK' ? c.nitaqat.candidateWeight : null)));
  rows.push(row('قرارات التوطين', (c) => c.localizationNote ?? (c.localization.map((l) => `${l.groupNameAr}: ${l.before.pct ?? '—'}% ← ${l.after.pct ?? '—'}% (المطلوب ${l.requiredPct ?? '—'}%)`).join('؛ ') || null)));
  rows.push(row('الطاقة (العمل الإضافي)', (c) => c.capacity?.note ?? null));
  rows.push(row('ملاحظات', (c) => c.notes.join(' ')));
  const side: XSheet = { name: 'المقارنة', columns: [{ header: 'البند', width: 46 }, ...cands.map((c) => ({ header: c.label, width: 26 }))], rows, totalRows, notes: ['رقم المقارنة = بعد دعم هدف + أثر المقابل المالي على بقية الوافدين.'] };
  const lines: XSheet = {
    name: 'بنود المرشحين',
    columns: [
      { header: 'المرشح', width: 24 },
      { header: 'البند', width: 34 },
      { header: 'النوع', width: 22 },
      { header: '12 شهراً', kind: 'money' },
      { header: '24 شهراً', kind: 'money' },
      { header: '36 شهراً', kind: 'money' },
      { header: 'الحساب (الشهر الأول)', width: 60 },
      { header: 'الحالة', kind: 'status' },
      { header: 'ملاحظة', width: 50 },
    ],
    rows: cands.flatMap((c) => c.lines.map((l) => [c.label, l.label, LINE_KIND_LABELS[l.kind] ?? l.kind, l.w12, l.w24, l.w36, l.basis, l.status, l.note ?? null])),
  };
  const flags = flagsSheet(
    'التنبيهات',
    cands.flatMap((c) => c.flags.map((f) => ({ severity: f.severity, code: f.code, message: f.message, subject: c.label }))),
    'المرشح',
  );
  const evidence: RuleEvidence[] = [...cands.flatMap((c) => Object.values(c.explanations).flatMap((e) => e?.rules ?? [])), ...Object.values(v.assumptionEvidence)];
  return assembleWorkbook(
    {
      title: `سيناريو توظيف — ${r.company.name}`,
      scope: r.company.name,
      period: `36 شهراً من ${r.startMonth} (الأفق المعروض ${v.horizon} شهراً)`,
      engineVersion: r.engineVersion,
      generatedAt: ctx.generatedAt,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['النطاق الحالي', r.nitaqatBefore.status === 'OK' ? `${BAND_TEXT(r.nitaqatBefore.band)} (${r.nitaqatBefore.pct}%، X = ${r.nitaqatBefore.x})` : (r.nitaqatBefore.message ?? '—')],
        ['عدد البدائل', int(cands.length)],
      ],
      notes: r.assumptions,
    },
    [side, lines, flags],
    evidenceToSources(evidence),
  );
}

// ---------------------------------------------------------------------------
// (e) Workforce plan «خطة القوى العاملة»
// ---------------------------------------------------------------------------

export interface PlanExportView {
  plan: {
    name: string;
    statusLabel: string;
    companyName: string | null;
    fromMonth: string | null;
    months: number;
    attritionPct: number | null;
    createdByName: string | null;
    decisionLabel: string | null;
    decidedByName: string | null;
    decidedAt: string | null;
    notes: string | null;
  };
  positions: ReadonlyArray<{
    id: string;
    kindLabel: string;
    title: string;
    companyId: string | null;
    branchId: string | null;
    departmentId: string | null;
    nationalityClass: string | null;
    basicSalary: number | null;
    housingAllowance: number | null;
    otherAllowances: number | null;
    dependentsCount: number | null;
    medicalClass: string | null;
    startMonth: string | null;
    exitEmployeeId: string | null;
    exitMonth: string | null;
    exitReason: string | null;
    notes: string | null;
  }>;
  raises: ReadonlyArray<{ id: string; scopeLabel: string; scope: string; scopeId: string | null; pct: number | null; amount: number | null; effectiveMonth: string | null; notes: string | null }>;
  names: { employees: Record<string, string>; branches: Record<string, string>; departments: Record<string, string>; companies: Record<string, string> };
  projection: Omit<PlanProjection, 'people'>;
  frozen: { snapshotId: string; createdAt: string } | null;
  actual: { result: PlanVsActualResult; warning: string | null } | null;
}

const WINDOW_LABELS: Record<PlanWindowKey, string> = { '12': '12 شهراً', '24': '24 شهراً', '36': '36 شهراً', horizon: 'المدة كاملة' };

export function buildPlanWorkbook(v: PlanExportView, ctx: ExportContext): BuiltWorkbook {
  const p = v.projection;
  const n = v.names;
  const windowKeys = (Object.keys(p.totals) as PlanWindowKey[]).sort((a, b) => (a === 'horizon' ? 1 : b === 'horizon' ? -1 : Number(a) - Number(b)));
  const totals: XSheet = {
    name: 'الإجماليات',
    columns: [
      { header: 'الفترة', width: 16 },
      ...TRIPLE_COLS,
      { header: 'المقابل المالي', kind: 'money' },
      { header: 'تكاليف الخروج لمرة واحدة', kind: 'money' },
      { header: 'استرداد مخصص نهاية الخدمة', kind: 'money' },
      { header: 'الدوران (بعد الدعم)', kind: 'money' },
      { header: 'الإجمالي قبل الدعم', kind: 'money' },
      { header: 'الإجمالي بعد الدعم', kind: 'money' },
      { header: 'القوى الحالية دون الخطة', kind: 'money' },
      { header: 'ما تضيفه الخطة', kind: 'money' },
    ],
    rows: windowKeys.map((k) => {
      const w = p.totals[k]!;
      return [WINDOW_LABELS[k], ...triple(w), w.levy, w.exitOneOff, w.exitAccrualRelease, w.attrition.net, w.totalBeforeHrdf, w.totalAfterHrdf, w.baseline.net, w.deltaAfterHrdf];
    }),
    notes: ['خطر المادة 77 لبنود الخروج يظهر في «البنود» ولا يدخل أي إجمالي.'],
  };
  const items = new Map(p.items.map((i) => [i.positionId, i]));
  const positions: XSheet = {
    name: 'البنود',
    columns: [
      { header: 'النوع', width: 14 },
      { header: 'العنوان', width: 26 },
      { header: 'الشركة', width: 22 },
      { header: 'الفرع', width: 16 },
      { header: 'الإدارة', width: 16 },
      { header: 'الجنسية', width: 9 },
      { header: 'الأساسي', kind: 'money' },
      { header: 'بدل السكن', kind: 'money' },
      { header: 'بدلات أخرى', kind: 'money' },
      { header: 'المرافقون', kind: 'int' },
      { header: 'فئة التأمين', width: 9 },
      { header: 'شهر البداية', kind: 'month' },
      { header: 'البداية الفعلية', kind: 'month' },
      { header: 'الموظف المغادر', width: 24 },
      { header: 'شهر الخروج', kind: 'month' },
      { header: 'سبب الخروج', width: 20 },
      { header: 'محسوب', kind: 'bool' },
      { header: 'كلفة الشهر الأول', kind: 'money' },
      { header: 'أثر البند للمدة (بعد الدعم)', kind: 'money' },
      { header: 'مستحقات الخروج', kind: 'money' },
      { header: 'خطر المادة 77 (خارج الإجمالي)', kind: 'money' },
      { header: 'ملاحظات', width: 50 },
    ],
    rows: v.positions.map((x) => {
      const it = items.get(x.id);
      return [
        x.kindLabel,
        x.title,
        x.companyId ? (n.companies[x.companyId] ?? x.companyId) : null,
        x.branchId ? (n.branches[x.branchId] ?? x.branchId) : null,
        x.departmentId ? (n.departments[x.departmentId] ?? x.departmentId) : null,
        x.nationalityClass ? (PLAN_NATIONALITY_LABELS[x.nationalityClass as keyof typeof PLAN_NATIONALITY_LABELS] ?? x.nationalityClass) : null,
        x.basicSalary,
        x.housingAllowance,
        x.otherAllowances,
        x.dependentsCount,
        x.medicalClass,
        x.startMonth,
        it?.start ?? null,
        x.exitEmployeeId ? (n.employees[x.exitEmployeeId] ?? it?.employeeName ?? x.exitEmployeeId) : null,
        x.exitMonth,
        x.exitReason ? (PLAN_EXIT_REASON_LABELS[x.exitReason as keyof typeof PLAN_EXIT_REASON_LABELS] ?? x.exitReason) : null,
        it?.computed ?? false,
        it?.firstMonthCost ?? null,
        it?.windows.horizon?.net ?? null,
        it?.exitCost?.payable ?? null,
        it?.exitCost?.risk ?? null,
        [x.notes, ...(it?.flags.map((f) => f.message) ?? [])].filter(Boolean).join('؛ ') || null,
      ];
    }),
  };
  const raises: XSheet = {
    name: 'الزيادات',
    columns: [
      { header: 'النطاق', width: 16 },
      { header: 'المعني', width: 26 },
      { header: 'النسبة', kind: 'pct' },
      { header: 'المبلغ', kind: 'money' },
      { header: 'شهر السريان', kind: 'month' },
      { header: 'المشمولون', kind: 'int' },
      { header: 'زيادة الأساسي الشهرية', kind: 'money' },
      { header: 'زيادة الأساسي للمدة', kind: 'money' },
      { header: 'ملاحظات', width: 40 },
    ],
    rows: v.raises.map((r) => {
      const res = p.raises.find((x) => x.raiseId === r.id);
      const who = r.scope === 'EMPLOYEE' ? n.employees[r.scopeId ?? ''] : r.scope === 'DEPARTMENT' ? n.departments[r.scopeId ?? ''] : r.scope === 'COMPANY' ? n.companies[r.scopeId ?? ''] : 'كل موظفي الخطة';
      return [r.scopeLabel, who ?? r.scopeId, r.pct, r.amount, r.effectiveMonth, res?.employees ?? null, res?.basicDeltaMonthly ?? null, res?.basicDeltaTotal ?? null, [r.notes, ...(res?.flags.map((f) => f.message) ?? [])].filter(Boolean).join('؛ ') || null];
    }),
  };
  const monthly: XSheet = {
    name: 'التوقع الشهري',
    columns: [
      { header: 'الشهر', kind: 'month' },
      { header: 'العدد', kind: 'int' },
      { header: 'سعوديون', kind: 'int' },
      { header: 'خليجيون', kind: 'int' },
      { header: 'وافدون', kind: 'int' },
      { header: 'تعيينات', kind: 'int' },
      { header: 'خروج مخطط', kind: 'int' },
      { header: 'مغادرون متوقعون (إحصائي)', kind: 'number' },
      ...TRIPLE_COLS,
      { header: 'المقابل المالي', kind: 'money' },
      { header: 'لمرة واحدة', kind: 'money' },
      { header: 'الاسترداد', kind: 'money' },
      { header: 'الدوران', kind: 'money' },
      { header: 'الإجمالي قبل الدعم', kind: 'money' },
      { header: 'الإجمالي بعد الدعم', kind: 'money' },
      { header: 'دون الخطة (بعد الدعم)', kind: 'money' },
      { header: 'العدد دون الخطة', kind: 'int' },
    ],
    rows: p.series.map((m) => [
      m.month,
      m.headcount.total,
      m.headcount.saudi,
      m.headcount.gcc,
      m.headcount.expat,
      m.headcount.hires,
      m.headcount.plannedExits,
      m.expectedLeavers,
      ...triple(m),
      m.levy,
      m.exitOneOff,
      m.exitAccrualRelease,
      m.attrition.net,
      m.totalBeforeHrdf,
      m.totalAfterHrdf,
      m.baseline.net,
      m.baseline.headcount,
    ]),
  };
  const nitaqat: XSheet = {
    name: 'نطاقات نهاية السنة',
    columns: [
      { header: 'الشركة', width: 26 },
      { header: 'سنة الخطة', kind: 'int' },
      { header: 'التاريخ', kind: 'date' },
      { header: 'النطاق بالخطة', width: 14 },
      { header: 'النسبة بالخطة', kind: 'pct' },
      { header: 'النطاق دون الخطة', width: 14 },
      { header: 'النسبة دون الخطة', kind: 'pct' },
      { header: 'التغير', width: 10 },
      { header: 'المقابل المالي الشهري بالخطة', kind: 'money' },
      { header: 'المقابل المالي الشهري دون الخطة', kind: 'money' },
    ],
    rows: p.companies.flatMap((c) =>
      c.years.map((y) => [
        c.name,
        y.yearIndex,
        y.date,
        y.nitaqat ? (y.nitaqat.plan.status === 'OK' ? BAND_TEXT(y.nitaqat.plan.band) : y.nitaqat.plan.message) : 'غير مقدّر',
        y.nitaqat?.plan.status === 'OK' ? y.nitaqat.plan.pct : null,
        y.nitaqat ? (y.nitaqat.baseline.status === 'OK' ? BAND_TEXT(y.nitaqat.baseline.band) : y.nitaqat.baseline.message) : null,
        y.nitaqat?.baseline.status === 'OK' ? y.nitaqat.baseline.pct : null,
        y.nitaqat?.change === 'UP' ? 'صعود' : y.nitaqat?.change === 'DOWN' ? 'هبوط' : y.nitaqat?.change === 'SAME' ? 'دون تغيير' : null,
        y.levy.plan.levyTotal,
        y.levy.baseline.levyTotal,
      ]),
    ),
  };
  const sheets: XSheet[] = [totals, positions, raises, monthly, nitaqat];
  if (v.actual) {
    const a = v.actual.result;
    const rows: XCell[][] = a.months.map((m) => [m.month, m.planned, m.actual, m.variance, m.variancePct, m.plannedHeadcount, m.actualHeadcount, m.partial]);
    const totalRows = [rows.length];
    rows.push(['التراكمي', a.cumulative.planned, a.cumulative.actual, a.cumulative.variance, a.cumulative.variancePct, null, null, a.cumulative.partial]);
    sheets.push({
      name: 'المخطط مقابل الفعلي',
      columns: [
        { header: 'الشهر', kind: 'month' },
        { header: 'المخطط', kind: 'money' },
        { header: 'الفعلي', kind: 'money' },
        { header: 'الفرق', kind: 'money' },
        { header: 'نسبة الفرق', kind: 'pct' },
        { header: 'العدد المخطط', kind: 'int' },
        { header: 'أسطر المسير', kind: 'int' },
        { header: 'شهر جزئي', kind: 'bool' },
      ],
      rows,
      totalRows,
      notes: [...(v.actual.warning ? [v.actual.warning] : []), ...(a.monthsWithoutPayroll.length ? [`أشهر بلا مسير معتمد (غير مقارنة): ${a.monthsWithoutPayroll.join('، ')}`] : []), ...a.explanations],
    });
    const drows: XCell[][] = a.drivers.map((d) => [d.label, d.amount, d.count, d.people.map((x) => `${x.name} (${x.amount})`).join('، ') || null]);
    const dTotal = [drows.length];
    drows.push(['المجموع = الفرق التراكمي', a.cumulative.variance, null, null]);
    sheets.push({
      name: 'أسباب الفرق',
      columns: [{ header: 'السبب', width: 44 }, { header: 'المبلغ', kind: 'money' }, { header: 'العدد', kind: 'int' }, { header: 'أبرز الأسماء', width: 80 }],
      rows: drows,
      totalRows: dTotal,
    });
  }
  sheets.push(flagsSheet('التنبيهات', [...p.flags.map((f) => ({ severity: f.severity, code: f.code, message: f.message })), ...p.engineFlags.map((f) => ({ severity: f.severity, code: f.code, message: `${f.message ?? f.code} (${f.count})` }))]));
  const evidence: RuleEvidence[] = Object.values(p.explanations).flatMap((e) => e.rules ?? []);
  const pl = v.plan;
  return assembleWorkbook(
    {
      title: `خطة القوى العاملة — ${pl.name}`,
      scope: pl.companyName ?? 'كل الشركات',
      period: `${pl.months} شهراً من ${pl.fromMonth ?? p.fromMonth}`,
      engineVersion: `${p.engineVersion} / ${p.planEngineVersion}`,
      generatedAt: ctx.generatedAt,
      scenario: p.scenario,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['الحالة', pl.statusLabel],
        ['أنشأها', pl.createdByName ?? '—'],
        ...(pl.decidedAt ? ([[`${pl.decisionLabel ?? 'القرار'}`, `${pl.decidedByName ?? '—'} (${pl.decidedAt.slice(0, 10)})`]] as Array<[string, XCell]>) : []),
        ['الدوران', p.attrition.basis],
        ['التوقع المعروض', v.frozen ? `مجمّد عند الاعتماد (${v.frozen.createdAt.slice(0, 10)})` : 'معاد حسابه بالبيانات الحالية'],
        ['الموظفون في النطاق', int(p.scope.employees)],
        ...(pl.notes ? ([['ملاحظات', pl.notes]] as Array<[string, XCell]>) : []),
      ],
      notes: p.assumptions,
    },
    sheets,
    evidenceToSources(evidence),
  );
}

// ---------------------------------------------------------------------------
// (f) Internal benchmarks «المؤشرات الداخلية» (suppression = text, never numbers)
// ---------------------------------------------------------------------------

export type BenchmarksExportView = BenchmarksResult & {
  scope: { companyId: string | null; branchId: string | null; departmentId: string | null; companyName: string | null; branchName: string | null; departmentName: string | null };
  notes: ReadonlyArray<string>;
};

const UNIT_KIND: Record<BmUnit, ColKind> = { PERCENT: 'pct', SAR: 'money', DAYS: 'number', YEARS: 'number', HOURS: 'number', COUNT: 'number' };
const BM_UNIT_TEXT: Record<BmUnit, string> = { PERCENT: '%', SAR: 'ريال', DAYS: 'يوم', YEARS: 'سنة', HOURS: 'ساعة', COUNT: 'عدد' };
export const SUPPRESSED_MONTH_TEXT = 'محجوب (مجموعة أقل من 5)';

export function buildBenchmarksWorkbook(v: BenchmarksExportView, ctx: ExportContext): BuiltWorkbook {
  const groups: Array<[string, BenchmarkMetric]> = [
    ['الدوران', v.turnover.overall],
    ['الدوران', v.turnover.voluntary],
    ['الدوران', v.turnover.involuntary],
    ['الدوران', v.turnover.unknownType],
    ['مدة الخدمة', v.tenure.active],
    ['مدة الخدمة', v.tenure.leavers],
    ['خروج المعيَّنين الجدد', v.newHireAttrition.m3],
    ['خروج المعيَّنين الجدد', v.newHireAttrition.m6],
    ['مدة التوظيف', v.timeToHire],
    ['العمل الإضافي', v.overtime.hours],
    ['العمل الإضافي', v.overtime.cost],
    ['العمل الإضافي', v.overtime.hoursPerEmployeePerMonth],
    ['الغياب', v.absence.rate],
    ['الغياب', v.absence.sickDaysPerEmployee],
    ['نهاية الخدمة', v.endOfService.paidPerExit],
    ['نهاية الخدمة', v.endOfService.paidVsAccrued],
    ['الرسوم الحكومية', v.govFees.perExpatPerYear],
    ['كلفة الموظف', v.costPerEmployee.perMonth],
    ['كلفة الدوران', v.turnoverCost.total],
    ['كلفة الدوران', v.turnoverCost.perExit],
  ];
  const metrics: XSheet = {
    name: 'المؤشرات',
    columns: [
      { header: 'المجموعة', width: 18 },
      { header: 'المؤشر', width: 40 },
      { header: 'القيمة', width: 16 },
      { header: 'الوحدة', width: 8 },
      { header: 'البسط', kind: 'number' },
      { header: 'وصف البسط', width: 34 },
      { header: 'المقام', kind: 'number' },
      { header: 'وصف المقام', width: 34 },
      { header: 'من', kind: 'date' },
      { header: 'إلى', kind: 'date' },
      { header: 'المعادلة («كيف حُسب؟»)', width: 70 },
      { header: 'تقريبي', kind: 'bool' },
      { header: 'سبب عدم العرض', width: 50 },
      { header: 'ملاحظات جودة البيانات', width: 60 },
      { header: 'قيم إضافية', width: 40 },
    ],
    rows: groups.map(([g, m]) => {
      const shown = m.value !== null;
      return [
        g,
        m.label,
        shown ? ({ v: m.value, kind: UNIT_KIND[m.unit] } as TypedCell) : (m.reason ?? INSUFFICIENT_DATA),
        BM_UNIT_TEXT[m.unit],
        shown ? m.numerator : null,
        m.numeratorLabel,
        shown ? m.denominator : null,
        m.denominatorLabel,
        m.period.from,
        m.period.to,
        m.formula,
        m.approximate,
        shown ? null : m.reason,
        m.dataQuality.join('؛ ') || null,
        shown && m.extra ? Object.entries(m.extra).filter(([, x]) => x !== null).map(([k, x]) => `${k}: ${x}`).join('، ') || null : null,
      ];
    }),
  };
  const bd = (title: string, rows: ReadonlyArray<BreakdownRow>, unit: BmUnit): XCell[][] =>
    rows.map((r) => [title, r.label, r.suppressed ? (r.suppressedText ?? COMPLEMENTARY_SUPPRESSED_TEXT) : int(r.size), r.suppressed ? (r.suppressedText ?? COMPLEMENTARY_SUPPRESSED_TEXT) : ({ v: r.value, kind: UNIT_KIND[unit] } as TypedCell), r.suppressed ? null : num(r.numerator), r.suppressed ? null : num(r.denominator)]);
  const breakdowns: XSheet = {
    name: 'التقسيمات',
    columns: [{ header: 'التقسيم', width: 30 }, { header: 'المجموعة', width: 28 }, { header: 'الحجم', width: 22 }, { header: 'القيمة', width: 22 }, { header: 'البسط', kind: 'number' }, { header: 'المقام', kind: 'number' }],
    rows: [
      ...bd('الدوران حسب الجنسية', v.turnover.byNationality, 'PERCENT'),
      ...bd('الدوران حسب الإدارة', v.turnover.byDepartment, 'PERCENT'),
      ...bd('الدوران حسب مدة الخدمة', v.turnover.byTenure, 'PERCENT'),
      ...bd('الإضافي حسب الإدارة', v.overtime.byDepartment, 'SAR'),
      ...bd('الغياب حسب الإدارة', v.absence.byDepartment, 'PERCENT'),
      ...bd('الإجازة المرضية حسب الإدارة', v.absence.sickByDepartment, 'DAYS'),
      ...bd('كلفة الموظف حسب الإدارة', v.costPerEmployee.byDepartment, 'SAR'),
    ],
    notes: ['أي مجموعة أقل من 5 أشخاص تُحجب «أقل من 5» بلا عدد ولا قيمة، ويُحجب معها ما يكشفها بالطرح.'],
  };
  const sp = (title: string, pts: ReadonlyArray<SeriesPoint>, unit: BmUnit): XCell[][] =>
    pts.map((x) => [title, x.month, x.suppressed ? SUPPRESSED_MONTH_TEXT : ({ v: x.value, kind: UNIT_KIND[unit] } as TypedCell), x.suppressed ? null : num(x.numerator), x.suppressed ? null : num(x.denominator)]);
  const series: XSheet = {
    name: 'السلاسل الشهرية',
    columns: [{ header: 'السلسلة', width: 28 }, { header: 'الشهر', kind: 'month' }, { header: 'القيمة', width: 24 }, { header: 'البسط', kind: 'number' }, { header: 'المقام', kind: 'number' }],
    rows: [
      ...sp('الدوران الشهري', v.turnover.series, 'PERCENT'),
      ...v.overtime.series.map((x) => ['ساعات الإضافي', x.month, x.suppressed ? SUPPRESSED_MONTH_TEXT : num(x.hours), null, null] as XCell[]),
      ...v.overtime.series.map((x) => ['كلفة الإضافي', x.month, x.suppressed ? SUPPRESSED_MONTH_TEXT : money(x.cost), null, null] as XCell[]),
      ...sp('الغياب الشهري', v.absence.series, 'PERCENT'),
      ...sp('كلفة الموظف الشهرية', v.costPerEmployee.series, 'SAR'),
    ],
  };
  const s = v.scope;
  const scope = [s.companyName, s.branchName, s.departmentName].filter(Boolean).join(' / ') || 'كل المنشأة';
  return assembleWorkbook(
    {
      title: 'المؤشرات الداخلية',
      scope,
      period: `${v.period.months} شهراً: من ${v.period.from} إلى ${v.period.to}`,
      engineVersion: ENGINE_VERSION,
      generatedAt: ctx.generatedAt,
      restricted: !ctx.canSeeDisability,
      extra: v.scopeSuppressed
        ? [['المؤشرات', v.turnover.overall.reason ?? 'النطاق محجوب لحماية مجموعة صغيرة']]
        : [
            ['العدد في بداية الفترة', int(v.headcount.start)],
            ['العدد في نهايتها', int(v.headcount.end)],
            ['متوسط العدد', num(v.headcount.average)],
          ],
      notes: ['كل قيمة من سجلات المنشأة في رديف فقط، بلا رقم مرجعي خارجي. تُعرض مجمّعة بلا أسماء.', ...v.notes],
    },
    [metrics, breakdowns, series],
    [{ key: 'RADEEF_DATA', label: v.source, value: null, unit: null, effectiveFrom: null, status: 'DERIVED', sourceUrl: null, note: 'المسيرات المعتمدة والمصروفة، والحضور، والإجازات، والتصفيات المدفوعة، وطلبات التوظيف، وأوامر الدفع' }],
  );
}

// ---------------------------------------------------------------------------
// (g) Rules register «سجل القواعد والأدلة» (+ Nitaqat curves + localization decisions)
// ---------------------------------------------------------------------------

export interface RulesExportView {
  today: string;
  domains: ReadonlyArray<RuleDomainView>;
  activities: ReadonlyArray<{ key: string; nameAr: string; code?: string | null; sizeSegment?: string | null; status: string; sourceUrl?: string | null; page?: number | null; notes?: string | null; curves: ReadonlyArray<{ band: string; year: number; m: number; c: number; status: string; page: number | null; sourceUrl: string | null; note: string | null }> }>;
  decisions: ReadonlyArray<ParsedDecision & { current: boolean; createdAt: string }>;
}

const STATE_LABELS: Record<string, string> = { CURRENT: 'سارٍ', FUTURE: 'قادم', SUPERSEDED: 'سابق' };

export function buildRulesWorkbook(v: RulesExportView, ctx: ExportContext): BuiltWorkbook {
  const versions = v.domains.flatMap((d) => d.keys.flatMap((k) => k.versions));
  const rules: XSheet = {
    name: 'القواعد',
    columns: [
      { header: 'المجال', width: 18 },
      { header: 'المفتاح', width: 34 },
      { header: 'البند', width: 46 },
      { header: 'القيمة', kind: 'number' },
      { header: 'القيمة المركّبة', width: 30 },
      { header: 'الوحدة', width: 12 },
      { header: 'يسري من', kind: 'date' },
      { header: 'يسري إلى', kind: 'date' },
      { header: 'الحالة', kind: 'status' },
      { header: 'السريان', width: 9 },
      { header: 'رابط المصدر', kind: 'url' },
      { header: 'الاقتباس', width: 60 },
      { header: 'ملاحظات', width: 50 },
      { header: 'الجدول', width: 14 },
    ],
    rows: versions.map((r) => [
      XLSX_DOMAIN_LABELS[r.domain] ?? r.domain,
      r.key,
      r.label,
      r.value,
      r.valueJson,
      r.unit ? (XLSX_UNIT_LABELS[r.unit] ?? r.unit) : null,
      r.effectiveFrom,
      r.effectiveTo,
      r.status,
      STATE_LABELS[r.state] ?? r.state,
      r.sourceUrl,
      r.sourceQuote,
      r.notes,
      r.origin === 'GOSI_RATE' ? 'نسب التأمينات' : 'سجل القواعد',
    ]),
  };
  const curves: XSheet = {
    name: 'ثوابت نطاقات',
    columns: [
      { header: 'النشاط', width: 40 },
      { header: 'الرمز', width: 8 },
      { header: 'شريحة الحجم', width: 16 },
      { header: 'حالة النشاط', kind: 'status' },
      { header: 'النطاق', width: 14 },
      { header: 'السنة', kind: 'int' },
      { header: 'm', kind: 'number' },
      { header: 'c', kind: 'number' },
      { header: 'الحالة', kind: 'status' },
      { header: 'الصفحة', kind: 'int' },
      { header: 'رابط المصدر', kind: 'url' },
      { header: 'ملاحظة', width: 40 },
    ],
    rows: v.activities.flatMap((a) =>
      a.curves.length
        ? a.curves.map((c) => [a.nameAr, a.code ?? null, a.sizeSegment ?? null, a.status, BAND_TEXT(c.band), c.year, c.m, c.c, c.status, c.page, c.sourceUrl ?? a.sourceUrl ?? null, c.note])
        : [[a.nameAr, a.code ?? null, a.sizeSegment ?? null, a.status, null, null, null, null, null, a.page ?? null, a.sourceUrl ?? null, a.notes ?? null]],
    ),
  };
  const decisions: XSheet = {
    name: 'قرارات التوطين',
    columns: [
      { header: 'مجموعة المهن', width: 30 },
      { header: 'الساري في الحساب', kind: 'bool' },
      { header: 'الحالة', width: 16 },
      { header: 'المهن', width: 50 },
      { header: 'المراحل', width: 50 },
      { header: 'الحد الأدنى للمنشأة', kind: 'int' },
      { header: 'الحد الأدنى للأجر', kind: 'money' },
      { header: 'رقم القرار', width: 14 },
      { header: 'تاريخ القرار', kind: 'date' },
      { header: 'رابط المصدر', kind: 'url' },
      { header: 'الصفحة', kind: 'int' },
      { header: 'ملاحظات', width: 50 },
      { header: 'أُضيف في', kind: 'date' },
    ],
    rows: v.decisions.map((d) => [
      d.groupNameAr,
      d.current,
      DECISION_STATUS_LABELS[(d.status ?? '').toUpperCase()] ?? d.status,
      d.occupations.join('، '),
      d.phases.map((p) => `${p.pct}% من ${p.effectiveFrom}${p.activity ? ` (${p.activity})` : ''}`).join('؛ '),
      d.minEstablishmentSize,
      d.minWage,
      d.decisionNo,
      d.decisionDate,
      d.sourceUrl,
      d.page,
      [d.notes, d.parseError].filter(Boolean).join('؛ ') || null,
      d.createdAt,
    ]),
  };
  const sources: SourceRow[] = versions
    .map((r) => ({ key: r.key, label: r.label, value: r.value, unit: r.unit, effectiveFrom: r.effectiveFrom, status: r.status, sourceUrl: r.sourceUrl, note: r.sourceQuote ?? r.notes }))
    .sort((a, b) => a.key.localeCompare(b.key) || (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''));
  return assembleWorkbook(
    {
      title: 'سجل القواعد والأدلة',
      scope: 'كل القواعد النظامية ونسب التأمينات وثوابت نطاقات وقرارات التوطين',
      period: `السريان في ${v.today}`,
      engineVersion: ENGINE_VERSION,
      generatedAt: ctx.generatedAt,
      extra: [
        ['إصدارات القواعد', int(versions.length)],
        ['أنشطة نطاقات', int(v.activities.length)],
        ['قرارات التوطين (بالتاريخ)', int(v.decisions.length)],
      ],
      notes: ['السجل لا يُعدَّل: التصحيح إصدار أو صف جديد، ويبقى القديم للتاريخ.'],
    },
    [rules, curves, decisions],
    sources,
  );
}

// ---------------------------------------------------------------------------
// (h) Saved calculation snapshot «الحسابات المحفوظة»
// ---------------------------------------------------------------------------

export interface CalculationExportView {
  id: string;
  kind: string;
  subjectType: string | null;
  subjectId: string | null;
  title: string | null;
  engineVersion: string;
  createdAt: string;
  createdByName: string | null;
  ruleVersions: ReadonlyArray<RuleVersionRef> | null;
  inputs: unknown;
  outputs: unknown;
}

export const CALC_KIND_LABELS: Record<string, string> = { TRUE_COST: 'الكلفة الحقيقية', EXIT_COST: 'كلفة الإنهاء', OVERVIEW: 'لوحة القرار', SAUDIZATION: 'مخطط السعودة', HIRE_SCENARIO: 'سيناريو توظيف', WORKFORCE_PLAN: 'خطة القوى العاملة' };
const MAX_FLAT_ROWS = 20_000;

/** JSON -> [path, scalar] rows (numbers stay numbers), at most `max` rows. */
export function flattenJson(value: unknown, max = MAX_FLAT_ROWS): { rows: Array<[string, Scalar]>; truncated: boolean } {
  const rows: Array<[string, Scalar]> = [];
  let truncated = false;
  const walk = (v: unknown, path: string) => {
    if (rows.length >= max) {
      truncated = true;
      return;
    }
    if (v === null || v === undefined) rows.push([path, null]);
    else if (Array.isArray(v)) {
      if (!v.length) rows.push([path, '[]']);
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (typeof v === 'object') {
      const keys = Object.keys(v as object);
      if (!keys.length) rows.push([path, '{}']);
      for (const k of keys) walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    } else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') rows.push([path, v]);
    else rows.push([path, String(v)]);
  };
  walk(value, '');
  return { rows, truncated };
}

function keyOutputs(kind: string, o: Record<string, unknown>): Array<[string, XCell]> {
  const t = (x: unknown) => (x && typeof x === 'object' ? (x as MoneyTriple) : null);
  const out: Array<[string, XCell]> = [];
  if (kind === 'EXIT_COST') {
    const tt = (o.totals ?? {}) as Record<string, number>;
    out.push(['المستحقات', money(tt.payable)], ['المقاصّة', money(tt.offsets)], [EXIT_NET_LABEL, money(tt.netToEmployee)], ['خطر المادة 77 (منفصل، لا يُجمع)', money(tt.risk)], ['كلفة الإحلال', money(tt.replacement)]);
  } else if (kind === 'SAUDIZATION') {
    const e = (o.estimate ?? {}) as { band?: string; pct?: number; counts?: { x?: number } };
    out.push(['النطاق التقديري', BAND_TEXT(e.band)], ['نسبة التوطين', pct(e.pct)], ['X', int(e.counts?.x)]);
  } else if (kind === 'HIRE_SCENARIO') {
    for (const c of (o.candidates ?? []) as Array<{ label: string; windows?: Record<string, { total: number }> }>) out.push([`${c.label}: رقم المقارنة 12 شهراً`, money(c.windows?.['12']?.total)], [`${c.label}: 36 شهراً`, money(c.windows?.['36']?.total)]);
  } else if (kind === 'WORKFORCE_PLAN') {
    const tt = (o.totals ?? {}) as Record<string, { totalBeforeHrdf: number; totalAfterHrdf: number; deltaAfterHrdf: number }>;
    for (const k of ['12', '24', '36', 'horizon']) if (tt[k]) out.push([`${WINDOW_LABELS[k as PlanWindowKey]}: الإجمالي بعد الدعم`, money(tt[k].totalAfterHrdf)], [`${WINDOW_LABELS[k as PlanWindowKey]}: ما تضيفه الخطة`, money(tt[k].deltaAfterHrdf)]);
  } else if (kind === 'OVERVIEW') {
    const k = (o.kpis ?? {}) as Record<string, unknown>;
    for (const [l, key] of [['هذا الشهر', 'thisMonth'], ['12 شهراً', 'next12'], ['36 شهراً', 'next36']] as const) {
      const x = t(k[key]);
      out.push([`${l}: قبل الدعم`, money(x?.cost)], [`${l}: بعد الدعم`, money(x?.net)]);
    }
  } else {
    const tt = (o.totals ?? {}) as Record<string, unknown>;
    for (const [l, key] of [['الشهر الأول', 'month1'], ['12 شهراً', 'next12'], ['36 شهراً', 'next36']] as const) {
      const x = t(tt[key]);
      out.push([`${l}: قبل الدعم`, money(x?.cost)], [`${l}: بعد الدعم`, money(x?.net)]);
    }
  }
  return out;
}

export function buildCalculationWorkbook(v: CalculationExportView, evidence: ReadonlyArray<RuleEvidence>, ctx: ExportContext): BuiltWorkbook {
  const fi = flattenJson(v.inputs);
  const fo = flattenJson(v.outputs);
  const flat = (name: string, f: ReturnType<typeof flattenJson>): XSheet => ({
    name,
    columns: [{ header: 'المسار', width: 60 }, { header: 'القيمة', width: 50 }],
    rows: f.rows.map(([p, x]) => [p, typeof x === 'number' ? num(x) : x]),
    notes: f.truncated ? [`اقتُصر على أول ${MAX_FLAT_ROWS} قيمة`] : [],
  });
  const keyRows = keyOutputs(v.kind, (v.outputs ?? {}) as Record<string, unknown>);
  const versions: XSheet = {
    name: 'نسخ القواعد',
    columns: [{ header: 'المفتاح', width: 40 }, { header: 'القيمة', kind: 'number' }, { header: 'يسري من', kind: 'date' }, { header: 'الحالة', kind: 'status' }],
    rows: (v.ruleVersions ?? []).map((r) => [r.key, r.value, r.effectiveFrom, r.status]),
  };
  return assembleWorkbook(
    {
      title: v.title ?? `حساب محفوظ — ${CALC_KIND_LABELS[v.kind] ?? v.kind}`,
      scope: v.title ?? (CALC_KIND_LABELS[v.kind] ?? v.kind),
      period: `محفوظ في ${v.createdAt.slice(0, 10)}`,
      engineVersion: v.engineVersion,
      generatedAt: ctx.generatedAt,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['النوع', CALC_KIND_LABELS[v.kind] ?? v.kind],
        ['رقم الحساب', v.id],
        ['حُفظ في', { v: new Date(v.createdAt), kind: 'datetime' }],
        ['حفظه', v.createdByName ?? '—'],
      ],
      notes: ['الحساب المحفوظ لا يتغير: المدخلات والنتائج ونسخ القواعد كما كانت وقت الحساب.'],
    },
    [kv(keyRows, 'النتائج الرئيسية'), flat('المدخلات', fi), flat('النتائج', fo), versions],
    evidenceToSources(evidence),
  );
}

// ---------------------------------------------------------------------------
// (i) Decision sensitivity «حساسية القرار»
// ---------------------------------------------------------------------------

export function buildSensitivityWorkbook(v: SensitivityResult, evidence: ReadonlyArray<RuleEvidence>, ctx: ExportContext): BuiltWorkbook {
  const ref = v.reference ?? null;
  const scen: XSheet = {
    name: 'السيناريوهات',
    columns: [
      { header: 'النتيجة', width: 40 },
      { header: 'منخفض', kind: 'money' },
      { header: 'أساسي', kind: 'money' },
      { header: 'مرتفع', kind: 'money' },
      { header: 'الفرق (مرتفع − منخفض)', kind: 'money' },
      ...(ref ? [{ header: ref.label, kind: 'money' as const, width: 26 }, { header: 'الحساب الحي − المعتمد', kind: 'money' as const, width: 20 }] : []),
    ],
    rows: v.outcomes.map((o) => {
      // Every difference comes from the engine (sensitivity.ts): the file prints it, never recomputes it.
      return [o.label, o.scenarios.low, o.scenarios.base, o.scenarios.high, o.scenarioSpread, ...(ref ? [ref.values[o.id] ?? null, ref.diffs?.[o.id] ?? null] : [])];
    }),
  };
  const tornado: XSheet = {
    name: 'الحساسية',
    columns: [
      { header: 'النتيجة', width: 30 },
      { header: 'العامل', width: 44 },
      { header: 'القيمة المنخفضة', width: 30 },
      { header: 'النتيجة عند المنخفض', kind: 'money' },
      { header: 'القيمة الأساسية', width: 26 },
      { header: 'النتيجة الأساسية', kind: 'money' },
      { header: 'القيمة المرتفعة', width: 30 },
      { header: 'النتيجة عند المرتفع', kind: 'money' },
      { header: 'الأثر (الفرق بين الطرفين)', kind: 'money' },
      { header: 'الفرق عند المنخفض', kind: 'money' },
      { header: 'الفرق عند المرتفع', kind: 'money' },
    ],
    rows: v.outcomes.flatMap((o) => o.factors.map((f) => [o.label, f.label, f.lowText, f.low, f.baseText, o.base, f.highText, f.high, f.swing, f.lowDelta, f.highDelta])),
    notes: ['كل عامل يُحرَّك وحده وبقية المدخلات على قيمتها الأساسية؛ الترتيب حسب الأثر.'],
  };
  const skipped: XSheet = { name: 'عوامل لم تُحرَّك', columns: [{ header: 'العامل', width: 44 }, { header: 'السبب', width: 90 }], rows: v.skipped.map((s) => [s.label, s.reason]) };
  const ranges: XSheet = {
    name: 'النطاقات المستخدمة',
    columns: [{ header: 'الافتراض', width: 44 }, { header: 'منخفض', kind: 'number' }, { header: 'أساسي', kind: 'number' }, { header: 'مرتفع', kind: 'number' }, { header: 'الوحدة', width: 12 }, { header: 'المصدر', width: 30 }],
    rows: v.ranges.map((r) => [r.label, r.low, r.base, r.high, r.unit ? (XLSX_UNIT_LABELS[r.unit] ?? r.unit) : null, r.origin === 'REQUEST' ? 'مدخل لهذا الحساب فقط' : 'الافتراضات المحفوظة']),
  };
  return assembleWorkbook(
    {
      title: `حساسية القرار — ${v.title}`,
      scope: v.title,
      period: v.horizonMonths ? `${v.horizonMonths} شهراً` : 'عند الخروج',
      engineVersion: v.engineVersion,
      generatedAt: ctx.generatedAt,
      restricted: !ctx.canSeeDisability,
      extra: [
        ['الرقم المقيس', v.metricLabel],
        ['عدد مرات تشغيل المحرك', int(v.runs)],
      ],
      notes: v.notes,
    },
    [scen, tornado, skipped, ranges],
    evidenceToSources(evidence),
  );
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** ASCII-safe and UTF-8 (RFC 5987) file names of an export. */
export function exportFileNames(kind: string, title: string, generatedAt: Date): { ascii: string; utf8: string } {
  const day = riyadhWallClock(generatedAt).toISOString().slice(0, 10);
  const ascii = `radeef-${kind.replace(/[^a-z0-9-]/gi, '') || 'export'}-${day}.xlsx`;
  const clean = stripBidiControls(title).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'تصدير';
  return { ascii, utf8: `${clean} ${day}.xlsx` };
}

export function contentDisposition(names: { ascii: string; utf8: string }): string {
  return attachmentDisposition(names.ascii, names.utf8);
}

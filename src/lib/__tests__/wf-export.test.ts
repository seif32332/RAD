// Excel exports («التقارير والتصدير», SPEC §11, src/lib/workforce/export-xlsx.ts): workbook structure (RTL,
// sheet names, frozen header row, number / date formats, sources sheet with Arabic statuses), privacy (a
// finance-view workbook carries no disability wording), benchmarks suppression (text, never numbers), the
// Art. 77 risk never summed, and the label copies kept in sync with the API shared labels.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  DATE_FMT,
  EXIT_NET_LABEL,
  MONEY_FMT,
  MONTH_FMT,
  SOURCES_SHEET,
  SUMMARY_SHEET,
  SUPPRESSED_MONTH_TEXT,
  XLSX_DOMAIN_LABELS,
  XLSX_LEVY_TIER_LABELS,
  XLSX_NATIONALITY_LABELS,
  XLSX_QIWA_NOTE,
  XLSX_SCENARIO_LABELS,
  XLSX_SEVERITY_LABELS,
  XLSX_STATUS_LABELS,
  XLSX_UNIT_LABELS,
  assembleWorkbook,
  attachmentDisposition,
  auditSearchText,
  buildBenchmarksWorkbook,
  buildExitCostWorkbook,
  buildOverviewWorkbook,
  buildSaudizationWorkbook,
  buildSensitivityWorkbook,
  buildTrueCostWorkbook,
  contentDisposition,
  evidenceToSources,
  exportFileNames,
  flattenJson,
  rfc5987Encode,
  settingsInScope,
  stripBidiControls,
  type BuiltWorkbook,
  type ExportContext,
} from '@/lib/workforce/export-xlsx';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import { computeOverview } from '@/lib/workforce/overview';
import { computeExitCost } from '@/lib/workforce/exit-cost';
import { redactMonths } from '@/lib/workforce/privacy';
import { nitaqatEstimate, restrictEstimate, WEIGHT_CLASS_LABELS, type NitaqatActivityRow, type NitaqatCurveRow } from '@/lib/workforce/nitaqat';
import { localizationCompliance } from '@/lib/workforce/saudization';
import { computeBenchmarks, SCOPE_SUPPRESSED_REASON, type BenchmarksInput, type BmEmployee } from '@/lib/workforce/benchmarks';
import { HRDF_CATEGORY_LABELS, HRDF_NEUTRAL_CATEGORIES_TEXT } from '@/lib/workforce/true-cost';
import { LEVY_TIER_LABELS, NATIONALITY_LABELS, QIWA_NOTE, SCENARIO_LABELS, SEVERITY_LABELS, STATUS_LABELS, UNIT_LABELS, DOMAIN_LABELS } from '@/app/api/workforce/_lib/shared';
import { buildOverviewResponse, compositionForWindow, groupRows, summarizeEmployee } from '@/app/api/workforce/_lib/views';
import type { CompanySaudization } from '@/app/api/workforce/_lib/saudization';
import type { WfCompanyInput, WfEmployeeInput } from '@/lib/workforce/types';
import type { SensitivityResult } from '@/lib/workforce/sensitivity';
import { COMPANY, SEED_GOSI, SEED_RULES, d, emp, housing } from './wf-fixtures';

const NOW = new Date('2026-09-26T10:00:00.000Z');
const HR: ExportContext = { generatedAt: NOW, canSeeDisability: true };
const FINANCE: ExportContext = { generatedAt: NOW, canSeeDisability: false };

async function roundTrip(b: BuiltWorkbook): Promise<ExcelJS.Workbook> {
  const buf = await b.workbook.xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  return wb;
}

function text(wb: ExcelJS.Workbook): string {
  const out: string[] = [];
  wb.eachSheet((ws) =>
    ws.eachRow((row) =>
      row.eachCell((c) => {
        const v = c.value as unknown;
        out.push(v && typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v ?? ''));
      }),
    ),
  );
  return out.join('\n');
}

function rows(wb: ExcelJS.Workbook, name: string): unknown[][] {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`sheet ${name} missing`);
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(row.getCell(c).value);
    out[n - 1] = vals;
  });
  return out;
}

// A Saudi woman with a disability (HRDF +10% DISABLED and FEMALE) hired inside the horizon, and an expat.
const DISABLED_SAUDI = emp({ id: 'dis', name: 'موظفة', nationality: 'سعودي', gender: 'FEMALE', joinDate: d('2026-10-01'), basicSalary: 6000, allowances: [housing(1000)], gosiRegime: 'NEW', isDisabled: true, qiwaContractDocumented: true });
const EXPAT = emp({ id: 'exp', name: 'وافد', nationality: 'هندي', gosiRegime: null, basicSalary: 3000 });
const TC_INPUT = { employees: [DISABLED_SAUDI, EXPAT], companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] };

describe('label copies stay in sync with the API shared labels', () => {
  it('statuses, units, domains, scenarios, nationalities, levy tiers, severities, Qiwa note', () => {
    for (const [k, v] of Object.entries(STATUS_LABELS)) expect(XLSX_STATUS_LABELS[k]).toBe(v);
    expect(XLSX_UNIT_LABELS).toEqual(UNIT_LABELS);
    expect(XLSX_DOMAIN_LABELS).toEqual(DOMAIN_LABELS);
    expect(XLSX_SCENARIO_LABELS).toEqual(SCENARIO_LABELS);
    expect(XLSX_NATIONALITY_LABELS).toEqual(NATIONALITY_LABELS);
    expect(XLSX_LEVY_TIER_LABELS).toEqual(LEVY_TIER_LABELS);
    expect(XLSX_SEVERITY_LABELS).toEqual(SEVERITY_LABELS);
    expect(XLSX_QIWA_NOTE).toBe(QIWA_NOTE);
  });
});

describe('workbook structure (overview)', () => {
  const tc = computeTrueCost(TC_INPUT, { startMonth: '2026-10', months: 36 });
  const view = buildOverviewResponse(tc, computeOverview(tc, { rules: SEED_RULES, gosiRates: SEED_GOSI }), 12, 'base');
  const sources = Object.values(tc.explanations).flatMap((e) => e?.rules ?? []);
  const built = buildOverviewWorkbook(view, sources, HR);

  it('first sheet «ملخص», last «المصادر والحالات», every sheet right-to-left, data sheets with a frozen header row', async () => {
    const wb = await roundTrip(built);
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe(SUMMARY_SHEET);
    expect(names[names.length - 1]).toBe(SOURCES_SHEET);
    expect(names).toEqual(expect.arrayContaining(['المؤشرات', 'تركيبة الكلفة', 'حسب الشركة', 'حسب الفرع', 'حسب الإدارة', 'السلسلة الشهرية', 'شرائح المقابل المالي']));
    for (const ws of wb.worksheets) expect(ws.views[0]).toMatchObject({ rightToLeft: true });
    for (const ws of wb.worksheets.slice(1)) expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    // summary: title, engine version, generated-at (Riyadh wall clock), disclaimer
    const s = rows(wb, SUMMARY_SHEET);
    expect(s[0][0]).toBe('لوحة القرار — 12 شهراً');
    expect(s.find((r) => r[0] === 'نسخة المحرك')?.[1]).toBe(view.engineVersion);
    expect((s.find((r) => r[0] === 'تاريخ الإنشاء (توقيت الرياض)')?.[1] as Date).toISOString()).toBe('2026-09-26T13:00:00.000Z');
    expect(text(wb)).toContain('تقدير لأغراض التخطيط');
    expect(built.sheets.find((x) => x.name === SOURCES_SHEET)?.rows).toBeGreaterThan(0);
  });

  it('header row bold, money as numbers in #,##0.00 "SAR", months as real dates yyyy-mm, same numbers as the view', async () => {
    const wb = await roundTrip(built);
    const k = wb.getWorksheet('المؤشرات')!;
    expect(k.getRow(1).getCell(2).value).toBe('الكلفة قبل الدعم');
    expect(k.getRow(1).font?.bold).toBe(true);
    expect(k.getRow(2).getCell(2).value).toBe(view.kpis.thisMonth.cost);
    expect(k.getRow(2).getCell(2).numFmt).toBe(MONEY_FMT);
    expect(k.getRow(3).getCell(4).value).toBe(view.kpis.next12.net);
    const s = wb.getWorksheet('السلسلة الشهرية')!;
    const m = s.getRow(2).getCell(1);
    expect(m.value).toBeInstanceOf(Date);
    expect((m.value as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(m.numFmt).toBe(MONTH_FMT);
    expect(s.getRow(2).getCell(5).value).toBe(view.series[0].net);
  });

  it('sources sheet: every rule with key, label, value, unit, effective date (real date), status in Arabic, URL; PROVISIONAL highlighted', async () => {
    const wb = await roundTrip(built);
    const r = rows(wb, SOURCES_SHEET);
    expect(r[0]).toEqual(['المفتاح', 'البند', 'القيمة', 'الوحدة', 'يسري من', 'الحالة', 'رابط المصدر', 'الاقتباس أو الملاحظة']);
    const data = r.slice(1).filter((x) => typeof x[0] === 'string' && /^[A-Z]/.test(x[0] as string));
    expect(data.length).toBe(evidenceToSources(sources).length);
    const iqama = data.find((x) => x[0] === 'IQAMA_FEE_YEAR')!;
    expect(iqama[2]).toBe(650);
    expect(iqama[5]).toBe('مؤقت');
    const ws = wb.getWorksheet(SOURCES_SHEET)!;
    const rowNo = r.findIndex((x) => x[0] === 'IQAMA_FEE_YEAR') + 1;
    expect((ws.getRow(rowNo).getCell(6).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFEF3C7');
    expect(ws.getRow(rowNo).getCell(5).value).toBeInstanceOf(Date);
    expect(ws.getRow(rowNo).getCell(5).numFmt).toBe(DATE_FMT);
    const levy = data.find((x) => x[0] === 'EXPAT_LEVY_WITHIN_SAUDI_COUNT')!;
    expect(levy[5]).toBe('موثّق من المصدر الرسمي');
    expect(String((levy[6] as { text?: string }).text ?? levy[6])).toMatch(/^https:\/\/www\.qiwa\.sa/);
  });
  it('group sheets: no duplicate «12 شهراً بعد الدعم» column when the horizon is 12', async () => {
    const wb = await roundTrip(built);
    const header = rows(wb, 'حسب الشركة')[0].filter((x) => x !== null && x !== undefined) as string[];
    expect(new Set(header).size).toBe(header.length);
    expect(header.filter((h) => h === '12 شهراً بعد الدعم')).toHaveLength(1);
    expect(header).toContain('36 شهراً بعد الدعم');
  });
});

describe('privacy: a finance-view workbook carries no disability wording', () => {
  const tc = computeTrueCost(TC_INPUT, { startMonth: '2026-10', months: 36, employeeIds: ['dis'] });
  const e = tc.employees[0];
  const view = (months: typeof e.months) => ({
    engineVersion: tc.engineVersion,
    startMonth: '2026-10',
    horizon: 36 as const,
    scenario: 'base' as const,
    scopeText: e.name,
    totals: tc.totals,
    headcount: 1,
    series: tc.series.map((s) => ({ month: s.month, cost: s.cost, subsidy: s.subsidy, net: s.net, headcount: s.headcount })),
    composition: compositionForWindow(tc, 36),
    byCompany: groupRows(tc.byCompany, 36),
    byBranch: groupRows(tc.byBranch, 36),
    byDepartment: groupRows(tc.byDepartment, 36),
    employees: [summarizeEmployee(e)],
    detail: { summary: summarizeEmployee(e), months, liabilities: e.liabilities, flags: e.flags },
  });

  it('precondition: the engine gives the HRDF line the DISABLED category', () => {
    expect(e.months.some((m) => m.lines.some((l) => l.key === 'HRDF_SUBSIDY' && l.categories?.includes('DISABLED')))).toBe(true);
  });

  it('true cost of one employee: HR sees the category, finance gets the neutral text and the same amounts', async () => {
    const hr = text(await roundTrip(buildTrueCostWorkbook(view(e.months), [], HR)));
    const finWb = await roundTrip(buildTrueCostWorkbook(view(redactMonths(e.months)), [], FINANCE));
    const fin = text(finWb);
    expect(hr).toContain(HRDF_CATEGORY_LABELS.DISABLED);
    expect(fin).not.toContain(HRDF_CATEGORY_LABELS.DISABLED);
    expect(fin).not.toContain('isDisabled');
    expect(fin).toContain(HRDF_NEUTRAL_CATEGORIES_TEXT);
    expect(fin).toContain('نسخة مقيّدة');
    const piv = rows(finWb, 'الأشهر × البنود');
    const net = (piv[0] as string[]).indexOf('بعد الدعم');
    e.months.forEach((m, i) => expect(piv[i + 1][net]).toBe(m.totals.net));
  });

  it('Saudization: the restricted estimate exports one Saudi-side row, no disability class, no names', async () => {
    const BIZ: NitaqatActivityRow = { key: 'test-biz', nameAr: 'خدمات الاعمال', code: '481', status: 'VERIFIED_PRIMARY', page: 14 };
    const CURVES: NitaqatCurveRow[] = [2026, 2027, 2028].flatMap((year) =>
      (['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const).map((band, i) => ({ activityKey: 'test-biz', band, year, m: [1.03, 1.03, 2.19, 2.19][i], c: [33.78, 42.62, 43.62, 54.82][i] + (year - 2026) * 3, status: 'VERIFIED_PRIMARY' })),
    );
    const staff: WfEmployeeInput[] = [
      emp({ id: 's-dis', name: 'سعودي ذو إعاقة', isDisabled: true, basicSalary: 5000, qiwaContractDocumented: true }),
      // 9 Saudis: the combined special-categories cap (15%) admits one weight-4 person
      ...Array.from({ length: 8 }, (_, i) => emp({ id: `s${i}`, basicSalary: 5000, qiwaContractDocumented: true })),
      ...Array.from({ length: 6 }, (_, i) => emp({ id: `x${i}`, nationality: 'هندي', gosiRegime: null, basicSalary: 3000 })),
    ];
    const date = d('2026-10-01');
    const est = nitaqatEstimate({ companyId: 'c1', companyName: COMPANY.name, activity: BIZ, curves: CURVES, employees: staff }, date, { average: false });
    const compliance = localizationCompliance({ companyId: 'c1', employees: staff, decisions: [] }, date);
    const company = (estimate: CompanySaudization['estimate']): CompanySaudization => ({ companyId: 'c1', companyName: COMPANY.name, activityKey: 'test-biz', activityText: null, settingsHref: '/x', estimate, compliance, alerts: [] });
    expect(est.breakdown.some((b) => b.weightClass === 'DISABLED')).toBe(true);
    const hrWb = await roundTrip(buildSaudizationWorkbook({ date: '2026-10-01', canSeeNames: true, companies: [company(est)] }, null, HR));
    const finWb = await roundTrip(buildSaudizationWorkbook({ date: '2026-10-01', canSeeNames: false, companies: [company(restrictEstimate(est))] }, null, FINANCE));
    expect(text(hrWb)).toContain(WEIGHT_CLASS_LABELS.DISABLED);
    const fin = text(finWb);
    expect(fin).not.toContain(WEIGHT_CLASS_LABELS.DISABLED);
    expect(fin).not.toContain('ذو إعاقة');
    expect(fin).not.toContain('سعودي ذو إعاقة');
    const w = rows(finWb, 'الأوزان').slice(1).filter((r) => r[1]);
    expect(w[0][1]).toBe(WEIGHT_CLASS_LABELS.SAUDI_TOTAL);
    expect(w.map((r) => r[1])).toEqual(restrictEstimate(est).breakdown.map((b) => b.label));
    // same weighted total on both sides (the restriction hides the split, not the result)
    expect(rows(finWb, 'التقدير')[1][7]).toBe(est.counts.saudiWeighted);
  });
});

describe('benchmarks: suppressed groups and scopes are text, never numbers', () => {
  const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const be = (id: string, o: Partial<BmEmployee> = {}): BmEmployee => ({ id, joinDate: D('2020-01-01'), isTerminated: false, terminationDate: null, nationality: 'سعودي', departmentId: 'A', departmentName: 'الإدارة أ', basicSalary: 8000, monthlyAllowances: 2000, ...o });
  const empty = (employees: BmEmployee[]): BenchmarksInput => ({ employees, payrolls: [], overtimeRequests: [], attendance: [], leaves: [], settlements: [], jobRequests: [], govFees: [] });
  const scope = { companyId: null, branchId: null, departmentId: null, companyName: null, branchName: null, departmentName: null };

  it('a breakdown group below 5 (and its complementary group) has text in size and value, no numerator / denominator', async () => {
    const staff = [
      ...Array.from({ length: 10 }, (_, i) => be(`a${i}`)),
      ...Array.from({ length: 6 }, (_, i) => be(`c${i}`, { departmentId: 'C', departmentName: 'الإدارة ج' })),
      ...['2025-12-31', '2026-03-15', '2026-06-30'].map((t, i) => be(`l${i}`, { isTerminated: true, terminationDate: D(t), exitVoluntary: true, nationality: 'مصري', departmentId: 'B', departmentName: 'الإدارة ب' })),
    ];
    const r = computeBenchmarks(empty(staff), { asOf: D('2026-06-30'), months: 12 });
    const suppressed = r.turnover.byDepartment.filter((g) => g.suppressed);
    expect(suppressed.length).toBeGreaterThan(0);
    const wb = await roundTrip(buildBenchmarksWorkbook({ ...r, scope, notes: [] }, HR));
    const b = rows(wb, 'التقسيمات').filter((x) => x[0] === 'الدوران حسب الإدارة');
    for (const g of suppressed) {
      const row = b.find((x) => x[1] === g.label)!;
      expect(typeof row[2]).toBe('string');
      expect(typeof row[3]).toBe('string');
      expect(row[4]).toBeNull();
      expect(row[5]).toBeNull();
    }
    const shown = r.turnover.byDepartment.find((g) => !g.suppressed)!;
    expect(b.find((x) => x[1] === shown.label)![3]).toBe(shown.value);
    const series = rows(wb, 'السلاسل الشهرية').slice(1);
    for (const p of r.turnover.series.filter((x) => x.suppressed)) expect(series.find((x) => x[0] === 'الدوران الشهري' && (x[1] as Date).toISOString().startsWith(p.month))![2]).toBe(SUPPRESSED_MONTH_TEXT);
  });

  it('a scope below 5 people: every metric is the reason text, nothing numeric, no head counts in the summary', async () => {
    const r = computeBenchmarks(empty([be('a'), be('b'), be('c')]), { asOf: D('2026-06-30'), months: 12 });
    expect(r.scopeSuppressed).toBe(true);
    const wb = await roundTrip(buildBenchmarksWorkbook({ ...r, scope, notes: [] }, FINANCE));
    const m = rows(wb, 'المؤشرات').slice(1).filter((x) => x[1]);
    expect(m).toHaveLength(20);
    for (const x of m) {
      expect(x[2]).toBe(SCOPE_SUPPRESSED_REASON);
      expect(x[4]).toBeNull();
      expect(x[6]).toBeNull();
    }
    expect(rows(wb, SUMMARY_SHEET).some((x) => x[0] === 'متوسط العدد')).toBe(false);
    expect(rows(wb, 'التقسيمات').slice(1).filter((x) => x[1])).toHaveLength(0);
  });
});

describe('exit cost: the Art. 77 risk is a separate scenario, never summed', () => {
  const worker = emp({ id: 'w', joinDate: d('2019-09-01'), basicSalary: 7000, allowances: [housing(2000)] });
  const r = computeExitCost({ employee: { ...worker, leaves: [], loans: [] }, reason: 'COMPANY_TERMINATION', lastWorkingDate: d('2026-08-31'), noticeServed: false, companyEmployees: [worker], company: COMPANY, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] });
  const view = { ...r, employee: { id: 'w', name: 'موظف', employeeNo: null, legalCompanyId: 'c1' }, reasonMapping: { exitReason: 'EMPLOYER_TERMINATION', terminationReason: r.reason, certain: true, note: null }, warnings: [], assumptionEvidence: {} };

  it('net row = payable + offsets; the risk row is apart, marked not summed; no cell adds the risk', async () => {
    expect(r.totals.risk).toBeGreaterThan(0);
    const wb = await roundTrip(buildExitCostWorkbook(view, [], HR));
    const x = rows(wb, 'كلفة الإنهاء');
    const net = x.find((row) => row[1] === EXIT_NET_LABEL)!;
    expect(net[2]).toBe(r.totals.netToEmployee);
    expect(r.totals.netToEmployee).toBeCloseTo(r.totals.payable + r.totals.offsets, 2);
    const risk = x.find((row) => row[1] === 'خطر المادة 77 (خارج أي إجمالي)')!;
    expect(risk[2]).toBe(r.totals.risk);
    expect(String(risk[5])).toMatch(/^لا/);
    const withRisk = Math.round((r.totals.netToEmployee + r.totals.risk) * 100) / 100;
    const payableWithRisk = Math.round((r.totals.payable + r.totals.risk) * 100) / 100;
    for (const row of x) expect([withRisk, payableWithRisk]).not.toContain(row[2]);
    // risk line itself is listed under its own section, after the net row
    const riskLine = x.findIndex((row) => row[0] === 'المخاطر (المادة 77)');
    expect(riskLine).toBeGreaterThan(x.indexOf(net));
  });

  it('summary: exit reasons as Arabic labels (no raw codes); the levy change is named', async () => {
    const wb = await roundTrip(buildExitCostWorkbook({ ...view, reasonInput: 'EMPLOYER_TERMINATION' }, [], HR));
    const s = rows(wb, SUMMARY_SHEET);
    expect(s.find((r) => r[0] === 'سبب الخروج')?.[1]).toBe('إنهاء من صاحب العمل');
    expect(s.find((r) => r[0] === 'أساس التسوية المستخدم')?.[1]).toBe('إنهاء من قبل الشركة');
    expect(text(wb)).not.toMatch(/EMPLOYER_TERMINATION|COMPANY_TERMINATION/);
  });
});

describe('file names and flattening', () => {
  it('ASCII file name + RFC 5987 UTF-8 name (Riyadh date)', () => {
    const n = exportFileNames('true-cost', 'الكلفة الحقيقية — "أحمد"/1', new Date('2026-09-26T22:30:00.000Z'));
    expect(n.ascii).toBe('radeef-true-cost-2026-09-27.xlsx');
    expect(n.utf8).toBe('الكلفة الحقيقية — أحمد 1 2026-09-27.xlsx');
    const h = contentDisposition(n);
    expect(h).toContain('filename="radeef-true-cost-2026-09-27.xlsx"');
    expect(h).toContain(`filename*=UTF-8''${encodeURIComponent(n.utf8)}`);
    expect(/^[\x20-\x7e]*$/.test(h)).toBe(true);
  });

  it('flattenJson keeps numbers and paths, caps the rows', () => {
    expect(flattenJson({ a: { b: [1, 'x'] }, c: true, e: [] }).rows).toEqual([
      ['a.b[0]', 1],
      ['a.b[1]', 'x'],
      ['c', true],
      ['e', '[]'],
    ]);
    const big = flattenJson({ list: Array.from({ length: 50 }, (_, i) => i) }, 10);
    expect(big.rows).toHaveLength(10);
    expect(big.truncated).toBe(true);
  });
});

describe('RFC 5987 file names (Excel and PDF share one helper)', () => {
  const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~%-]*$/;

  it("encodes ' ( ) * ! as %XX (encodeURIComponent leaves them), and the value decodes back", () => {
    const name = "تقرير (نسخة) 'أ'*! 2026.xlsx";
    const enc = rfc5987Encode(name);
    expect(enc).not.toMatch(/['()*!]/);
    for (const x of ['%28', '%29', '%27', '%2A', '%21']) expect(enc).toContain(x);
    expect(ATTR_CHAR.test(enc)).toBe(true);
    expect(decodeURIComponent(enc)).toBe(name);
    const h = attachmentDisposition('radeef-x-2026-09-27.xlsx', name);
    const star = /filename\*=UTF-8''(.*)$/.exec(h)![1];
    expect(ATTR_CHAR.test(star)).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(h)).toBe(true);
  });

  it('a title with parentheses exported: filename* valid', () => {
    const n = exportFileNames('true-cost', 'الكلفة الحقيقية (فرع الرياض)', NOW);
    const h = contentDisposition(n);
    expect(ATTR_CHAR.test(/filename\*=UTF-8''(.*)$/.exec(h)![1])).toBe(true);
    expect(h).toContain('%28');
  });
});

describe('bidi and control characters are stripped from cells and file names', () => {
  const EVIL = 'أحمد\u202Eفدا\u2066x\u2069\u200e\u200f\u0007\u007f\u0000y';
  const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\x00-\x1f\x7f]/;

  it('stripBidiControls removes the listed characters; tab / newline become a space', () => {
    expect(stripBidiControls(EVIL)).toBe('أحمدفداxy');
    expect(stripBidiControls('سطر\nثان\tثالث')).toBe('سطر ثان ثالث');
  });

  it('a name with U+202E exported: no cell, title or sheet note carries it', async () => {
    const built = assembleWorkbook(
      { title: `الكلفة الحقيقية — ${EVIL}`, scope: EVIL, period: 'x', engineVersion: 'v', generatedAt: NOW, extra: [[`الاسم ${EVIL}`, EVIL]], notes: [EVIL] },
      [{ name: 'الموظفون', columns: [{ header: 'الاسم' }, { header: 'الحالة', kind: 'status' }, { header: 'المصدر', kind: 'url' }], rows: [[EVIL, 'X\u202E', `ليس رابطاً ${EVIL}`]], notes: [EVIL] }],
      [{ key: 'K', label: EVIL, value: 1, unit: null, effectiveFrom: null, status: 'MISSING', sourceUrl: null, note: EVIL }],
    );
    const wb = await roundTrip(built);
    const all = text(wb);
    expect(all).toContain('أحمدفداxy');
    expect(BIDI.test(all.replace(/\n/g, ''))).toBe(false);
    expect(BIDI.test(String(wb.title ?? ''))).toBe(false);
  });

  it('file names: the Arabic name and the header carry no bidi / control character', () => {
    const n = exportFileNames('true-cost', `الكلفة الحقيقية — ${EVIL}`, NOW);
    expect(BIDI.test(n.utf8)).toBe(false);
    const h = contentDisposition(n);
    expect(h).not.toMatch(/%E2%80%AE|%E2%81%A6|%E2%80%8E|%00|%07|%7F/i);
    // even when a caller passes an unclean name, the shared helper strips it
    expect(attachmentDisposition('a.xlsx', 'x\u202Ey.xlsx')).not.toMatch(/%E2%80%AE/i);
  });
});

describe('EXPORT audit: the free-text search is never stored', () => {
  it('only { qProvided, qLength }', () => {
    const a = auditSearchText('أحمد العتيبي');
    expect(a).toEqual({ qProvided: true, qLength: 'أحمد العتيبي'.length });
    expect(JSON.stringify(a)).not.toContain('أحمد');
    expect(auditSearchText(undefined)).toEqual({ qProvided: false, qLength: 0 });
    expect(auditSearchText('')).toEqual({ qProvided: false, qLength: 0 });
  });
});

describe('company-scoped sources: only the companies in scope', () => {
  const C1: WfCompanyInput = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC', medicalPremiums: { A: 6000 }, iqamaFeeYear: null } };
  const C2: WfCompanyInput = { id: 'c2', name: 'شركة أخرى', isIndustrialLicensed: false, costSettings: { overtimeHourlyBasis: 'TOTAL_PLUS_HALF_BASIC', medicalPremiums: { B: 4000 }, iqamaFeeYear: null } };
  const a = emp({ id: 'a1', legalCompanyId: 'c1', basicSalary: 5000 });
  const b = emp({ id: 'b1', legalCompanyId: 'c2', basicSalary: 5000 });
  // The engine prepares every loaded employee (levy tiers), so it lists c2's settings even when only a1 is reported.
  const tc = computeTrueCost({ employees: [a, b], companies: [C1, C2], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth: '2026-10', months: 12, employeeIds: ['a1'] });

  it('the engine lists both companies; the export keeps the reported / selected ones', () => {
    expect(tc.companySettingsUsed.map((c) => c.companyId).sort()).toEqual(['c1', 'c2']);
    expect(settingsInScope(tc, null).map((c) => c.companyId)).toEqual(['c1']);
    expect(settingsInScope(tc, 'c1').map((c) => c.companyId)).toEqual(['c1']);
    expect(settingsInScope(tc, 'c2').map((c) => c.companyId)).toEqual(['c2']);
  });
});

describe('sensitivity workbook prints the engine differences (no new number in the file)', () => {
  const result: SensitivityResult = {
    engineVersion: 'v',
    disclaimer: 'x',
    decision: 'PLAN',
    title: 'خطة',
    metricLabel: 'إجمالي الخطة',
    horizonMonths: 12,
    // Sentinel differences that are NOT high − low / live − approved: the file must show them as given.
    outcomes: [{ id: 'total', label: 'الإجمالي', base: 1000, scenarios: { low: 900, base: 1000, high: 1150 }, scenarioSpread: 250.01, scenarioDeltas: { low: -100, high: 150 }, factors: [] }],
    skipped: [],
    ranges: [],
    notes: ['ملاحظة'],
    runs: 3,
    reference: { label: 'المعتمد', createdAt: '2026-09-01T00:00:00.000Z', values: { total: 980 }, diffs: { total: 20.02 } },
  };

  it('«الفرق (مرتفع − منخفض)» = scenarioSpread and «الحساب الحي − المعتمد» = reference.diffs', async () => {
    const wb = await roundTrip(buildSensitivityWorkbook(result, [], HR));
    const r = rows(wb, 'السيناريوهات');
    expect(r[0]).toEqual(['النتيجة', 'منخفض', 'أساسي', 'مرتفع', 'الفرق (مرتفع − منخفض)', 'المعتمد', 'الحساب الحي − المعتمد']);
    expect(r[1]).toEqual(['الإجمالي', 900, 1000, 1150, 250.01, 980, 20.02]);
  });
});

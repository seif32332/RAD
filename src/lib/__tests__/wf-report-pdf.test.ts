// Internal PDF reports of the workforce engine (SPEC §11 «تقارير PDF»): data builders, sanitization, footer,
// privacy for finance, Art.77 kept apart, the 503 path, and (opt-in, RENDER_SERVICE_URL + RENDER_SERVICE_TOKEN)
// determinism against the live radeef-render: same data + same calculation time -> identical bytes.
// RENDER_IT_OUT=<dir> also writes the PDFs for visual review.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_TEXT_RE } from '@/lib/documents/types';

const brandMock = vi.hoisted(() => ({ numerals: 'latn' as 'latn' | 'arab', logo: null as Buffer | null }));
vi.mock('@/lib/documents/service', () => ({
  companyBranding: vi.fn(async () => ({
    brand: { primaryColor: '#1B6B4A', numerals: brandMock.numerals, addressAr: 'الرياض، حي العليا', addressEn: null, phone: '0110000000', email: 'hr@example.sa', logoSha256: null },
    logo: brandMock.logo,
  })),
}));
const session = vi.hoisted(() => ({ role: 'HR_MANAGER' }));
vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(async () => ({ id: 'u1', role: session.role, email: 'x@test', name: 'x', employeeId: 'e1' })),
  requireEmployeeId: vi.fn(async () => 'e1'),
  getClientIp: () => '127.0.0.1',
}));

const {
  INTERNAL_REPORT_NOTICE,
  MULTI_COMPANY_LABEL,
  REPORT_FILE_STEMS,
  REPORT_SERVICE_NOT_CONFIGURED,
  UNSPECIFIED_COMPANY_LABEL,
  ReportServiceNotConfiguredError,
  buildExitCostReport,
  buildSensitivityReport,
  buildTotalRewardsReport,
  buildTrueCostReport,
  finalizeReportData,
  localizeDigits,
  pdfContentDisposition,
  renderWorkforceReport,
  reportBranding,
  sanitizeReportData,
  sanitizeReportText,
  viewForRole,
} = await import('@/lib/workforce/report-pdf');
type TrueCostReportView = import('@/lib/workforce/report-pdf').TrueCostReportView;
type ExitCostReportView = import('@/lib/workforce/report-pdf').ExitCostReportView;
type ReportModel = import('@/lib/workforce/report-pdf').ReportModel;
type SensitivityReportView = import('@/lib/workforce/report-pdf').SensitivityReportView;
const { ENGINE_VERSION, ESTIMATE_DISCLAIMER } = await import('@/lib/workforce/version');

const T0 = new Date('2026-09-26T12:00:00.000Z');
const triple = (cost: number, subsidy = 0) => ({ cost, subsidy, net: Math.round((cost + subsidy) * 100) / 100 });

function trueCostView(hrdfNote: string, categories?: string[]): TrueCostReportView {
  const group = { id: 'c1', name: 'شركة التجربة', headcount: 2, month1: triple(20000, -1500), window: triple(240000, -18000), next12: triple(240000, -18000), next36: triple(720000, -36000) };
  return {
    overview: {
      engineVersion: ENGINE_VERSION,
      startMonth: '2026-10',
      horizon: 12,
      scenario: 'base',
      kpis: { thisMonth: triple(20000, -1500), next12: triple(240000, -18000), next36: triple(720000, -36000), window: triple(240000, -18000), headcount: 2, saudi: 1, gcc: 0, expat: 1, eosbLiabilityEmployer: 12345.678, eosbLiabilityResignation: 4000 },
      composition: [
        { key: 'BASIC', label: 'الراتب الأساسي', kind: 'COST', amount: 180000, month1: 15000 },
        { key: 'HRDF_SUBSIDY', label: 'دعم هدف للتوظيف (مشروط)', kind: 'SUBSIDY', amount: -18000, month1: -1500 },
      ],
      byCompany: [group],
      byDepartment: [{ ...group, id: 'd1', name: 'المالية' }],
      legalCompanies: [{ companyId: 'c1', name: 'شركة التجربة', headcount: 2, saudi: 1, gcc: 0, expat: 1, exempt: 0, within: 1, above: 0, industrialZero: false, monthlyLevy: 700, rawSaudiRatioPct: 50 }],
      upcomingEvents: [{ label: 'نسبة المعاشات للنظام الجديد', effectiveFrom: '2027-07-01', appliesFromMonth: '2027-07', value: 10.5, previousValue: 10, unit: 'PERCENT', status: 'VERIFIED_PRIMARY', estimatedMonthlyImpact: 42.5, affected: 1, impactBasis: '' }],
      dataQuality: [{ code: 'MISSING_MEDICAL_PREMIUM', severity: 'WARNING', count: 2, employees: 2, message: 'قسط التأمين الطبي غير مدخل 😀' }],
    },
    evidence: [{ key: 'GOSI_MAX_WAGE', label: 'الحد الأعلى للأجر الخاضع للاشتراك', value: 45000, unit: 'SAR_MONTH', status: 'VERIFIED_PRIMARY', sourceUrl: 'https://www.gosi.gov.sa/x', effectiveFrom: '2024-07-03' }],
    rulesUsed: [{ key: 'GOSI_MAX_WAGE', effectiveFrom: '2024-07-03', status: 'VERIFIED_PRIMARY', value: 45000 }, { key: 'ERV_SINGLE', effectiveFrom: '2019-01-01', status: 'CORROBORATED_SECONDARY', value: 200 }],
    employee: {
      summary: { name: 'سارة أحمد', employeeNo: 'E-001', companyName: 'شركة التجربة', departmentName: 'المالية', nationalityClass: 'SAUDI', month1: triple(10000, -1500), next12: triple(120000, -18000), next36: triple(360000, -36000), eosbLiabilityEmployer: 5000 },
      months: [{
        month: '2026-10', active: true, basicSalary: 8000, totals: triple(10000, -1500), memo: 500,
        lines: [
          { label: 'الراتب الأساسي', amount: 8000, basis: '8,000', status: 'DERIVED', kind: 'COST' },
          { key: 'HRDF_SUBSIDY', label: 'دعم هدف للتوظيف (مشروط)', amount: -1500, basis: '30% × 5,000', status: 'VERIFIED_PRIMARY', kind: 'SUBSIDY', note: hrdfNote, ...(categories ? { categories } : {}) } as never,
        ],
      }],
    },
  };
}

function exitView(): ExitCostReportView {
  return {
    employee: { id: 'e9', name: 'خالد', employeeNo: 'E-9', legalCompanyId: 'c1' },
    reasonMapping: { exitReason: 'EMPLOYER_TERMINATION', terminationReason: 'COMPANY_TERMINATION', certain: true, note: null },
    warnings: [],
    assumptionEvidence: {},
    reason: 'COMPANY_TERMINATION',
    lastWorkingDate: '2026-12-31',
    yearsOfService: 6,
    wageUsed: 5000,
    lines: [
      { key: 'EOSB', label: 'مكافأة نهاية الخدمة', amount: 17500, basis: '5,000 × (0.5 × 5 + 1)', status: 'VERIFIED_PRIMARY', ruleKeys: ['LAW:ART84'], kind: 'PAYABLE' },
      { key: 'LOANS_OFFSET', label: 'السلف', amount: -1000, basis: '', status: 'DERIVED', ruleKeys: [], kind: 'OFFSET' },
      { key: 'ART77_RISK', label: 'تعويض الإنهاء غير المشروع (خطر)', amount: 15000, basis: '6 × 15 / 30 × 5,000', status: 'VERIFIED_PRIMARY', ruleKeys: ['LAW:ART77'], kind: 'RISK' },
    ],
    totals: { payable: 17500, offsets: -1000, netToEmployee: 16500, risk: 15000, sunkFees: 0, replacement: 0, ongoingMonthlyDelta: 0 },
    settlementScreenTotal: 16500,
    lastMonth: { workingDays: 3, salary: 500, settlementTotalIfUnpaid: 17000, paidByPayroll: false },
    levyImpact: null,
    flags: [{ code: 'COUNSEL_PENDING', severity: 'WARNING', message: 'بانتظار تأكيد المستشار', lineKey: 'EOSB' }],
    explanations: {},
    rulesUsed: [],
  };
}

const branding = { companyId: 'c1', companyName: 'شركة التجربة', multiCompany: false, primaryColor: '#1B6B4A', numerals: 'latn' as const, contact: null, hasLogo: false };

/** Every string of a JSON-like value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

describe('sanitization to the printable set', () => {
  it('drops emoji and invisible characters, maps symbols, strips Arabic marks and accents, keeps Arabic and Latin', () => {
    expect(sanitizeReportText('مستنداً رسمياً')).toBe('مستندا رسميا');
    expect(sanitizeReportText('30% × 5,000 ≤ 7 − 2 → نعم ✓😀')).toBe('30% x 5,000 <= 7 - 2 -> نعم ');
    expect(sanitizeReportText('José Ñ‏علي‍')).toBe('Jose Nعلي');
    expect(sanitizeReportText('李 名')).toBe('? ?');
    expect(sanitizeReportText('سطر\r\nثان')).toBe('سطر\nثان');
    for (const s of ['مستنداً', '😀×→', 'José‏']) expect(DOCUMENT_TEXT_RE.test(sanitizeReportText(s))).toBe(true);
  });

  it('localizes number tokens for Arabic-Indic numerals, never URLs, colours or the engine version', () => {
    expect(localizeDigits('12,345.60 و 2026-09-26', 'arab')).toBe('١٢٬٣٤٥٫٦٠ و ٢٠٢٦-٠٩-٢٦');
    expect(localizeDigits('12,345.60', 'latn')).toBe('12,345.60');
    const out = sanitizeReportData({ a: '15,000.00', url: 'https://x.sa/2026', engine: 'wf-1.0.0', primaryColor: '#123456' }, 'arab');
    expect(out).toEqual({ a: '١٥٬٠٠٠٫٠٠', url: 'https://x.sa/2026', engine: 'wf-1.0.0', primaryColor: '#123456' });
  });

  it('finalized data: every string in the printable set, footer notice + disclaimer + time + engine version', () => {
    const data = finalizeReportData(buildTrueCostReport(trueCostView('الفئات: امرأة')), branding, T0);
    for (const s of strings(data)) expect(DOCUMENT_TEXT_RE.test(s), s).toBe(true);
    expect(data.footer.internal).toBe('تقرير داخلي لأغراض التخطيط — ليس مستندا رسميا');
    expect(data.footer.internal).toBe(sanitizeReportText(INTERNAL_REPORT_NOTICE));
    expect(data.footer.disclaimer).toBe(ESTIMATE_DISCLAIMER);
    expect(data.footer.engine).toBe(ENGINE_VERSION);
    expect(data.footer.generated).toContain('2026-09-26 15:00');
    expect(data.sources.title).toBe('المصادر والحالات');
    expect(JSON.stringify(data)).not.toContain('😀');
  });
});

describe('builders: numbers = the view', () => {
  it('true cost: KPIs and composition formatted from the view values (2 decimals)', () => {
    const m = buildTrueCostReport(trueCostView('الفئات: امرأة'));
    const kpis = (m.sections[0].blocks[0] as { items: Array<{ value: string }> }).items;
    expect(kpis[0].value).toBe('20,000.00');
    expect(kpis[2].value).toBe('222,000.00');
    expect(kpis[5].value).toBe('12,345.68');
    const comp = m.sections[1].blocks[0] as { rows: Array<{ cells: string[] }> };
    expect(comp.rows.map((r) => r.cells[3])).toEqual(['180,000.00', '-18,000.00']);
    // Sources: the evidence row (with its URL) and the rule ref without evidence (key as label).
    expect(m.sources.map((s) => [s.label, s.status])).toEqual([
      ['الحد الأعلى للأجر الخاضع للاشتراك', 'موثق من المصدر الرسمي'],
      ['ERV_SINGLE', 'مؤكد ثانويا'],
    ]);
    expect(m.sources[0].url).toBe('https://www.gosi.gov.sa/x');
  });

  it('exit cost: Art.77 risk is its own section and never added to the payable or the net', () => {
    const v = exitView();
    const m = buildExitCostReport(v);
    const kpis = (m.sections[0].blocks[0] as { items: Array<{ label: string; value: string }> }).items;
    expect(kpis.find((k) => k.label.startsWith('المستحقات'))!.value).toBe('17,500.00');
    expect(kpis.find((k) => k.label === 'الصافي للموظف')!.value).toBe('16,500.00');
    expect(kpis.some((k) => k.value === '32,500.00' || k.value === '31,500.00')).toBe(false);
    const payable = m.sections.find((s) => s.title === 'المستحقات')!;
    expect(JSON.stringify(payable)).not.toContain('15,000.00');
    const risk = m.sections.find((s) => s.title.includes('المادة 77'))!;
    expect(risk.title).toContain('لا تجمع');
    expect((risk.blocks[0] as { title: string }).title).toContain('15,000.00');
    expect(JSON.stringify(risk.blocks[1])).toContain('تعويض الإنهاء غير المشروع');
    // Counsel-pending note printed with the flag.
    expect(JSON.stringify(m.sections.find((s) => s.title === 'ملاحظات الحساب'))).toContain('بانتظار تأكيد المستشار');
    expect(m.scope).toEqual({ employeeId: 'e9', exitReason: 'EMPLOYER_TERMINATION', lastWorkingDate: '2026-12-31' });
  });

  it('total rewards: employee lead, totals and the unavailable case', () => {
    const st = {
      year: 2026,
      employee: { id: 'e1', name: 'نورة', employeeNo: 'E-1', jobTitle: 'محاسبة', joinDate: '2020-01-01', companyName: 'شركة التجربة' },
      coveredMonths: [1, 2],
      through: '2026-02-28',
      available: true,
      reason: null,
      lines: [
        { key: 'BASIC', label: 'الراتب الأساسي', amount: 16000, kind: 'CASH', sourceLabel: 'من مسيرات الرواتب', explanation: '', basis: '', available: true },
        { key: 'MEDICAL', label: 'التأمين الطبي', amount: 0, kind: 'EMPLOYER', sourceLabel: 'غير متوفر', explanation: '', basis: '', available: false },
      ],
      totals: { cash: 16000, employerPaid: 0, accrued: 0, total: 16000 },
      notes: [],
    };
    const m = buildTotalRewardsReport({ statement: st }, 'EMPLOYEE');
    expect(m.lead).toContain('ليس مستندا رسميا');
    expect(JSON.stringify(m.sections)).toContain('غير متوفر');
    expect((m.sections[0].blocks[0] as { items: Array<{ value: string }> }).items[3].value).toBe('16,000.00');
    const none = buildTotalRewardsReport({ statement: { ...st, available: false, reason: 'لا توجد مسيرات', lines: [] } }, 'HR');
    expect(JSON.stringify(none.sections)).toContain('لا توجد مسيرات');
  });

  it('multi-company scope: «عدة شركات» in the letterhead, no contact line', async () => {
    const b = await reportBranding('c1', 'شركة التجربة', true);
    expect(b.companyName).toBe(MULTI_COMPANY_LABEL);
    expect(b.contact).toBeNull();
    const one = await reportBranding('c1', 'شركة التجربة', false);
    expect(one.companyName).toBe('شركة التجربة');
    expect(one.contact).toContain('hr@example.sa');
  });

  it('Content-Disposition: ASCII filename + filename* (Arabic, RFC 5987)', () => {
    const h = pdfContentDisposition('workforce-true-cost-2026-09-26.pdf', 'تقرير الكلفة الحقيقية 2026-09-26.pdf');
    expect(h).toMatch(/^attachment; filename="workforce-true-cost-2026-09-26\.pdf"; filename\*=UTF-8''%D8%AA/);
    expect(/^[\x20-\x7e]+$/.test(h)).toBe(true);
  });

  it("Content-Disposition: ' ( ) * ! percent-encoded, bidi / control characters dropped (shared helper)", () => {
    const h = pdfContentDisposition('workforce-plan-2026-09-26.pdf', "خطة (أ) 'ب'*!\u202E\u0007 2026-09-26.pdf");
    const star = /filename\*=UTF-8''(.*)$/.exec(h)![1];
    expect(/^[A-Za-z0-9!#$&+.^_`|~%-]*$/.test(star)).toBe(true);
    expect(star).not.toMatch(/['()*!]/);
    for (const x of ['%28', '%29', '%27', '%2A', '%21']) expect(star).toContain(x);
    expect(star).not.toMatch(/%E2%80%AE|%07/i);
    expect(decodeURIComponent(star)).toBe("خطة (أ) 'ب'*! 2026-09-26.pdf");
  });

  it('file stems: workforce-<kind> for every report (HR total-rewards included)', () => {
    for (const stem of Object.values(REPORT_FILE_STEMS)) expect(stem).toMatch(/^workforce-[a-z-]+$/);
    expect(REPORT_FILE_STEMS['total-rewards']).toBe('workforce-total-rewards');
  });

  it('letterhead with only the no-company group: default branding and «عدة شركات/غير محدد»', async () => {
    const b = await reportBranding(null, UNSPECIFIED_COMPANY_LABEL, false);
    expect(b.companyName).toBe('عدة شركات/غير محدد');
    expect(b.primaryColor).toBe('#0F4C81');
    expect(b.logo).toBeNull();
    expect(b.contact).toBeNull();
  });
});

describe('privacy: finance never gets disability-identifying content', () => {
  const sensitive = () => trueCostView('الفئات: امرأة، ذو إعاقة (نسبة 50%)', ['FEMALE', 'DISABLED']);

  it('HRDF category list replaced by the neutral text for FINANCE_MANAGER / PAYROLL_ADMIN, kept for HR', () => {
    for (const role of ['FINANCE_MANAGER', 'PAYROLL_ADMIN']) {
      const data = JSON.stringify(finalizeReportData(buildTrueCostReport(viewForRole(sensitive(), role)), branding, T0));
      expect(data).not.toMatch(/إعاقة/);
      expect(data).toContain('فئات دعم إضافية');
      expect(data).not.toContain('DISABLED');
    }
    const hr = JSON.stringify(finalizeReportData(buildTrueCostReport(viewForRole(sensitive(), 'HR_MANAGER')), branding, T0));
    expect(hr).toContain('ذو إعاقة');
  });

  it('sensitive employee fields are dropped from any view for finance', () => {
    const v = viewForRole({ employee: { isDisabled: true, iqamaOrIdNumber: '2123', name: 'x' } }, 'FINANCE_MANAGER');
    expect(v).toEqual({ employee: { name: 'x' } });
  });
});

describe('503 when radeef-render is not configured', () => {
  const saved = { url: process.env.RENDER_SERVICE_URL, token: process.env.RENDER_SERVICE_TOKEN };
  afterEach(() => {
    if (saved.url === undefined) delete process.env.RENDER_SERVICE_URL;
    else process.env.RENDER_SERVICE_URL = saved.url;
    if (saved.token === undefined) delete process.env.RENDER_SERVICE_TOKEN;
    else process.env.RENDER_SERVICE_TOKEN = saved.token;
  });

  it('renderWorkforceReport throws ReportServiceNotConfiguredError; the routes answer 503 with the Arabic message', async () => {
    delete process.env.RENDER_SERVICE_URL;
    delete process.env.RENDER_SERVICE_TOKEN;
    const model = buildExitCostReport(exitView());
    await expect(renderWorkforceReport(model, { ...branding, logo: null }, T0)).rejects.toBeInstanceOf(ReportServiceNotConfiguredError);
    const route = await import('@/app/api/workforce/report/route');
    const res = await route.GET(new Request('http://t/api/workforce/report?kind=true-cost'));
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe(REPORT_SERVICE_NOT_CONFIGURED);
    const post = await route.POST(new Request('http://t/api/workforce/report?kind=exit-cost', { method: 'POST', body: '{}' }));
    expect(post.status).toBe(503);
    const bad = await route.GET(new Request('http://t/api/workforce/report?kind=nope'));
    expect(bad.status).toBe(400);
    const portal = await import('@/app/api/portal/total-rewards/pdf/route');
    expect((await portal.GET(new Request('http://t/api/portal/total-rewards/pdf'))).status).toBe(503);
  }, 60_000);
});

describe.skipIf(!process.env.RENDER_SERVICE_URL)('live radeef-render (opt-in)', () => {
  const out = process.env.RENDER_IT_OUT;
  if (out) mkdirSync(out, { recursive: true });
  const save = (name: string, pdf: Buffer) => {
    if (out) writeFileSync(path.join(out, name), pdf);
  };

  it('deterministic: same data + same calculation time -> identical sha256; another time -> another PDF', async () => {
    const model: ReportModel = buildExitCostReport(exitView());
    const b = { ...branding, logo: null };
    const a1 = await renderWorkforceReport(model, b, T0);
    const a2 = await renderWorkforceReport(model, b, T0);
    const a3 = await renderWorkforceReport(model, b, new Date(T0.getTime() + 60_000));
    expect(a1.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(a2.sha256).toBe(a1.sha256);
    expect(a3.sha256).not.toBe(a1.sha256);
    expect(a1.fileName).toBe('workforce-exit-cost-2026-09-26.pdf');
    save('exit-cost-fixture.pdf', a1.pdf);
  }, 60_000);

  it('brand with a logo and Arabic-Indic numerals renders (every report string printable)', async () => {
    brandMock.numerals = 'arab';
    brandMock.logo = readFileSync(path.join(process.cwd(), 'services', 'render', 'test', 'fixtures', 'F2-ar-en', 'logo.png'));
    try {
      const b = await reportBranding('c1', 'شركة التجربة', false);
      expect(b.logo).not.toBeNull();
      const r = await renderWorkforceReport(buildTrueCostReport(trueCostView('الفئات: امرأة')), b, T0);
      expect(r.data.pageNumbering).toBe('١');
      expect(r.data.sections[0].blocks[0]).toMatchObject({ type: 'kpis' });
      expect(JSON.stringify(r.data)).toContain('٢٠٬٠٠٠٫٠٠');
      save('true-cost-arab-logo.pdf', r.pdf);
    } finally {
      brandMock.numerals = 'latn';
      brandMock.logo = null;
    }
  }, 60_000);
});

describe('sensitivity report: approved reference first, engine differences printed as given', () => {
  const view = (withRef: boolean): SensitivityReportView => ({
    result: {
      decision: 'PLAN',
      title: 'خطة 2027',
      metricLabel: 'إجمالي الخطة بعد دعم هدف',
      horizonMonths: 12,
      outcomes: [{
        id: 'total',
        label: 'إجمالي الخطة بعد دعم هدف',
        base: 1000,
        scenarios: { low: 900, base: 1000, high: 1150 },
        // Sentinels that differ from a recomputation (low − base = -100, high − base = 150).
        scenarioSpread: 250.01,
        scenarioDeltas: { low: -100.01, high: 150.01 },
        factors: [],
      }],
      skipped: [{ label: 'العمل الإضافي', reason: 'لا عمل إضافي مخطط' }],
      ranges: [],
      notes: ['الخطة معتمدة: الإجمالي المعتمد في لقطة الاعتماد'],
      runs: 3,
      reference: withRef ? { label: 'المعتمد (اللقطة المجمدة عند الاعتماد)', createdAt: '2026-09-01T10:00:00.000Z', values: { total: 980 }, diffs: { total: 20.02 } } : null,
    },
    evidence: [],
  });

  it('«المعتمد / الحساب الحي / الفرق» is the first block of the outcome, with the API diff', () => {
    const m = buildSensitivityReport(view(true));
    const first = m.sections[0].blocks[0] as { type: string; items: Array<{ label: string; value: string; hint: string | null }> };
    expect(first.type).toBe('kpis');
    expect(first.items.map((i) => i.label)).toEqual(['المعتمد', 'الحساب الحي', 'الفرق (الحي - المعتمد)']);
    expect(first.items.map((i) => i.value)).toEqual(['980.00', '1,000.00', '+20.02']);
    expect(first.items[0].hint).toContain('2026-09-01');
    const scen = m.sections[0].blocks[1] as { items: Array<{ hint: string | null }> };
    expect(scen.items[1].hint).toBe('الفرق -100.01');
    expect(scen.items[2].hint).toBe('الفرق +150.01');
  });

  it('without a reference: no approved block; notes come before the factors not varied', () => {
    const m = buildSensitivityReport(view(false));
    expect(JSON.stringify(m.sections[0])).not.toContain('المعتمد');
    const notes = m.sections.find((s) => s.title === 'ملاحظات')!;
    const items = (notes.blocks[0] as { items: string[] }).items;
    expect(items[0]).toContain('الخطة معتمدة');
    expect(items[1]).toContain('العمل الإضافي');
  });
});

describe('PDF text: bidi / control characters are stripped like the Excel cells', () => {
  it('U+200E/F, U+202A–E, U+2066–9, C0 controls and DEL never reach the renderer', () => {
    const out = sanitizeReportText('أحمد\u202Eفدا\u2066x\u2069\u200e\u200f\u202a\u0007\u007f\u0000y');
    expect(out).toBe('أحمدفداxy');
    expect(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\x00-\x09\x0b-\x1f\x7f]/.test(out)).toBe(false);
  });
});

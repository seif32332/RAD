// Templates x languages through the real radeef-render service (Typst 0.15.1).
// Opt-in: set RENDER_SERVICE_URL + RENDER_SERVICE_TOKEN (e.g. the container from
// services/render/README.md). Skipped otherwise, so the default unit run needs no service.
// RENDER_IT_OUT=<dir> also writes the PDFs for visual review.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { hashVerifyToken, newVerifyToken, sha256Hex } from '@/lib/documents/core';
import { qrSvg, verifyUrl } from '@/lib/documents/qr';
import { buildRenderModel } from '@/lib/documents/render-model';
import { renderServiceConfig, typstServiceRenderer } from '@/lib/documents/renderer';
import { bundleHash, loadTemplate } from '@/lib/documents/templates';
import {
  buildContractData, EMPLOYMENT_CERTIFICATE, EXPERIENCE_CERTIFICATE, SALARY_CERTIFICATE,
  type CompanyRecord, type DocumentLanguage, type DocumentTypeDefinition, type EmployeeRecord,
} from '@/lib/documents/types';

const config = renderServiceConfig();
const fixtures = path.join(process.cwd(), 'services', 'render', 'test', 'fixtures', 'F2-ar-en');
const asset = (name: string) => readFileSync(path.join(fixtures, name));

const employee: EmployeeRecord = {
  id: 'e1', employeeId: 'E-00412', firstNameArabic: 'محمد', lastNameArabic: 'عبدالله الأحمد',
  firstNameEnglish: 'Mohammed', lastNameEnglish: 'Abdullah Alahmad', nationality: 'أردني', iqamaOrIdNumber: '2456789012',
  idType: null, passportNumber: 'N1234567', jobTitle: 'مهندس مدني أول', jobTitleEnglish: 'Senior Civil Engineer',
  joinDate: new Date('2019-03-09T21:00:00Z'), basicSalary: 9500, isTerminated: false, terminationDate: null, legalCompanyId: 'c1',
  allowances: [
    { name: 'بدل سكن', amount: 2375, isMonthly: true, allowanceType: 'HOUSING' },
    { name: 'بدل نقل', amount: 950, isMonthly: true, allowanceType: 'TRANSPORT' },
  ],
};
const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي للمقاولات العامة المحدودة', nameEnglish: 'ACME General Contracting Co. Ltd.', commercialRegNum: '1010123456', unifiedNumber: '7001234567' };

async function render(def: DocumentTypeDefinition, language: DocumentLanguage, opts: { terminated?: boolean; signature?: boolean; logo?: boolean } = {}) {
  const emp = opts.terminated ? { ...employee, isTerminated: true, terminationDate: new Date('2026-08-31T21:00:00Z') } : employee;
  const data = buildContractData(def, { employee: emp, company, params: { language } }) as never;
  const token = newVerifyToken();
  const url = verifyUrl('https://acme.radeef.sa', token);
  const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: 'الرياض، حي العليا', addressEn: null, phone: '+966 11 234 5678', email: null, logoSha256: null }, {
    typeLabelAr: def.labelAr, typeLabelEn: def.labelEn, number: `ACM-${def.code}-2026-000001`, issuedDate: '2026-09-26',
    validUntilDate: def.defaults.validityDays ? '2026-12-25' : null, verifyUrl: url, language, addresseeAr: null, addresseeEn: null,
    signature: opts.signature === false ? null : { nameAr: 'سارة خالد العتيبي', nameEn: 'Sarah Alotaibi', titleAr: 'مديرة الموارد البشرية', titleEn: 'HR Director', printImage: true, printStamp: true },
    hasLogo: opts.logo !== false,
  });
  const bundle = await loadTemplate(def, language);
  const assets: Record<string, Buffer> = { 'qr.svg': await qrSvg(url) };
  if (opts.logo !== false) assets['logo.png'] = asset('logo.png');
  if (opts.signature !== false) {
    assets['signature.png'] = asset('signature.png');
    assets['stamp.png'] = asset('stamp.png');
  }
  const out = await typstServiceRenderer().render({
    templateRef: bundle.templateRef, template: bundle.files, data: model, assets, creationTimestamp: 1790413200, pdfStandard: 'a-2b',
  });
  if (process.env.RENDER_IT_OUT) {
    mkdirSync(process.env.RENDER_IT_OUT, { recursive: true });
    writeFileSync(path.join(process.env.RENDER_IT_OUT, `${def.code}-${language}${opts.terminated ? '-ended' : ''}${opts.signature === false ? '-nosig' : ''}.pdf`), out.pdf);
  }
  return { out, token };
}

describe.skipIf(!config)('templates through radeef-render', () => {
  for (const def of [SALARY_CERTIFICATE, EMPLOYMENT_CERTIFICATE, EXPERIENCE_CERTIFICATE]) {
    for (const language of ['ar', 'ar-en'] as const) {
      it(`${def.key} / ${language}`, async () => {
        const { out, token } = await render(def, language);
        expect(out.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(out.pdfSha256).toBe(sha256Hex(out.pdf));
        expect(out.rendererVersion).toBe('0.15.1');
        expect(hashVerifyToken(token)).toHaveLength(64);
      });
    }
  }

  it('experience certificate after the end of service, no signatory, no logo', async () => {
    const { out } = await render(EXPERIENCE_CERTIFICATE, 'ar-en', { terminated: true, signature: false, logo: false });
    expect(out.pdf.length).toBeGreaterThan(1000);
  });

  it('same inputs give the same bytes (determinism)', async () => {
    const bundle = await loadTemplate(SALARY_CERTIFICATE, 'ar');
    expect(bundle.sha256).toBe(bundleHash(bundle.files));
    const url = verifyUrl('https://acme.radeef.sa', 'K7Q2M9XJ4TRW8PZC3VN6HD5BLA');
    const data = buildContractData(SALARY_CERTIFICATE, { employee, company, params: { language: 'ar' } }) as never;
    const model = buildRenderModel(data, { primaryColor: '#0F4C81', numerals: 'arab', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
      typeLabelAr: 'خطاب تعريف بالراتب', typeLabelEn: 'Salary Certificate', number: 'ACM-SAL-2026-000184', issuedDate: '2026-09-26',
      validUntilDate: '2026-12-25', verifyUrl: url, language: 'ar', addresseeAr: 'بنك الرياض', addresseeEn: null, signature: null, hasLogo: false,
    });
    const input = { templateRef: bundle.templateRef, template: bundle.files, data: model, assets: { 'qr.svg': await qrSvg(url) }, creationTimestamp: 1790413200, pdfStandard: 'a-2b' as const };
    const a = await typstServiceRenderer().render(input);
    const b = await typstServiceRenderer().render(input);
    expect(a.pdfSha256).toBe(b.pdfSha256);
  });
});

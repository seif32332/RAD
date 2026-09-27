// Administrative decision / circular (CIR, SPEC §15 item 37): the audience turned into recipients and
// the "To:" line, what the builder refuses, the title and the default policy. Pure: no database.
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CIRCULAR, buildCompanyContractData, buildContractData, circularParamsSchema, ContractValidationError, paramsSchema, SALARY_CERTIFICATE,
  type CircularFacts, type CompanyRecord, type EmployeeRecord,
} from '@/lib/documents/types';
import { effectivePolicy } from '@/lib/documents/policy';
import { buildRenderModel } from '@/lib/documents/render-model';

const company: CompanyRecord = { id: 'c1', nameArabic: 'شركة أكمي', nameEnglish: 'ACME Co.', commercialRegNum: '1010123456', unifiedNumber: null };
const circular = (over: Record<string, unknown> = {}) => ({
  legalCompanyId: 'c1', kind: 'CIRCULAR', subjectAr: 'مواعيد الدوام في رمضان', bodyAr: 'يكون الدوام من العاشرة صباحا حتى الثالثة عصرا.\n\nمع التمنيات بالتوفيق.',
  audience: { scope: 'COMPANY', ids: [] }, ...over,
});
const facts = (over: Partial<CircularFacts> = {}): CircularFacts => ({
  recipients: [{ id: 'e2', employeeNumber: 'E-2', nameAr: 'سارة أحمد' }, { id: 'e1', employeeNumber: 'E-1', nameAr: 'محمد علي' }],
  groups: [], unknownIds: [], ...over,
});
type Data = { circular: { addresseeAr: string; recipientIds: string[]; listed: unknown; acknowledge: boolean; kind: string } };
const build = (c: Record<string, unknown>, f = facts()) =>
  buildCompanyContractData(ADMIN_CIRCULAR, { company, params: paramsSchema.parse({ language: 'ar', circular: c }), circular: f }) as Data;
const codes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContractValidationError) return e.errors.map((x) => x.code);
    throw e;
  }
  return [];
};

describe('administrative decision / circular (CIR)', () => {
  it('whole company: addressed to all staff, every recipient in the snapshot (sorted), acknowledgement on by default', () => {
    const d = build(circular());
    expect(d.circular).toMatchObject({ addresseeAr: 'جميع منسوبي شركة أكمي', recipientIds: ['e1', 'e2'], listed: null, acknowledge: true });
  });

  it('branches / departments: the groups named in the "To:" line; named employees: listed in the document', () => {
    expect(build(circular({ audience: { scope: 'BRANCHES', ids: ['b1', 'b2'] } }), facts({ groups: ['فرع الرياض', 'فرع جدة'] })).circular.addresseeAr).toBe('منسوبي فرع الرياض، فرع جدة');
    expect(build(circular({ audience: { scope: 'DEPARTMENTS', ids: ['d1'] } }), facts({ groups: ['إدارة المشاريع'] })).circular.addresseeAr).toBe('منسوبي إدارة المشاريع');
    const named = build(circular({ audience: { scope: 'EMPLOYEES', ids: ['e1', 'e2'] } }));
    expect(named.circular.addresseeAr).toBe('الموظفون المذكورون أدناه');
    expect(named.circular.listed).toEqual([{ employeeNumber: 'E-2', nameAr: 'سارة أحمد' }, { employeeNumber: 'E-1', nameAr: 'محمد علي' }]);
  });

  it('refuses: no groups chosen, unknown or ended recipients, nobody in service, too many named', () => {
    expect(codes(() => build(circular({ audience: { scope: 'BRANCHES', ids: [] } })))).toContain('NO_AUDIENCE');
    expect(codes(() => build(circular({ audience: { scope: 'EMPLOYEES', ids: ['x'] } }), facts({ unknownIds: ['x'] })))).toContain('UNKNOWN_AUDIENCE');
    expect(codes(() => build(circular(), facts({ recipients: [] })))).toContain('NO_RECIPIENTS');
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `e${i}`, employeeNumber: `E-${i}`, nameAr: 'موظف' }));
    expect(codes(() => build(circular({ audience: { scope: 'EMPLOYEES', ids: many.map((m) => m.id) } }), facts({ recipients: many })))).toContain('TOO_MANY_LISTED');
    expect(circularParamsSchema.safeParse(circular({ bodyAr: 'قصير' })).success).toBe(false);
  });

  it('title follows the kind; it is never built as an employee document', () => {
    expect(ADMIN_CIRCULAR.titleOf!(build(circular({ kind: 'DECISION' })))).toEqual({ ar: 'قرار إداري', en: 'Administrative Decision' });
    expect(ADMIN_CIRCULAR.titleOf!(build(circular()))).toEqual({ ar: 'تعميم إداري', en: 'Administrative Circular' });
    const employee = { id: 'e1' } as EmployeeRecord;
    expect(codes(() => buildContractData(ADMIN_CIRCULAR, { employee, company, params: paramsSchema.parse({ language: 'ar' }) }))).toEqual(['SUBJECT']);
    expect(codes(() => buildCompanyContractData(SALARY_CERTIFICATE, { company, params: paramsSchema.parse({ language: 'ar' }), circular: facts() }))).toEqual(['SUBJECT']);
  });

  it('default policy: approved before issuance, never from the portal (the company may change the approval)', () => {
    expect(effectivePolicy(ADMIN_CIRCULAR, null)).toMatchObject({ requiresApproval: true, selfService: false });
    expect(ADMIN_CIRCULAR.approvalLocked).toBeFalsy();
  });

  it('render model: "To:" the audience, the body as paragraphs', () => {
    const d = build(circular({ effectiveDate: '2027-02-18' }));
    const m = buildRenderModel(d as never, { primaryColor: '#0F4C81', numerals: 'latn', addressAr: null, addressEn: null, phone: null, email: null, logoSha256: null }, {
      typeLabelAr: 'تعميم إداري', typeLabelEn: 'x', number: 'ACM-CIR-2026-000001', issuedDate: '2026-09-27', validUntilDate: null, verifyUrl: 'https://x/v/y',
      language: 'ar', addresseeAr: null, addresseeEn: null, addressedToEmployee: false, signature: null, hasLogo: false,
    }) as unknown as { addressee: { ar: string }; circular: { paragraphs: string[][]; effectiveAr: string } };
    expect(m.addressee.ar).toBe('جميع منسوبي شركة أكمي');
    expect(m.circular.paragraphs).toEqual([['يكون الدوام من العاشرة صباحا حتى الثالثة عصرا.'], ['مع التمنيات بالتوفيق.']]);
    expect(m.circular.effectiveAr).toMatch(/2027/);
  });
});

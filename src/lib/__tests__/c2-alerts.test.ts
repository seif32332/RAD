import { describe, expect, it } from 'vitest';
import {
  BRANCH_EXPIRY_DOCUMENTS,
  branchDocumentAlerts,
  branchDocumentAlertsFromAdminAlerts,
  buildAdminAlerts,
  buildLegalAlerts,
  commercialRegMessage,
  DEFAULT_ALERT_THRESHOLDS,
  EMPLOYEE_DUE_DOCUMENT_TYPES,
  isNewExpiryNotInFuture,
  LEGAL_MANAGED_RENEWALS,
  promissoryCompanyRole,
  promissoryNoteAlertText,
  RENEWAL_DOCUMENT_LABELS,
  renewalPaymentTitle,
  type AdminAlertSources,
} from '@/lib/alerts';

// WP-7 (DOM-010 / DOM-011): branch service contracts reach the owner alerts, the commercial
// register is an annual confirmation, promissory-note wording follows the company's side, and
// the renewals queue helpers (labels, payment titles, past-date guard).

const NOW = new Date('2026-09-25T09:00:00Z'); // Riyadh 2026-09-25
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const t = DEFAULT_ALERT_THRESHOLDS;
// "referred to execution" with or without the damma (built so this file does not contain the phrase).
const EXECUTION_CLAIM = new RegExp(['مُ?حال', 'للتنفيذ'].join(String.raw`\s+`));

const emptyBranch = {
  munLicenseExp: null,
  civilDefenseExp: null,
  rentContractExp: null,
  wasteContractExp: null,
  safetyContractExp: null,
  cameraContractExp: null,
};

describe('buildAdminAlerts: branch waste / safety / camera contracts', () => {
  const src: AdminAlertSources = {
    companies: [],
    contracts: [],
    branches: [
      {
        id: 'b1',
        nameArabic: 'فرع العليا',
        company: { nameArabic: 'شركة س' },
        ...emptyBranch,
        safetyContractExp: day('2026-09-20'), // expired 5 days ago
        cameraContractExp: day('2026-10-05'), // in 10 days (threshold 30)
        wasteContractExp: day('2027-06-01'), // outside the window
      },
    ],
  };

  it('raises the expired safety contract and the camera contract inside its window', () => {
    const alerts = buildAdminAlerts(src, t, NOW);
    const safety = alerts.find((a) => a.type === 'SAFETY_CONTRACT_EXPIRED');
    expect(safety).toBeDefined();
    expect(safety!.entityId).toBe('b1');
    expect(safety!.category).toBe('BRANCH');
    expect(safety!.level).toBe('expired');
    expect(safety!.message).toContain('عقد صيانة السلامة');
    expect(safety!.message).toContain('5');
    const camera = alerts.find((a) => a.type === 'CAMERA_CONTRACT');
    expect(camera?.daysLeft).toBe(10);
    expect(camera?.level).toBe('warning');
    expect(alerts.some((a) => a.type.startsWith('WASTE_CONTRACT'))).toBe(false);
  });

  it('uses the configured thresholds (alert_waste_contract_days)', () => {
    const alerts = buildAdminAlerts(src, { ...t, wasteContract: 400 }, NOW);
    expect(alerts.find((a) => a.type === 'WASTE_CONTRACT')?.level).toBe('warning');
  });
});

describe('commercial register = annual confirmation', () => {
  it('never says the register expired or expires', () => {
    for (const d of [-40, -1, 0, 1, 20]) {
      const m = commercialRegMessage(d);
      expect(m).toContain('موعد التأكيد السنوي للسجل التجاري');
      expect(m).not.toMatch(/انتهى|ينتهي|منتهي/);
    }
    expect(commercialRegMessage(-3)).toContain('فات منذ 3 يوم');
    expect(commercialRegMessage(0)).toContain('اليوم');
    expect(commercialRegMessage(12)).toContain('بعد 12 يوم');
  });

  it('is what buildAdminAlerts emits for companies', () => {
    const alerts = buildAdminAlerts(
      { companies: [{ id: 'c1', nameArabic: 'شركة س', commercialRegExp: day('2026-09-01'), trademarkExpDate: null }], branches: [], contracts: [] },
      t,
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('CR_EXPIRED');
    expect(alerts[0].message).toBe('موعد التأكيد السنوي للسجل التجاري فات منذ 24 يوم');
  });
});

describe('promissory notes: wording by the company side, no automatic "referred to execution"', () => {
  const note = { amount: 5000, creditorName: 'شركة س', debtorName: 'خالد', companyRole: 'CREDITOR' };

  it('normalises companyRole (column defaults to CREDITOR)', () => {
    expect(promissoryCompanyRole('DEBTOR')).toBe('DEBTOR');
    expect(promissoryCompanyRole(' debtor ')).toBe('DEBTOR');
    expect(promissoryCompanyRole('CREDITOR')).toBe('CREDITOR');
    expect(promissoryCompanyRole(null)).toBe('CREDITOR');
    expect(promissoryCompanyRole('x')).toBe('CREDITOR');
  });

  it('overdue note owed to the company: "مستحق لنا غير مسدد"', () => {
    const r = promissoryNoteAlertText(note, -30);
    expect(r.type).toBe('NOTE_EXPIRED');
    expect(r.companyRole).toBe('CREDITOR');
    expect(r.message.startsWith('مستحق لنا غير مسدد')).toBe(true);
    expect(r.message).toContain('خالد');
    expect(r.counterparty).toBe('خالد');
    expect(r.message).not.toMatch(EXECUTION_CLAIM);
    expect(r.message).not.toContain('للتنفيذ');
  });

  it('overdue note owed by the company: "مستحق علينا، خطر تنفيذ"', () => {
    const r = promissoryNoteAlertText({ ...note, creditorName: 'مورد', debtorName: 'شركة س', companyRole: 'DEBTOR' }, -2);
    expect(r.message.startsWith('مستحق علينا، خطر تنفيذ')).toBe(true);
    expect(r.counterparty).toBe('مورد');
    expect(r.source).toContain('على الشركة لصالح مورد');
    expect(r.message).not.toMatch(EXECUTION_CLAIM);
  });

  it('due today and upcoming notes keep their types', () => {
    expect(promissoryNoteAlertText(note, 0).type).toBe('NOTE_DUE');
    expect(promissoryNoteAlertText(note, 0).message).toContain('مستحق لنا اليوم');
    const soon = promissoryNoteAlertText({ ...note, companyRole: 'DEBTOR' }, 9);
    expect(soon.type).toBe('NOTE_NOTICE');
    expect(soon.message).toContain('بعد 9 يوم');
  });

  it('buildLegalAlerts carries companyRole and never claims a referral to execution', () => {
    const alerts = buildLegalAlerts(
      {
        notes: [
          { id: 'n1-aaaaa', amount: 1000, creditorName: 'شركة س', debtorName: 'خالد', companyRole: 'CREDITOR', dueDate: day('2026-08-01') },
          { id: 'n2-bbbbb', amount: 2000, creditorName: 'مورد', debtorName: 'شركة س', companyRole: 'DEBTOR', dueDate: day('2026-08-01') },
        ],
        contracts: [],
        lawsuits: [],
        agencies: [],
      },
      t,
      NOW,
    );
    expect(alerts.map((a) => a.companyRole)).toEqual(['CREDITOR', 'DEBTOR']);
    expect(alerts.every((a) => a.type === 'NOTE_EXPIRED' && a.level === 'expired')).toBe(true);
    for (const a of alerts) expect(a.message).not.toMatch(EXECUTION_CLAIM);
  });
});

describe('branch document alerts (branches list / detail badges)', () => {
  it('covers all six dated branch documents', () => {
    expect(BRANCH_EXPIRY_DOCUMENTS.map((d) => d.field).sort()).toEqual(Object.keys(emptyBranch).sort());
  });

  it('classifies each document with classifyExpiry and its own threshold', () => {
    const list = branchDocumentAlerts(
      { id: 'b1', ...emptyBranch, munLicenseExp: day('2026-09-20'), rentContractExp: day('2026-11-10'), safetyContractExp: day('2026-10-01'), cameraContractExp: day('2027-01-01') },
      t,
      NOW,
    );
    const byType = Object.fromEntries(list.map((a) => [a.type, a]));
    expect(byType.MUN_LICENSE.level).toBe('expired');
    expect(byType.LEASE.level).toBe('warning'); // 46 days, lease threshold 60
    expect(byType.SAFETY_CONTRACT.level).toBe('critical'); // 6 days
    expect(byType.CAMERA_CONTRACT).toBeUndefined();
  });

  it('maps /api/admin/alerts rows back to branch documents', () => {
    const rows = [
      { category: 'BRANCH' as const, type: 'SAFETY_CONTRACT_EXPIRED', level: 'expired' as const, daysLeft: -3, entityId: 'b1' },
      { category: 'BRANCH' as const, type: 'LEASE', level: 'warning' as const, daysLeft: 20, entityId: 'b2' },
      { category: 'COMPANY' as const, type: 'CR', level: 'warning' as const, daysLeft: 20, entityId: 'c1' },
      { category: 'BRANCH' as const, type: 'MUN_LICENSE', level: 'warning' as const, daysLeft: 20 },
    ];
    const out = branchDocumentAlertsFromAdminAlerts(rows);
    expect(out).toEqual([
      { branchId: 'b1', type: 'SAFETY_CONTRACT', label: 'عقد صيانة السلامة', level: 'expired', daysLeft: -3 },
      { branchId: 'b2', type: 'LEASE', label: 'عقد الإيجار', level: 'warning', daysLeft: 20 },
    ]);
  });
});

describe('renewals queue helpers', () => {
  it('labels every vehicle document and the commercial register in Arabic', () => {
    for (const k of ['VEHICLE_INSPECTION', 'VEHICLE_OPERATING_CARD', 'VEHICLE_DRIVER_CARD', 'VEHICLE_DRIVING_AUTH']) {
      expect(RENEWAL_DOCUMENT_LABELS[k]).toMatch(/[؀-ۿ]/);
    }
    expect(RENEWAL_DOCUMENT_LABELS.COMMERCIAL_REG).toBe('التأكيد السنوي للسجل التجاري');
  });

  it('employee entitlements are a category of their own', () => {
    expect([...EMPLOYEE_DUE_DOCUMENT_TYPES].sort()).toEqual(['ANNUAL_LEAVE_DUE', 'PROBATION']);
  });

  it('agencies and legal contracts are managed by the legal department', () => {
    expect(Object.keys(LEGAL_MANAGED_RENEWALS).sort()).toEqual(['AGENCY', 'LEGAL_CONTRACT']);
    expect(LEGAL_MANAGED_RENEWALS.AGENCY.manageUrl).toBe('/legal/agencies');
  });

  it('payment title: Arabic document name, entity name, then employee number or company', () => {
    const iqama = renewalPaymentTitle('IQAMA', { name: 'أحمد علي', reference: 'الرقم الوظيفي 1023' });
    expect(iqama).toBe('تجديد الإقامة / الهوية – أحمد علي (الرقم الوظيفي 1023)');
    expect(iqama).not.toContain('(IQAMA)');
    expect(renewalPaymentTitle('CIVIL_DEFENSE', { name: 'فرع العليا', reference: 'شركة س' })).toBe('تجديد رخصة الدفاع المدني – فرع العليا (شركة س)');
    expect(renewalPaymentTitle('COMMERCIAL_REG', { name: 'شركة س' })).toBe('التأكيد السنوي للسجل التجاري – شركة س');
    expect(renewalPaymentTitle('UNKNOWN_DOC', null)).toBe('تجديد وثيقة');
    expect(renewalPaymentTitle('VEHICLE_INSPECTION', { name: 'مركبة كيا 1234', reference: '  ' })).toBe('تجديد الفحص الدوري للمركبة – مركبة كيا 1234');
  });

  it('a new expiry date of today or earlier needs confirmation (Riyadh calendar day)', () => {
    expect(isNewExpiryNotInFuture(day('2026-09-24'), NOW)).toBe(true);
    expect(isNewExpiryNotInFuture(day('2026-09-25'), NOW)).toBe(true);
    expect(isNewExpiryNotInFuture(day('2026-09-26'), NOW)).toBe(false);
    // 22:30 UTC on the 25th is already the 26th in Riyadh.
    expect(isNewExpiryNotInFuture(day('2026-09-26'), new Date('2026-09-25T22:30:00Z'))).toBe(true);
    expect(isNewExpiryNotInFuture(null, NOW)).toBe(false);
    expect(isNewExpiryNotInFuture('garbage', NOW)).toBe(false);
  });
});

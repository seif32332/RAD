import { describe, expect, it } from 'vitest';
import { decideScopedFileAccess, inferFileCategory, isFileCategory, isSensitiveCategory, type ScopedFileEntry } from '@/lib/storage';

const entry = (over: Partial<ScopedFileEntry> = {}): ScopedFileEntry => ({
  uploadedById: 'hr-user',
  employeeId: 'emp-x',
  category: null,
  isPublic: false,
  ...over,
});

const subject = (role: string, over: { id?: string; employeeId?: string | null } = {}) => ({
  id: over.id ?? `u-${role}`,
  role,
  employeeId: over.employeeId === undefined ? `e-${role}` : over.employeeId,
});

describe('decideScopedFileAccess: full-access roles', () => {
  for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN']) {
    it(`${role} reads any file, sensitive and legacy unregistered ones included`, () => {
      expect(decideScopedFileAccess(subject(role), null)).toBe('allow');
      expect(decideScopedFileAccess(subject(role), entry({ category: 'PASSPORT' }))).toBe('allow');
      expect(decideScopedFileAccess(subject(role), entry({ isPublic: true, employeeId: null }))).toBe('allow');
    });
  }
});

describe('decideScopedFileAccess: legacy unregistered files', () => {
  for (const role of ['BRANCH_MANAGER', 'DEPT_MANAGER', 'LEGAL_ADMIN', 'PURCHASING_AGENT', 'GOV_RELATIONS', 'EMPLOYEE']) {
    it(`${role} is denied`, () => {
      expect(decideScopedFileAccess(subject(role), null)).toBe('deny');
    });
  }
});

describe('decideScopedFileAccess: sensitive categories', () => {
  for (const category of ['IDENTITY', 'PASSPORT', 'HEALTH', 'BANK']) {
    it(`${category}: managers and other staff cannot read someone else's document`, () => {
      const noEmp = { employeeId: null };
      expect(decideScopedFileAccess(subject('BRANCH_MANAGER', noEmp), entry({ category }))).toBe('deny');
      expect(decideScopedFileAccess(subject('PURCHASING_AGENT', noEmp), entry({ category }))).toBe('deny');
      expect(decideScopedFileAccess(subject('LEGAL_ADMIN', noEmp), entry({ category }))).toBe('deny');
      // With an employee file they only get the "referenced by my own records" check.
      expect(decideScopedFileAccess(subject('BRANCH_MANAGER'), entry({ category }))).toBe('check-references');
      expect(decideScopedFileAccess(subject('GOV_RELATIONS'), entry({ category }))).toBe('check-references');
    });
    it(`${category}: the employee themselves may read it`, () => {
      expect(decideScopedFileAccess(subject('EMPLOYEE', { employeeId: 'emp-x' }), entry({ category }))).toBe('allow');
      expect(decideScopedFileAccess(subject('BRANCH_MANAGER', { employeeId: 'emp-x' }), entry({ category }))).toBe('allow');
    });
  }
  it('an uploader who is not the employee cannot read a sensitive document registered to someone else', () => {
    const s = subject('BRANCH_MANAGER', { id: 'mgr', employeeId: null });
    expect(decideScopedFileAccess(s, entry({ category: 'IDENTITY', uploadedById: 'mgr', employeeId: 'emp-x' }))).toBe('deny');
    expect(decideScopedFileAccess(s, entry({ category: 'IDENTITY', uploadedById: 'mgr', employeeId: null }))).toBe('allow');
  });
});

describe('decideScopedFileAccess: managers', () => {
  it('classified team files need the team check; unclassified or unowned files need a reference', () => {
    expect(decideScopedFileAccess(subject('BRANCH_MANAGER'), entry({ category: 'CONTRACT' }))).toBe('check-team');
    expect(decideScopedFileAccess(subject('DEPT_MANAGER'), entry({ category: 'OTHER' }))).toBe('check-team');
    // Unclassified = restricted: an uncategorized document of a team member may be an iqama copy.
    expect(decideScopedFileAccess(subject('DEPT_MANAGER'), entry({ category: null }))).toBe('check-references');
    expect(decideScopedFileAccess(subject('DEPT_MANAGER'), entry({ employeeId: null, category: 'OTHER' }))).toBe('check-references');
    expect(decideScopedFileAccess(subject('DEPT_MANAGER', { employeeId: null }), entry({ employeeId: null }))).toBe('deny');
  });
  it('own uploads and own files are allowed', () => {
    expect(decideScopedFileAccess(subject('BRANCH_MANAGER', { id: 'm1' }), entry({ uploadedById: 'm1' }))).toBe('allow');
    expect(decideScopedFileAccess(subject('BRANCH_MANAGER', { employeeId: 'emp-x' }), entry())).toBe('allow');
  });
});

describe('decideScopedFileAccess: other back-office roles', () => {
  for (const role of ['LEGAL_ADMIN', 'PURCHASING_AGENT', 'GOV_RELATIONS']) {
    it(`${role}: CONTRACT / OTHER yes, unclassified personal no`, () => {
      const s = subject(role, { employeeId: null });
      expect(decideScopedFileAccess(s, entry({ category: 'CONTRACT' }))).toBe('allow');
      expect(decideScopedFileAccess(s, entry({ category: 'OTHER' }))).toBe('allow');
      expect(decideScopedFileAccess(s, entry({ category: null }))).toBe('deny');
      // Public job-application uploads (CVs) are never "business documents".
      expect(decideScopedFileAccess(s, entry({ category: 'OTHER', isPublic: true, employeeId: null, uploadedById: null }))).toBe('deny');
      expect(decideScopedFileAccess(subject(role), entry({ category: null }))).toBe('check-references');
    });
    it(`${role}: files they uploaded`, () => {
      expect(decideScopedFileAccess(subject(role, { id: 'me' }), entry({ uploadedById: 'me', category: null }))).toBe('allow');
    });
  }
});

describe('decideScopedFileAccess: plain employees', () => {
  it('own files, own uploads, else references', () => {
    const s = subject('EMPLOYEE', { id: 'u1', employeeId: 'e1' });
    expect(decideScopedFileAccess(s, entry({ employeeId: 'e1' }))).toBe('allow');
    expect(decideScopedFileAccess(s, entry({ uploadedById: 'u1', employeeId: null }))).toBe('allow');
    expect(decideScopedFileAccess(s, entry({ category: 'CONTRACT' }))).toBe('check-references');
    expect(decideScopedFileAccess(subject('EMPLOYEE', { employeeId: null }), entry())).toBe('deny');
  });
  it('null ids on both sides never match', () => {
    const s = subject('EMPLOYEE', { id: 'u9', employeeId: null });
    expect(decideScopedFileAccess(s, entry({ uploadedById: null, employeeId: null }))).toBe('deny');
  });
  it('unknown roles fall back to the most restrictive rules', () => {
    expect(decideScopedFileAccess(subject('SOMETHING', { employeeId: null }), entry({ category: 'IDENTITY' }))).toBe('deny');
  });
});

describe('file categories', () => {
  it('validates category values', () => {
    expect(isFileCategory('IDENTITY')).toBe(true);
    expect(isFileCategory('identity')).toBe(false);
    expect(isFileCategory('CV')).toBe(false);
    expect(isSensitiveCategory('BANK')).toBe(true);
    expect(isSensitiveCategory('CONTRACT')).toBe(false);
    expect(isSensitiveCategory(null)).toBe(false);
  });
  it('infers the category from record field names', () => {
    expect(inferFileCategory('iqamaCopyUrl')).toBe('IDENTITY');
    expect(inferFileCategory('passportCopyUrl')).toBe('PASSPORT');
    expect(inferFileCategory('healthCertificateUrl')).toBe('HEALTH');
    expect(inferFileCategory('ibanCertificateUrl')).toBe('BANK');
    expect(inferFileCategory('ibanUrl')).toBe('BANK');
    expect(inferFileCategory('workContractUrl')).toBe('CONTRACT');
    expect(inferFileCategory('rentContractUrl')).toBe('CONTRACT');
    expect(inferFileCategory('najmReportUrl')).toBeNull();
    expect(inferFileCategory('')).toBeNull();
    expect(inferFileCategory(null)).toBeNull();
  });
});

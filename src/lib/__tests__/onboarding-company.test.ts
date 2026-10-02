// P0-05 / BL-ONB-012: company of a new hire and the company scope of onboarding / recruitment.
// Pure rules here; the routes are exercised against a real database in onboarding-company-routes.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { HIRE_COMPANY_MESSAGES, resolveHireCompanies } from '@/lib/onboarding-company';
import { companiesInScope, companyScopeWhere, userCompanyScope } from '@/lib/company-scope';

describe('resolveHireCompanies (P0-05)', () => {
  it('derives both companies from the branch when HR chooses nothing', () => {
    expect(resolveHireCompanies({ orgCompanyId: 'A', onlyCompanyId: null })).toEqual({
      ok: true,
      legalCompanyId: 'A',
      actualCompanyId: 'A',
      actualFrom: 'ORG',
    });
  });

  it('keeps a different legal company chosen by HR; the actual company still follows the branch', () => {
    expect(resolveHireCompanies({ orgCompanyId: 'A', legalCompanyId: 'B', onlyCompanyId: null })).toMatchObject({
      ok: true,
      legalCompanyId: 'B',
      actualCompanyId: 'A',
    });
  });

  it('refuses an actual company other than the branch company (INV-ORG-01)', () => {
    expect(resolveHireCompanies({ orgCompanyId: 'A', actualCompanyId: 'B', onlyCompanyId: null })).toEqual({
      ok: false,
      message: HIRE_COMPANY_MESSAGES.branchMismatch,
    });
    expect(resolveHireCompanies({ orgCompanyId: 'A', actualCompanyId: 'A', onlyCompanyId: null }).ok).toBe(true);
  });

  it('without a branch, uses the companies HR chose', () => {
    expect(resolveHireCompanies({ orgCompanyId: null, legalCompanyId: 'B', actualCompanyId: 'C', onlyCompanyId: null })).toEqual({
      ok: true,
      legalCompanyId: 'B',
      actualCompanyId: 'C',
      actualFrom: 'CHOSEN',
    });
  });

  it('without a branch and with a single company in the database, uses it', () => {
    expect(resolveHireCompanies({ orgCompanyId: null, onlyCompanyId: 'ONLY' })).toEqual({
      ok: true,
      legalCompanyId: 'ONLY',
      actualCompanyId: 'ONLY',
      actualFrom: 'ONLY_COMPANY',
    });
  });

  it('never guesses: no branch, no choice, several companies -> refused (EV-0026)', () => {
    expect(resolveHireCompanies({ orgCompanyId: null, onlyCompanyId: null })).toEqual({ ok: false, message: HIRE_COMPANY_MESSAGES.missing });
    expect(resolveHireCompanies({ orgCompanyId: null, legalCompanyId: '', actualCompanyId: '', onlyCompanyId: null }).ok).toBe(false);
  });

  it('a chosen legal company alone gives no actual company', () => {
    expect(resolveHireCompanies({ orgCompanyId: null, legalCompanyId: 'B', onlyCompanyId: null }).ok).toBe(false);
  });
});

describe('company scope', () => {
  it('an unrestricted scope (null) passes everything, including unknown companies', () => {
    expect(companiesInScope(null, ['A', null])).toBe(true);
    expect(companyScopeWhere(null)).toBeUndefined();
  });

  it('a scoped user passes only his companies, and never a record without a company (fail closed)', () => {
    expect(companiesInScope(['A'], ['A'])).toBe(true);
    expect(companiesInScope(['A'], ['A', 'B'])).toBe(false);
    expect(companiesInScope(['A'], [null])).toBe(false);
    expect(companiesInScope(['A'], [undefined])).toBe(false);
    expect(companyScopeWhere(['A', 'B'])).toEqual({ companyId: { in: ['A', 'B'] } });
  });

  it('owners are unrestricted; other users get their UserCompanyScope rows, none = unrestricted', async () => {
    const findMany = vi.fn();
    const db = { userCompanyScope: { findMany } } as unknown as Parameters<typeof userCompanyScope>[0];

    expect(await userCompanyScope(db, { id: 'u1', role: 'SUPER_ADMIN' })).toBeNull();
    expect(findMany).not.toHaveBeenCalled();

    findMany.mockResolvedValueOnce([{ companyId: 'A' }, { companyId: 'B' }]);
    expect(await userCompanyScope(db, { id: 'u2', role: 'HR_MANAGER' })).toEqual(['A', 'B']);
    expect(findMany).toHaveBeenLastCalledWith({ where: { userId: 'u2' }, select: { companyId: true } });

    findMany.mockResolvedValueOnce([]);
    expect(await userCompanyScope(db, { id: 'u3', role: 'HR_MANAGER' })).toBeNull();
  });
});

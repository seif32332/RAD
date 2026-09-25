import { describe, expect, it } from 'vitest';
import { ALL_ROLES, type AppRole } from '@/lib/constants';
import {
  MENU_GROUPS,
  PAGE_ACCESS,
  canAccessPath,
  homePathFor,
  landingPathFor,
  matchPageRule,
  normalizePathname,
  visibleGroups,
  visibleHrefs,
} from '@/lib/menu';

const hrefsOf = (role: AppRole, allowedPages: string[] | null = null) => visibleHrefs(role, allowedPages);
const groupOf = (role: AppRole, href: string) =>
  visibleGroups(role, null).find((g) => g.items.some((i) => i.href === href))?.key ?? null;

describe('visibleGroups / menu gaps', () => {
  it('SUPER_ADMIN sees every page of the menu exactly once', () => {
    const all = new Set(MENU_GROUPS.flatMap((g) => g.items.map((i) => i.href)));
    const groups = visibleGroups('SUPER_ADMIN', null);
    const shown = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(shown)).toEqual(all);
    expect(shown.length).toBe(new Set(shown).size);
  });

  it('secondary placements yield to the primary group (SUPER_ADMIN keeps /leaves under HR)', () => {
    expect(groupOf('SUPER_ADMIN', '/leaves')).toBe('hr');
    expect(groupOf('SUPER_ADMIN', '/transfers')).toBe('hr');
    expect(groupOf('SUPER_ADMIN', '/attendance-corrections')).toBe('hr');
  });

  it.each(['BRANCH_MANAGER', 'DEPT_MANAGER'] as const)('%s sees leaves, corrections and transfers in operations', (role) => {
    for (const href of ['/leaves', '/attendance-corrections', '/transfers']) {
      expect(groupOf(role, href)).toBe('operations');
    }
  });

  it('BRANCH_MANAGER keeps the supervisor screen, DEPT_MANAGER the department screen', () => {
    expect(hrefsOf('BRANCH_MANAGER').has('/manager-portal')).toBe(true);
    expect(hrefsOf('BRANCH_MANAGER').has('/dept-manager')).toBe(false);
    expect(hrefsOf('DEPT_MANAGER').has('/dept-manager')).toBe(true);
    expect(hrefsOf('DEPT_MANAGER').has('/manager-portal')).toBe(false);
  });

  it('/incoming-requests is visible to HR_MANAGER and hidden from GOV_RELATIONS', () => {
    expect(hrefsOf('HR_MANAGER').has('/incoming-requests')).toBe(true);
    expect(hrefsOf('GOV_RELATIONS').has('/incoming-requests')).toBe(false);
  });

  it('/gov-platforms is only for SUPER_ADMIN, COMPANY_ADMIN and GOV_RELATIONS', () => {
    const seeing = ALL_ROLES.filter((r) => hrefsOf(r).has('/gov-platforms'));
    expect(seeing.sort()).toEqual(['COMPANY_ADMIN', 'GOV_RELATIONS', 'SUPER_ADMIN']);
    expect(canAccessPath('HR_MANAGER', null, '/gov-platforms')).toBe(false);
  });

  it('HR_MANAGER sees transfers and attendance corrections under HR', () => {
    expect(groupOf('HR_MANAGER', '/transfers')).toBe('hr');
    expect(groupOf('HR_MANAGER', '/attendance-corrections')).toBe('hr');
  });

  it('EMPLOYEE only sees the self-service portal', () => {
    expect([...hrefsOf('EMPLOYEE')]).toEqual(['/portal']);
  });

  it('every visible item is also openable by the guard (menu never links to a denied page)', () => {
    for (const role of ALL_ROLES) {
      for (const href of hrefsOf(role)) expect([role, href, canAccessPath(role, null, href)]).toEqual([role, href, true]);
    }
  });

  it('a custom RolePermission row narrows the menu; unknown entries are ignored', () => {
    const hrefs = hrefsOf('HR_MANAGER', ['legal', 'not-a-group']);
    expect(hrefs.has('/employees')).toBe(false);
    expect(hrefs.has('/legal/investigations')).toBe(true); // LEGAL + HR
    expect(hrefs.has('/legal/contracts')).toBe(false); // LEGAL only
    expect(hrefs.has('/portal')).toBe(true); // always visible
  });

  it('returns nothing without a role', () => {
    expect(visibleGroups(null, null)).toEqual([]);
  });
});

describe('matchPageRule', () => {
  it('uses the longest matching entry and lets sub-paths inherit', () => {
    expect(matchPageRule('/employees')).toBe('/employees');
    expect(matchPageRule('/employees/abc')).toBe('/employees');
    expect(matchPageRule('/employees/abc/edit')).toBe('/employees/*/edit');
    expect(matchPageRule('/employees/new')).toBe('/employees/new');
    expect(matchPageRule('/services/telecom/42/edit')).toBe('/services/telecom/*/edit');
    expect(matchPageRule('/owner-portal/circulars')).toBe('/owner-portal');
    expect(matchPageRule('/evaluations/abc')).toBe('/evaluations');
    expect(matchPageRule('/evaluations/reports')).toBe('/evaluations/reports');
  });

  it('"/" only governs the root; unknown pages have no rule', () => {
    expect(matchPageRule('/')).toBe('/');
    expect(matchPageRule('/does-not-exist')).toBeNull();
    expect(matchPageRule('/employeesX')).toBeNull();
  });

  it('normalises trailing slashes, queries and hashes', () => {
    expect(normalizePathname('/employees/?q=1#x')).toBe('/employees');
    expect(normalizePathname('')).toBe('/');
    expect(normalizePathname(null)).toBe('/');
    expect(matchPageRule('/employees/')).toBe('/employees');
  });

  it('every explicit rule points at a real role list', () => {
    for (const [path, roles] of PAGE_ACCESS) {
      expect(path.startsWith('/')).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.includes('SUPER_ADMIN')).toBe(true);
    }
  });
});

describe('canAccessPath', () => {
  it('never blocks /portal, /login, /apply or print views', () => {
    for (const role of ALL_ROLES) {
      for (const p of ['/portal', '/portal/archive', '/login', '/apply/x', '/evaluations/print/1']) {
        expect(canAccessPath(role, null, p)).toBe(true);
      }
    }
  });

  it('SUPER_ADMIN opens everything; no role opens nothing', () => {
    expect(canAccessPath('SUPER_ADMIN', ['legal'], '/settings/users')).toBe(true);
    expect(canAccessPath(null, null, '/portal')).toBe(false);
  });

  it('EMPLOYEE is kept out of back-office pages', () => {
    for (const p of ['/', '/employees', '/employees/x/edit', '/leaves', '/assets', '/search', '/owner-reports', '/settings']) {
      expect([p, canAccessPath('EMPLOYEE', null, p)]).toEqual([p, false]);
    }
    expect(canAccessPath('EMPLOYEE', null, '/attendance-corrections')).toBe(true);
    expect(canAccessPath('EMPLOYEE', null, '/attendance-corrections/new')).toBe(true);
  });

  it('follows the API guard of out-of-menu pages', () => {
    expect(canAccessPath('COMPANY_ADMIN', null, '/owner-reports')).toBe(true);
    expect(canAccessPath('HR_MANAGER', null, '/owner-reports')).toBe(false);
    expect(canAccessPath('GOV_RELATIONS', null, '/hr-alerts')).toBe(true);
    expect(canAccessPath('LEGAL_ADMIN', null, '/hr-alerts')).toBe(false);
    expect(canAccessPath('LEGAL_ADMIN', null, '/legal-alerts')).toBe(true);
    expect(canAccessPath('PURCHASING_AGENT', null, '/logistics-alerts')).toBe(true);
    expect(canAccessPath('FINANCE_MANAGER', null, '/logistics-alerts')).toBe(false);
    expect(canAccessPath('DEPT_MANAGER', null, '/dept-actions')).toBe(true);
    expect(canAccessPath('FINANCE_MANAGER', null, '/dept-actions')).toBe(false);
    expect(canAccessPath('FINANCE_MANAGER', null, '/search')).toBe(true);
  });

  it('managers can open evaluation scoring but not the HR evaluation reports', () => {
    expect(canAccessPath('BRANCH_MANAGER', null, '/evaluations/cycle-1')).toBe(true);
    expect(canAccessPath('BRANCH_MANAGER', null, '/evaluations/reports')).toBe(false);
    expect(canAccessPath('HR_MANAGER', null, '/evaluations/reports')).toBe(true);
    expect(canAccessPath('FINANCE_MANAGER', null, '/evaluations')).toBe(false);
  });

  it('create/edit screens follow their write endpoint', () => {
    expect(canAccessPath('GOV_RELATIONS', null, '/employees')).toBe(true); // STAFF read
    expect(canAccessPath('GOV_RELATIONS', null, '/employees/new')).toBe(false); // HR write
    expect(canAccessPath('GOV_RELATIONS', null, '/employees/abc/edit')).toBe(false);
    expect(canAccessPath('HR_MANAGER', null, '/employees/abc/edit')).toBe(true);
    expect(canAccessPath('PURCHASING_AGENT', null, '/vehicles/new')).toBe(true);
    expect(canAccessPath('LEGAL_ADMIN', null, '/vehicles/new')).toBe(false);
    expect(canAccessPath('LEGAL_ADMIN', null, '/vehicles/v1')).toBe(true); // STAFF read
  });

  it('managers reach leaves, transfers and corrections; not payroll or settings', () => {
    for (const role of ['BRANCH_MANAGER', 'DEPT_MANAGER'] as const) {
      expect(canAccessPath(role, null, '/leaves')).toBe(true);
      expect(canAccessPath(role, null, '/transfers')).toBe(true);
      expect(canAccessPath(role, null, '/attendance-corrections')).toBe(true);
      expect(canAccessPath(role, null, '/payrolls')).toBe(false);
      expect(canAccessPath(role, null, '/settings/users')).toBe(false);
    }
  });

  it('allows unknown paths so the not-found page renders', () => {
    expect(canAccessPath('EMPLOYEE', null, '/no-such-page')).toBe(true);
  });

  it('a page granted through a custom menu row opens even for an item without a role list', () => {
    // /assets is STAFF; EMPLOYEE stays blocked even if an admin grants the services group.
    expect(canAccessPath('EMPLOYEE', ['services'], '/assets')).toBe(false);
    expect(canAccessPath('FINANCE_MANAGER', null, '/assets')).toBe(true);
  });
});

describe('homePathFor / landingPathFor', () => {
  it('EMPLOYEE lands on /portal', () => {
    expect(homePathFor('EMPLOYEE', null)).toBe('/portal');
  });

  it('roles with the dashboard in their menu land on "/"', () => {
    expect(homePathFor('SUPER_ADMIN', null)).toBe('/');
    expect(homePathFor('COMPANY_ADMIN', null)).toBe('/');
  });

  it('other roles land on their first work screen', () => {
    expect(homePathFor('BRANCH_MANAGER', null)).toBe('/manager-portal');
    expect(homePathFor('DEPT_MANAGER', null)).toBe('/dept-manager');
    expect(homePathFor('GOV_RELATIONS', null)).toBe('/gov-platforms');
    expect(homePathFor('FINANCE_MANAGER', null)).toBe('/payments');
    expect(homePathFor('LEGAL_ADMIN', null)).toBe('/legal/investigations');
    expect(homePathFor('PURCHASING_AGENT', null)).toBe('/vehicles');
  });

  it('every role home is openable and never "/" unless the dashboard is in the menu', () => {
    for (const role of ALL_ROLES) {
      const home = homePathFor(role, null);
      expect(canAccessPath(role, null, home)).toBe(true);
      if (home === '/') expect(hrefsOf(role).has('/')).toBe(true);
    }
  });

  it('a custom menu row changes the home; the portal is the last resort', () => {
    expect(homePathFor('HR_MANAGER', ['dashboard'])).toBe('/');
    expect(homePathFor('FINANCE_MANAGER', ['employee-portal'])).toBe('/portal');
    expect(homePathFor(null, null)).toBe('/login');
  });

  it('landingPathFor honours a safe, allowed next and falls back to the home otherwise', () => {
    expect(landingPathFor('EMPLOYEE', null, null)).toBe('/portal');
    expect(landingPathFor('EMPLOYEE', null, '/employees')).toBe('/portal');
    expect(landingPathFor('EMPLOYEE', null, '/portal/archive')).toBe('/portal/archive');
    expect(landingPathFor('HR_MANAGER', null, '/employees?tab=1')).toBe('/employees?tab=1');
    expect(landingPathFor('BRANCH_MANAGER', null, '//evil.com')).toBe('/manager-portal');
    expect(landingPathFor('BRANCH_MANAGER', null, '/login')).toBe('/manager-portal');
    expect(landingPathFor(null, null, '/employees')).toBe('/employees');
  });
});

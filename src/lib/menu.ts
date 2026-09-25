// Single source of truth for the sidebar navigation and the menu-permission matrix.
// Client-safe: no server imports.
//
// RolePermission.allowedPages stores group keys (e.g. "hr"). Rows saved by older versions
// store the Arabic heading instead; `legacyHeadings` keeps those rows working.

import { ROLE_GROUPS, type AppRole } from '@/lib/constants';

const union = (...groups: (readonly AppRole[])[]): readonly AppRole[] => Array.from(new Set(groups.flat()));

/**
 * Per-item role lists that mirror the server-side guard of the page's main GET endpoint, so a
 * role never sees a menu item whose data it would get a 403 for. Keep in sync with the routes.
 */
const PAGE_ROLES = {
  /** Back-office reads (dashboard, org structure, employees list, vehicles, telecom...): STAFF */
  staff: ROLE_GROUPS.STAFF,
  /** Users, permissions, audit logs, system settings: ADMIN */
  admin: ROLE_GROUPS.ADMIN,
  /** Owner portal: OWNER */
  owner: ROLE_GROUPS.OWNER,
  /**
   * Government platforms vault (stored platform credentials): owner + government relations only.
   * Deliberately narrower than GET /api/gov-platforms (ROLE_GROUPS.GOV also admits HR_MANAGER).
   */
  gov: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS'] as readonly AppRole[],
  /** Payroll / penalties / overtime / loans administration (GET /api/payroll-hub full view): PAYROLL */
  payroll: ROLE_GROUPS.PAYROLL,
  /** GET /api/settlements: HR + OWNER + FINANCE */
  settlements: union(ROLE_GROUPS.HR, ROLE_GROUPS.OWNER, ROLE_GROUPS.FINANCE),
  /** GET /api/recruitment, /api/manager-portal, /api/dept-manager: MANAGERS */
  managers: ROLE_GROUPS.MANAGERS,
  /** GET /api/manager-portal?action=get_employees: MANAGERS + LOGISTICS */
  assetRequest: union(ROLE_GROUPS.MANAGERS, ROLE_GROUPS.LOGISTICS),
  /** Legal department pages: LEGAL */
  legal: ROLE_GROUPS.LEGAL,
  /** GET /api/legal/investigations: LEGAL + HR */
  investigations: union(ROLE_GROUPS.LEGAL, ROLE_GROUPS.HR),
  /** GET /api/renewals: ROLE_GROUPS.GOV */
  renewals: ROLE_GROUPS.GOV,
  /** GET /api/incoming-requests: HR + PAYROLL (HUB_ROLES) */
  incomingRequests: union(ROLE_GROUPS.HR, ROLE_GROUPS.PAYROLL),
  /**
   * GET /api/incoming-requests scoped to asset requests awaiting purchasing: PURCHASING_AGENT only
   * (the archive, /api/incoming-requests/archive, stays HR + PAYROLL).
   */
  incomingAssetRequests: ['PURCHASING_AGENT'] as readonly AppRole[],
  /** GET /api/payments: FINANCE + GOV (PAYMENTS_ACCESS) */
  payments: union(ROLE_GROUPS.FINANCE, ROLE_GROUPS.GOV),
  /** GET /api/attendance-hub, /api/applications, evaluations dashboard: ROLE_GROUPS.HR */
  hrOnly: ROLE_GROUPS.HR,
  /** GET /api/transfers (HR sees everything, branch/department managers their own scope): MANAGERS */
  transfers: ROLE_GROUPS.MANAGERS,
  /** Reviewers of GET /api/attendance-corrections (HR + branch/department managers): MANAGERS */
  corrections: ROLE_GROUPS.MANAGERS,
  /** GET /api/visas, /api/medical-insurance: HR + GOV */
  hrOrGov: union(ROLE_GROUPS.HR, ROLE_GROUPS.GOV),
  /** GET /api/integrations/muqeem/status, transactions, residents sync: ROLE_GROUPS.GOV */
  muqeem: ROLE_GROUPS.GOV,
} as const;

/**
 * Roles that can read at least one alert source of /unified-alerts
 * (/api/admin/alerts, /api/hr/alerts, /api/logistics/alerts, /api/legal/alerts).
 */
export const ALERT_VIEWER_ROLES: readonly AppRole[] = union(
  ROLE_GROUPS.ADMIN,
  ROLE_GROUPS.GOV,
  ROLE_GROUPS.HR,
  ROLE_GROUPS.LOGISTICS,
  ROLE_GROUPS.LEGAL,
);

/** Names of lucide-react icons; the shell maps them to components. */
export type MenuIconName =
  | 'LayoutGrid'
  | 'Landmark'
  | 'User'
  | 'Briefcase'
  | 'Building2'
  | 'BriefcaseBusiness'
  | 'Wallet'
  | 'BellRing'
  | 'ArrowDownToLine'
  | 'AlertTriangle'
  | 'Users'
  | 'Clock'
  | 'CalendarDays'
  | 'Plane'
  | 'ShieldPlus'
  | 'ClipboardCheck'
  | 'CalendarClock'
  | 'PiggyBank'
  | 'Receipt'
  | 'ArrowRightLeft'
  | 'UserPlus'
  | 'FileText'
  | 'ShieldCheck'
  | 'GitBranch'
  | 'Layers'
  | 'Truck'
  | 'ShieldAlert'
  | 'Smartphone'
  | 'Zap'
  | 'Package'
  | 'MonitorSmartphone'
  | 'Shield'
  | 'Scale'
  | 'FileSignature'
  | 'Gavel'
  | 'History'
  | 'Settings';

export interface MenuItem {
  href: string;
  label: string;
  iconName: MenuIconName;
  /** Static Tailwind classes for the icon (colour). */
  iconClassName?: string;
  /** When set, only these roles see the item (SUPER_ADMIN always does). */
  roles?: readonly AppRole[];
  /**
   * Secondary placement of a page that also lives in another group (e.g. /leaves in the managers'
   * operations group). Shown only when the role does not already see the page in another group.
   */
  secondary?: boolean;
}

export interface MenuGroup {
  /** Stable English key saved in RolePermission.allowedPages. */
  key: string;
  /** Arabic heading shown in the sidebar and on the permissions screen. */
  heading: string;
  /** Previous Arabic titles that may still be stored in RolePermission.allowedPages. */
  legacyHeadings: readonly string[];
  /** Roles that see this group when no custom permission row exists for the role. */
  defaultRoles: readonly AppRole[];
  /** Always visible to every signed-in user (cannot be switched off). */
  alwaysVisible?: boolean;
  items: readonly MenuItem[];
}

export const EMPLOYEE_PORTAL_KEY = 'employee-portal';

export const MENU_GROUPS: readonly MenuGroup[] = [
  {
    key: 'dashboard',
    heading: 'لوحة التحكم',
    legacyHeadings: ['القائمة الرئيسية'],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
    items: [{ href: '/', label: 'لوحة الإدارة (Admins)', iconName: 'LayoutGrid', roles: PAGE_ROLES.staff }],
  },
  {
    key: 'gov-platforms',
    heading: 'إدارة المنصات الحكومية',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS'],
    items: [{ href: '/gov-platforms', label: 'المنصات الحكومية', iconName: 'Landmark', iconClassName: 'text-blue-600', roles: PAGE_ROLES.gov }],
  },
  {
    key: EMPLOYEE_PORTAL_KEY,
    heading: 'بوابة الموظف',
    legacyHeadings: [],
    defaultRoles: [
      'SUPER_ADMIN',
      'COMPANY_ADMIN',
      'HR_MANAGER',
      'FINANCE_MANAGER',
      'PAYROLL_ADMIN',
      'GOV_RELATIONS',
      'LEGAL_ADMIN',
      'BRANCH_MANAGER',
      'EMPLOYEE',
      'DEPT_MANAGER',
      'PURCHASING_AGENT',
    ],
    alwaysVisible: true,
    items: [{ href: '/portal', label: 'بوابة الموظف الذاتية', iconName: 'User', iconClassName: 'text-emerald-400' }],
  },
  {
    key: 'operations',
    heading: 'بوابة التشغيل',
    legacyHeadings: ['بوابة المشرف المباشر'],
    defaultRoles: ['SUPER_ADMIN', 'BRANCH_MANAGER', 'DEPT_MANAGER'],
    items: [
      {
        href: '/manager-portal',
        label: 'شاشة المشرف المباشر',
        iconName: 'Briefcase',
        iconClassName: 'text-blue-500',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'BRANCH_MANAGER'],
      },
      {
        href: '/dept-manager',
        label: 'شاشة مدير الإدارة / القسم',
        iconName: 'Building2',
        iconClassName: 'text-violet-500',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'DEPT_MANAGER'],
      },
      // Manager approval step of leave requests (GET /api/leaves is scoped to the manager's team).
      { href: '/leaves', label: 'إجازات الفريق', iconName: 'CalendarDays', roles: PAGE_ROLES.managers, secondary: true },
      {
        href: '/attendance-corrections',
        label: 'طلبات تصحيح الحضور',
        iconName: 'ClipboardCheck',
        iconClassName: 'text-amber-500',
        roles: PAGE_ROLES.corrections,
        secondary: true,
      },
      {
        href: '/transfers',
        label: 'طلبات النقل بين الفروع',
        iconName: 'ArrowRightLeft',
        iconClassName: 'text-teal-500',
        roles: PAGE_ROLES.transfers,
        secondary: true,
      },
    ],
  },
  {
    key: 'owner',
    heading: 'بوابة صاحب العمل',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
    items: [{ href: '/owner-portal', label: 'بوابة صاحب العمل', iconName: 'BriefcaseBusiness', iconClassName: 'text-indigo-500', roles: PAGE_ROLES.owner }],
  },
  {
    key: 'finance',
    heading: 'بوابة المالية',
    legacyHeadings: ['بوابة المحاسب المالي'],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER', 'PAYROLL_ADMIN'],
    items: [{ href: '/payments', label: 'شاشة المحاسب المالي', iconName: 'Wallet', iconClassName: 'text-emerald-400', roles: PAGE_ROLES.payments }],
  },
  {
    key: 'operations-management',
    heading: 'إدارة العمليات',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN'],
    items: [
      { href: '/renewals', label: 'إدارة التجديدات الدورية', iconName: 'BellRing', iconClassName: 'text-orange-500', roles: PAGE_ROLES.renewals },
      { href: '/integrations/muqeem', label: 'الربط مع منصة مقيم', iconName: 'Landmark', iconClassName: 'text-teal-600', roles: PAGE_ROLES.muqeem },
      {
        href: '/incoming-requests',
        label: 'الطلبات الواردة',
        iconName: 'ArrowDownToLine',
        iconClassName: 'text-blue-500',
        roles: PAGE_ROLES.incomingRequests,
      },
      { href: '/payments', label: 'شاشة المدفوعات', iconName: 'Wallet', iconClassName: 'text-emerald-400', roles: PAGE_ROLES.payments },
      {
        href: '/unified-alerts',
        label: 'شاشة التنبيهات المجمعة',
        iconName: 'AlertTriangle',
        iconClassName: 'text-rose-500',
        roles: ALERT_VIEWER_ROLES,
      },
    ],
  },
  {
    key: 'hr',
    heading: 'إدارة القوى العاملة (HR)',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'PAYROLL_ADMIN'],
    items: [
      { href: '/employees', label: 'إدارة الموظفين', iconName: 'Users', roles: PAGE_ROLES.staff },
      { href: '/attendance', label: 'الحضور والانصراف والمطابقة', iconName: 'Clock', roles: PAGE_ROLES.hrOnly },
      {
        href: '/attendance-corrections',
        label: 'طلبات تصحيح الحضور',
        iconName: 'ClipboardCheck',
        iconClassName: 'text-amber-500',
        roles: PAGE_ROLES.corrections,
      },
      { href: '/leaves', label: 'إدارة الإجازات', iconName: 'CalendarDays', roles: PAGE_ROLES.staff },
      { href: '/visas', label: 'التأشيرات والتذاكر', iconName: 'Plane', iconClassName: 'text-blue-500', roles: PAGE_ROLES.hrOrGov },
      {
        href: '/medical-insurance',
        label: 'إدارة التأمين الطبي',
        iconName: 'ShieldPlus',
        iconClassName: 'text-emerald-500',
        roles: PAGE_ROLES.hrOrGov,
      },
      { href: '/evaluations', label: 'إدارة التقييم', iconName: 'ClipboardCheck', iconClassName: 'text-violet-500', roles: PAGE_ROLES.hrOnly },
      { href: '/payrolls', label: 'مسير إدارة الراتب', iconName: 'Wallet', roles: PAGE_ROLES.payroll },
      { href: '/penalties', label: 'الجزاءات والمخالفات', iconName: 'AlertTriangle', iconClassName: 'text-rose-500', roles: PAGE_ROLES.payroll },
      { href: '/overtimes', label: 'التكليفات والعمل الإضافي', iconName: 'CalendarClock', iconClassName: 'text-indigo-500', roles: PAGE_ROLES.payroll },
      { href: '/loans', label: 'إدارة السلف (والعفو)', iconName: 'PiggyBank', iconClassName: 'text-emerald-500', roles: PAGE_ROLES.payroll },
      { href: '/settlements', label: 'تصفية المستحقات', iconName: 'Receipt', roles: PAGE_ROLES.settlements },
      {
        href: '/transfers',
        label: 'النقل الداخلي بين الفروع',
        iconName: 'ArrowRightLeft',
        iconClassName: 'text-teal-500',
        roles: PAGE_ROLES.transfers,
      },
    ],
  },
  {
    key: 'recruitment',
    heading: 'إدارة التوظيف والاحتياج',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER'],
    items: [
      { href: '/recruitment', label: 'إدارة التوظيف والاحتياج', iconName: 'UserPlus', iconClassName: 'text-indigo-500', roles: PAGE_ROLES.managers },
      { href: '/applications', label: 'إدارة السير الذاتية وفرزها', iconName: 'FileText', iconClassName: 'text-emerald-500', roles: PAGE_ROLES.hrOnly },
    ],
  },
  {
    key: 'organization',
    heading: 'الهيكل التنظيمي والإداري',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER'],
    items: [
      { href: '/compliance', label: 'إدارة الالتزام والمخالفات', iconName: 'ShieldCheck', iconClassName: 'text-rose-500', roles: PAGE_ROLES.staff },
      { href: '/companies', label: 'الشركات', iconName: 'Building2', roles: PAGE_ROLES.staff },
      { href: '/administrations', label: 'الإدارات', iconName: 'Building2', iconClassName: 'text-blue-400', roles: PAGE_ROLES.staff },
      { href: '/branches', label: 'الفروع "مقر العمل"', iconName: 'GitBranch', roles: PAGE_ROLES.staff },
      { href: '/departments', label: 'الأقسام', iconName: 'Layers', roles: PAGE_ROLES.staff },
    ],
  },
  {
    key: 'logistics',
    heading: 'إدارة اللوجستي والمركبات',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'GOV_RELATIONS', 'PURCHASING_AGENT'],
    items: [
      { href: '/vehicles', label: 'إدارة أسطول المركبات', iconName: 'Truck', roles: PAGE_ROLES.staff },
      { href: '/claims', label: 'مطالبات الحوادث والتعويضات', iconName: 'ShieldAlert', roles: PAGE_ROLES.staff },
    ],
  },
  {
    key: 'services',
    heading: 'إدارة الخدمات والأصول',
    legacyHeadings: ['إدارة الخدمات السحابية والأصول'],
    defaultRoles: ['SUPER_ADMIN', 'GOV_RELATIONS', 'PURCHASING_AGENT'],
    items: [
      { href: '/services/telecom', label: 'شرائح الجوال والانترنت', iconName: 'Smartphone', roles: PAGE_ROLES.staff },
      { href: '/services/utilities', label: 'عدادات الكهرباء والمياه', iconName: 'Zap', roles: PAGE_ROLES.staff },
      { href: '/assets', label: 'إدارة العُهَد والأصول', iconName: 'Package', iconClassName: 'text-emerald-500', roles: PAGE_ROLES.staff },
      { href: '/asset-request', label: 'طلب احتياج عهدة', iconName: 'MonitorSmartphone', iconClassName: 'text-orange-500', roles: PAGE_ROLES.assetRequest },
      // Purchasing stage of asset requests (the same page HR uses, scoped by the API to ASSET_REQUEST).
      {
        href: '/incoming-requests',
        label: 'طلبات العهد الواردة',
        iconName: 'ArrowDownToLine',
        iconClassName: 'text-blue-500',
        roles: PAGE_ROLES.incomingAssetRequests,
      },
    ],
  },
  {
    key: 'legal',
    heading: 'الإدارة القانونية',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'LEGAL_ADMIN'],
    items: [
      { href: '/legal/investigations', label: 'التحقيقات الإدارية', iconName: 'Shield', iconClassName: 'text-rose-500', roles: PAGE_ROLES.investigations },
      { href: '/legal/promissory-notes', label: 'السندات لأمر', iconName: 'Scale', iconClassName: 'text-indigo-500', roles: PAGE_ROLES.legal },
      { href: '/legal/contracts', label: 'العقود والاتفاقيات', iconName: 'BriefcaseBusiness', iconClassName: 'text-blue-500', roles: PAGE_ROLES.legal },
      { href: '/legal/agencies', label: 'الوكالات الموثقة', iconName: 'FileSignature', iconClassName: 'text-teal-500', roles: PAGE_ROLES.legal },
      { href: '/legal/lawsuits', label: 'المنازعات القضائية', iconName: 'Gavel', iconClassName: 'text-amber-500', roles: PAGE_ROLES.legal },
    ],
  },
  {
    key: 'settings',
    heading: 'إعدادات وتأمين النظام',
    legacyHeadings: [],
    defaultRoles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
    items: [
      { href: '/settings/audit-logs', label: 'سجل التدقيق والمراقبة', iconName: 'History', iconClassName: 'text-emerald-400', roles: PAGE_ROLES.admin },
      { href: '/settings/users', label: 'مستخدمي النظام والصلاحيات', iconName: 'UserPlus', iconClassName: 'text-blue-400', roles: PAGE_ROLES.admin },
      { href: '/settings/permissions', label: 'تخصيص القوائم والصلاحيات', iconName: 'Layers', iconClassName: 'text-rose-400', roles: PAGE_ROLES.admin },
      { href: '/settings', label: 'منطقة الإعدادات العامـة', iconName: 'Settings', roles: PAGE_ROLES.admin },
    ],
  },
];

/**
 * Normalises stored allowedPages entries (keys, current headings or legacy headings)
 * to the set of group keys they refer to. Unknown entries are ignored.
 */
export function allowedGroupKeys(allowedPages: readonly string[] | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!allowedPages) return keys;
  for (const entry of allowedPages) {
    const group = MENU_GROUPS.find(
      (g) => g.key === entry || g.heading === entry || g.legacyHeadings.includes(entry),
    );
    if (group) keys.add(group.key);
  }
  return keys;
}

/** Group keys a role sees when no custom permission row exists for it. */
export function defaultGroupKeys(role: AppRole): Set<string> {
  return new Set(MENU_GROUPS.filter((g) => g.alwaysVisible || g.defaultRoles.includes(role)).map((g) => g.key));
}

/**
 * The effective set of group keys a role sees.
 * - SUPER_ADMIN sees everything.
 * - A non-empty allowedPages list (custom row) wins over the defaults.
 * - Always-visible groups (employee portal) are always included.
 */
export function effectiveGroupKeys(role: AppRole, allowedPages: readonly string[] | null | undefined): Set<string> {
  if (role === 'SUPER_ADMIN') return new Set(MENU_GROUPS.map((g) => g.key));
  const keys = allowedPages && allowedPages.length > 0 ? allowedGroupKeys(allowedPages) : defaultGroupKeys(role);
  for (const g of MENU_GROUPS) if (g.alwaysVisible) keys.add(g.key);
  return keys;
}

function itemVisible(item: MenuItem, role: AppRole): boolean {
  return !item.roles || role === 'SUPER_ADMIN' || item.roles.includes(role);
}

/**
 * Sidebar groups (with per-item role filtering applied) for the given role.
 * An item that appears in several visible groups (e.g. /payments) is shown only once: in the
 * first group, except that a `secondary` placement yields to a primary placement of the same page.
 */
export function visibleGroups(role: AppRole | null, allowedPages: readonly string[] | null | undefined): MenuGroup[] {
  if (!role) return [];
  const keys = effectiveGroupKeys(role, allowedPages);
  const groups = MENU_GROUPS.filter((g) => keys.has(g.key));
  const primaryHrefs = new Set(
    groups.flatMap((g) => g.items.filter((item) => !item.secondary && itemVisible(item, role)).map((item) => item.href)),
  );
  const seen = new Set<string>();
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        if (!itemVisible(item, role) || seen.has(item.href)) return false;
        if (item.secondary && primaryHrefs.has(item.href)) return false;
        seen.add(item.href);
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0);
}

/** Hrefs of every sidebar item the role sees. */
export function visibleHrefs(role: AppRole | null, allowedPages: readonly string[] | null | undefined): Set<string> {
  return new Set(visibleGroups(role, allowedPages).flatMap((g) => g.items.map((item) => item.href)));
}

// ---------------------------------------------------------------------------
// Page-level access (UX guard in the AppShell; the API routes remain the real enforcement).
// ---------------------------------------------------------------------------

/** Pages every signed-in user may open (self-service, public and print views). */
export const ALWAYS_OPEN_PREFIXES = ['/portal', '/login', '/apply', '/evaluations/print'] as const;

/**
 * Pages outside the menu, and sub-pages whose main API is narrower or wider than the menu item
 * they live under. Each list mirrors the requireUser() guard of the page's main endpoint.
 * A "*" segment matches exactly one dynamic path segment (e.g. an id).
 */
const EXPLICIT_PAGE_ACCESS: Readonly<Record<string, readonly AppRole[]>> = {
  // --- Pages that are not in the sidebar -----------------------------------------------------
  /** GET /api/owner-reports: OWNER (linked from the owner portal). */
  '/owner-reports': ROLE_GROUPS.OWNER,
  /** GET /api/admin/alerts: ADMIN + GOV. */
  '/admin-alerts': union(ROLE_GROUPS.ADMIN, ROLE_GROUPS.GOV),
  /** GET /api/hr/alerts: HR + GOV. */
  '/hr-alerts': union(ROLE_GROUPS.HR, ROLE_GROUPS.GOV),
  /** GET /api/legal/alerts: LEGAL. */
  '/legal-alerts': ROLE_GROUPS.LEGAL,
  /** GET /api/logistics/alerts: LOGISTICS. */
  '/logistics-alerts': ROLE_GROUPS.LOGISTICS,
  /** Department manager quick actions (GET /api/manager-portal): MANAGERS. */
  '/dept-actions': ROLE_GROUPS.MANAGERS,
  /** GET /api/search: STAFF (header search box). */
  '/search': ROLE_GROUPS.STAFF,
  /** Evaluation cycles/templates and scoring (GET /api/evaluations?view=cycles|cycle-detail): MANAGERS. */
  '/evaluations': ROLE_GROUPS.MANAGERS,
  /** GET /api/evaluations?view=dashboard: HR. */
  '/evaluations/reports': ROLE_GROUPS.HR,
  /** CREATE_TEMPLATE: HR. */
  '/evaluations/templates': ROLE_GROUPS.HR,
  /** GET/POST /api/attendance-corrections: every user (reviewers see their scope, others their own). */
  '/attendance-corrections': ROLE_GROUPS.ALL,
  /** GET /api/incoming-requests/archive: HR + PAYROLL (narrower than /incoming-requests, which PURCHASING_AGENT opens). */
  '/incoming-requests/archive': PAGE_ROLES.incomingRequests,
  // --- Create / edit screens whose write endpoint is narrower than the list page --------------
  '/employees/new': ROLE_GROUPS.HR,
  '/employees/import': ROLE_GROUPS.HR,
  '/employees/*/edit': ROLE_GROUPS.HR,
  '/companies/new': union(ROLE_GROUPS.ADMIN, ROLE_GROUPS.HR),
  '/companies/*/edit': union(ROLE_GROUPS.ADMIN, ROLE_GROUPS.HR),
  '/administrations/new': union(ROLE_GROUPS.ADMIN, ROLE_GROUPS.HR),
  '/branches/new': union(ROLE_GROUPS.ADMIN, ROLE_GROUPS.HR),
  '/branches/*/edit': union(ROLE_GROUPS.ADMIN, ROLE_GROUPS.HR),
  '/branches/*/work-schedules': ROLE_GROUPS.HR,
  '/departments/new': ROLE_GROUPS.HR,
  '/departments/*/edit': ROLE_GROUPS.HR,
  '/settlements/new': ROLE_GROUPS.HR,
  '/vehicles/new': ROLE_GROUPS.LOGISTICS,
  '/vehicles/*/edit': ROLE_GROUPS.LOGISTICS,
  '/claims/new': ROLE_GROUPS.LOGISTICS,
  '/claims/*/edit': ROLE_GROUPS.LOGISTICS,
  '/services/telecom/new': ROLE_GROUPS.LOGISTICS,
  '/services/telecom/*/edit': ROLE_GROUPS.LOGISTICS,
  '/services/utilities/new': ROLE_GROUPS.LOGISTICS,
  '/services/utilities/*/edit': ROLE_GROUPS.LOGISTICS,
};

function buildPageAccess(): ReadonlyMap<string, readonly AppRole[]> {
  const map = new Map<string, Set<AppRole>>();
  for (const group of MENU_GROUPS) {
    for (const item of group.items) {
      // An item without its own role list is open to whoever sees its group by default.
      const roles = item.roles ?? (group.alwaysVisible ? ROLE_GROUPS.ALL : group.defaultRoles);
      const set = map.get(item.href) ?? new Set<AppRole>();
      for (const r of roles) set.add(r);
      map.set(item.href, set);
    }
  }
  const result = new Map<string, readonly AppRole[]>();
  for (const [href, set] of map) result.set(href, Array.from(set));
  for (const [path, roles] of Object.entries(EXPLICIT_PAGE_ACCESS)) result.set(path, roles);
  return result;
}

/**
 * Page path (or pattern) -> roles allowed to open it, derived from the menu items plus the explicit
 * entries above. Sub-paths inherit the rule of their longest matching entry.
 */
export const PAGE_ACCESS: ReadonlyMap<string, readonly AppRole[]> = buildPageAccess();

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/** Drops the query/hash and any trailing slash ("/employees/?x=1" -> "/employees"). */
export function normalizePathname(pathname: string | null | undefined): string {
  const raw = (pathname || '/').split(/[?#]/)[0] || '/';
  const trimmed = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
}

/**
 * The PAGE_ACCESS key governing a path: the most specific entry that is a segment-wise prefix of it
 * (literal segments beat "*" on equal length). "/" only governs the root itself. Null when no entry
 * matches (unknown page: the not-found screen handles it).
 */
export function matchPageRule(pathname: string | null | undefined): string | null {
  const path = normalizePathname(pathname);
  if (path === '/') return PAGE_ACCESS.has('/') ? '/' : null;
  const segments = splitPath(path);
  let best: string | null = null;
  let bestLength = -1;
  let bestLiterals = -1;
  for (const key of PAGE_ACCESS.keys()) {
    const keySegments = splitPath(key);
    if (keySegments.length === 0 || keySegments.length > segments.length) continue;
    let literals = 0;
    let matches = true;
    for (let i = 0; i < keySegments.length; i++) {
      if (keySegments[i] === '*') continue;
      if (keySegments[i] !== segments[i]) {
        matches = false;
        break;
      }
      literals++;
    }
    if (!matches) continue;
    if (keySegments.length > bestLength || (keySegments.length === bestLength && literals > bestLiterals)) {
      best = key;
      bestLength = keySegments.length;
      bestLiterals = literals;
    }
  }
  return best;
}

/**
 * Whether the role may open the page (UX only: the API routes enforce access).
 * - /portal, /login, /apply and print views are open to everyone; SUPER_ADMIN opens everything.
 * - A page listed in the role's sidebar (including custom RolePermission groups) is allowed.
 * - Otherwise the roles of the most specific PAGE_ACCESS entry decide; unknown paths are allowed
 *   so that the not-found page can render.
 */
export function canAccessPath(
  role: AppRole | null,
  allowedPages: readonly string[] | null | undefined,
  pathname: string | null | undefined,
): boolean {
  if (!role) return false;
  const path = normalizePathname(pathname);
  if (matchesPrefix(path, ALWAYS_OPEN_PREFIXES)) return true;
  if (role === 'SUPER_ADMIN') return true;
  const key = matchPageRule(path);
  if (!key) return true;
  if (visibleHrefs(role, allowedPages).has(key)) return true;
  return PAGE_ACCESS.get(key)?.includes(role) ?? false;
}

/**
 * Landing page of a role: EMPLOYEE -> /portal; others -> "/" when their menu has the dashboard,
 * otherwise their first work screen in the menu (the self-service portal only as a last resort).
 */
export function homePathFor(role: AppRole | null, allowedPages: readonly string[] | null | undefined): string {
  if (!role) return '/login';
  if (role === 'EMPLOYEE') return '/portal';
  const hrefs = Array.from(visibleHrefs(role, allowedPages));
  if (hrefs.includes('/')) return '/';
  return hrefs.find((href) => href !== '/portal') ?? '/portal';
}

/**
 * Where to send a user right after signing in: the (safe) `next` target when the role may open
 * it, otherwise the role's home page. Without a known role, "/" (the shell re-routes from there).
 */
export function landingPathFor(
  role: AppRole | null,
  allowedPages: readonly string[] | null | undefined,
  next: string | null | undefined,
): string {
  const home = role ? homePathFor(role, allowedPages) : '/';
  const target = safeRedirectPath(next, home);
  if (!role || target === home) return target;
  return canAccessPath(role, allowedPages, target) ? target : home;
}

// ---------------------------------------------------------------------------
// Routes rendered without the application shell / without a session.
// ---------------------------------------------------------------------------

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** Pages reachable without a session (mirrors src/proxy.ts). */
export const PUBLIC_PAGE_PREFIXES = ['/login', '/apply'] as const;

/** Pages rendered without the sidebar/header (public pages + print views). */
export const SHELL_FREE_PREFIXES = [...PUBLIC_PAGE_PREFIXES, '/evaluations/print'] as const;

export function isPublicPath(pathname: string | null | undefined): boolean {
  return !!pathname && matchesPrefix(pathname, PUBLIC_PAGE_PREFIXES);
}

export function isShellFreePath(pathname: string | null | undefined): boolean {
  return !!pathname && matchesPrefix(pathname, SHELL_FREE_PREFIXES);
}

/**
 * A redirect target is safe when it is a same-origin relative path.
 * Rejects protocol-relative ("//x", "/\x"), backslashes and ASCII control/whitespace characters
 * (the URL parser strips tabs/newlines, so "/\t/evil.com" would become "//evil.com"), then
 * re-checks the resolved URL stays on the same origin.
 */
export function safeRedirectPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || next.length > 2000 || !next.startsWith('/') || next.startsWith('//')) return fallback;
  if (/[\\\u0000- \u007f]/.test(next)) return fallback;
  let resolved: URL;
  try {
    const base = 'http://radeef.invalid';
    resolved = new URL(next, base);
    if (resolved.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  // Dot segments can normalise to a "//host" path ("/.//evil.com"); never hand those back.
  if (resolved.pathname.startsWith('//') || isPublicPath(resolved.pathname)) return fallback;
  return next;
}

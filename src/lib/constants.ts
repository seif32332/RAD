// Single source of truth for roles, role groups and workflow status values.
// Client-safe: no server imports.

export const ALL_ROLES = [
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
] as const;

export type AppRole = (typeof ALL_ROLES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: 'مدير النظام',
  COMPANY_ADMIN: 'صاحب العمل / مدير الشركة',
  HR_MANAGER: 'مدير الموارد البشرية',
  FINANCE_MANAGER: 'المدير المالي',
  PAYROLL_ADMIN: 'مسؤول الرواتب',
  GOV_RELATIONS: 'العلاقات الحكومية',
  LEGAL_ADMIN: 'الإدارة القانونية',
  BRANCH_MANAGER: 'مدير الفرع / المشرف المباشر',
  EMPLOYEE: 'موظف',
  DEPT_MANAGER: 'مدير الإدارة / القسم',
  PURCHASING_AGENT: 'مسؤول المشتريات',
};

const STAFF_ROLES = ALL_ROLES.filter((r) => r !== 'EMPLOYEE');

/**
 * Server-side authorization groups. Use with requireUser(ROLE_GROUPS.X).
 * SUPER_ADMIN and COMPANY_ADMIN (the "owner") are included everywhere.
 */
export const ROLE_GROUPS = {
  /** Any authenticated user, including plain employees (self-service only). */
  ALL: ALL_ROLES as readonly AppRole[],
  /** Any back-office user (everyone except EMPLOYEE). */
  STAFF: STAFF_ROLES as readonly AppRole[],
  /** System administration: users, permissions, settings, audit logs. */
  ADMIN: ['SUPER_ADMIN', 'COMPANY_ADMIN'] as readonly AppRole[],
  /** Owner / employer approvals (owner portal). */
  OWNER: ['SUPER_ADMIN', 'COMPANY_ADMIN'] as readonly AppRole[],
  /** HR operations: employees, leaves, visas, attendance, evaluations, transfers. */
  HR: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER'] as readonly AppRole[],
  /** Finance: payments, money transfers, marking things PAID. */
  FINANCE: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER', 'PAYROLL_ADMIN'] as readonly AppRole[],
  /** Payroll preparation (HR + finance). */
  PAYROLL: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN'] as readonly AppRole[],
  /** Legal department. */
  LEGAL: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'LEGAL_ADMIN'] as readonly AppRole[],
  /** Government relations / renewals / gov platforms. */
  GOV: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS', 'HR_MANAGER'] as readonly AppRole[],
  /** Operational managers (supervisor + department manager portals). */
  MANAGERS: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'BRANCH_MANAGER', 'DEPT_MANAGER'] as readonly AppRole[],
  /** Logistics: vehicles, claims, telecom, utilities, assets. */
  LOGISTICS: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'PURCHASING_AGENT', 'GOV_RELATIONS'] as readonly AppRole[],
  /** Workforce decision engine ("محرك القرارات", docs/workforce-engine/SPEC.md): owner, finance and HR management. */
  WORKFORCE: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER', 'HR_MANAGER'] as readonly AppRole[],
} as const;

export function isAppRole(v: unknown): v is AppRole {
  return typeof v === 'string' && (ALL_ROLES as readonly string[]).includes(v);
}

export function roleIn(role: string | null | undefined, group: readonly string[]): boolean {
  return !!role && group.includes(role);
}

// ---------------------------------------------------------------------------
// Workflow status values. NEVER write a status string that is not listed here.
// ---------------------------------------------------------------------------

export const LEAVE_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  /** Employee returned from leave (set on CONFIRM_RETURN). */
  COMPLETED: 'COMPLETED',
} as const;
/** Leaves that block a new leave request while their date range is still open. */
export const LEAVE_ACTIVE_STATUSES = [LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED] as const;

export const LOAN_STATUS = {
  PENDING: 'PENDING',
  MANAGER_APPROVED: 'MANAGER_APPROVED',
  HR_APPROVED: 'HR_APPROVED',
  /** Approved by finance/owner: active, installments are deducted in payroll. */
  FINANCE_APPROVED: 'FINANCE_APPROVED',
  /** Money transferred to the employee; still active for deductions. */
  FINANCE_TRANSFERRED: 'FINANCE_TRANSFERRED',
  /** Fully repaid. */
  COMPLETED: 'COMPLETED',
  FORGIVEN: 'FORGIVEN',
  REJECTED: 'REJECTED',
} as const;
/** Loans whose installments payroll deducts. Legacy 'APPROVED' is accepted on read only. */
export const LOAN_DEDUCTIBLE_STATUSES = [LOAN_STATUS.FINANCE_APPROVED, LOAN_STATUS.FINANCE_TRANSFERRED, 'APPROVED'];
export const LOAN_PENDING_STATUSES = [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED, LOAN_STATUS.HR_APPROVED];

export const DEDUCTION_STATUS = {
  /** Approved and due: will be deducted in payroll. */
  DEDUCTED: 'DEDUCTED',
  PENDING_AMOUNT_APPROVAL: 'PENDING_AMOUNT_APPROVAL',
  PENDING_WAIVE_APPROVAL: 'PENDING_WAIVE_APPROVAL',
  WAIVED: 'WAIVED',
  PENDING_INVESTIGATION: 'PENDING_INVESTIGATION',
  UNDER_INVESTIGATION: 'UNDER_INVESTIGATION',
  OBJECTION_SUBMITTED: 'OBJECTION_SUBMITTED',
  OBJECTION_REJECTED: 'OBJECTION_REJECTED',
  REJECTED: 'REJECTED',
} as const;
/**
 * Deductions payroll must deduct. Legacy 'COMPLETED' (HR-approved manager violation
 * written by older code) is accepted on read only.
 */
export const DEDUCTION_PAYABLE_STATUSES = [DEDUCTION_STATUS.DEDUCTED, DEDUCTION_STATUS.OBJECTION_REJECTED, 'COMPLETED'];
/** Awaiting HR approval. Legacy 'PENDING_HR_APPROVAL' accepted on read only. */
export const DEDUCTION_PENDING_STATUSES = [DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL, 'PENDING_HR_APPROVAL'];

export const SETTLEMENT_STATUS = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  OWNER_APPROVED: 'OWNER_APPROVED',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
} as const;

export const PAYROLL_STATUS = { DRAFT: 'DRAFT', APPROVED: 'APPROVED', PAID: 'PAID' } as const;

/** Default exit/re-entry visa fee (SAR) used when no SystemSetting overrides it. */
export const DEFAULT_EXIT_REENTRY_VISA_FEE = 200;

/** TransferRequest.status (String column). */
export const TRANSFER_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' } as const;

/** AttendanceCorrection.status (String column). */
export const ATTENDANCE_CORRECTION_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' } as const;

/** Asset.status values (String column). Same values as src/app/api/assets/_lib.ts. */
export const ASSET_STATUS = {
  /** In an employee's custody. */
  ACTIVE: 'ACTIVE',
  /** In the warehouse, available to assign. */
  VACANT: 'VACANT',
  /** Legacy "returned to warehouse" value; treated like VACANT. */
  RETURNED: 'RETURNED',
  DAMAGED: 'DAMAGED',
  /** History row kept for the previous holder after a transfer. */
  TRANSFERRED: 'TRANSFERRED',
} as const;

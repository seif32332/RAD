// The EmployeeFinancialChange model of compensation (P1-PAY-B, BR-PAY-009 / ARC-PAY-A2): its vocabularies
// (the CHECKs of 9zg), the safe view (never the IBAN, its masked form only) and the errors. No writes here:
// the transitions are ./transitions/financial-change.ts.
import type { PaymentMethod, Prisma } from '@prisma/client';
import { HttpError } from '@/lib/http';
import type { CompensationAllowance } from '@/modules/platform';
import { maskedIban } from './bank';

/**
 * The events of the CompensationPeriod facts (written by platform/effective for compensation): payroll
 * consumes them to regenerate the drafts a pay change affects (DOMAIN_BOUNDARIES §5.5: payroll consumes
 * compensation.periodOpened). Aggregate: the period's lineage; the employee is in the payload.
 */
export const COMPENSATION_PERIOD_EVENT_TYPES: readonly string[] = Object.freeze(['compensation.periodOpened', 'compensation.periodSuperseded', 'compensation.periodClosed']);
/**
 * The one-off bonus status that pays (BL-PAY-027, RT-WFE-701): payroll generation, the bonus link and
 * the paid step take APPROVED bonuses only (PENDING / REJECTED / CANCELLED never pay; defensive before
 * BL-WFE-012b makes new bonuses PENDING).
 */
export const PAYABLE_BONUS_STATUS = 'APPROVED';

/** compensation's own event when a bank identity is in force (DOMAIN_BOUNDARIES §5.5 compensation.bankIdentityOpened). */
export const BANK_IDENTITY_OPENED_EVENT = 'compensation.bankIdentityOpened';

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SAUDI_IBAN_SHAPE = /^SA[0-9A-Z]{22}$/;

export const FINANCIAL_CHANGE_FIELDS = ['COMPENSATION', 'BANK_IDENTITY'] as const;
export type FinancialChangeField = (typeof FINANCIAL_CHANGE_FIELDS)[number];
export const FINANCIAL_CHANGE_SOURCES = ['FORM', 'IMPORT', 'ONBOARDING', 'EDIT', 'PORTAL'] as const;
export type FinancialChangeSource = (typeof FINANCIAL_CHANGE_SOURCES)[number];
export const FINANCIAL_CHANGE_STATUSES = ['LEGACY_UNVERIFIED', 'PENDING', 'PENDING_EFFECT', 'APPLIED', 'REJECTED', 'CANCELLED'] as const;
export type FinancialChangeStatus = (typeof FINANCIAL_CHANGE_STATUSES)[number];
/** Statuses that still wait for something (a confirmation, a decision, a date). */
export const OPEN_FINANCIAL_CHANGE_STATUSES: readonly FinancialChangeStatus[] = ['LEGACY_UNVERIFIED', 'PENDING', 'PENDING_EFFECT'];


/** 403 of an IBAN change that does not come from the employee's own portal (BR-PAY-009). */
export class IbanSelfServiceOnlyError extends HttpError {
  constructor() {
    super(403, 'تغيير الآيبان المسجَّل يقدّمه الموظف بنفسه من بوابته الذاتية، ويعتمده شخص ثانٍ', { code: 'IBAN_SELF_SERVICE_ONLY' });
    this.name = 'IbanSelfServiceOnlyError';
  }
}

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

export const FINANCIAL_CHANGE_SELECT = {
  id: true,
  employeeId: true,
  companyId: true,
  field: true,
  source: true,
  status: true,
  effectiveDate: true,
  compensation: true,
  ibanLast4: true,
  bankName: true,
  paymentMethod: true,
  beforeJson: true,
  note: true,
  batchKey: true,
  requestedById: true,
  requestedAt: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  decisionSelfAct: true,
  cancelledById: true,
  cancelledAt: true,
  cancelReason: true,
  appliedAt: true,
  compensationPeriodId: true,
  bankIdentityPeriodId: true,
  legacyFiledByUserIds: true,
} as const satisfies Prisma.EmployeeFinancialChangeSelect;

export type ChangeRow = Prisma.EmployeeFinancialChangeGetPayload<{ select: typeof FINANCIAL_CHANGE_SELECT }>;

/** JSON-safe view of a request: never the IBAN itself (its masked form only). */
export interface FinancialChangeView {
  id: string;
  employeeId: string;
  companyId: string | null;
  field: FinancialChangeField;
  source: FinancialChangeSource;
  status: FinancialChangeStatus;
  effectiveDate: string;
  compensation: { basicSalary: number; allowances: CompensationAllowance[] } | null;
  bank: { paymentMethod: PaymentMethod; bankName: string | null; ibanMasked: string | null } | null;
  before: unknown;
  note: string | null;
  batchKey: string | null;
  requestedById: string | null;
  requestedAt: string;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decisionSelfAct: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  appliedAt: string | null;
}

export function financialChangeView(r: ChangeRow): FinancialChangeView {
  const comp = r.compensation as { basicSalary?: number; allowances?: CompensationAllowance[] } | null;
  return {
    id: r.id,
    employeeId: r.employeeId,
    companyId: r.companyId,
    field: r.field as FinancialChangeField,
    source: r.source as FinancialChangeSource,
    status: r.status as FinancialChangeStatus,
    effectiveDate: r.effectiveDate.toISOString().slice(0, 10),
    compensation: comp ? { basicSalary: Number(comp.basicSalary ?? 0), allowances: comp.allowances ?? [] } : null,
    bank: r.field === 'BANK_IDENTITY' && r.paymentMethod ? { paymentMethod: r.paymentMethod, bankName: r.bankName, ibanMasked: maskedIban(r.ibanLast4) } : null,
    before: r.beforeJson,
    note: r.note,
    batchKey: r.batchKey,
    requestedById: r.requestedById,
    requestedAt: r.requestedAt.toISOString(),
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    decisionSelfAct: r.decisionSelfAct,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    appliedAt: r.appliedAt?.toISOString() ?? null,
  };
}


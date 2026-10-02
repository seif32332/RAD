// The period kinds of P1-FND-EFF and their table (DOMAIN_MODEL §1.3, DOMAIN_BOUNDARIES §5.2).
//
// platform/effective is the ONLY physical writer of the period tables (ARCH-012); the owning module
// (`owner`) is the only caller that may open, close or supersede periods of its kind. The table is
// reached through `delegate` so that one generic primitive serves every kind; later kinds
// (ContractPeriod, GosiRegistrationPeriod) are added here and in the SQL function
// effective_open_legacy_period (migration 9u, extended by their own migration; BankIdentityPeriod by 9zg).
import type { TxClient } from '../tx';

export type PeriodKind = 'EMPLOYMENT' | 'COMPENSATION' | 'ASSIGNMENT' | 'BANK_IDENTITY';
export const PERIOD_KINDS: readonly PeriodKind[] = ['EMPLOYMENT', 'COMPENSATION', 'ASSIGNMENT', 'BANK_IDENTITY'];

/** Why a row stopped being active (supersedeReason). Void = superseded without a successor (ADR-0002 #3). */
export type SupersedeReason = 'CORRECTION' | 'CLOSE' | 'VOID';

/** One recurring allowance inside a compensation period. */
export interface CompensationAllowance {
  name: string;
  /** Payslip line (HOUSING | TRANSPORT | OTHER). */
  line: 'HOUSING' | 'TRANSPORT' | 'OTHER';
  /** The allowance type as recorded (null on old rows classified by name at the legacy opening). */
  allowanceType?: string | null;
  /** SAR, halala precision. */
  amount: number;
  /** Part of the GOSI contributory wage (explicit flag, DEC-003). */
  countsTowardGosi: boolean;
  /** The legacy Allowance row this item came from, when there is one. */
  allowanceId?: string | null;
}

export interface CompensationAttrs {
  /** SAR, halala precision. */
  basicSalary: number;
  allowances: CompensationAllowance[];
  /** Explicit GOSI contributory wage; null = basic + the allowances flagged countsTowardGosi. */
  gosiBaseOverride?: number | null;
}

export interface AssignmentAttrs {
  legalCompanyId: string;
  actualCompanyId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  managerId?: string | null;
  /** The WorkPattern (WorkSchedule row, owner calendar) of the assignment (P1-CAL, 9z_calendar). */
  workPatternId?: string | null;
}

/**
 * The bank identity of an employee (P1-PAY-B, ARC-PAY-A3; 9zg). The IBAN travels encrypted
 * (src/lib/crypto.ts) with its fingerprint (sha256 of the normalized IBAN) and last 4; a CASH identity
 * has none. Never back-dated: compensation opens it on the day it is applied (ADR-0001 #8).
 */
export interface BankIdentityAttrs {
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'WPS';
  ibanEncrypted?: string | null;
  ibanFingerprint?: string | null;
  ibanLast4?: string | null;
  bankName?: string | null;
}

/** The kind's own columns (besides the uniform shape). */
export interface PeriodAttrsByKind {
  EMPLOYMENT: Record<string, never>;
  COMPENSATION: CompensationAttrs;
  ASSIGNMENT: AssignmentAttrs;
  BANK_IDENTITY: BankIdentityAttrs;
}

/** A period row as read from its table (Decimal columns come back as Prisma.Decimal). */
export interface PeriodRow {
  id: string;
  employeeId: string;
  validFrom: Date;
  validTo: Date | null;
  lineageId: string;
  supersedesId: string | null;
  supersededAt: Date | null;
  supersedeReason: string | null;
  sourceType: string;
  sourceId: string;
  recordedAt: Date;
  createdById: string | null;
  [column: string]: unknown;
}

type Where = Record<string, unknown>;
/** The part of a Prisma model delegate the primitive uses (identical on every period table). */
export interface PeriodDelegate {
  findUnique(args: { where: { id: string } }): Promise<PeriodRow | null>;
  findFirst(args: { where: Where; orderBy?: Where | Where[] }): Promise<PeriodRow | null>;
  findMany(args: { where: Where; orderBy?: Where | Where[]; take?: number }): Promise<PeriodRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<PeriodRow>;
  updateMany(args: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/** Any client that can read the period tables (root client or transaction). */
export type PeriodReader = Pick<TxClient, 'employmentPeriod' | 'compensationPeriod' | 'assignmentPeriod' | 'bankIdentityPeriod'>;

export interface PeriodKindSpec {
  kind: PeriodKind;
  model: 'EmploymentPeriod' | 'CompensationPeriod' | 'AssignmentPeriod' | 'BankIdentityPeriod';
  /** The module that owns the table and alone calls the primitive for it (DOMAIN_BOUNDARIES §5.2). */
  owner: 'lifecycle' | 'compensation' | 'org';
  /** Event domain: `<domain>.periodOpened | periodSuperseded | periodClosed` (DOMAIN_BOUNDARIES §5.5). */
  eventDomain: 'employment' | 'compensation' | 'assignment' | 'bankIdentity';
  /** The kind's own columns, copied to a successor unless replaced. */
  attrColumns: readonly string[];
  /**
   * ADR-0001 #9: the end (validTo) is edited in place (EmploymentPeriod only). Every other kind is
   * closed by superseding the row with a shortened successor of the same lineage, so the view "as
   * recorded" before the close stays readable.
   */
  endInPlace: boolean;
  delegate(client: PeriodReader): PeriodDelegate;
}

export const KIND_SPECS: Record<PeriodKind, PeriodKindSpec> = {
  EMPLOYMENT: {
    kind: 'EMPLOYMENT',
    model: 'EmploymentPeriod',
    owner: 'lifecycle',
    eventDomain: 'employment',
    attrColumns: [],
    endInPlace: true,
    delegate: (c) => c.employmentPeriod as unknown as PeriodDelegate,
  },
  COMPENSATION: {
    kind: 'COMPENSATION',
    model: 'CompensationPeriod',
    owner: 'compensation',
    eventDomain: 'compensation',
    attrColumns: ['basicSalary', 'allowances', 'gosiBaseOverride'],
    endInPlace: false,
    delegate: (c) => c.compensationPeriod as unknown as PeriodDelegate,
  },
  ASSIGNMENT: {
    kind: 'ASSIGNMENT',
    model: 'AssignmentPeriod',
    owner: 'org',
    eventDomain: 'assignment',
    attrColumns: ['legalCompanyId', 'actualCompanyId', 'branchId', 'departmentId', 'managerId', 'workPatternId'],
    endInPlace: false,
    delegate: (c) => c.assignmentPeriod as unknown as PeriodDelegate,
  },
  BANK_IDENTITY: {
    kind: 'BANK_IDENTITY',
    model: 'BankIdentityPeriod',
    owner: 'compensation',
    eventDomain: 'bankIdentity',
    attrColumns: ['paymentMethod', 'ibanEncrypted', 'ibanFingerprint', 'ibanLast4', 'bankName'],
    endInPlace: false,
    delegate: (c) => c.bankIdentityPeriod as unknown as PeriodDelegate,
  },
};

export function kindSpec(kind: PeriodKind): PeriodKindSpec {
  const spec = (KIND_SPECS as Record<string, PeriodKindSpec | undefined>)[kind];
  if (!spec) throw new Error(`Unknown period kind "${String(kind)}"`);
  return spec;
}

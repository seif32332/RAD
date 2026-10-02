// effectiveContext (DOMAIN_MODEL §1.3): what was true for one employee on one day, now or as the
// system knew it at a recorded instant. First sources (P1-FND-EFF): employment, compensation,
// assignment. Later packages add state (P1-LCY), contract, GOSI and day type.
//
// Read-only and company-aware: the caller passes the company scope explicitly (no default). The
// scope key is the legal company of the assignment active on that day (DOMAIN_BOUNDARIES §5.4.3),
// so a transferred employee is visible to each company for its own period only.
import { roundMoney, sumMoney } from '@/lib/money';
import type { CompensationAllowance, PeriodReader } from './kinds';
import { activeAt, type ReadOptions } from './periods';
import { dayKey, toDateOnly, type DateOnly } from './shape';

export class EffectiveScopeError extends Error {
  constructor(employeeId: string, day: string) {
    super(`employee ${employeeId} on ${day} is outside the caller's company scope`);
    this.name = 'EffectiveScopeError';
  }
}

export interface EffectiveContextOptions extends ReadOptions {
  /**
   * The caller's companies (the CompanySet of an iam ScopeContext); 'ALL' or null = cross-company
   * (an explicit owner or system context). A scoped caller gets EffectiveScopeError when the day's
   * assignment is outside the scope, or when there is no assignment to decide it (fail closed).
   */
  companyIds: readonly string[] | 'ALL' | null;
}

export interface EmploymentOnDay {
  periodId: string;
  lineageId: string;
  validFrom: string;
  validTo: string | null;
  source: { type: string; id: string };
}

export interface CompensationOnDay {
  periodId: string;
  lineageId: string;
  validFrom: string;
  validTo: string | null;
  source: { type: string; id: string };
  basicSalary: number;
  housing: number;
  transport: number;
  otherAllowances: number;
  allowances: CompensationAllowance[];
  /** Contributory wage before any legal cap (the cap is a rule value, applied by payroll). */
  gosiBase: number;
  gosiBaseOverridden: boolean;
}

export interface AssignmentOnDay {
  periodId: string;
  lineageId: string;
  validFrom: string;
  validTo: string | null;
  source: { type: string; id: string };
  legalCompanyId: string;
  actualCompanyId: string | null;
  branchId: string | null;
  departmentId: string | null;
  managerId: string | null;
  /** The WorkPattern of the assignment (P1-CAL); null on periods opened before 9z_calendar without one. */
  workPatternId: string | null;
}

export interface EffectiveContext {
  employeeId: string;
  date: string;
  asRecordedAt: string | null;
  /** A non-superseded employment period covers the day. */
  inService: boolean;
  employment: EmploymentOnDay | null;
  compensation: CompensationOnDay | null;
  assignment: AssignmentOnDay | null;
}

/** Totals of a compensation period's allowances by payslip line, and the GOSI base. */
export function summarizeCompensation(basicSalary: number, allowances: readonly CompensationAllowance[], gosiBaseOverride: number | null) {
  const byLine = (line: CompensationAllowance['line']) => sumMoney(allowances.filter((a) => a.line === line).map((a) => a.amount));
  const gosiBase = gosiBaseOverride ?? sumMoney([basicSalary, ...allowances.filter((a) => a.countsTowardGosi).map((a) => a.amount)]);
  return {
    housing: byLine('HOUSING'),
    transport: byLine('TRANSPORT'),
    otherAllowances: byLine('OTHER'),
    gosiBase: roundMoney(gosiBase),
    gosiBaseOverridden: gosiBaseOverride !== null,
  };
}

export async function effectiveContext(db: PeriodReader, employeeId: string, date: DateOnly, opts: EffectiveContextOptions): Promise<EffectiveContext> {
  if (!opts || !('companyIds' in opts)) throw new Error('effectiveContext: companyIds is required (null only for an explicit cross-company context)');
  const day = toDateOnly(date, 'date');
  const read: ReadOptions = { asRecordedAt: opts.asRecordedAt ?? null };
  const [employment, compensation, assignment] = await Promise.all([
    activeAt(db, 'EMPLOYMENT', employeeId, day, read),
    activeAt(db, 'COMPENSATION', employeeId, day, read),
    activeAt(db, 'ASSIGNMENT', employeeId, day, read),
  ]);

  if (opts.companyIds !== null && opts.companyIds !== 'ALL') {
    const company = assignment?.attrs.legalCompanyId as string | undefined;
    if (!company || !opts.companyIds.includes(company)) throw new EffectiveScopeError(employeeId, dayKey(day));
  }

  let comp: CompensationOnDay | null = null;
  if (compensation) {
    const basic = Number(compensation.attrs.basicSalary);
    const allowances = (compensation.attrs.allowances ?? []) as CompensationAllowance[];
    const override = compensation.attrs.gosiBaseOverride === null || compensation.attrs.gosiBaseOverride === undefined ? null : Number(compensation.attrs.gosiBaseOverride);
    comp = {
      periodId: compensation.id,
      lineageId: compensation.lineageId,
      validFrom: compensation.validFrom,
      validTo: compensation.validTo,
      source: compensation.source,
      basicSalary: basic,
      allowances,
      ...summarizeCompensation(basic, allowances, override),
    };
  }

  return {
    employeeId,
    date: dayKey(day),
    asRecordedAt: opts.asRecordedAt ? opts.asRecordedAt.toISOString() : null,
    inService: !!employment,
    employment: employment
      ? { periodId: employment.id, lineageId: employment.lineageId, validFrom: employment.validFrom, validTo: employment.validTo, source: employment.source }
      : null,
    compensation: comp,
    assignment: assignment
      ? {
          periodId: assignment.id,
          lineageId: assignment.lineageId,
          validFrom: assignment.validFrom,
          validTo: assignment.validTo,
          source: assignment.source,
          legalCompanyId: assignment.attrs.legalCompanyId as string,
          actualCompanyId: (assignment.attrs.actualCompanyId as string | null) ?? null,
          branchId: (assignment.attrs.branchId as string | null) ?? null,
          departmentId: (assignment.attrs.departmentId as string | null) ?? null,
          managerId: (assignment.attrs.managerId as string | null) ?? null,
          workPatternId: (assignment.attrs.workPatternId as string | null) ?? null,
        }
      : null,
  };
}

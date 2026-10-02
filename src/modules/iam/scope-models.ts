// Which models are company-scoped, and how each row's company is found (DOMAIN_BOUNDARIES §5.4.3).
//
// Derived from the Prisma schema at load time (Prisma.dmmf), with the same definition as the ARCH-006
// conformance check (src/test/architecture/rules.ts companyScoped): a model with a companyId /
// legalCompanyId / actualCompanyId / employeeId column, or Employee, except the platform and iam
// infrastructure tables (§5.4.2: cross-company by nature: audit, outbox, users). So a new model with
// one of these columns is scoped the day it is added, without editing this file.
//
// How the company of a row is resolved, in this order:
//   Company                      → its id
//   Employee                     → legalCompanyId (the projection of the effective AssignmentPeriod,
//                                  §5.4.3 people/lifecycle/compensation; P3-ORG replaces the projection
//                                  by the period itself, the rule here stays "legal company")
//   companyId column             → companyId            (Branch, JobRequest, OnboardingRequest, …)
//   legalCompanyId column        → legalCompanyId       (documents, Vehicle, UtilityMeter; never the
//                                  actual company: the scope key is the legal entity, §5.4.3 documents)
//   employeeId + relation        → the employee's legalCompanyId (Leave, Payroll, Attendance, …: time /
//                                  leave / payroll rows follow their employee; the "assignment at the
//                                  record date" of §5.4.3 arrives with AssignmentPeriod in P3-ORG)
//   employeeId without relation  → 'employee-column': filterable by the employee id only (Self);
//                                  under a company-restricted Scoped / Team context the query is
//                                  REFUSED (EmployeeChangeOrder, DocumentAcknowledgement)
//   Department                   → its branch's companyId (no own column; listed in INDIRECT)
//
// Not covered (reach them through an in-scope parent, or they get a column in P1-SCOPE / P1-FND-DB):
// child tables without a company or employee column (LoanInstallment, DocumentApproval, …) and nested
// reads/writes through include/select/relation writes.
import { Prisma } from '@prisma/client';

export type ScopeRule =
  | { kind: 'company' }
  | { kind: 'employee' }
  | { kind: 'column'; column: string; relation: string | null }
  | { kind: 'via-employee'; relation: string }
  | { kind: 'employee-column' }
  | { kind: 'via-parent'; relation: string; parentColumn: string };

/** platform and iam tables (§5.2): infrastructure, cross-company by design. */
export const INFRA_MODELS: readonly string[] = [
  'AuditLog',
  'AuditRecord',
  'SystemSetting',
  'JobRun',
  'NotificationOutbox',
  'UploadedFile',
  'DomainEvent',
  'EventConsumption',
  'OperationLog',
  'Discrepancy',
  'InvariantRun',
  'User',
  'RolePermission',
  'UserCompanyScope',
  'Permission',
  'RoleGrant',
  'MfaFactor',
];

/** Scoped models without a company column of their own: the relation to the parent that has one. */
const INDIRECT: Record<string, { relation: string; parentColumn: string }> = {
  Department: { relation: 'branch', parentColumn: 'companyId' },
};

type DmmfField = { name: string; kind: string; type: string; relationFromFields?: readonly string[] | null };

function relationFor(fields: readonly DmmfField[], column: string, type?: string): string | null {
  const f = fields.find(
    (x) => x.kind === 'object' && (!type || x.type === type) && x.relationFromFields?.length === 1 && x.relationFromFields[0] === column,
  );
  return f?.name ?? null;
}

export function buildScopeRules(models: readonly { name: string; fields: readonly DmmfField[] }[]): Map<string, ScopeRule> {
  const out = new Map<string, ScopeRule>();
  for (const m of models) {
    if (INFRA_MODELS.includes(m.name)) continue;
    const has = (c: string) => m.fields.some((f) => f.name === c && f.kind === 'scalar');
    if (m.name === 'Company') out.set(m.name, { kind: 'company' });
    else if (m.name === 'Employee') out.set(m.name, { kind: 'employee' });
    else if (INDIRECT[m.name]) out.set(m.name, { kind: 'via-parent', ...INDIRECT[m.name] });
    else if (has('companyId')) out.set(m.name, { kind: 'column', column: 'companyId', relation: relationFor(m.fields, 'companyId') });
    else if (has('legalCompanyId')) out.set(m.name, { kind: 'column', column: 'legalCompanyId', relation: relationFor(m.fields, 'legalCompanyId') });
    else if (has('actualCompanyId')) out.set(m.name, { kind: 'column', column: 'actualCompanyId', relation: relationFor(m.fields, 'actualCompanyId') });
    else if (has('employeeId')) {
      const relation = relationFor(m.fields, 'employeeId', 'Employee');
      out.set(m.name, relation ? { kind: 'via-employee', relation } : { kind: 'employee-column' });
    }
  }
  return out;
}

/** The scope rule of every company-scoped model of the schema. */
export const SCOPE_RULES: ReadonlyMap<string, ScopeRule> = buildScopeRules(
  Prisma.dmmf.datamodel.models as unknown as { name: string; fields: DmmfField[] }[],
);

export function scopeRuleOf(model: string): ScopeRule | undefined {
  return SCOPE_RULES.get(model);
}

/** Company-scoped model names (for docs, tests and reports). */
export function companyScopedModels(): string[] {
  return [...SCOPE_RULES.keys()].sort();
}

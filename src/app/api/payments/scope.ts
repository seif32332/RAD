// Company scope of payment requests (P1-SCOPE part B).
//
// PaymentRequest has no company column (a gap of the schema: the proper fix is a companyId set by every
// writer, P1-FND-DB). Until then its company is derived from the record it pays for: an employee, a
// visa / settlement / loan (their employee), a company, a branch or a vehicle. A request without a
// resolvable company (a free-form request typed on the payments screen) is visible to an unrestricted
// user and to the user who filed it only (fail closed for everyone else).
import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { ALL_COMPANIES, type ScopeContext } from '@/modules/iam';

type Linked = { id: string; entityType: string | null; entityId: string | null; requestedById: string | null };

/** Company of each payment request (null = none resolvable). Unscoped reads by id, batched per type. */
export async function paymentCompanies(db: PrismaClient, rows: readonly Linked[]): Promise<Map<string, string | null>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type && r.entityId).map((r) => r.entityId as string))];
  const byEmployee = (list: { id: string; employee: { legalCompanyId: string | null } | null }[]) =>
    new Map(list.map((x) => [x.id, x.employee?.legalCompanyId ?? null]));
  const emp = { select: { legalCompanyId: true } } as const;
  const [employees, visas, settlements, loans, branches, vehicles] = await Promise.all([
    db.employee.findMany({ where: { id: { in: ids('EMPLOYEE') } }, select: { id: true, legalCompanyId: true } }),
    db.visa.findMany({ where: { id: { in: ids('VISA') } }, select: { id: true, employee: emp } }),
    db.settlement.findMany({ where: { id: { in: ids('SETTLEMENT') } }, select: { id: true, employee: emp } }),
    db.loan.findMany({ where: { id: { in: ids('LOAN') } }, select: { id: true, employee: emp } }),
    db.branch.findMany({ where: { id: { in: ids('BRANCH') } }, select: { id: true, companyId: true } }),
    db.vehicle.findMany({ where: { id: { in: ids('VEHICLE') } }, select: { id: true, legalCompanyId: true } }),
  ]);
  const company: Record<string, Map<string, string | null>> = {
    EMPLOYEE: new Map(employees.map((e) => [e.id, e.legalCompanyId])),
    VISA: byEmployee(visas),
    SETTLEMENT: byEmployee(settlements),
    LOAN: byEmployee(loans),
    BRANCH: new Map(branches.map((b) => [b.id, b.companyId])),
    VEHICLE: new Map(vehicles.map((v) => [v.id, v.legalCompanyId])),
  };
  const out = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.entityType || !r.entityId) out.set(r.id, null);
    else if (r.entityType === 'COMPANY') out.set(r.id, r.entityId);
    else out.set(r.id, company[r.entityType]?.get(r.entityId) ?? null);
  }
  return out;
}

/** Whether the context may see / act on a payment request of `companyId` (see the header). */
export function paymentInScope(ctx: ScopeContext, row: Pick<Linked, 'requestedById'>, companyId: string | null): boolean {
  if (ctx.companies === ALL_COMPANIES) return true;
  if (companyId) return ctx.companies.includes(companyId);
  return ctx.kind !== 'system' && !!row.requestedById && row.requestedById === ctx.actor.userId;
}

/** The rows of `rows` inside the context. */
export async function filterPaymentsInScope<T extends Linked>(db: PrismaClient, ctx: ScopeContext, rows: readonly T[]): Promise<T[]> {
  if (ctx.companies === ALL_COMPANIES) return [...rows];
  const companies = await paymentCompanies(db, rows);
  return rows.filter((r) => paymentInScope(ctx, r, companies.get(r.id) ?? null));
}

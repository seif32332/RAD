// People-layer resolvers for the iam Self and Team contexts (P1-FND-SCOPE).
//
// iam sits below people and org (DOMAIN_BOUNDARIES §5.3) and does not read their tables (ARCH-001), so
// the session employee's placement (legal company, branch, department) is loaded here, in people's
// code, and handed to the iam constructors. The employee is always the session's (actor.employeeId),
// never a client value (EV-6008). Moves to src/modules/people when that module is created (§5.1).
import type { Prisma, PrismaClient } from '@prisma/client';
import { selfContext, teamContext, type Actor, type EmployeePlacement, type SelfContext, type TeamContext } from '@/modules/iam';

type Db = PrismaClient | Prisma.TransactionClient;

async function placementOf(db: Db, actor: Actor): Promise<EmployeePlacement | null> {
  if (!actor?.employeeId) return null;
  return db.employee.findUnique({
    where: { id: actor.employeeId },
    select: { legalCompanyId: true, branchId: true, departmentId: true },
  });
}

/** SelfContext of the session employee (403 when the account has no employee). */
export async function resolveSelfContext(db: Db, actor: Actor): Promise<SelfContext> {
  return selfContext(actor, await placementOf(db, actor));
}

/** TeamContext of the session manager: his team inside his legal company ∩ his company scope. */
export async function resolveTeamContext(db: Db, actor: Actor): Promise<TeamContext> {
  return teamContext(actor, await placementOf(db, actor));
}

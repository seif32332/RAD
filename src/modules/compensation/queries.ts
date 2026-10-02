// compensation read side used by the modules above (payroll's BR-PAY-002 approvers of a line's inputs).
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Who approved the bonuses the given payroll lines pay (BR-PAY-002: approvers of the line's inputs). */
export async function bonusApproversOfLines(db: Db, payrollIds: readonly string[]): Promise<string[]> {
  if (!payrollIds.length) return [];
  const rows = await db.allowance.findMany({
    where: { paidInPayrollId: { in: [...payrollIds] }, approvedById: { not: null } },
    select: { approvedById: true },
    distinct: ['approvedById'],
  });
  return rows.map((r) => r.approvedById as string);
}

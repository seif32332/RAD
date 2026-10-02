// time read side used by the modules above (payroll's BR-PAY-002 approvers of a line's inputs).
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Who decided the overtime the given payroll lines pay (BR-PAY-002: approvers of the line's inputs). */
export async function overtimeApproversOfLines(db: Db, payrollIds: readonly string[]): Promise<string[]> {
  if (!payrollIds.length) return [];
  const rows = await db.overtimeRequest.findMany({
    where: { paidInPayrollId: { in: [...payrollIds] }, decidedById: { not: null } },
    select: { decidedById: true },
    distinct: ['decidedById'],
  });
  return rows.map((r) => r.decidedById as string);
}

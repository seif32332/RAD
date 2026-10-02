// "Is the employee on leave on day D?" read from approved Leave rows (BR-LCY-008, DEC-PO-030,
// BL-LCY-002 Release A). The rule itself is onLeaveWhere / leaveCoversDay in src/lib/leave.ts; this
// file only runs it against the database. Nothing here writes: "on leave" is never stored.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { onLeaveWhere, type LeaveDay } from '@/lib/leave';

type Db = Prisma.TransactionClient;

/** True when an approved (or completed) leave of the employee covers `day`. */
export async function isOnLeave(db: Db, employeeId: string, day: LeaveDay): Promise<boolean> {
  const row = await db.leave.findFirst({ where: { employeeId, ...onLeaveWhere(day) }, select: { id: true } });
  return row !== null;
}

/** Batch form for lists: the subset of `employeeIds` on leave on `day` (one query). */
export async function onLeaveEmployeeIds(db: Db, employeeIds: readonly string[], day: LeaveDay): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db.leave.findMany({
    where: { employeeId: { in: [...employeeIds] }, ...onLeaveWhere(day) },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });
  return new Set(rows.map((r) => r.employeeId));
}

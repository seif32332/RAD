// BR-PAY-009 (pay-to-be §12): while an employee is not ready for pay (payrollReady = false: his salary, or
// his bank identity when he is paid by bank, is not applied yet), the acts that produce money for him are
// refused: a leave with a deduction, an overtime approval, a penalty, a settlement, a loan. The flag is
// compensation's projection (ARC-PAY-A4; every existing employee is ready, DEC-PO-017 LEGACY_READY).
import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError, notFound } from '@/lib/http';
import { employeeForCompensation } from '@/modules/people';

type Db = PrismaClient | Prisma.TransactionClient;

/** 409 of a money act on an employee whose pay is not applied yet. */
export class EmployeeNotPayrollReadyError extends HttpError {
  constructor(employeeId: string) {
    super(409, 'الموظف غير جاهز للصرف بعد: راتبه أو بيانات صرفه بانتظار اعتماد طلب التغيير المالي', { code: 'EMPLOYEE_NOT_PAYROLL_READY', employeeId });
    this.name = 'EmployeeNotPayrollReadyError';
  }
}

export async function assertPayrollReady(db: Db, employeeId: string): Promise<void> {
  const emp = await employeeForCompensation(db, employeeId);
  if (!emp) throw notFound('الموظف غير موجود');
  if (!emp.payrollReady) throw new EmployeeNotPayrollReadyError(employeeId);
}

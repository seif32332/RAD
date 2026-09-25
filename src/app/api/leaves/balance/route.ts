// GET /api/leaves/balance?employeeId=&asOf=YYYY-MM-DD
// Annual leave balance computed with the single formula in src/lib/leave.ts.
// HR / payroll may query any employee; branch / department managers only the employees they
// manage (assertCanManageEmployee); everyone else gets their own balance.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { forbidden, handleApiError, parseQuery } from '@/lib/http';
import { zId, zOptDate } from '@/lib/validation';
import { assertCanManageEmployee, getEmployeeLeaveBalance } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

const BALANCE_READ_ANY = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.PAYROLL])];

const query = z.object({ employeeId: zId.optional(), asOf: zOptDate });

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const q = parseQuery(req, query);
    let employeeId: string;
    if (q.employeeId && roleIn(user.role, BALANCE_READ_ANY)) {
      employeeId = q.employeeId;
    } else if (q.employeeId && q.employeeId !== user.employeeId && roleIn(user.role, ROLE_GROUPS.MANAGERS)) {
      const employee = await prisma.employee.findUnique({
        where: { id: q.employeeId },
        select: { id: true, directManagerId: true, branchId: true, departmentId: true },
      });
      // Same answer as an out-of-scope employee: managers cannot probe which ids exist.
      if (!employee) throw forbidden('هذا الموظف ليس ضمن نطاق إدارتك');
      await assertCanManageEmployee(prisma, user, employee);
      employeeId = employee.id;
    } else {
      employeeId = await requireEmployeeId(user);
      if (q.employeeId && q.employeeId !== employeeId) throw forbidden();
    }
    const balance = await getEmployeeLeaveBalance(prisma, employeeId, { asOf: q.asOf ?? undefined });
    return NextResponse.json({ employeeId, ...balance });
  } catch (err) {
    return handleApiError(err, 'leaves/balance:GET');
  }
}

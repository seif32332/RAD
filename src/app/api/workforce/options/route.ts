// GET /api/workforce/options — filter lists of the workforce pages: legal companies, branches, departments
// and the active employees (id, name, number, company, branch, department) for the pickers.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const [companies, branches, departments, employees] = await Promise.all([
      prisma.company.findMany({ select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
      prisma.branch.findMany({ select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
      prisma.department.findMany({ select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
      prisma.employee.findMany({
        where: { isTerminated: false },
        select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, legalCompanyId: true, branchId: true, departmentId: true },
        orderBy: [{ firstNameArabic: 'asc' }, { id: 'asc' }],
        take: 5000,
      }),
    ]);
    return NextResponse.json({
      role: user.role,
      companies: companies.map((c) => ({ id: c.id, name: c.nameArabic })),
      branches: branches.map((b) => ({ id: b.id, name: b.nameArabic })),
      departments: departments.map((d) => ({ id: d.id, name: d.nameArabic })),
      employees: employees.map((e) => ({
        id: e.id,
        employeeNo: e.employeeId,
        name: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() || e.employeeId || e.id,
        companyId: e.legalCompanyId,
        branchId: e.branchId,
        departmentId: e.departmentId,
      })),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:options:GET');
  }
}

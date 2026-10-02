import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { managedEmployeesWhere } from '@/lib/hr-workflows';
import { resolveTeamContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const MAX_QUERY_LENGTH = 100;

/**
 * GET ?q=... — global search (employees / branches / companies), minimal fields only.
 * Branch / department managers only find employees of their own team.
 * P1-SCOPE: results come from the user's context (TeamContext for the two manager roles, ScopedContext
 * otherwise): nothing of a company outside it is found.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);

    if (!q) {
      return NextResponse.json({ results: { employees: [], companies: [], branches: [] } });
    }

    const contains = { contains: q, mode: 'insensitive' as const };
    const isTeam = user.role === 'BRANCH_MANAGER' || user.role === 'DEPT_MANAGER';
    const actor = await resolveActor(prisma, user);
    const ctx = isTeam ? await resolveTeamContext(prisma, actor) : scopedContext(actor);
    authz.assert(ctx, 'search.run');
    const db = scopedPrisma(ctx);
    const teamScope = isTeam ? await managedEmployeesWhere(prisma, user) : null;

    const [employees, branches, companies] = await Promise.all([
      db.employee.findMany({
        where: {
          ...(teamScope ? { AND: [teamScope] } : {}),
          OR: [
            { firstNameArabic: contains },
            { lastNameArabic: contains },
            { firstNameEnglish: contains },
            { lastNameEnglish: contains },
            { employeeId: contains },
          ],
        },
        take: 20,
        orderBy: { firstNameArabic: 'asc' },
        select: {
          id: true,
          employeeId: true,
          firstNameArabic: true,
          lastNameArabic: true,
          jobTitle: true,
          department: { select: { id: true, nameArabic: true } },
          branch: { select: { id: true, nameArabic: true } },
        },
      }),
      db.branch.findMany({
        where: { OR: [{ nameArabic: contains }, { nameEnglish: contains }] },
        take: 10,
        select: { id: true, nameArabic: true, nameEnglish: true },
      }),
      db.company.findMany({
        where: { OR: [{ nameArabic: contains }, { nameEnglish: contains }, { commercialRegNum: contains }] },
        take: 10,
        select: { id: true, nameArabic: true, nameEnglish: true, commercialRegNum: true },
      }),
    ]);

    return NextResponse.json({
      results: {
        employees,
        branches,
        // registrationNumber is what the search page displays.
        companies: companies.map((c) => ({ ...c, registrationNumber: c.commercialRegNum })),
      },
    });
  } catch (err) {
    return handleApiError(err, 'search:GET');
  }
}

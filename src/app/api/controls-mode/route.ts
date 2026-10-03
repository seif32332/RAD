// The controls mode for the persistent banner (BL-PAY-021; pay-to-be.md BR-PAY-020 "شريط دائم"; DEC-PO-144: per
// legal company). Any signed-in user. The answer covers THE VIEWER'S companies only: a staff user's company scope
// (every company for an owner role or no scope row), an employee's own employee file's company. It names the
// viewer's companies that are SINGLE_OPERATOR (by name, never an id), and no person or amount. Financial approvers
// also get the control gaps they must know (the owner contact missing at Radeef, a digest that could not be
// delivered, confirmations waiting for the owner). Read only; each company's mode comes from the one resolver
// (computed from the attested approvers and Radeef's readiness mark), never from a setting or the client.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { handleApiError } from '@/lib/http';
import { ALL_COMPANIES, actorCompanies, controlsNotice, SINGLE_OPERATOR_BANNER } from '@/modules/iam';
import { companyNames, listCompanyIds } from '@/modules/org';
import { legalCompanyOfEmployees } from '@/modules/people';
import { resolveOperatorMode } from '@/modules/platform';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    let scope: 'ALL' | readonly string[];
    if (user.role === 'EMPLOYEE') {
      const own = user.employeeId ? await legalCompanyOfEmployees(prisma, [user.employeeId]) : null;
      scope = own ? [own] : [];
    } else {
      const set = await actorCompanies(prisma, user);
      scope = set === ALL_COMPANIES ? 'ALL' : (set as readonly string[]);
    }
    const companyIds = scope === 'ALL' ? await listCompanyIds(prisma) : [...scope];
    const single: string[] = [];
    for (const id of companyIds) if ((await resolveOperatorMode(prisma, id)) === 'SINGLE_OPERATOR') single.push(id);
    const names = await companyNames(prisma, single);
    const companies = single.map((id) => names.get(id) ?? '—').sort((a, b) => a.localeCompare(b));
    const notices = await controlsNotice(prisma, { role: user.role, companyIds: scope, singleCompanyIds: single });
    return NextResponse.json(
      {
        mode: single.length ? 'SINGLE_OPERATOR' : 'ENFORCED',
        banner: single.length ? `${SINGLE_OPERATOR_BANNER} (${companies.join('، ')})` : null,
        companies,
        notices,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    return handleApiError(err, 'controls-mode:GET');
  }
}

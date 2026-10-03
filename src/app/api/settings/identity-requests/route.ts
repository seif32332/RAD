import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { ALL_COMPANIES, authz, resolveActor, scopedContext } from '@/modules/iam';

export const dynamic = 'force-dynamic';

// BL-PAY-005 (DEC-PO-021 / 024): the pending two-person identity changes (deactivation, role change or
// credential reset of an account that counts toward ENFORCED).
//   - a tenant-wide admin (every company) sees every pending request;
//   - any other signed-in user sees only the requests about HIS OWN account (he may consent to them).
// User has no company (§5.4.2): a company-restricted admin is treated like any other user here.

const SELECT = {
  id: true,
  userId: true,
  kind: true,
  nextRole: true,
  status: true,
  requestedById: true,
  requestedAt: true,
  reason: true,
  user: { select: { email: true, name: true, role: true } },
  requestedBy: { select: { email: true, name: true } },
} as const;

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    let tenantWide = false;
    if (roleIn(user.role, ROLE_GROUPS.ADMIN)) {
      try {
        const ctx = scopedContext(await resolveActor(prisma, user), ALL_COMPANIES);
        authz.assert(ctx, 'platform.settings.manage');
        tenantWide = true;
      } catch {
        tenantWide = false;
      }
    }
    const requests = await prisma.identityChangeRequest.findMany({
      where: { status: 'PENDING', ...(tenantWide ? {} : { userId: user.id }) },
      orderBy: { requestedAt: 'asc' },
      select: SELECT,
    });
    return NextResponse.json({ requests, tenantWide });
  } catch (err) {
    return handleApiError(err, 'identity-requests:GET');
  }
}

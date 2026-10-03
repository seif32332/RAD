import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { ALL_COMPANIES, authz, decideChangeRequest, resolveActor, runIdentityTransaction, scopedContext } from '@/modules/iam';
import { moneyActorOf } from '@/modules/platform';
import { loadSecurityPolicy } from '../../security';

export const dynamic = 'force-dynamic';

// POST /api/settings/identity-requests/:id { decision: APPROVE | REJECT | CANCEL, note? } (BL-PAY-005;
// DEC-PO-021 / 024): the second person of a pending identity change.
//   - the account's holder may APPROVE (consent) or REJECT a change about himself, whatever his role;
//   - otherwise only a tenant-wide admin (every company), and the transition requires him to be another
//     attested person with a financial approver role, never the requester;
//   - the requester CANCELs his own request.
// Approving executes the change in the same transaction (a reset issues the holder's one-time link).

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'CANCEL']), note: zOptText(1000) });

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const id = zId.parse((await params).id);
    const body = await parseBody(req, Body);
    const request = await prisma.identityChangeRequest.findUnique({ where: { id }, select: { userId: true, requestedById: true } });
    if (!request) throw notFound('طلب التغيير غير موجود');
    const isHolder = request.userId === user.id;
    const isRequester = request.requestedById === user.id;
    if (!isHolder && !(isRequester && body.decision === 'CANCEL')) {
      if (!ROLE_GROUPS.ADMIN.includes(user.role)) throw forbidden();
      const ctx = scopedContext(await resolveActor(prisma, user), ALL_COMPANIES);
      authz.assert(ctx, 'platform.settings.manage');
    }
    const { credentialLinkHours } = await loadSecurityPolicy();
    const idem = req.headers.get('idempotency-key')?.slice(0, 100) || randomUUID();
    const r = await runIdentityTransaction(prisma, (tx) =>
      decideChangeRequest(tx, {
        actor: moneyActorOf(user),
        requestId: id,
        decision: body.decision,
        note: body.note ?? null,
        linkHours: credentialLinkHours,
        operationKey: `identity.request.${body.decision.toLowerCase()}:${user.id}:${id}:${idem}`,
        ipAddress: getClientIp(req),
      }),
    );
    const message =
      body.decision === 'CANCEL' ? 'تم إلغاء الطلب' : body.decision === 'REJECT' ? 'تم رفض الطلب' : 'تمت الموافقة على الطلب وتنفيذه';
    return NextResponse.json({ message, request: r.request, executed: r.executed, replayed: r.replayed });
  } catch (err) {
    return handleApiError(err, 'identity-requests/[id]:POST');
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { zOptText } from '@/lib/validation';
import { authz, resolveActor, scopedContext } from '@/modules/iam';
import { prisma } from '@/lib/prisma';
import { actOnChange, financialChangeView, loadScopedChange, withEmployees } from '../_shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/financial-changes/:id — one request of the user's companies (404 for another company's). */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'compensation.change.read');
    const { id } = await params;
    const [change] = await withEmployees(ctx, [financialChangeView(await loadScopedChange(ctx, id))]);
    return NextResponse.json({ change });
  } catch (err) {
    return handleApiError(err, 'financial-changes/[id]:GET');
  }
}

const actionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'CANCEL']),
  note: zOptText(1000),
});

/**
 * POST /api/financial-changes/:id { action: APPROVE | REJECT | CANCEL, note? } — the second person's
 * decision (BR-PAY-009; never the requester, never the employee; SINGLE_OPERATOR: recorded self-act), or
 * the withdrawal of a request not applied yet. An approval whose effective date has come is in force at
 * once (a pay change dated inside an approved payroll month is refused, 409 PAYROLL_MONTH_FINALIZED).
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    const { id } = await params;
    const b = await parseBody(req, actionSchema);
    const r = await actOnChange(user, ctx, id, b.action, { note: b.note ?? null, idempotencyKey: req.headers.get('idempotency-key'), ipAddress: getClientIp(req) });
    const message =
      b.action === 'CANCEL'
        ? 'تم إلغاء طلب التغيير المالي'
        : b.action === 'REJECT'
          ? 'تم رفض طلب التغيير المالي'
          : r.applied
            ? 'تم اعتماد طلب التغيير المالي وتطبيقه'
            : 'تم اعتماد طلب التغيير المالي، ويُطبَّق في تاريخ نفاذه';
    return NextResponse.json({ message, change: r.change, applied: r.applied ?? false, selfAct: r.selfAct ?? false, replayed: r.replayed });
  } catch (err) {
    return handleApiError(err, 'financial-changes/[id]:POST');
  }
}

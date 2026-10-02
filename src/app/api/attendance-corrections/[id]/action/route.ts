import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { handleApiError, parseBody, badRequest, notFound } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { approveAttendanceCorrection, rejectAttendanceCorrection } from '@/lib/hr-workflows';
import { resolveTeamContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const actionSchema = z.object({
  action: z.enum(['APPROVE_MANAGER', 'APPROVE_HR', 'REJECT']),
  /** Optional reviewer comment / rejection reason. */
  comment: zOptText(1000),
  reason: zOptText(1000),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const { id: rawId } = await params;
    const id = zId.parse(rawId);
    const body = await parseBody(req, actionSchema);
    const ipAddress = getClientIp(req);
    const note = body.comment ?? body.reason ?? null;

    // P1-SCOPE: HR decides in its companies, a manager in his team (own company); a correction outside
    // the context is "not found" before the workflow helper runs.
    const actor = await resolveActor(prisma, user);
    const ctx = roleIn(user.role, ROLE_GROUPS.HR) ? scopedContext(actor) : await resolveTeamContext(prisma, actor);
    authz.assert(ctx, 'attendance.correction.decide');
    const target = await scopedPrisma(ctx).attendanceCorrection.findUnique({ where: { id }, select: { id: true } });
    if (!target) throw notFound('طلب التصحيح غير موجود');

    if (body.action === 'REJECT') {
      // A rejection must say why: the reason is shown to the employee in the portal.
      if (!note || note.trim().length < 3) throw badRequest('سبب الرفض مطلوب');
      await prisma.$transaction((tx) => rejectAttendanceCorrection(tx, id, user, note, { ipAddress }));
      return NextResponse.json({ message: 'تم رفض طلب تصحيح البصمة' });
    }

    const stage = body.action === 'APPROVE_MANAGER' ? 'MANAGER' : 'HR';
    const result = await prisma.$transaction((tx) =>
      approveAttendanceCorrection(tx, id, user, { stage, comment: note, ipAddress }),
    );
    return NextResponse.json({ message: result.message, outcome: result.outcome });
  } catch (err) {
    return handleApiError(err, 'attendance-corrections/[id]/action:POST');
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, badRequest } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { approveAttendanceCorrection, rejectAttendanceCorrection } from '@/lib/hr-workflows';

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

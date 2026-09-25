import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { conflict, forbidden, handleApiError, parseBody } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { lockEmployeeForUpdate } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

/** Termination types offered by the employee portal. */
const TERMINATION_TYPES = ['END_OF_CONTRACT', 'RESIGNATION', 'MUTUAL_AGREEMENT'] as const;
const TERMINATION_PENDING = 'PENDING';

const createSchema = z.object({
  /** Legacy: the page still sends it; it must match the session employee. */
  employeeId: zId.optional(),
  terminationType: z.enum(TERMINATION_TYPES, { errorMap: () => ({ message: 'نوع إنهاء العقد غير صالح' }) }),
  reasonDetails: zOptText(4000),
});

/** POST /api/portal/termination — the logged-in employee requests to end their contract. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const employeeId = await requireEmployeeId(user);
    const body = await parseBody(req, createSchema);
    if (body.employeeId && body.employeeId !== employeeId) throw forbidden('لا يمكنك تقديم طلب لموظف آخر');

    const request = await prisma.$transaction(async (tx) => {
      // Serialize concurrent submissions for this employee so only one pending request exists.
      await lockEmployeeForUpdate(tx, employeeId);
      const pending = await tx.terminationRequest.findFirst({
        where: { employeeId, status: TERMINATION_PENDING },
        select: { id: true },
      });
      if (pending) throw conflict('لديك طلب إنهاء عقد قيد المراجعة بالفعل');

      const created = await tx.terminationRequest.create({
        data: {
          employeeId,
          terminationType: body.terminationType,
          reasonDetails: body.reasonDetails ?? null,
          status: TERMINATION_PENDING,
        },
      });

      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'TerminationRequest',
          entityId: created.id,
          details: { employeeId, terminationType: created.terminationType },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    return NextResponse.json(request, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'portal/termination:POST');
  }
}

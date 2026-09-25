import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, jsonError, notFound, parseBody } from '@/lib/http';
import { featureSettlePath, reconcileTransaction } from '@/lib/muqeem';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Same roles as reconcileTransaction() and the feature screens' reconcile actions. */
const ROLES = ROLE_GROUPS.GOV;

const zNote = z.string().trim().min(3, 'اكتب ملاحظة توضح كيف تحققت من النتيجة في مقيم').max(1000);

const BodySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('SUCCEEDED'),
    externalRef: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9_-]*$/, 'المرجع يجب أن يتكون من أرقام أو حروف لاتينية فقط')
      .optional()
      .transform((v) => (v ? v : undefined)),
    note: zNote,
  }),
  z.object({ status: z.literal('FAILED'), note: zNote }),
]);

/**
 * POST /api/integrations/muqeem/transactions/{id}/reconcile  (ROLE_GROUPS.GOV)
 * { status: 'SUCCEEDED', externalRef?, note } | { status: 'FAILED', note }
 * Settles an UNKNOWN (or stale PENDING) transaction after the operator checked Muqeem's interactive
 * services report. Only for operations WITHOUT a feature screen: visas (EXIT_REENTRY_*), iqama /
 * passport updates and final exits are refused here with 409 { code: 'SETTLE_IN_FEATURE', settleAt },
 * because settling them here would leave the visa / iqama / settlement in its old state and the next
 * request from that screen would pay for a second operation.
 * 409 also when the transaction is not undetermined (e.g. already reconciled).
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLES);
    const { id } = await params;
    const body = await parseBody(req, BodySchema);

    const row = await prisma.muqeemTransaction.findUnique({ where: { id }, select: { operation: true, employeeId: true } });
    if (!row) throw notFound('عملية مقيم غير موجودة');
    const feature = featureSettlePath(row.operation, row.employeeId);
    if (feature) {
      return jsonError(
        409,
        `هذه العملية تُسوّى من شاشة ${feature.label}، لأن التسوية هناك تُحدّث السجل المرتبط بها أيضاً (التأشيرة / تاريخ الإقامة / بيانات الجواز / التصفية). ` +
          'تسويتها من هنا تترك السجل على حاله فيُرسَل طلب جديد مدفوع إلى مقيم لاحقاً.',
        { settleAt: feature.path, details: { code: 'SETTLE_IN_FEATURE', settleAt: feature.path, operation: row.operation } },
      );
    }

    const tx = await reconcileTransaction(
      id,
      body.status === 'SUCCEEDED' ? { status: 'SUCCEEDED', externalRef: body.externalRef ?? null, note: body.note } : { status: 'FAILED', note: body.note },
      user,
      getClientIp(req),
    );
    return NextResponse.json({
      id: tx.id,
      status: tx.status,
      externalRef: tx.externalRef,
      completedAt: tx.completedAt,
      message: tx.status === 'SUCCEEDED' ? 'سُجّلت العملية كناجحة.' : 'سُجّلت العملية كفاشلة، وأصبح إرسال الطلب نفسه ممكناً من جديد.',
    });
  } catch (err) {
    return handleApiError(err, 'integrations/muqeem/transactions/reconcile:POST');
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { LOAN_STATUS, ROLE_GROUPS, SETTLEMENT_STATUS } from '@/lib/constants';
import { conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { approveLoanStep, approveSettlement, rejectLoan, rejectSettlement } from '@/lib/finance';
import { enforceMakerChecker } from '@/app/api/payments/maker-checker';

export const dynamic = 'force-dynamic';

/** Loans the owner can still approve on behalf of the manager + HR (before they reach finance). */
const OWNER_LOAN_STATUSES = [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED];

const employeeNameSelect = { select: { firstNameArabic: true, lastNameArabic: true } } as const;

function fullName(e: { firstNameArabic: string | null; lastNameArabic: string | null } | null | undefined): string {
  return `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim();
}

export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.OWNER);

    // Items awaiting the owner's decision: loans, payment orders and settlements.
    const [loans, requests, settlements] = await Promise.all([
      prisma.loan.findMany({
        where: { status: { in: OWNER_LOAN_STATUSES } },
        select: { id: true, amount: true, status: true, createdAt: true, employee: employeeNameSelect },
      }),
      prisma.paymentRequest.findMany({
        where: { status: 'PENDING_OWNER' },
        select: { id: true, title: true, amount: true, status: true, createdAt: true, requestedById: true },
      }),
      prisma.settlement.findMany({
        where: { status: SETTLEMENT_STATUS.PENDING_APPROVAL },
        select: { id: true, totalSettlement: true, status: true, createdAt: true, employee: employeeNameSelect },
      }),
    ]);

    // Maker-checker display: who filed each payment order (the requester cannot approve it).
    const requesterIds = [...new Set(requests.map((r) => r.requestedById).filter((v): v is string => !!v))];
    const requesters = requesterIds.length
      ? await prisma.user.findMany({ where: { id: { in: requesterIds } }, select: { id: true, name: true, email: true } })
      : [];
    const requesterName = new Map(requesters.map((u) => [u.id, u.name || u.email]));

    const unified = [
      ...loans.map((l) => ({
        id: l.id,
        type: 'LOAN' as const,
        title: `سلفة للموظف (${fullName(l.employee)})`,
        amount: roundMoney(l.amount ?? 0),
        createdAt: l.createdAt,
        status: l.status,
      })),
      ...requests.map((r) => ({
        id: r.id,
        type: 'PAYMENT' as const,
        title: r.title,
        amount: roundMoney(r.amount ?? 0),
        createdAt: r.createdAt,
        status: r.status as string,
        requestedByName: r.requestedById ? (requesterName.get(r.requestedById) ?? null) : null,
        isOwnRequest: !!r.requestedById && r.requestedById === user.id,
      })),
      ...settlements.map((s) => ({
        id: s.id,
        type: 'SETTLEMENT' as const,
        title: `تصفية مستحقات موظف (${fullName(s.employee)})`,
        amount: roundMoney(s.totalSettlement ?? 0),
        createdAt: s.createdAt,
        status: s.status,
      })),
    ];

    unified.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return NextResponse.json(unified);
  } catch (err) {
    return handleApiError(err, 'owner-portal/payments:GET');
  }
}

const decisionSchema = z.object({
  id: zId,
  type: z.enum(['LOAN', 'PAYMENT', 'SETTLEMENT']),
  action: z.enum(['APPROVE', 'REJECT']),
  notes: zOptText(2000),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.OWNER);
    const { id, type, action, notes } = await parseBody(req, decisionSchema);
    const ctx = { ipAddress: getClientIp(req) };
    const approve = action === 'APPROVE';

    await prisma.$transaction(
      async (tx) => {
        if (type === 'LOAN') {
          // The owner portal only decides loans that have not reached HR yet. approveLoanStep('OWNER')
          // also accepts HR_APPROVED, so lock the row and re-check the status here: a second click
          // (or a concurrent request) gets 409 instead of re-approving the loan.
          await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${id} FOR UPDATE`;
          const loan = await tx.loan.findUnique({ where: { id }, select: { status: true } });
          if (!loan) throw notFound('طلب السلفة غير موجود');
          if (!(OWNER_LOAN_STATUSES as readonly string[]).includes(loan.status)) {
            throw conflict('تم اتخاذ قرار بشأن طلب السلفة مسبقاً');
          }
          if (approve) await approveLoanStep(tx, id, 'OWNER', user, ctx);
          else await rejectLoan(tx, id, user, notes ?? 'مرفوض من صاحب العمل', ctx);
          return;
        }

        if (type === 'SETTLEMENT') {
          if (approve) await approveSettlement(tx, id, user, notes, ctx);
          else await rejectSettlement(tx, id, user, notes, ctx);
          return;
        }

        // PAYMENT: PENDING_OWNER -> PENDING_FINANCE (approve) / RETURNED (reject), guarded.
        const current = await tx.paymentRequest.findUnique({ where: { id }, select: { id: true, status: true, requestedById: true } });
        if (!current) throw notFound('أمر الصرف غير موجود');
        if (current.status !== 'PENDING_OWNER') throw conflict('تم اتخاذ قرار بشأن أمر الصرف مسبقاً');
        // Maker-checker: the requester may not approve their own request (403), except SUPER_ADMIN /
        // allow_self_approval (audited as SELF_APPROVAL_OVERRIDE). Rejecting (withdrawing) is always allowed.
        const makerChecker = approve ? await enforceMakerChecker(tx, 'APPROVE', user, current, ctx.ipAddress) : null;
        const res = await tx.paymentRequest.updateMany({
          where: { id, status: 'PENDING_OWNER' },
          data: approve
            ? { status: 'PENDING_FINANCE', returnReason: null, approvedById: user.id }
            : { status: 'RETURNED', returnReason: notes ?? 'مرفوض من صاحب العمل' },
        });
        if (res.count === 0) throw conflict('تم اتخاذ قرار بشأن أمر الصرف مسبقاً');
        await logAudit(
          {
            userId: user.id,
            action: approve ? 'APPROVE' : 'REJECT',
            entityType: 'PaymentRequest',
            entityId: id,
            details: {
              status: approve ? 'PENDING_FINANCE' : 'RETURNED',
              notes: notes ?? null,
              requestedById: current.requestedById,
              ...(makerChecker ? { makerChecker } : {}),
            },
            ipAddress: ctx.ipAddress,
          },
          tx,
        );
      },
      { timeout: 20_000 },
    );

    return NextResponse.json({ message: approve ? 'تم اعتماد الطلب بنجاح' : 'تم رفض الطلب' });
  } catch (err) {
    return handleApiError(err, 'owner-portal/payments:POST');
  }
}

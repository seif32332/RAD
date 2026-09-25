import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zId, zMoney, zOptInt, zOptText, zText } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** Compliance writes: admins, HR and government relations (GOV = owner/admin + GOV_RELATIONS + HR_MANAGER). */
const COMPLIANCE_WRITE_ROLES = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV])];

const VIOLATION_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CORRECTED: 'CORRECTED',
  PAID: 'PAID',
} as const;

const UPDATE_TARGETS = [VIOLATION_STATUS.CORRECTED, VIOLATION_STATUS.PAID] as const;
type UpdateTarget = (typeof UPDATE_TARGETS)[number];

const ALLOWED_FROM: Record<UpdateTarget, string[]> = {
  CORRECTED: [VIOLATION_STATUS.PENDING_PAYMENT],
  PAID: [VIOLATION_STATUS.PENDING_PAYMENT, VIOLATION_STATUS.CORRECTED],
};

const envelopeSchema = z
  .object({
    actionType: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

const updateStatusSchema = z.object({
  id: zId,
  status: z.enum(UPDATE_TARGETS, { errorMap: () => ({ message: 'حالة المخالفة غير صالحة' }) }),
});

const createSchema = z.object({
  targetType: z.enum(['COMPANY', 'BRANCH'], { errorMap: () => ({ message: 'يرجى اختيار نوع الجهة (شركة أو فرع)' }) }),
  targetId: zId,
  authority: zText(300),
  amount: zMoney,
  correctivePeriod: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    zOptInt.refine((n) => n === undefined || (n >= 0 && n <= 3650), 'فترة التصحيح غير صالحة'),
  ),
  canObject: z.preprocess((v) => (v === '' || v === null || v === undefined ? false : v), zBool),
  notes: zOptText(5000),
});

export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.STAFF);
    const [violations, companies, branches] = await Promise.all([
      prisma.complianceViolation.findMany({
        include: {
          company: { select: { nameArabic: true } },
          branch: { select: { nameArabic: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.company.findMany({ select: { id: true, nameArabic: true } }),
      prisma.branch.findMany({ select: { id: true, nameArabic: true } }),
    ]);

    const structuredData = violations.map((v) => ({
      ...v,
      targetName: v.branch?.nameArabic
        ? `فرع: ${v.branch.nameArabic}`
        : v.company?.nameArabic
          ? `شركة: ${v.company.nameArabic}`
          : 'مخالفة عامة غير مرتبطة',
    }));

    return NextResponse.json({ violations: structuredData, metadata: { companies, branches } });
  } catch (err) {
    return handleApiError(err, 'compliance:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(COMPLIANCE_WRITE_ROLES);
    const body = await parseBody(req, envelopeSchema);
    const ipAddress = getClientIp(req);

    // Status updates (corrected / paid).
    if (body.actionType === 'UPDATE_STATUS') {
      const { id, status } = updateStatusSchema.parse(body.payload ?? {});
      const updatedViolation = await prisma.$transaction(async (tx) => {
        const res = await tx.complianceViolation.updateMany({
          where: { id, status: { in: ALLOWED_FROM[status] } },
          data: { status },
        });
        if (res.count === 0) {
          const exists = await tx.complianceViolation.findUnique({ where: { id }, select: { id: true } });
          if (!exists) throw notFound('المخالفة غير موجودة');
          throw conflict('لا يمكن تغيير حالة المخالفة من حالتها الحالية (ربما تمت معالجتها مسبقاً)');
        }
        return tx.complianceViolation.findUniqueOrThrow({ where: { id } });
      });

      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'ComplianceViolation',
        entityId: id,
        details: { status },
        ipAddress,
      });

      let successMessage = 'تم تحديث حالة المخالفة بنجاح';
      if (status === VIOLATION_STATUS.PAID) successMessage = 'تم سداد المخالفة مالياً بنجاح ✅';
      if (status === VIOLATION_STATUS.CORRECTED) successMessage = 'تم تصحيح وتصويب المخالفة الرقابية محلياً ✅';
      return NextResponse.json({ message: successMessage, data: updatedViolation });
    }

    if (body.actionType !== undefined && body.actionType !== 'CREATE') {
      throw badRequest('إجراء غير معروف');
    }

    // Default action: register a new government violation.
    const data = createSchema.parse(body);
    const target =
      data.targetType === 'COMPANY'
        ? await prisma.company.findUnique({ where: { id: data.targetId }, select: { id: true } })
        : await prisma.branch.findUnique({ where: { id: data.targetId }, select: { id: true } });
    if (!target) throw notFound(data.targetType === 'COMPANY' ? 'الشركة غير موجودة' : 'الفرع غير موجود');

    const newViolation = await prisma.complianceViolation.create({
      data: {
        authority: data.authority,
        amount: roundMoney(data.amount),
        correctivePeriod: data.correctivePeriod ?? null,
        canObject: data.canObject,
        notes: data.notes ?? null,
        status: VIOLATION_STATUS.PENDING_PAYMENT,
        companyId: data.targetType === 'COMPANY' ? data.targetId : null,
        branchId: data.targetType === 'BRANCH' ? data.targetId : null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'ComplianceViolation',
      entityId: newViolation.id,
      details: { authority: newViolation.authority, amount: newViolation.amount, targetType: data.targetType, targetId: data.targetId },
      ipAddress,
    });

    return NextResponse.json({ message: 'تم قيد وتسجيل المخالفة بنجاح ضمن سجل الالتزام', data: newViolation });
  } catch (err) {
    return handleApiError(err, 'compliance:POST');
  }
}

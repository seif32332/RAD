import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, hasRole, requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { resolveTeamContext } from '@/lib/employee-scope';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';
import { deriveRequestCompanyId } from '@/lib/onboarding-company';
import { JOB_REQUEST_STATUS, JOB_REQUEST_TRANSITIONS, JOB_TYPES } from './shared';

export const dynamic = 'force-dynamic';

const jobRequestInclude = {
  requester: { select: { id: true, firstNameArabic: true, lastNameArabic: true, employeeId: true } },
  department: { select: { id: true, nameArabic: true } },
} satisfies Prisma.JobRequestInclude;

const createSchema = z.object({
  requesterId: zId.optional(),
  departmentId: zId,
  jobTitle: zText(200),
  jobType: z.enum(JOB_TYPES),
  nationality: zText(100),
  description: zText(5000),
});

const updateStatusSchema = z.object({
  actionType: z.literal('UPDATE_STATUS'),
  payload: z.object({
    id: zId,
    status: z.enum([JOB_REQUEST_STATUS.APPROVED, JOB_REQUEST_STATUS.REJECTED, JOB_REQUEST_STATUS.FULFILLED]),
  }),
});

/**
 * GET: job requests + dropdown metadata.
 * HR/owner see the requests of their companies (P1-FND-SCOPE: ScopedContext over UserCompanyScope).
 * Branch/department managers work in their TeamContext (their own legal company): they see the
 * requests they raised or that belong to their department, and can only pick themselves as the requester.
 * Every query goes through the scoped client, so a row of a company outside the context never leaves.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const isHr = hasRole(user, ROLE_GROUPS.HR);
    const actor = await resolveActor(prisma, user);
    const ctx = isHr ? scopedContext(actor) : await resolveTeamContext(prisma, actor);
    authz.assert(ctx, 'recruitment.jobRequest.read');
    const db = scopedPrisma(ctx);

    let where: Prisma.JobRequestWhereInput = {};
    let managersWhere: Prisma.EmployeeWhereInput = { isTerminated: false };
    if (!isHr) {
      const employeeId = await requireEmployeeId(user);
      const me = await db.employee.findUnique({ where: { id: employeeId }, select: { departmentId: true } });
      where = {
        OR: [{ requesterId: employeeId }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])],
      };
      managersWhere = { id: employeeId };
    }

    const [jobRequests, managers, departments] = await Promise.all([
      db.jobRequest.findMany({ where, include: jobRequestInclude, orderBy: { createdAt: 'desc' } }),
      db.employee.findMany({
        where: managersWhere,
        select: { id: true, firstNameArabic: true, lastNameArabic: true, employeeId: true },
        orderBy: { firstNameArabic: 'asc' },
      }),
      db.department.findMany({ select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
    ]);

    return NextResponse.json({ jobRequests, metadata: { managers, departments } });
  } catch (err) {
    return handleApiError(err, 'recruitment:GET');
  }
}

/**
 * POST { actionType: 'UPDATE_STATUS', payload: { id, status } } -> HR approves/rejects/fulfills.
 * POST { requesterId, departmentId, jobTitle, jobType, nationality, description } -> new request.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.MANAGERS);
    const ip = getClientIp(req);
    const raw = await parseBody(req, z.object({ actionType: z.string().max(50).optional() }).passthrough());

    if (raw.actionType === 'UPDATE_STATUS') {
      if (!hasRole(user, ROLE_GROUPS.HR)) throw forbidden('اعتماد طلبات التوظيف من صلاحية الموارد البشرية');
      const { id, status } = updateStatusSchema.parse(raw).payload;
      const allowedFrom = JOB_REQUEST_TRANSITIONS[status];
      // P1-FND-SCOPE: HR decides only requests of its companies; another company's request is "not found".
      const ctx = scopedContext(await resolveActor(prisma, user));
      authz.assert(ctx, 'recruitment.jobRequest.decide', undefined, 'اعتماد طلبات التوظيف من صلاحية الموارد البشرية');
      const inScope: Prisma.JobRequestWhereInput = scopeWhere(ctx, 'JobRequest') ?? {};

      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.jobRequest.updateMany({
          where: { id, status: { in: [...allowedFrom] }, AND: [inScope] },
          data: { status },
        });
        if (res.count === 0) {
          const exists = await tx.jobRequest.findFirst({ where: { id, AND: [inScope] }, select: { id: true } });
          if (!exists) throw notFound('طلب التوظيف غير موجود');
          throw conflict('لا يمكن تغيير حالة الطلب من حالته الحالية، يرجى تحديث الصفحة');
        }
        await logAudit(
          {
            userId: user.id,
            action: status === JOB_REQUEST_STATUS.REJECTED ? 'REJECT' : status === JOB_REQUEST_STATUS.APPROVED ? 'APPROVE' : 'UPDATE',
            entityType: 'JobRequest',
            entityId: id,
            details: { status },
            ipAddress: ip,
          },
          tx,
        );
        return tx.jobRequest.findUniqueOrThrow({ where: { id }, include: jobRequestInclude });
      });

      return NextResponse.json({ message: 'تم تحديث حالة طلب التوظيف بنجاح', data: updated });
    }

    if (raw.actionType !== undefined && raw.actionType !== 'CREATE') throw badRequest('إجراء غير معروف');
    const body = createSchema.parse(raw);

    // Create: HR may raise a request on behalf of any active employee; other managers only for themselves.
    const requesterId = hasRole(user, ROLE_GROUPS.HR)
      ? body.requesterId || (await requireEmployeeId(user))
      : await requireEmployeeId(user);

    // P1-SCOPE: HR raises requests in its ScopedContext, the other managers in their TeamContext; the
    // requester and the department must be inside it ("not found" otherwise).
    const actor = await resolveActor(prisma, user);
    const ctx = hasRole(user, ROLE_GROUPS.HR) ? scopedContext(actor) : await resolveTeamContext(prisma, actor);
    authz.assert(ctx, 'recruitment.jobRequest.create');
    const db = scopedPrisma(ctx);
    const [requester, department] = await Promise.all([
      db.employee.findUnique({ where: { id: requesterId }, select: { id: true, isTerminated: true } }),
      db.department.findUnique({ where: { id: body.departmentId }, select: { id: true } }),
    ]);
    if (!requester || requester.isTerminated) throw badRequest('الموظف رافع الطلب غير موجود');
    if (!department) throw badRequest('الإدارة المحددة غير موجودة');
    // Scope key (BL-ONB-012): the company of the department's branch; a scoped user only raises requests for his companies.
    const companyId = await deriveRequestCompanyId(prisma, { departmentId: body.departmentId });
    if (companyId) authz.assert(ctx, 'recruitment.jobRequest.create', { companyId }, 'هذه الشركة خارج نطاق صلاحياتك');

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.jobRequest.create({
        data: {
          requesterId,
          companyId,
          departmentId: body.departmentId,
          jobTitle: body.jobTitle,
          jobType: body.jobType,
          nationality: body.nationality,
          description: body.description,
          status: JOB_REQUEST_STATUS.PENDING,
        },
        include: jobRequestInclude,
      });
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'JobRequest',
          entityId: row.id,
          details: { jobTitle: row.jobTitle, departmentId: row.departmentId, requesterId },
          ipAddress: ip,
        },
        tx,
      );
      return row;
    });

    return NextResponse.json({ message: 'تم رفع طلب الاحتياج الوظيفي للموارد البشرية بنجاح', data: created });
  } catch (err) {
    return handleApiError(err, 'recruitment:POST');
  }
}

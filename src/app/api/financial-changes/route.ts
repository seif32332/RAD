import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { HttpError, badRequest, handleApiError, parseBody, parseQuery } from '@/lib/http';
import { zId, zOptText } from '@/lib/validation';
import { FINANCIAL_CHANGE_STATUSES, OPEN_FINANCIAL_CHANGE_STATUSES, listFinancialChanges, type FinancialChangeStatus } from '@/modules/compensation';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';
import { prisma } from '@/lib/prisma';
import { actOnChange, withEmployees } from './_shared';

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  /** Comma-separated statuses; default: the open ones (waiting for a confirmation, a decision or a date). */
  status: z.string().trim().max(200).optional(),
  employeeId: zId.optional(),
  batchKey: z.string().trim().max(200).optional(),
});

/**
 * GET /api/financial-changes — the financial change requests of the user's companies (P1-PAY-B,
 * BR-PAY-009: "طلبات تغيير مالي" list with their age). Never the IBAN itself (its masked form only).
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'compensation.change.read');
    const q = parseQuery(req, listQuery);
    const statuses = q.status
      ? q.status.split(',').map((s) => s.trim()).filter((s): s is FinancialChangeStatus => (FINANCIAL_CHANGE_STATUSES as readonly string[]).includes(s))
      : [...OPEN_FINANCIAL_CHANGE_STATUSES];
    if (q.status && !statuses.length) throw badRequest('حالة غير معروفة');
    const db = scopedPrisma(ctx) as unknown as PrismaClient;
    const rows = await listFinancialChanges(db, { statuses, employeeId: q.employeeId ?? null, batchKey: q.batchKey ?? null });
    return NextResponse.json({ changes: await withEmployees(ctx, rows) });
  } catch (err) {
    return handleApiError(err, 'financial-changes:GET');
  }
}

const bulkSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    /** The requests to decide (each is decided on its own; one refusal never blocks the others). */
    ids: z.array(zId).max(500).optional(),
    /** Every PENDING request of one import run (BR-PAY-009: bulk approval by another person). */
    batchKey: z.string().trim().min(1).max(200).optional(),
    note: zOptText(1000),
  })
  .refine((b) => !!b.ids?.length !== !!b.batchKey, 'حدد الطلبات أو دفعة الاستيراد (أحدهما فقط)');

/**
 * POST /api/financial-changes { decision, ids | batchKey, note? } — the second person decides several
 * requests (an import run, a selection). Each one passes the same rules as a single decision: never the
 * requester, never the employee himself (SINGLE_OPERATOR: recorded). The result lists each request.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'compensation.change.decide');
    const b = await parseBody(req, bulkSchema);
    const db = scopedPrisma(ctx) as unknown as PrismaClient;
    const ids = b.ids?.length
      ? [...new Set(b.ids)]
      : (await db.employeeFinancialChange.findMany({ where: { batchKey: b.batchKey, status: 'PENDING' }, select: { id: true }, orderBy: { requestedAt: 'asc' } })).map((r) => r.id);
    const results: Array<{ id: string; ok: boolean; status?: string; applied?: boolean; selfAct?: boolean; error?: string; code?: string }> = [];
    for (const id of ids) {
      try {
        const r = await actOnChange(user, ctx, id, b.decision, { note: b.note ?? null, idempotencyKey: req.headers.get('idempotency-key'), ipAddress: getClientIp(req) });
        results.push({ id, ok: true, status: r.change.status, applied: r.applied, selfAct: r.selfAct });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        results.push({ id, ok: false, error: err.message, code: (err.details as { code?: string } | undefined)?.code ?? String(err.status) });
      }
    }
    const done = results.filter((r) => r.ok).length;
    return NextResponse.json({ message: `تم البت في ${done} من ${results.length} طلب تغيير مالي`, results });
  } catch (err) {
    return handleApiError(err, 'financial-changes:POST');
  }
}

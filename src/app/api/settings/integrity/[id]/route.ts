// Actions on one discrepancy (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.3, ADR-0002 #1): explain, request
// a waiver, approve or reject the pending one, resolve. The rules (second person, the beneficiary,
// single operator, verified resolution) live in the platform transitions; this route authenticates,
// applies the company scope of the discrepancy and resolves the operator mode on the server. The
// owner's confirmation of a single-operator act arrives over the DEC-PO-022 channel, not here.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody } from '@/lib/http';
import { ALL_COMPANIES, authz, resolveActor, scopedContext } from '@/modules/iam';
import {
  approveDiscrepancyExplanation,
  approveDiscrepancyWaiver,
  discrepancyScopeOf,
  explainDiscrepancy,
  rejectDiscrepancyAction,
  requestDiscrepancyWaiver,
  resolveDiscrepancy,
  registerInvariantCheck,
  resolveOperatorMode,
} from '@/modules/platform';
import { INV_RULE_02_ID, belowLegalOverrideCheck } from '@/modules/rules';
import { INV_PAY_04_ID, employmentChangeCheck } from '@/modules/payroll';
import { INV_SAL_01_ID, payProjectionCheck } from '@/modules/compensation';

// INV-RULE-02's check belongs to rules (DEC-PO-126): resolving one of its findings re-runs it.
registerInvariantCheck(INV_RULE_02_ID, belowLegalOverrideCheck);
// INV-PAY-04's employment-change check belongs to payroll (BL-PAY-025): same composition root.
registerInvariantCheck(INV_PAY_04_ID, employmentChangeCheck);
// INV-SAL-01's check belongs to compensation (P1-PAY-B).
registerInvariantCheck(INV_SAL_01_ID, payProjectionCheck);

export const dynamic = 'force-dynamic';

const text = z.string().trim().min(1).max(4000);
const ref = z.string().trim().min(1).max(500);
const version = z.number().int().min(0);
const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('explain'), expectedVersion: version, explanation: text, reference: ref, category: z.string().trim().max(60).optional() }),
  z.object({ action: z.literal('approve-explanation'), expectedVersion: version }),
  z.object({ action: z.literal('waive'), expectedVersion: version, reason: text }),
  z.object({ action: z.literal('approve-waiver'), expectedVersion: version }),
  z.object({ action: z.literal('reject'), expectedVersion: version }),
  z.object({ action: z.literal('resolve'), expectedVersion: version, resolution: text, resolutionRef: ref }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const { id } = await params;
    const body = await parseBody(req, BodySchema);
    const row = await discrepancyScopeOf(prisma, id);
    if (!row) throw notFound('الاختلاف غير موجود');
    const actor = await resolveActor(prisma, user);
    // A tenant-level finding (no company) belongs to whoever sees every company.
    const ctx = scopedContext(actor, row.companyId ? [row.companyId] : ALL_COMPANIES);
    authz.assert(ctx, 'platform.discrepancy.decide', { companyId: row.companyId });

    const common = {
      discrepancyId: id,
      expectedVersion: body.expectedVersion,
      key: req.headers.get('idempotency-key')?.trim() || undefined,
      ipAddress: getClientIp(req),
    };
    const who = { userId: user.id, employeeId: user.employeeId ?? null };
    const outcome = await (async () => {
      switch (body.action) {
        case 'explain':
          return explainDiscrepancy(prisma, { ...common, explanation: body.explanation, reference: body.reference, category: body.category }, who, { operatorMode: await resolveOperatorMode(prisma) });
        case 'approve-explanation':
          return approveDiscrepancyExplanation(prisma, common, who);
        case 'waive':
          return requestDiscrepancyWaiver(prisma, { ...common, reason: body.reason }, who, { operatorMode: await resolveOperatorMode(prisma) });
        case 'approve-waiver':
          return approveDiscrepancyWaiver(prisma, common, who);
        case 'reject':
          return rejectDiscrepancyAction(prisma, common, who);
        case 'resolve':
          return resolveDiscrepancy(prisma, { ...common, resolution: body.resolution, resolutionRef: body.resolutionRef }, who);
      }
    })();
    return NextResponse.json({ ...outcome.result, replayed: outcome.replayed });
  } catch (err) {
    return handleApiError(err, 'integrity:[id]:POST');
  }
}

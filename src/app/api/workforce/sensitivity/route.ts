// /api/workforce/sensitivity — «حساسية القرار» (SPEC §11). WORKFORCE roles, read-only (nothing is written).
// POST {decision: 'hire', params: <hire-scenario body>} | {decision: 'exit', params: <exit-cost body>} |
//      {decision: 'plan', planId}, optional ranges {KEY: {low, base?, high}} for this calculation only.
// GET ?decision=plan&planId=… (a plan needs no body).
// The decision is run with the same engine as its page under the scenarios low / base / high and one factor
// at a time (assumption ranges, medical class extremes, overtime basis, HRDF on / off): a tornado table.
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { auditViewOnce, limitOrThrow } from '../_lib/server';
import { bodyFromQuery, runSensitivity, sensitivityBodySchema, type SensitivityBody } from './_run';

export const dynamic = 'force-dynamic';

async function respond(req: Request, body: SensitivityBody, userId: string) {
  const out = await runSensitivity(body);
  await auditViewOnce({ id: userId }, 'WorkforceSensitivity', out.subject, getClientIp(req));
  return NextResponse.json({ result: out.result, evidence: out.evidence });
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const body = bodyFromQuery(Object.fromEntries(new URL(req.url).searchParams.entries()));
    limitOrThrow(user, 'sensitivity', 10, 60_000);
    return await respond(req, body, user.id);
  } catch (err) {
    return handleApiError(err, 'workforce:sensitivity:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const body = await parseBody(req, sensitivityBodySchema);
    limitOrThrow(user, 'sensitivity', 10, 60_000);
    return await respond(req, body, user.id);
  } catch (err) {
    return handleApiError(err, 'workforce:sensitivity:POST');
  }
}

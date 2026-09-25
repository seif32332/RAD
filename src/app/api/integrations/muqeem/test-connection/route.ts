import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser } from '@/lib/auth';
import type { AppRole } from '@/lib/constants';
import { HttpError, handleApiError, parseBody } from '@/lib/http';
import { zId } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { createMuqeemClient, MuqeemError } from '@/lib/muqeem';

export const dynamic = 'force-dynamic';

/** Same roles as the government-platforms vault. */
const ROLES: readonly AppRole[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS'];

const BodySchema = z.object({ companyId: zId });

/**
 * POST /api/integrations/muqeem/test-connection { companyId }
 * Authenticates against Muqeem with the company's linked credentials (nothing else is called).
 * 200 { ok: true } or 200 { ok: false, kind, message } for Muqeem failures (a diagnostic, not an error).
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLES);
    const limit = rateLimit(`muqeem-test:${user.id}`, 20, 10 * 60_000);
    if (!limit.ok) throw new HttpError(429, 'تم تجاوز عدد محاولات اختبار الاتصال، حاول بعد قليل');
    const { companyId } = await parseBody(req, BodySchema);

    let result: { ok: true } | { ok: false; kind: string; message: string };
    try {
      const client = await createMuqeemClient({ companyId });
      await client.authenticate({ force: true });
      result = { ok: true };
    } catch (err) {
      if (!(err instanceof MuqeemError)) throw err;
      if (err.detail) console.warn(`[muqeem] test-connection ${companyId}: ${err.kind} (${err.detail})`);
      result = { ok: false, kind: err.kind, message: err.message };
    }

    await logAudit({
      userId: user.id,
      action: 'VIEW',
      entityType: 'Company',
      entityId: companyId,
      details: { muqeemOperation: 'TEST_CONNECTION', status: result.ok ? 'OK' : result.kind },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json(result);
  } catch (err) {
    return handleApiError(err, 'integrations/muqeem/test-connection:POST');
  }
}

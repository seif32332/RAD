import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { applySettingsAction, documentSettings, pendingAcceptances, settingsActionSchema } from '@/lib/documents/settings';
import { actorFrom } from '../_shared';

export const dynamic = 'force-dynamic';

/** GET /api/documents/settings?companyId=  (?mine=acceptances: delegations awaiting my acceptance) */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const url = new URL(req.url);
    if (url.searchParams.get('mine') === 'acceptances') return NextResponse.json({ acceptances: await pendingAcceptances(user.id) });
    return NextResponse.json(await documentSettings(url.searchParams.get('companyId'), actorFrom(user, req)));
  } catch (err) {
    return handleApiError(err, 'documents/settings:GET');
  }
}

/** POST /api/documents/settings { action: brand | asset | signatory | type | grant | accept | revoke } */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const body = await parseBody(req, settingsActionSchema);
    return NextResponse.json(await applySettingsAction(body, actorFrom(user, req)));
  } catch (err) {
    return handleApiError(err, 'documents/settings:POST');
  }
}

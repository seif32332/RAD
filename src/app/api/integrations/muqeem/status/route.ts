import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { muqeemConfig } from '@/lib/muqeem';

export const dynamic = 'force-dynamic';

/** Roles allowed to change a company's Muqeem link (credentials vault roles that also manage companies). */
const LINK_ROLES: readonly string[] = ['SUPER_ADMIN', 'COMPANY_ADMIN'];

/** GovPlatform names that look like a Muqeem account. */
const MUQEEM_NAME_RE = /مقيم|muqeem|muqim/i;

/**
 * GET /api/integrations/muqeem/status (ROLE_GROUPS.GOV)
 * { enabled, configured, usable, missing, canLink, companies: [{ id, name, moiNumber, linked, platformName }],
 *   platforms: [{ id, platformName }] }. Never returns credentials or env values.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const config = muqeemConfig();
    const [companies, platforms] = await Promise.all([
      prisma.company.findMany({
        orderBy: { nameArabic: 'asc' },
        select: {
          id: true,
          nameArabic: true,
          moiNumber: true,
          muqeemPlatformId: true,
          muqeemPlatform: { select: { platformName: true } },
        },
      }),
      prisma.govPlatform.findMany({ orderBy: { platformName: 'asc' }, select: { id: true, platformName: true } }),
    ]);

    return NextResponse.json({
      enabled: config.enabled,
      configured: config.configured,
      usable: config.usable,
      missing: config.missing,
      canLink: LINK_ROLES.includes(user.role),
      companies: companies.map((c) => ({
        id: c.id,
        name: c.nameArabic,
        moiNumber: c.moiNumber ?? null,
        linked: !!c.moiNumber && !!c.muqeemPlatformId,
        platformName: c.muqeemPlatform?.platformName ?? null,
      })),
      platforms: platforms.filter((p) => MUQEEM_NAME_RE.test(p.platformName)),
    });
  } catch (err) {
    return handleApiError(err, 'integrations/muqeem/status:GET');
  }
}

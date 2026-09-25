import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { handleApiError, jsonError } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Current user + the menu sections their role may see.
 * allowedPages is null when no custom permission row exists for the role
 * (the client then falls back to the default menu for that role).
 */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return jsonError(401, 'يجب تسجيل الدخول أولاً');

    const perm = await prisma.rolePermission.findUnique({ where: { role: user.role }, select: { allowedPages: true } });

    return NextResponse.json(
      {
        user,
        allowedPages: perm && perm.allowedPages.length > 0 ? perm.allowedPages : null,
      },
      // Identity must never be served from a shared/browser cache (logout, user switch).
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    return handleApiError(err, 'auth:me');
  }
}

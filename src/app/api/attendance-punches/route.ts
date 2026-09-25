import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { zId, zOptDate } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  from: zOptDate,
  to: zOptDate,
  result: z.enum(['ACCEPTED', 'FLAGGED', 'REJECTED']).optional(),
  employeeId: zId.optional(),
  branchId: zId.optional(),
  /** 'pending' = flagged punches not reviewed yet. */
  review: z.enum(['pending']).optional(),
  take: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(1).max(200).optional()),
  skip: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(0).optional()),
});

/**
 * GET /api/attendance-punches — self clock-in attempts (HR only): newest first, paginated.
 * Coordinates are returned for HR review; selfies are fetched separately (…/[id]/photo).
 */
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.HR);
    const q = parseQuery(req, querySchema);
    const where: Prisma.AttendancePunchWhereInput = {
      ...(q.result ? { result: q.result } : {}),
      ...(q.review === 'pending' ? { result: 'FLAGGED', reviewedAt: null } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.branchId ? { employee: { branchId: q.branchId } } : {}),
      ...(q.from || q.to ? { workDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const take = q.take ?? 50;
    const skip = q.skip ?? 0;
    const [punches, total, pendingReview] = await Promise.all([
      prisma.attendancePunch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          employeeId: true,
          workDate: true,
          type: true,
          result: true,
          reasons: true,
          latitude: true,
          longitude: true,
          accuracyM: true,
          distanceM: true,
          locationName: true,
          radiusM: true,
          faceScore: true,
          livenessScore: true,
          selfieStoredName: true,
          selfiePurgedAt: true,
          reviewedAt: true,
          createdAt: true,
          employee: { select: { employeeId: true, firstNameArabic: true, lastNameArabic: true, branch: { select: { nameArabic: true } } } },
        },
      }),
      prisma.attendancePunch.count({ where }),
      prisma.attendancePunch.count({ where: { result: 'FLAGGED', reviewedAt: null } }),
    ]);
    return NextResponse.json({
      punches: punches.map(({ selfieStoredName, ...p }) => ({ ...p, hasSelfie: !!selfieStoredName })),
      total,
      take,
      skip,
      pendingReview,
    });
  } catch (err) {
    return handleApiError(err, 'attendance-punches:GET');
  }
}

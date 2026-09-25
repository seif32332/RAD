import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Visas are handled by HR and government relations (GOV includes HR_MANAGER). */
const VISA_ROLES = [...new Set([...ROLE_GROUPS.GOV, ...ROLE_GROUPS.HR])];

export async function GET() {
  try {
    await requireUser(VISA_ROLES);
    const visas = await prisma.visa.findMany({
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstNameArabic: true,
            lastNameArabic: true,
            nationality: true,
            branch: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(visas);
  } catch (err) {
    return handleApiError(err, 'visas:GET');
  }
}

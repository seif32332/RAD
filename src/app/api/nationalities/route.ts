import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { DEFAULT_NATIONALITY, normalizeNationality } from '@/lib/employee';

export const dynamic = 'force-dynamic';

// Saudi aliases ('SAUDI', 'السعودية'...) are stored as DEFAULT_NATIONALITY, so they never create a duplicate row.
const CreateSchema = z.object({ label: zText(100).transform((v) => normalizeNationality(v) ?? v) });

const select = { id: true, label: true, createdAt: true } as const;

export async function GET() {
  try {
    await requireUser();
    const nationalities = await prisma.nationality.findMany({ select, orderBy: { createdAt: 'asc' } });
    return NextResponse.json(nationalities);
  } catch (err) {
    return handleApiError(err, 'nationalities:GET');
  }
}

/** POST { label } — idempotent: returns the existing row (200) when the (normalized) label already exists. */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { label } = await parseBody(req, CreateSchema);

    const existing = await prisma.nationality.findUnique({ where: { label }, select });
    if (existing) return NextResponse.json(existing);

    // A concurrent insert of the same label raises P2002, which handleApiError maps to 409.
    const nationality = await prisma.nationality.create({ data: { label }, select });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'Nationality', entityId: nationality.id, details: { label }, ipAddress: getClientIp(req) });
    return NextResponse.json(nationality, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'nationalities:POST');
  }
}

/**
 * DELETE ?id=<id> or ?label=<label> (HR). Employees keep their nationality text (it is not a foreign key).
 * The default nationality (DEFAULT_NATIONALITY) cannot be deleted.
 */
export async function DELETE(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const params = new URL(req.url).searchParams;
    const id = params.get('id');
    const label = params.get('label');
    if (!id && !label) throw badRequest('معرّف الجنسية مطلوب');

    const where = id ? { id: zId.parse(id) } : { label: normalizeNationality(zText(100).parse(label)) ?? '' };
    const existing = await prisma.nationality.findUnique({ where, select });
    if (!existing) throw notFound('الجنسية غير موجودة');
    if (existing.label === DEFAULT_NATIONALITY) throw conflict('لا يمكن حذف الجنسية الافتراضية');

    await prisma.nationality.delete({ where: { id: existing.id } });
    await logAudit({ userId: user.id, action: 'DELETE', entityType: 'Nationality', entityId: existing.id, details: { label: existing.label }, ipAddress: getClientIp(req) });
    return NextResponse.json({ message: 'تم حذف الجنسية بنجاح' });
  } catch (err) {
    return handleApiError(err, 'nationalities:DELETE');
  }
}

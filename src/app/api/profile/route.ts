import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { definedOnly, handleApiError, parseBody } from '@/lib/http';
import { zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** Avatar must be one of our own uploaded files (no external or javascript: URLs). */
const zAvatarUrl = z
  .preprocess(
    (v) => (v === '' ? null : v),
    z
      .string()
      .trim()
      .max(500)
      .regex(/^\/(?:api\/files|uploads)\/[\w.\-/]+$/, 'رابط الصورة غير صالح')
      .refine((v) => !v.includes('..'), 'رابط الصورة غير صالح')
      .nullable(),
  )
  .optional();

const ProfileUpdateSchema = z.object({
  name: zOptText(120),
  avatarUrl: zAvatarUrl,
});

// GET - بيانات الملف الشخصي للمستخدم الحالي
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
    });
  } catch (err) {
    return handleApiError(err, 'profile:GET');
  }
}

// PUT - تحديث الاسم والصورة للمستخدم الحالي فقط
export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const body = await parseBody(req, ProfileUpdateSchema);
    const data = definedOnly({ name: body.name, avatarUrl: body.avatarUrl });

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, name: true, avatarUrl: true, email: true, role: true },
    });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      details: { fields: Object.keys(data) },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({
      message: 'تم تحديث الملف الشخصي بنجاح',
      user: { ...updated, name: updated.name || user.name },
    });
  } catch (err) {
    return handleApiError(err, 'profile:PUT');
  }
}

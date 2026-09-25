import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { GovPlatform } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser, type AuthUser } from '@/lib/auth';
import type { AppRole } from '@/lib/constants';
import { HttpError, definedOnly, handleApiError, notFound, parseBody } from '@/lib/http';
import { zId, zOptText, zText } from '@/lib/validation';
import { decryptField, encryptField, isEncrypted } from '@/lib/crypto';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Government-platform credentials are restricted to system admin, the owner and government
 * relations (list, reveal and every write). Deliberately narrower than ROLE_GROUPS.GOV, which
 * also includes HR_MANAGER for renewals.
 */
const GOV_PLATFORM_ROLES: readonly AppRole[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS'];

/**
 * Placeholder returned instead of the real password. When the edit form sends it back
 * unchanged, the stored password is kept.
 */
const PASSWORD_MASK = '••••••••';

type PublicGovPlatform = Omit<GovPlatform, 'password'> & { password: string; hasPassword: boolean; passwordMasked: true };

function toPublic(row: GovPlatform): PublicGovPlatform {
  return { ...row, password: PASSWORD_MASK, hasPassword: !!row.password, passwordMasked: true };
}

/** undefined/''/mask = keep the current password. */
const zOptNewPassword = z
  .preprocess((v) => (v === '' || v === null || v === PASSWORD_MASK ? undefined : v), z.string().max(500).optional());

const CreateSchema = z.object({
  platformName: zText(200),
  username: zText(200),
  password: z.string().min(1, 'كلمة المرور مطلوبة').max(500),
  phoneNumber: zOptText(50),
  authorizedPerson: zOptText(200),
  notes: zOptText(5000),
});

const UpdateSchema = z.object({
  id: zId,
  platformName: zText(200).optional(),
  username: zText(200).optional(),
  password: zOptNewPassword,
  phoneNumber: zOptText(50),
  authorizedPerson: zOptText(200),
  notes: zOptText(5000),
});

const RevealSchema = z.object({ action: z.literal('reveal'), id: zId });

async function revealPassword(user: AuthUser, id: string, req: Request) {
  const limit = rateLimit(`gov-reveal:${user.id}`, 60, 60 * 60_000);
  if (!limit.ok) throw new HttpError(429, 'تم تجاوز عدد مرات عرض كلمات المرور المسموح بها، حاول لاحقاً');

  const row = await prisma.govPlatform.findUnique({ where: { id }, select: { id: true, platformName: true, password: true } });
  if (!row) throw notFound('المنصة غير موجودة');

  await logAudit({
    userId: user.id,
    action: 'VIEW',
    entityType: 'GovPlatform',
    entityId: row.id,
    details: { reveal: 'credential', platformName: row.platformName },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json({ id: row.id, password: decryptField(row.password) ?? '' });
}

// GET: list platforms (password masked). GET ?reveal=<id> returns { id, password } (audited).
export async function GET(req: Request) {
  try {
    const user = await requireUser(GOV_PLATFORM_ROLES);
    const revealId = new URL(req.url).searchParams.get('reveal');
    if (revealId !== null) return await revealPassword(user, zId.parse(revealId), req);

    const platforms = await prisma.govPlatform.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json(platforms.map(toPublic));
  } catch (err) {
    return handleApiError(err, 'gov-platforms:GET');
  }
}

// POST: create a platform, or { action: 'reveal', id } to reveal a password.
export async function POST(req: Request) {
  try {
    const user = await requireUser(GOV_PLATFORM_ROLES);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new HttpError(400, 'صيغة البيانات المرسلة غير صحيحة');
    }

    if (raw && typeof raw === 'object' && (raw as { action?: unknown }).action === 'reveal') {
      const { id } = RevealSchema.parse(raw);
      return await revealPassword(user, id, req);
    }

    const body = CreateSchema.parse(raw);
    const platform = await prisma.govPlatform.create({
      data: {
        platformName: body.platformName,
        username: body.username,
        password: encryptField(body.password),
        phoneNumber: body.phoneNumber ?? null,
        authorizedPerson: body.authorizedPerson ?? null,
        notes: body.notes ?? null,
      },
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'GovPlatform',
      entityId: platform.id,
      details: { platformName: platform.platformName, username: platform.username },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم إضافة المنصة بنجاح', platform: toPublic(platform) }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'gov-platforms:POST');
  }
}

// PUT: update a platform (partial). Password omitted/''/mask keeps the current one.
export async function PUT(req: Request) {
  try {
    const user = await requireUser(GOV_PLATFORM_ROLES);
    const body = await parseBody(req, UpdateSchema);

    const existing = await prisma.govPlatform.findUnique({ where: { id: body.id }, select: { id: true, password: true } });
    if (!existing) throw notFound('المنصة غير موجودة');

    let password: string | undefined;
    if (body.password !== undefined) password = encryptField(body.password);
    else if (existing.password && !isEncrypted(existing.password)) password = encryptField(existing.password); // migrate legacy plaintext

    const data = definedOnly({
      platformName: body.platformName,
      username: body.username,
      password,
      phoneNumber: body.phoneNumber,
      authorizedPerson: body.authorizedPerson,
      notes: body.notes,
    });

    const updated = await prisma.govPlatform.update({ where: { id: body.id }, data });

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'GovPlatform',
      entityId: updated.id,
      details: { fields: Object.keys(data).filter((k) => k !== 'password'), credentialChanged: body.password !== undefined },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم تحديث المنصة بنجاح', data: toPublic(updated) });
  } catch (err) {
    return handleApiError(err, 'gov-platforms:PUT');
  }
}

// DELETE ?id=
export async function DELETE(req: Request) {
  try {
    const user = await requireUser(GOV_PLATFORM_ROLES);
    const id = zId.parse(new URL(req.url).searchParams.get('id') ?? '');

    const existing = await prisma.govPlatform.findUnique({ where: { id }, select: { id: true, platformName: true, username: true } });
    if (!existing) throw notFound('المنصة غير موجودة');

    await prisma.govPlatform.delete({ where: { id } });
    await logAudit({
      userId: user.id,
      action: 'DELETE',
      entityType: 'GovPlatform',
      entityId: id,
      details: { platformName: existing.platformName, username: existing.username },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ message: 'تم حذف المنصة بنجاح' });
  } catch (err) {
    return handleApiError(err, 'gov-platforms:DELETE');
  }
}

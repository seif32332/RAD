// Document settings per legal company: brand, assets, signatories, type policy, authorizations.
// Writes are the owner's (ROLE_GROUPS.OWNER): whoever controls the stamp and the delegations can
// issue letters in the company's name (DOC-04). A signatory accepts his own delegation.
import 'server-only';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { canonicalJson, PREFIX_RE } from './core';
import { appendEvent } from './events';
import { enqueueNotice } from './notify';
import { storeAsset } from './storage';
import { DOCUMENT_TYPES, getDocumentType } from './types';
import { staffCompanyScope, type Actor } from './service';

const isOwner = (actor: Actor) => !!actor.role && roleIn(actor.role, ROLE_GROUPS.OWNER);
const canRead = (actor: Actor) => !!actor.role && (roleIn(actor.role, ROLE_GROUPS.OWNER) || roleIn(actor.role, ROLE_GROUPS.HR) || roleIn(actor.role, ROLE_GROUPS.PAYROLL));

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG only (transparency for signatures / stamps; the renderer's allow-list). */
export function validatePng(buf: Buffer): { width: number; height: number } {
  if (buf.length === 0 || buf.length > MAX_ASSET_BYTES) throw badRequest('حجم الصورة يجب ألا يتجاوز 2 ميجابايت');
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw badRequest('الصورة يجب أن تكون بصيغة PNG');
  // Dimensions from the IHDR chunk (always first in a PNG): no decoding of untrusted pixels here.
  const size = buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR' ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
  if (!size || size.width < 16 || size.height < 16 || size.width > 4000 || size.height > 4000) throw badRequest('أبعاد الصورة غير مقبولة (16 إلى 4000 بكسل)');
  return size;
}

export async function documentSettings(companyId: string | null, actor: Actor) {
  if (!canRead(actor)) throw forbidden();
  const scope = await staffCompanyScope(prisma, actor);
  const companies = await prisma.company.findMany({
    where: scope ? { id: { in: scope } } : {},
    select: { id: true, nameArabic: true, nameEnglish: true },
    orderBy: { nameArabic: 'asc' },
  });
  const id = companyId ?? companies[0]?.id ?? null;
  if (!id) return { companies, companyId: null };
  if (!companies.some((c) => c.id === id)) throw notFound('الشركة غير موجودة');
  const [brand, assets, signatories, typeSettings, authorizations, issuedCount, scopeRows] = await Promise.all([
    prisma.brandProfile.findUnique({ where: { companyId: id } }),
    prisma.documentAsset.findMany({ where: { companyId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, sha256: true, width: true, height: true, createdAt: true } }),
    prisma.signatory.findMany({ where: { companyId: id }, orderBy: { createdAt: 'asc' } }),
    prisma.documentTypeSetting.findMany({ where: { companyId: id } }),
    prisma.signingAuthorization.findMany({ where: { legalCompanyId: id }, orderBy: { grantedAt: 'desc' } }),
    prisma.issuedDocument.count({ where: { legalCompanyId: id } }),
    isOwner(actor) ? prisma.userCompanyScope.findMany({ select: { userId: true, companyId: true } }) : Promise.resolve([]),
  ]);
  const scopes: Record<string, string[]> = {};
  for (const r of scopeRows) (scopes[r.userId] ??= []).push(r.companyId);
  return {
    companies,
    companyId: id,
    canEdit: isOwner(actor),
    prefixLocked: issuedCount > 0,
    /** Owner only: userId -> legal companies that user is limited to (absent = all). */
    scopes,
    brand,
    assets,
    signatories,
    authorizations: authorizations.map((a) => ({ ...a, typeLabel: getDocumentType(a.typeKey)?.labelAr ?? a.typeKey })),
    types: Object.values(DOCUMENT_TYPES).map((d) => ({
      key: d.key, code: d.code, labelAr: d.labelAr, defaults: d.defaults,
      setting: typeSettings.find((s) => s.typeKey === d.key) ?? null,
    })),
  };
}

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

export const settingsActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('brand'), companyId: z.string().min(1),
    numberPrefix: z.string().trim().toUpperCase().regex(PREFIX_RE, 'بادئة الترقيم من 2 إلى 6 أحرف لاتينية كبيرة'),
    primaryColor: hex.default('#0F4C81'), numerals: z.enum(['latn', 'arab']).default('latn'),
    addressAr: optText(200), addressEn: optText(200), phone: optText(40), email: optText(120), logoAssetId: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal('asset'), companyId: z.string().min(1), kind: z.enum(['LOGO', 'SIGNATURE', 'STAMP']), dataBase64: z.string().min(10).max(3_000_000) }),
  z.object({
    action: z.literal('signatory'), companyId: z.string().min(1), id: z.string().optional(), userId: z.string().nullable().optional(),
    nameAr: z.string().trim().min(3).max(120), nameEn: optText(120), titleAr: z.string().trim().min(2).max(120), titleEn: optText(120),
    signatureAssetId: z.string().nullable().optional(), stampAssetId: z.string().nullable().optional(), isActive: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('type'), companyId: z.string().min(1), typeKey: z.string().min(1),
    enabled: z.boolean(), selfService: z.boolean().nullable(), requiresApproval: z.boolean().nullable(),
    validityDays: z.number().int().min(1).max(3650).nullable(), signatoryId: z.string().nullable(),
  }),
  z.object({
    action: z.literal('grant'), companyId: z.string().min(1), signatoryId: z.string().min(1), typeKey: z.string().min(1),
    validFrom: z.coerce.date(), validUntil: z.coerce.date().nullable().optional(),
    maxTotalSalary: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  }),
  z.object({ action: z.literal('accept'), authorizationId: z.string().min(1) }),
  // Owner: limit a back-office user to some legal companies (empty list = no limit).
  z.object({ action: z.literal('scope'), userId: z.string().min(1), companyIds: z.array(z.string().min(1)).max(500) }),
  z.object({ action: z.literal('revoke'), authorizationId: z.string().min(1), reason: z.string().trim().min(3).max(300) }),
]);
export type SettingsAction = z.infer<typeof settingsActionSchema>;

async function assetOf(companyId: string, id: string | null | undefined, kind: string) {
  if (!id) return null;
  const a = await prisma.documentAsset.findFirst({ where: { id, companyId, kind }, select: { id: true } });
  if (!a) throw badRequest('الصورة المختارة غير موجودة لهذه الشركة');
  return a.id;
}

export async function applySettingsAction(body: SettingsAction, actor: Actor) {
  if (body.action === 'accept') {
    const a = await prisma.signingAuthorization.findUnique({ where: { id: body.authorizationId }, include: { signatory: true } });
    if (!a || !actor.userId || a.signatory.userId !== actor.userId) throw notFound('التفويض غير موجود');
    if (a.revokedAt) throw conflict('التفويض ملغى');
    if (a.acceptedAt) return { ok: true };
    await prisma.$transaction(async (tx) => {
      await tx.signingAuthorization.update({ where: { id: a.id }, data: { acceptedAt: new Date() } });
      await appendEvent(tx, { type: 'AUTHORIZATION_ACCEPTED', actorId: actor.userId, ip: actor.ip, meta: { authorizationId: a.id } });
    });
    return { ok: true };
  }
  if (!isOwner(actor)) throw forbidden('هذا الإعداد للمالك فقط');

  if (body.action === 'revoke') {
    const a = await prisma.signingAuthorization.findUnique({ where: { id: body.authorizationId } });
    if (!a) throw notFound('التفويض غير موجود');
    if (a.revokedAt) return { ok: true };
    await prisma.$transaction(async (tx) => {
      await tx.signingAuthorization.update({ where: { id: a.id }, data: { revokedAt: new Date(), revokedById: actor.userId, revokeReason: body.reason } });
      await appendEvent(tx, { type: 'AUTHORIZATION_REVOKED', actorId: actor.userId, ip: actor.ip, meta: { authorizationId: a.id, reason: body.reason } });
    });
    await logAudit({ userId: actor.userId, action: 'UPDATE', entityType: 'SigningAuthorization', entityId: a.id, details: { revoked: true }, ipAddress: actor.ip });
    return { ok: true };
  }

  if (body.action === 'scope') {
    const user = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, role: true } });
    if (!user) throw notFound('المستخدم غير موجود');
    const ids = [...new Set(body.companyIds)];
    if (ids.length && (await prisma.company.count({ where: { id: { in: ids } } })) !== ids.length) throw badRequest('إحدى الشركات غير موجودة');
    await prisma.$transaction(async (tx) => {
      await tx.userCompanyScope.deleteMany({ where: { userId: user.id } });
      if (ids.length) await tx.userCompanyScope.createMany({ data: ids.map((companyId) => ({ userId: user.id, companyId, createdById: actor.userId })) });
      await appendEvent(tx, { type: 'POLICY_CHANGED', actorId: actor.userId, ip: actor.ip, meta: { scopeUserId: user.id, companyIds: ids } });
    });
    await logAudit({ userId: actor.userId, action: 'UPDATE', entityType: 'UserCompanyScope', entityId: user.id, details: { companyIds: ids }, ipAddress: actor.ip });
    return { ok: true };
  }

  const company = await prisma.company.findUnique({ where: { id: body.companyId }, select: { id: true } });
  if (!company) throw notFound('الشركة غير موجودة');

  switch (body.action) {
    case 'brand': {
      const existing = await prisma.brandProfile.findUnique({ where: { companyId: company.id } });
      if (existing && existing.numberPrefix !== body.numberPrefix && (await prisma.issuedDocument.count({ where: { legalCompanyId: company.id } })) > 0) {
        throw conflict('لا تتغير بادئة الترقيم بعد إصدار أول مستند (DOC-02)');
      }
      const data = {
        numberPrefix: body.numberPrefix, primaryColor: body.primaryColor.toUpperCase(), numerals: body.numerals,
        addressAr: body.addressAr, addressEn: body.addressEn, phone: body.phone, email: body.email,
        logoAssetId: await assetOf(company.id, body.logoAssetId, 'LOGO'), updatedById: actor.userId,
      };
      await prisma.$transaction(async (tx) => {
        await tx.brandProfile.upsert({ where: { companyId: company.id }, create: { companyId: company.id, ...data }, update: data });
        await appendEvent(tx, { type: 'BRAND_CHANGED', actorId: actor.userId, ip: actor.ip, meta: { companyId: company.id, numberPrefix: body.numberPrefix } });
      });
      return { ok: true };
    }
    case 'asset': {
      const buf = Buffer.from(body.dataBase64, 'base64');
      const { width, height } = validatePng(buf);
      const stored = await storeAsset(buf);
      const asset = await prisma.$transaction(async (tx) => {
        const existing = await tx.documentAsset.findUnique({ where: { companyId_sha256: { companyId: company.id, sha256: stored.sha256 } } });
        const row = existing ?? (await tx.documentAsset.create({
          data: { companyId: company.id, kind: body.kind, sha256: stored.sha256, storedName: stored.storedName, size: buf.length, width, height, createdById: actor.userId },
        }));
        await appendEvent(tx, { type: 'ASSET_UPLOADED', actorId: actor.userId, ip: actor.ip, meta: { companyId: company.id, kind: body.kind, sha256: stored.sha256 } });
        // A new signature / stamp image is told to every signatory of the company (SPEC §9).
        if (!existing && body.kind !== 'LOGO') {
          const signatories = await tx.signatory.findMany({ where: { companyId: company.id, isActive: true }, select: { userId: true } });
          await enqueueNotice(tx, signatories.map((x) => x.userId), `asset:${row.id}`, { kind: 'ASSET_CHANGED', assetLabel: body.kind === 'STAMP' ? 'صورة الختم' : 'صورة التوقيع' });
        }
        return row;
      });
      await logAudit({ userId: actor.userId, action: 'CREATE', entityType: 'DocumentAsset', entityId: asset.id, details: { kind: body.kind, sha256: stored.sha256 }, ipAddress: actor.ip });
      return { ok: true, asset: { id: asset.id, kind: asset.kind, sha256: asset.sha256 } };
    }
    case 'signatory': {
      const data = {
        userId: body.userId ?? null, nameAr: body.nameAr, nameEn: body.nameEn, titleAr: body.titleAr, titleEn: body.titleEn,
        signatureAssetId: await assetOf(company.id, body.signatureAssetId, 'SIGNATURE'),
        stampAssetId: await assetOf(company.id, body.stampAssetId, 'STAMP'),
        isActive: body.isActive,
      };
      if (data.userId && !(await prisma.user.findUnique({ where: { id: data.userId }, select: { id: true } }))) throw badRequest('المستخدم غير موجود');
      const id = await prisma.$transaction(async (tx) => {
        let sid = body.id;
        if (sid) {
          const s = await tx.signatory.findFirst({ where: { id: sid, companyId: company.id } });
          if (!s) throw notFound('الموقّع غير موجود');
          await tx.signatory.update({ where: { id: sid }, data });
        } else {
          sid = (await tx.signatory.create({ data: { companyId: company.id, ...data } })).id;
        }
        await appendEvent(tx, { type: 'SIGNATORY_CHANGED', actorId: actor.userId, ip: actor.ip, meta: { signatoryId: sid, companyId: company.id, isActive: data.isActive } });
        return sid;
      });
      return { ok: true, id };
    }
    case 'type': {
      const def = getDocumentType(body.typeKey);
      if (!def) throw badRequest('نوع مستند غير معروف');
      if (body.signatoryId && !(await prisma.signatory.findFirst({ where: { id: body.signatoryId, companyId: company.id }, select: { id: true } }))) {
        throw badRequest('الموقّع لا يتبع هذه الشركة');
      }
      const data = { enabled: body.enabled, selfService: body.selfService, requiresApproval: body.requiresApproval, validityDays: body.validityDays, signatoryId: body.signatoryId, updatedById: actor.userId };
      await prisma.$transaction(async (tx) => {
        await tx.documentTypeSetting.upsert({ where: { companyId_typeKey: { companyId: company.id, typeKey: def.key } }, create: { companyId: company.id, typeKey: def.key, ...data }, update: data });
        await appendEvent(tx, { type: 'POLICY_CHANGED', actorId: actor.userId, ip: actor.ip, meta: { companyId: company.id, typeKey: def.key, ...data } });
      });
      return { ok: true };
    }
    case 'grant': {
      const def = getDocumentType(body.typeKey);
      if (!def) throw badRequest('نوع مستند غير معروف');
      const s = await prisma.signatory.findFirst({ where: { id: body.signatoryId, companyId: company.id, isActive: true } });
      if (!s) throw badRequest('الموقّع غير موجود أو غير نشط في هذه الشركة');
      if (body.validUntil && body.validUntil <= body.validFrom) throw badRequest('تاريخ نهاية التفويض يجب أن يكون بعد بدايته');
      const a = await prisma.$transaction(async (tx) => {
        const row = await tx.signingAuthorization.create({
          data: {
            signatoryId: s.id, legalCompanyId: company.id, typeKey: def.key, validFrom: body.validFrom, validUntil: body.validUntil ?? null,
            scopeJson: body.maxTotalSalary ? canonicalJson({ maxTotalSalary: Number(body.maxTotalSalary).toFixed(2) }) : null,
            grantedById: actor.userId!,
            // A signatory without an account cannot accept; the owner's grant is then the act.
            acceptedAt: s.userId ? null : new Date(),
          },
        });
        await appendEvent(tx, { type: 'AUTHORIZATION_GRANTED', actorId: actor.userId, ip: actor.ip, meta: { authorizationId: row.id, signatoryId: s.id, typeKey: def.key } });
        if (s.userId) await enqueueNotice(tx, [s.userId], `authorization:${row.id}`, { kind: 'AUTHORIZATION_PENDING', typeLabel: def.labelAr });
        return row;
      });
      await logAudit({ userId: actor.userId, action: 'CREATE', entityType: 'SigningAuthorization', entityId: a.id, details: { signatoryId: s.id, typeKey: def.key }, ipAddress: actor.ip });
      return { ok: true, id: a.id, needsAcceptance: !!s.userId };
    }
  }
}

/** Delegations waiting for the logged-in user's acceptance (shown on his portal / documents page). */
export async function pendingAcceptances(userId: string) {
  const rows = await prisma.signingAuthorization.findMany({
    where: { acceptedAt: null, revokedAt: null, signatory: { userId } },
    include: { signatory: { select: { nameAr: true, company: { select: { nameArabic: true } } } } },
  });
  return rows.map((a) => ({
    id: a.id, typeLabel: getDocumentType(a.typeKey)?.labelAr ?? a.typeKey, company: a.signatory.company.nameArabic,
    validFrom: a.validFrom, validUntil: a.validUntil, scopeJson: a.scopeJson,
  }));
}

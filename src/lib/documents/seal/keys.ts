// Seal key of a legal company: created on its first sealed issuance, then reused. The private key
// is stored encrypted (DATA_ENCRYPTION_KEY) and only decrypted here, for signing.
import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { decryptField, encryptField } from '@/lib/crypto';
import { appendEvent } from '../events';
import { assertKeyMatchesCertificate, createSealCertificate } from './cert';

const RENEW_BEFORE_MS = 30 * 86_400_000;

export interface SealKey {
  id: string;
  certDer: Buffer;
  privateKeyPem: string;
  fingerprint: string;
}

async function active(companyId: string) {
  return prisma.documentSealKey.findFirst({ where: { companyId, retiredAt: null }, select: { id: true, certDer: true, keyEnc: true, fingerprint: true, notAfter: true } });
}

/** The company's key in force, created (with its certificate and a SEAL_KEY_CREATED event) when missing. */
export async function companySealKey(companyId: string, actorId: string | null, now = new Date()): Promise<SealKey> {
  let row = await active(companyId);
  // A certificate near its end (10 years) is retired and replaced; documents sealed with it stay verifiable.
  if (row && row.notAfter.getTime() - now.getTime() < RENEW_BEFORE_MS) {
    await prisma.$transaction(async (tx) => {
      const retired = await tx.documentSealKey.updateMany({ where: { id: row!.id, retiredAt: null }, data: { retiredAt: now } });
      if (retired.count) await appendEvent(tx, { type: 'SEAL_KEY_RETIRED', actorId, meta: { companyId, sealKeyId: row!.id, reason: 'EXPIRING' } });
    });
    row = await active(companyId);
  }
  if (!row) {
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { nameArabic: true, nameEnglish: true, commercialRegNum: true } });
    if (!company) throw new Error('legal company not found');
    const cert = createSealCertificate({ nameAr: company.nameArabic, nameEn: company.nameEnglish, commercialRegNum: company.commercialRegNum || null }, now);
    try {
      await prisma.$transaction(async (tx) => {
        const created = await tx.documentSealKey.create({
          data: {
            companyId, certDer: cert.certDer, keyEnc: encryptField(cert.privateKeyPem), fingerprint: cert.fingerprint,
            serialHex: cert.serialHex, notBefore: cert.notBefore, notAfter: cert.notAfter, createdById: actorId,
          },
        });
        await appendEvent(tx, { type: 'SEAL_KEY_CREATED', actorId, meta: { companyId, sealKeyId: created.id, fingerprint: cert.fingerprint, notAfter: cert.notAfter.toISOString() } });
      });
    } catch (err) {
      // Another issuance created it first (one active key per company): use that one.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    row = await active(companyId);
    if (!row) throw new Error('seal key missing after creation');
  }
  const privateKeyPem = decryptField(row.keyEnc);
  if (!privateKeyPem) throw new Error('seal key cannot be decrypted');
  const certDer = Buffer.from(row.certDer);
  assertKeyMatchesCertificate(certDer, privateKeyPem);
  return { id: row.id, certDer, privateKeyPem, fingerprint: row.fingerprint };
}

/** Public certificate of a seal key (verification page download). */
export async function sealCertificate(sealKeyId: string): Promise<{ certDer: Buffer; fingerprint: string } | null> {
  const row = await prisma.documentSealKey.findUnique({ where: { id: sealKeyId }, select: { certDer: true, fingerprint: true } });
  return row ? { certDer: Buffer.from(row.certDer), fingerprint: row.fingerprint } : null;
}

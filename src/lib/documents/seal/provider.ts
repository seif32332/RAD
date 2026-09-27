// SignatureProvider (ADR-001: `seal(pdf) → pdf` after rendering, before the fingerprint). Today one
// provider: the company's own key and self-issued certificate (SPEC §15 item 33). An accredited
// provider (AATL / licensed trust service) would be another implementation of this interface; the
// pipeline and the documents already issued do not change.
import 'server-only';
import { prisma } from '@/lib/prisma';
import { companySealKey } from './keys';
import { sealPdf } from './pades';

export interface SealRequest {
  pdf: Buffer;
  legalCompanyId: string;
  /** Claimed signing time (/M): the document's issuedAt. */
  issuedAt: Date;
  number: string;
  actorId: string | null;
}

export interface SignatureProvider {
  readonly id: string;
  /** Returns the sealed PDF and the key that sealed it (IssuedDocument.sealKeyId). Throws on failure. */
  seal(req: SealRequest): Promise<{ pdf: Buffer; sealKeyId: string }>;
}

export const selfSealProvider: SignatureProvider = {
  id: 'radeef-self',
  async seal(req) {
    const key = await companySealKey(req.legalCompanyId, req.actorId);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: req.legalCompanyId }, select: { nameArabic: true } });
    const pdf = sealPdf(req.pdf, {
      certDer: key.certDer, privateKeyPem: key.privateKeyPem, signingTime: req.issuedAt,
      name: company.nameArabic, reason: `مستند رسمي رقم ${req.number}`,
    });
    return { pdf, sealKeyId: key.id };
  },
};

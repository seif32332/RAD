// Candidate side of a job offer (owner decision 2026-09-26). A candidate has no account: at issuance
// the offer gets a private link (a 128-bit token; only its hash + an encrypted copy for HR are
// stored) that expires with the offer. Through it the candidate downloads the PDF and accepts or
// declines, once (DocumentAcknowledgement via LINK). Everything else stays behind the staff login.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { decryptField, encryptField } from '@/lib/crypto';
import { conflict, HttpError } from '@/lib/http';
import { hashVerifyToken, newVerifyToken, riyadhDate, TOKEN_RE } from './core';
import { appendEvent, truncateIp } from './events';
import { enqueueNotice } from './notify';
import { readIssuedPdf } from './storage';
import { getDocumentType } from './types';

type Tx = Prisma.TransactionClient;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function offerLink(token: string): string {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return `${base}/offer/${token}`;
}

/**
 * In the issuance transaction of a candidate document: creates the link, marks the application as
 * OFFERED (from APPLIED / INTERVIEW) and queues one email to the candidate (no personal data: the
 * number, the deadline and the link).
 */
export async function grantCandidateAccess(
  tx: Tx,
  input: { documentId: string; jobApplicationId: string; validUntil: Date | null; issuedAt: Date; number: string },
): Promise<void> {
  const token = newVerifyToken();
  const expiresAt = input.validUntil ?? new Date(input.issuedAt.getTime() + 30 * 86400e3);
  await tx.candidateDocumentAccess.create({ data: { documentId: input.documentId, tokenHash: hashVerifyToken(token), tokenEnc: encryptField(token)!, expiresAt } });
  await tx.jobApplication.updateMany({ where: { id: input.jobApplicationId, status: { in: ['APPLIED', 'INTERVIEW'] } }, data: { status: 'OFFERED' } });
  const app = await tx.jobApplication.findUnique({ where: { id: input.jobApplicationId }, select: { candidateEmail: true } });
  const email = app?.candidateEmail?.trim() ?? '';
  if (EMAIL_RE.test(email) && process.env.APP_URL?.trim()) {
    await tx.notificationOutbox.createMany({
      data: [{
        idempotencyKey: `doc:offer:${input.documentId}`,
        channel: 'EMAIL',
        recipient: email,
        subject: 'عرض وظيفي',
        body: `وصلك عرض وظيفي برقم ${input.number}. للاطلاع عليه وتنزيله والرد بالقبول أو الاعتذار:\n\n${offerLink(token)}\n\nيسري الرابط حتى ${riyadhDate(expiresAt)}.`,
      }],
      skipDuplicates: true,
    });
  }
}

/** HR: the candidate link of an offer (to send it by another channel). Staff permission is checked by the caller. */
export async function candidateLinkOf(documentId: string): Promise<{ url: string; expiresAt: Date } | null> {
  const a = await prisma.candidateDocumentAccess.findUnique({ where: { documentId } });
  if (!a) return null;
  const token = decryptField(a.tokenEnc);
  return token ? { url: offerLink(token), expiresAt: a.expiresAt } : null;
}

async function accessByToken(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const a = await prisma.candidateDocumentAccess.findUnique({
    where: { tokenHash: hashVerifyToken(token) },
    include: {
      document: {
        include: {
          legalCompany: { select: { nameArabic: true, nameEnglish: true } },
          acknowledgement: { select: { decision: true, acknowledgedAt: true } },
          jobApplication: { select: { candidateName: true } },
        },
      },
    },
  });
  return a;
}

export interface CandidateOfferView {
  number: string;
  typeLabelAr: string;
  companyAr: string;
  companyEn: string | null;
  candidateName: string;
  issuedAt: string;
  expiresAt: string;
  expired: boolean;
  status: 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';
  answeredAt: string | null;
}

/** What the offer page shows. null = unknown token (same answer as a wrong one). */
export async function candidateOffer(token: string): Promise<CandidateOfferView | null> {
  const a = await accessByToken(token);
  if (!a) return null;
  const d = a.document;
  const ack = d.acknowledgement;
  return {
    number: d.number,
    typeLabelAr: getDocumentType(d.typeKey)?.labelAr ?? d.typeKey,
    companyAr: d.legalCompany.nameArabic,
    companyEn: d.legalCompany.nameEnglish,
    candidateName: d.jobApplication?.candidateName ?? '',
    issuedAt: riyadhDate(d.issuedAt),
    expiresAt: riyadhDate(a.expiresAt),
    expired: a.expiresAt.getTime() < Date.now(),
    status: d.status !== 'ISSUED' ? 'WITHDRAWN' : ack?.decision === 'ACCEPTED' ? 'ACCEPTED' : ack?.decision === 'DECLINED' ? 'DECLINED' : 'OPEN',
    answeredAt: ack ? riyadhDate(ack.acknowledgedAt) : null,
  };
}

/** The offer PDF through the link (until it expires, while the offer stands). */
export async function candidateOfferPdf(token: string, ip: string | null) {
  const a = await accessByToken(token);
  if (!a || a.document.status !== 'ISSUED' || a.document.purgedAt) return null;
  if (a.expiresAt.getTime() < Date.now()) throw new HttpError(410, 'انتهت صلاحية رابط العرض');
  const pdf = await readIssuedPdf(a.document.storedName, a.document.pdfSha256);
  await prisma.$transaction((tx) => appendEvent(tx, { type: 'DOWNLOADED', documentId: a.documentId, ip: truncateIp(ip), meta: { via: 'LINK' } }));
  return { pdf, fileName: `${a.document.number}.pdf` };
}

/** The candidate accepts or declines, once; whoever issued and approved the offer is told. */
export async function answerOffer(token: string, decision: 'ACCEPTED' | 'DECLINED', comment: string | null, ip: string | null) {
  const a = await accessByToken(token);
  if (!a) throw new HttpError(404, 'الرابط غير صحيح');
  if (a.document.status !== 'ISSUED') throw conflict('سُحب هذا العرض');
  if (a.expiresAt.getTime() < Date.now()) throw new HttpError(410, 'انتهت صلاحية العرض');
  const def = getDocumentType(a.document.typeKey);
  const request = await prisma.documentRequest.findUnique({ where: { id: a.document.requestId }, select: { requestedById: true, approvals: { select: { approverId: true } } } });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.documentAcknowledgement.create({ data: { documentId: a.documentId, employeeId: null, userId: null, via: 'LINK', decision, comment } });
      await appendEvent(tx, { type: 'ACKNOWLEDGED', documentId: a.documentId, ip: truncateIp(ip), meta: { decision, via: 'LINK', withComment: !!comment } });
      const staff = [request?.requestedById, ...(request?.approvals.map((x) => x.approverId) ?? [])];
      await enqueueNotice(tx, staff, `offer-answer:${a.documentId}`, { kind: 'OFFER_ANSWERED', number: a.document.number, accepted: decision === 'ACCEPTED', typeLabel: def?.labelAr ?? '' });
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw conflict('سُجّل ردك على هذا العرض مسبقاً');
    throw e;
  }
  return { decision };
}

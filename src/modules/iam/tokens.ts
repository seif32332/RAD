// One-time credential link rows (BL-PAY-005; BL-PAY-022 adds the INVITE and the VENDOR-delivered code): helpers of
// iam's transitions (transitions/identity.ts, transitions/vendor.ts), always called inside an iam operation of
// money.gateway. Not part of the module's public interface (index.ts does not export them).
import { randomUUID } from 'crypto';
import { emitEvent, type TxClient } from '@/modules/platform';
import { credentialCodeFor, credentialCodeHash, credentialFingerprintOf, credentialTokenFor, credentialTokenHash } from './credentials';
import { CREDENTIAL_LINK_ISSUED_EVENT } from './identity';

/** The lifetime of a link in hours (security setting credential_link_hours), between 1 and 72. */
export function clampHours(hours: number | null | undefined): number {
  const n = Number(hours);
  if (!Number.isFinite(n)) return 24;
  return Math.min(72, Math.max(1, Math.floor(n)));
}

/** Revokes the account's usable links (a new link, a reset or an email change supersedes them). */
export async function revokeOpenTokens(w: TxClient, userId: string, reason: string): Promise<number> {
  const r = await w.credentialToken.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  return r.count;
}

/** Creates a one-time link row (the secret is derived from its id, only the keyed hashes are stored). */
export async function issueToken(
  w: TxClient,
  input: {
    userId: string;
    purpose: 'RESET' | 'FIRST_ATTESTATION' | 'INVITE';
    /** FIRST_ATTESTATION: who hands over the code (VENDOR = ROOT_ATTEST_OWN, with its list entry). */
    codeDelivery?: 'ATTESTER' | 'VENDOR';
    namedPersonId?: string | null;
    sentTo: string;
    issuedById: string | null;
    attesterId?: string | null;
    verificationNote?: string | null;
    changeRequestId?: string | null;
    hours: number;
    operationKey: string;
  },
): Promise<{ id: string; expiresAt: Date }> {
  await revokeOpenTokens(w, input.userId, input.purpose === 'FIRST_ATTESTATION' ? 'SUPERSEDED_BY_ATTESTATION' : input.purpose === 'INVITE' ? 'SUPERSEDED_BY_INVITE' : 'SUPERSEDED_BY_RESET');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + clampHours(input.hours) * 3600_000);
  const { passwordHash } = await w.user.findUniqueOrThrow({ where: { id: input.userId }, select: { passwordHash: true } });
  await w.credentialToken.create({
    data: {
      id,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: credentialTokenHash(credentialTokenFor(id)),
      codeHash: input.purpose === 'FIRST_ATTESTATION' ? credentialCodeHash(id, credentialCodeFor(id)) : null,
      sentTo: input.sentTo,
      credentialFingerprint: credentialFingerprintOf(passwordHash),
      issuedById: input.issuedById,
      attesterId: input.attesterId ?? null,
      verificationNote: input.verificationNote ?? null,
      changeRequestId: input.changeRequestId ?? null,
      codeDelivery: input.codeDelivery ?? 'ATTESTER',
      namedPersonId: input.namedPersonId ?? null,
      expiresAt,
    },
  });
  await emitEvent(w, {
    type: CREDENTIAL_LINK_ISSUED_EVENT,
    aggregateType: 'User',
    aggregateId: input.userId,
    idempotencyKey: `${input.operationKey}:${CREDENTIAL_LINK_ISSUED_EVENT}`,
    payload: { tokenId: id, userId: input.userId, purpose: input.purpose },
    actorId: input.issuedById,
  });
  return { id, expiresAt };
}

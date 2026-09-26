// Issuance policy and signature authorization (ADR DOC-04 / DOC-05). Pure: callers load the rows.
import type { DocumentTypeDefinition } from './types';

export interface TypeSettingRow {
  enabled: boolean;
  selfService: boolean | null;
  requiresApproval: boolean | null;
  validityDays: number | null;
  signatoryId: string | null;
}

export interface EffectivePolicy {
  enabled: boolean;
  selfService: boolean;
  requiresApproval: boolean;
  validityDays: number | null;
  signatoryId: string | null;
}

/** Company setting over type defaults (null = default). */
export function effectivePolicy(def: DocumentTypeDefinition, setting: TypeSettingRow | null): EffectivePolicy {
  return {
    enabled: setting?.enabled ?? true,
    selfService: setting?.selfService ?? def.defaults.selfService,
    requiresApproval: setting?.requiresApproval ?? def.defaults.requiresApproval,
    validityDays: setting?.validityDays !== undefined && setting?.validityDays !== null ? setting.validityDays : def.defaults.validityDays,
    signatoryId: setting?.signatoryId ?? null,
  };
}

export interface SignatoryRow {
  id: string;
  companyId: string;
  userId: string | null;
  isActive: boolean;
  signatureAssetId: string | null;
  stampAssetId: string | null;
}

export interface AuthorizationRow {
  id: string;
  signatoryId: string;
  legalCompanyId: string;
  typeKey: string;
  scopeJson: string | null;
  validFrom: Date;
  validUntil: Date | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApprovalRow {
  id: string;
  approverId: string;
  decision: string;
  snapshotSha256: string;
  invalidatedAt: Date | null;
}

export type SignatureDecision =
  | { printImage: true; basis: 'SIGNATORY_APPROVED'; approvalId: string; authorizationId: null }
  | { printImage: true; basis: 'PRE_AUTHORIZED'; approvalId: string | null; authorizationId: string }
  | { printImage: false; reason: 'NO_SIGNATORY' | 'INACTIVE_SIGNATORY' | 'WRONG_COMPANY' | 'NO_SIGNATURE_ASSET' | 'NOT_AUTHORIZED' };

/** Is the authorization in force for this document, now (DOC-04: explicit, revocable, bounded, accepted)? */
export function authorizationApplies(
  a: AuthorizationRow,
  ctx: { signatory: SignatoryRow; legalCompanyId: string; typeKey: string; now: Date; totalSalary: string | null },
): boolean {
  if (a.signatoryId !== ctx.signatory.id || a.legalCompanyId !== ctx.legalCompanyId || a.typeKey !== ctx.typeKey) return false;
  if (a.revokedAt) return false;
  if (ctx.now < a.validFrom || (a.validUntil && ctx.now > a.validUntil)) return false;
  // A signatory with an account must accept the delegation himself before it counts.
  if (ctx.signatory.userId && !a.acceptedAt) return false;
  if (a.scopeJson) {
    let scope: { maxTotalSalary?: string } = {};
    try {
      scope = JSON.parse(a.scopeJson);
    } catch {
      return false; // unreadable scope: fail closed
    }
    if (scope.maxTotalSalary !== undefined) {
      if (ctx.totalSalary === null) return false;
      if (Number(ctx.totalSalary) > Number(scope.maxTotalSalary)) return false;
    }
  }
  return true;
}

/**
 * Whether the signature image may be printed (DOC-04). Existence of the image never suffices:
 * 1. the signatory himself approved THIS snapshot, or
 * 2. a pre-authorization applies.
 * Otherwise the name and title are printed without the image.
 */
export function decideSignature(ctx: {
  signatory: SignatoryRow | null;
  legalCompanyId: string;
  typeKey: string;
  snapshotSha256: string;
  approvals: readonly ApprovalRow[];
  authorizations: readonly AuthorizationRow[];
  now: Date;
  totalSalary: string | null;
}): SignatureDecision {
  const s = ctx.signatory;
  if (!s) return { printImage: false, reason: 'NO_SIGNATORY' };
  if (!s.isActive) return { printImage: false, reason: 'INACTIVE_SIGNATORY' };
  if (s.companyId !== ctx.legalCompanyId) return { printImage: false, reason: 'WRONG_COMPANY' };
  if (!s.signatureAssetId) return { printImage: false, reason: 'NO_SIGNATURE_ASSET' };

  const valid = ctx.approvals.filter((a) => a.decision === 'APPROVED' && !a.invalidatedAt && a.snapshotSha256 === ctx.snapshotSha256);
  const bySignatory = s.userId ? valid.find((a) => a.approverId === s.userId) : undefined;
  if (bySignatory) return { printImage: true, basis: 'SIGNATORY_APPROVED', approvalId: bySignatory.id, authorizationId: null };

  const auth = ctx.authorizations.find((a) => authorizationApplies(a, { signatory: s, legalCompanyId: ctx.legalCompanyId, typeKey: ctx.typeKey, now: ctx.now, totalSalary: ctx.totalSalary }));
  if (auth) return { printImage: true, basis: 'PRE_AUTHORIZED', approvalId: valid[0]?.id ?? null, authorizationId: auth.id };
  return { printImage: false, reason: 'NOT_AUTHORIZED' };
}

/**
 * Whether a request needs a human approval before issuance. Salary / employment / experience
 * letters are issued at once when a pre-authorization covers the signatory; otherwise (or when the
 * company / type policy requires it) they wait for an approval of the current snapshot.
 */
export function needsApproval(policy: EffectivePolicy, signature: SignatureDecision, approvals: readonly ApprovalRow[], snapshotSha256: string): boolean {
  const approved = approvals.some((a) => a.decision === 'APPROVED' && !a.invalidatedAt && a.snapshotSha256 === snapshotSha256);
  if (approved) return false;
  if (policy.requiresApproval) return true;
  // Without the policy flag, issuing without a human is allowed only when the signature itself is
  // pre-authorized (a letter never goes out on nobody's authority).
  return !(signature.printImage && signature.basis === 'PRE_AUTHORIZED');
}

/** validUntil = issuance day + validityDays (Riyadh end of day), or null (no expiry). */
export function computeValidUntil(issuedAt: Date, validityDays: number | null): Date | null {
  if (validityDays === null || validityDays <= 0) return null;
  const riyadhMidnight = new Date(Date.UTC(
    new Date(issuedAt.getTime() + 3 * 3600e3).getUTCFullYear(),
    new Date(issuedAt.getTime() + 3 * 3600e3).getUTCMonth(),
    new Date(issuedAt.getTime() + 3 * 3600e3).getUTCDate(),
  ) - 3 * 3600e3);
  return new Date(riyadhMidnight.getTime() + (validityDays + 1) * 86400e3 - 1000);
}

/** Validity status computed at read time (EXPIRED is never stored, DOC-08). */
export function validityStatus(doc: { status: string; validUntil: Date | null; purgedAt?: Date | null }, now: Date = new Date()): 'VALID' | 'EXPIRED' | 'REVOKED' | 'SUPERSEDED' | 'PURGED' {
  if (doc.purgedAt) return 'PURGED';
  if (doc.status === 'REVOKED') return 'REVOKED';
  if (doc.status === 'SUPERSEDED') return 'SUPERSEDED';
  if (doc.validUntil && now > doc.validUntil) return 'EXPIRED';
  return 'VALID';
}

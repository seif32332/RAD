-- 9zm_controls_mode (BL-PAY-021; pay-to-be.md BR-PAY-020, DEC-PO-018 / 022).
--
-- The tenant's controlsMode is now COMPUTED from the identity facts (two attested people with a financial
-- approver role => ENFORCED, else SINGLE_OPERATOR; iam.readControlsMode, the one resolver every reader asks).
-- The placeholder SystemSetting `platform.operatorMode` (P1-FND-INV, read until now by
-- platform.resolveOperatorMode) has no reader any more; it is removed so that no tenant keeps a value that looks
-- like a switch. No schema change: the mode is not stored, a change of it is recorded as an AuditRecord and the
-- DomainEvent iam.controls.modeChanged (aggregate ControlsMode / tenant), and the owner digest is a
-- NotificationOutbox row (key owner-digest:<YYYY-MM>:<owner contact id>).
DELETE FROM "SystemSetting" WHERE "key" = 'platform.operatorMode';

-- ---------------------------------------------------------------------------------------------------------
-- DEC-PO-144 (ADR-0009 accepted): the mode is computed PER LEGAL COMPANY, and only for a company Radeef has
-- marked ready (the owner's rollout "after each company is ready"). Every existing and new company starts NOT
-- ready (no row): ENFORCED whatever its count. iam table, written only by the vendor operation
-- iam.vendor.controlsReadiness (money.gateway VENDOR_ONLY_TABLES); revoking a mark makes the company ENFORCED.
-- ---------------------------------------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "ControlsReadiness" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "requestRef" TEXT NOT NULL,
    "markedBy" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeRequestRef" TEXT,

    CONSTRAINT "ControlsReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ControlsReadiness_companyId_revokedAt_idx" ON "ControlsReadiness"("companyId", "revokedAt");

-- AddForeignKey
ALTER TABLE "ControlsReadiness" ADD CONSTRAINT "ControlsReadiness_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity (fail closed at the database too)
ALTER TABLE "ControlsReadiness"
  ADD CONSTRAINT "ControlsReadiness_basis_check" CHECK ("basis" IN ('ATTESTED', 'ONE_PERSON')),
  ADD CONSTRAINT "ControlsReadiness_requestRef_check" CHECK (length(btrim("requestRef")) > 0),
  ADD CONSTRAINT "ControlsReadiness_markedBy_check" CHECK (length(btrim("markedBy")) > 0),
  ADD CONSTRAINT "ControlsReadiness_revoked_check" CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL) AND ("revokedAt" IS NULL) = ("revokeRequestRef" IS NULL));

-- One open mark per company.
CREATE UNIQUE INDEX "ControlsReadiness_one_open" ON "ControlsReadiness"("companyId") WHERE "revokedAt" IS NULL;

-- ---------------------------------------------------------------------------------------------------------
-- BL-PAY-021 security re-check (HIGH): a company scope change can drop a company below two counted approvers
-- (an owner narrows the other approver's scope, then approves and pays alone there). UserCompanyScope becomes an
-- identity table written only by iam (iam.user.scope; money.gateway IDENTITY_TABLES), and a change that drops a
-- company below two counted approvers is a two-person IdentityChangeRequest (DEC-PO-021): kind CHANGE_SCOPE with
-- the requested companies (empty = every company), executed when the holder or another counted approver approves.
-- ---------------------------------------------------------------------------------------------------------

-- AlterEnum (compared as text below: a value added in this transaction cannot be used in it)
ALTER TYPE "IdentityChangeKind" ADD VALUE 'CHANGE_SCOPE';

-- AlterTable
ALTER TABLE "IdentityChangeRequest" ADD COLUMN "nextCompanyIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "IdentityChangeRequest"
  ADD CONSTRAINT "IdentityChangeRequest_scope_check" CHECK ("kind"::text = 'CHANGE_SCOPE' OR "nextCompanyIds" IS NULL OR cardinality("nextCompanyIds") = 0);

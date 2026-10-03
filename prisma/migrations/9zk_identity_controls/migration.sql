-- 9zk_identity_controls (master plan P1-PAY-B: BL-PAY-005; pay-to-be.md BR-PAY-005, §2, §17;
-- DEC-PO-013 / 016 / 021 / 024 / 027). Owner: iam. Order: after 9zj_workflow_engine; letter 9zk (never 10+).
--
-- 1. User identity columns: createdById, isVendorStaff, identityStatus (UNATTESTED / ATTESTED /
--    VENDOR_BOOTSTRAP), identityAttestedById / At, attestedEmail, noEmployeeAttestedById, identityDroppedReason
--    / At, tenantRoot (written by Radeef's vendor panel only, BL-PAY-017: nothing in this release sets it),
--    rootSuspendedAt, emailSetById / emailSetAt (who last set the login email). Written only inside iam's identity operations (money.gateway refuses them elsewhere).
-- 2. UserEmployeeLink (two-step link, BR-PAY-005), CredentialToken (one-time credential links: the secret is
--    derived from the row id with the server key and only its keyed hash is stored), IdentityChangeRequest
--    (two-person deactivation / role change / credential reset of an account that counts toward ENFORCED,
--    DEC-PO-021 / 024; every reset is recorded for the DEC-PO-027 re-attestation rule).
-- 3. Backfill (§17, DEC-PO-013):
--      - every existing account stays identityStatus = UNATTESTED (the column default) and isVendorStaff =
--        false (Radeef reviews vendor accounts by hand before activation, §17 "تشغيلي");
--      - User.createdById from the earliest AuditLog CREATE row of the account whose author is another,
--        existing user; anything that does not match stays NULL (unknown: nothing is invented, and NULL never
--        waives the "attester is not the creator" rule once known);
--      - User.emailSetById / emailSetAt from the latest AuditLog row that set the login email (creation, admin
--        edit, self change), NULL when unknown;
--      - every Employee.userId becomes a LEGACY_LINKED UserEmployeeLink (not a confirmed link until the
--        attestation confirms it, §17).
--    One summary AuditRecord, no DomainEvent (like 9u / 9zg).
--
-- Rollback: expand only. The previous release ignores the new columns and tables (no NOT NULL without a
-- default was added to User, no existing column changed). Dropping the three tables, the six enums and
-- the thirteen User columns undoes it.

-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('UNATTESTED', 'ATTESTED', 'VENDOR_BOOTSTRAP');

-- CreateEnum
CREATE TYPE "IdentityDropReason" AS ENUM ('CREDENTIAL_RESET', 'PROMOTION', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "UserEmployeeLinkStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'LEGACY_LINKED', 'REJECTED', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "CredentialTokenPurpose" AS ENUM ('RESET', 'FIRST_ATTESTATION');

-- CreateEnum
CREATE TYPE "IdentityChangeKind" AS ENUM ('DEACTIVATE', 'CHANGE_ROLE', 'RESET_CREDENTIALS');

-- CreateEnum
CREATE TYPE "IdentityChangeStatus" AS ENUM ('PENDING', 'EXECUTED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "attestedEmail" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "emailSetAt" TIMESTAMP(3),
ADD COLUMN     "emailSetById" TEXT,
ADD COLUMN     "identityAttestedAt" TIMESTAMP(3),
ADD COLUMN     "identityAttestedById" TEXT,
ADD COLUMN     "identityDroppedAt" TIMESTAMP(3),
ADD COLUMN     "identityDroppedReason" "IdentityDropReason",
ADD COLUMN     "identityStatus" "IdentityStatus" NOT NULL DEFAULT 'UNATTESTED',
ADD COLUMN     "isVendorStaff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "noEmployeeAttestedById" TEXT,
ADD COLUMN     "rootSuspendedAt" TIMESTAMP(3),
ADD COLUMN     "tenantRoot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UserEmployeeLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "UserEmployeeLinkStatus" NOT NULL,
    "proposedById" TEXT,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "selfActSingleOperator" BOOLEAN NOT NULL DEFAULT false,
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "endedById" TEXT,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEmployeeLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "CredentialTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT,
    "sentTo" TEXT NOT NULL,
    "credentialFingerprint" TEXT NOT NULL,
    "issuedById" TEXT,
    "attesterId" TEXT,
    "verificationNote" TEXT,
    "changeRequestId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "IdentityChangeKind" NOT NULL,
    "nextRole" "Role",
    "status" "IdentityChangeStatus" NOT NULL,
    "twoPerson" BOOLEAN NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserEmployeeLink_userId_idx" ON "UserEmployeeLink"("userId");

-- CreateIndex
CREATE INDEX "UserEmployeeLink_employeeId_idx" ON "UserEmployeeLink"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialToken_tokenHash_key" ON "CredentialToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CredentialToken_userId_idx" ON "CredentialToken"("userId");

-- CreateIndex
CREATE INDEX "IdentityChangeRequest_userId_status_idx" ON "IdentityChangeRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "IdentityChangeRequest_status_requestedAt_idx" ON "IdentityChangeRequest"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_identityAttestedById_fkey" FOREIGN KEY ("identityAttestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_noEmployeeAttestedById_fkey" FOREIGN KEY ("noEmployeeAttestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_emailSetById_fkey" FOREIGN KEY ("emailSetById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmployeeLink" ADD CONSTRAINT "UserEmployeeLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmployeeLink" ADD CONSTRAINT "UserEmployeeLink_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmployeeLink" ADD CONSTRAINT "UserEmployeeLink_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmployeeLink" ADD CONSTRAINT "UserEmployeeLink_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmployeeLink" ADD CONSTRAINT "UserEmployeeLink_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialToken" ADD CONSTRAINT "CredentialToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialToken" ADD CONSTRAINT "CredentialToken_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialToken" ADD CONSTRAINT "CredentialToken_attesterId_fkey" FOREIGN KEY ("attesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialToken" ADD CONSTRAINT "CredentialToken_changeRequestId_fkey" FOREIGN KEY ("changeRequestId") REFERENCES "IdentityChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityChangeRequest" ADD CONSTRAINT "IdentityChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityChangeRequest" ADD CONSTRAINT "IdentityChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityChangeRequest" ADD CONSTRAINT "IdentityChangeRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity (fail closed at the database too)
-- ---------------------------------------------------------------------------
ALTER TABLE "User"
  ADD CONSTRAINT "User_identity_attested_check" CHECK (
    "identityStatus" <> 'ATTESTED' OR ("identityAttestedById" IS NOT NULL AND "identityAttestedAt" IS NOT NULL AND "attestedEmail" IS NOT NULL)),
  ADD CONSTRAINT "User_attester_not_self_check" CHECK ("identityAttestedById" IS NULL OR "identityAttestedById" <> "id"),
  ADD CONSTRAINT "User_creator_not_self_check" CHECK ("createdById" IS NULL OR "createdById" <> "id"),
  ADD CONSTRAINT "User_noEmployeeAttester_not_self_check" CHECK ("noEmployeeAttestedById" IS NULL OR "noEmployeeAttestedById" <> "id"),
  -- A vendor account is a vendor identity only: never attested, never the tenant root (BR-PAY-005, DEC-PO-016).
  ADD CONSTRAINT "User_vendor_not_attested_check" CHECK (NOT ("isVendorStaff" AND "identityStatus" = 'ATTESTED')),
  ADD CONSTRAINT "User_root_not_vendor_check" CHECK (NOT ("tenantRoot" AND "isVendorStaff")),
  ADD CONSTRAINT "User_root_suspended_check" CHECK ("rootSuspendedAt" IS NULL OR "tenantRoot"),
  ADD CONSTRAINT "User_identity_dropped_check" CHECK (("identityDroppedReason" IS NULL) = ("identityDroppedAt" IS NULL));

-- DEC-PO-016: one TENANT_ROOT per tenant (database).
CREATE UNIQUE INDEX "User_one_tenant_root" ON "User"("tenantRoot") WHERE "tenantRoot";

ALTER TABLE "UserEmployeeLink"
  -- Every link has a proposer, except one found at 9zk (legacy: no proposer is known, none is invented).
  ADD CONSTRAINT "UserEmployeeLink_proposer_check" CHECK ("proposedById" IS NOT NULL OR "legacy"),
  ADD CONSTRAINT "UserEmployeeLink_legacy_check" CHECK ("status" <> 'LEGACY_LINKED' OR "legacy"),
  -- No self-link (BR-PAY-005): the account linked never proposes nor confirms its own link.
  ADD CONSTRAINT "UserEmployeeLink_no_self_proposal_check" CHECK ("proposedById" IS NULL OR "proposedById" <> "userId"),
  ADD CONSTRAINT "UserEmployeeLink_no_self_confirmation_check" CHECK ("confirmedById" IS NULL OR "confirmedById" <> "userId"),
  ADD CONSTRAINT "UserEmployeeLink_confirmed_check" CHECK ("status" <> 'CONFIRMED' OR ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL)),
  -- Two people, except a recorded SINGLE_OPERATOR self-act (BR-PAY-020).
  ADD CONSTRAINT "UserEmployeeLink_two_person_check" CHECK (
    "confirmedById" IS NULL OR "proposedById" IS NULL OR "confirmedById" <> "proposedById" OR "selfActSingleOperator"),
  ADD CONSTRAINT "UserEmployeeLink_ended_check" CHECK (("status" = 'ENDED') = ("endedAt" IS NOT NULL));

-- One open link per account and per employee file.
CREATE UNIQUE INDEX "UserEmployeeLink_one_open_per_user" ON "UserEmployeeLink"("userId") WHERE "status" IN ('PROPOSED', 'CONFIRMED', 'LEGACY_LINKED');
CREATE UNIQUE INDEX "UserEmployeeLink_one_open_per_employee" ON "UserEmployeeLink"("employeeId") WHERE "status" IN ('PROPOSED', 'CONFIRMED', 'LEGACY_LINKED');

ALTER TABLE "CredentialToken"
  ADD CONSTRAINT "CredentialToken_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "CredentialToken_codeHash_check" CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "CredentialToken_credentialFingerprint_check" CHECK ("credentialFingerprint" ~ '^[0-9a-f]{64}$'),
  -- A first attestation has its second channel (the code), its attester and his note (RT-PAY-1102 / 1201).
  ADD CONSTRAINT "CredentialToken_purpose_check" CHECK (
    ("purpose" = 'FIRST_ATTESTATION' AND "codeHash" IS NOT NULL AND "attesterId" IS NOT NULL AND "verificationNote" IS NOT NULL)
    OR ("purpose" = 'RESET' AND "codeHash" IS NULL AND "attesterId" IS NULL)),
  ADD CONSTRAINT "CredentialToken_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "CredentialToken_single_end_check" CHECK ("usedAt" IS NULL OR "revokedAt" IS NULL),
  ADD CONSTRAINT "CredentialToken_expiry_check" CHECK ("expiresAt" > "createdAt");

-- At most one usable link per account: issuing a new one revokes the previous one.
CREATE UNIQUE INDEX "CredentialToken_one_open_per_user" ON "CredentialToken"("userId") WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;

ALTER TABLE "IdentityChangeRequest"
  ADD CONSTRAINT "IdentityChangeRequest_role_check" CHECK (("kind" = 'CHANGE_ROLE') = ("nextRole" IS NOT NULL)),
  ADD CONSTRAINT "IdentityChangeRequest_decided_check" CHECK ("status" NOT IN ('EXECUTED', 'REJECTED') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)),
  ADD CONSTRAINT "IdentityChangeRequest_executed_check" CHECK (("status" = 'EXECUTED') = ("executedAt" IS NOT NULL)),
  -- DEC-PO-021 / 024: a two-person change is executed only on the approval of someone else.
  ADD CONSTRAINT "IdentityChangeRequest_two_person_check" CHECK (
    "status" <> 'EXECUTED' OR NOT "twoPerson" OR ("decidedById" IS NOT NULL AND "decidedById" <> "requestedById"));

CREATE UNIQUE INDEX "IdentityChangeRequest_one_pending_per_user" ON "IdentityChangeRequest"("userId") WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- Backfill (§17, DEC-PO-013)
-- ---------------------------------------------------------------------------
-- User.createdById: the author of the earliest AuditLog CREATE row of the account, when that author is
-- another account that still exists. No match: NULL (unknown).
UPDATE "User" u
   SET "createdById" = c."creatorId"
  FROM (
    SELECT DISTINCT ON (a."entityId") a."entityId" AS "userId", a."userId" AS "creatorId"
      FROM "AuditLog" a
     WHERE a."action" = 'CREATE' AND a."entityType" = 'User' AND a."entityId" IS NOT NULL AND a."userId" IS NOT NULL
     ORDER BY a."entityId", a."createdAt" ASC, a."id" ASC
  ) c
 WHERE u."id" = c."userId"
   AND u."createdById" IS NULL
   AND c."creatorId" <> u."id"
   AND EXISTS (SELECT 1 FROM "User" x WHERE x."id" = c."creatorId");

-- User.emailSetById / emailSetAt: who last set the login email, from the legacy AuditLog (the admin edit
-- logged "email":{"from"…}, the self change "field":"email", the creation a CREATE row), when that author
-- still exists. No match: NULL (unknown, nothing invented).
UPDATE "User" u
   SET "emailSetById" = s."setterId", "emailSetAt" = s."at"
  FROM (
    SELECT DISTINCT ON (a."entityId") a."entityId" AS "userId", a."userId" AS "setterId", a."createdAt" AS "at"
      FROM "AuditLog" a
     WHERE a."entityType" = 'User' AND a."entityId" IS NOT NULL AND a."userId" IS NOT NULL
       AND (a."action" = 'CREATE'
            OR (a."action" = 'UPDATE' AND (a."details" LIKE '%"email":{"from"%' OR a."details" LIKE '%"field":"email"%')))
     ORDER BY a."entityId", a."createdAt" DESC, a."id" DESC
  ) s
 WHERE u."id" = s."userId"
   AND EXISTS (SELECT 1 FROM "User" x WHERE x."id" = s."setterId");

-- Every existing login link becomes LEGACY_LINKED (confirmed by the attestation itself, §17).
INSERT INTO "UserEmployeeLink" ("id", "userId", "employeeId", "status", "legacy", "proposedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, e."userId", e."id", 'LEGACY_LINKED', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "Employee" e
 WHERE e."userId" IS NOT NULL;

INSERT INTO "AuditRecord" ("id", "actorType", "actorId", "action", "entityType", "after", "reason")
SELECT gen_random_uuid()::text, 'SYSTEM', '9zk_identity_controls', 'identity.legacy.backfilled', 'User',
       jsonb_build_object(
         'users', (SELECT count(*) FROM "User"),
         'unattested', (SELECT count(*) FROM "User" WHERE "identityStatus" = 'UNATTESTED'),
         'createdByFromAuditLog', (SELECT count(*) FROM "User" WHERE "createdById" IS NOT NULL),
         'createdByUnknown', (SELECT count(*) FROM "User" WHERE "createdById" IS NULL),
         'legacyLinks', (SELECT count(*) FROM "UserEmployeeLink" WHERE "status" = 'LEGACY_LINKED')),
       'BL-PAY-005: every account starts UNATTESTED (DEC-PO-013); createdById from AuditLog; existing links LEGACY_LINKED';

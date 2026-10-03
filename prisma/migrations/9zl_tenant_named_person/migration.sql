-- 9zl_tenant_named_person: TENANT_ROOT and the owner's named people from Radeef's vendor panel
-- (BL-PAY-017 / BL-PAY-022; pay-to-be.md BR-PAY-005 "جذر الثقة"، "إقرار الجذر لما سمّاه المالك"، "الشخص
-- المسمّى"، §17; DEC-PO-016 / 018 / 022; RT-PAY-602 / 603 / 702 / 1301 / 1403).
--
--   TenantNamedPerson   iam table, written only by the vendor operations (src/modules/iam/vendor, run by
--                       radeef-manage over SSH through money.gateway). NAMED_PERSON rows are the owner's list
--                       for ROOT_ATTEST_OWN (email + a keyed hash of the national id); the OWNER_CONTACT row is
--                       the owner's contact of the DEC-PO-022 channel. The account link (userId) is Radeef's
--                       too (RT-PAY-1403).
--   CredentialToken     codeDelivery (ATTESTER | VENDOR: ROOT_ATTEST_OWN, the code comes from Radeef, never
--                       the root, RT-PAY-1301), codeReleasedAt (released once to the vendor operator),
--                       namedPersonId (the list entry it relies on); purpose INVITE (Radeef's invitation).
--
-- No backfill: nothing is named before Radeef registers the owner's formal request. Additive only.

-- CreateEnum
CREATE TYPE "CredentialCodeDelivery" AS ENUM ('ATTESTER', 'VENDOR');

-- CreateEnum
CREATE TYPE "TenantNamedPersonKind" AS ENUM ('NAMED_PERSON', 'OWNER_CONTACT');

-- AlterEnum (the new value is compared as text below: an enum value added in this transaction cannot be used in it)
ALTER TYPE "CredentialTokenPurpose" ADD VALUE 'INVITE';

-- AlterEnum (DEC-PO-143: revoking a named person drops the linked account's attestation; not used in this script)
ALTER TYPE "IdentityDropReason" ADD VALUE 'NAMED_PERSON_REVOKED';

-- AlterTable
ALTER TABLE "CredentialToken" ADD COLUMN     "codeDelivery" "CredentialCodeDelivery" NOT NULL DEFAULT 'ATTESTER',
ADD COLUMN     "codeReleasedAt" TIMESTAMP(3),
ADD COLUMN     "namedPersonId" TEXT;

-- CreateTable
CREATE TABLE "TenantNamedPerson" (
    "id" TEXT NOT NULL,
    "kind" "TenantNamedPersonKind" NOT NULL,
    "email" TEXT,
    "mobile" TEXT,
    "name" TEXT,
    "nationalIdHash" TEXT,
    "requestRef" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "linkedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeRequestRef" TEXT,

    CONSTRAINT "TenantNamedPerson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantNamedPerson_kind_revokedAt_idx" ON "TenantNamedPerson"("kind", "revokedAt");

-- CreateIndex
CREATE INDEX "TenantNamedPerson_userId_idx" ON "TenantNamedPerson"("userId");

-- AddForeignKey
ALTER TABLE "TenantNamedPerson" ADD CONSTRAINT "TenantNamedPerson_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialToken" ADD CONSTRAINT "CredentialToken_namedPersonId_fkey" FOREIGN KEY ("namedPersonId") REFERENCES "TenantNamedPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity (fail closed at the database too)
-- ---------------------------------------------------------------------------
ALTER TABLE "TenantNamedPerson"
  ADD CONSTRAINT "TenantNamedPerson_email_lower_check" CHECK ("email" IS NULL OR ("email" = lower("email") AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  ADD CONSTRAINT "TenantNamedPerson_mobile_check" CHECK ("mobile" IS NULL OR "mobile" ~ '^\+?[0-9]{8,15}$'),
  ADD CONSTRAINT "TenantNamedPerson_nationalIdHash_check" CHECK ("nationalIdHash" IS NULL OR "nationalIdHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "TenantNamedPerson_requestRef_check" CHECK (length(btrim("requestRef")) > 0),
  -- A named person has an email and an id (the ROOT_ATTEST_OWN address, RT-PAY-702); the owner contact has a way to reach him.
  ADD CONSTRAINT "TenantNamedPerson_kind_check" CHECK (
    ("kind" = 'NAMED_PERSON' AND "email" IS NOT NULL AND "nationalIdHash" IS NOT NULL)
    OR ("kind" = 'OWNER_CONTACT' AND ("email" IS NOT NULL OR "mobile" IS NOT NULL) AND "userId" IS NULL)),
  ADD CONSTRAINT "TenantNamedPerson_link_check" CHECK (("userId" IS NULL) = ("linkedAt" IS NULL) AND ("linkedAt" IS NULL) = ("linkedBy" IS NULL)),
  ADD CONSTRAINT "TenantNamedPerson_revoked_check" CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL));

-- One open entry per named email, one open entry per account, one open owner contact.
CREATE UNIQUE INDEX "TenantNamedPerson_one_open_email" ON "TenantNamedPerson"("email") WHERE "kind" = 'NAMED_PERSON' AND "revokedAt" IS NULL;
CREATE UNIQUE INDEX "TenantNamedPerson_one_open_user" ON "TenantNamedPerson"("userId") WHERE "userId" IS NOT NULL AND "revokedAt" IS NULL;
CREATE UNIQUE INDEX "TenantNamedPerson_one_owner_contact" ON "TenantNamedPerson"("kind") WHERE "kind" = 'OWNER_CONTACT' AND "revokedAt" IS NULL;

-- The purpose check of 9zk, extended: INVITE (Radeef's invitation: no code, no attester); a VENDOR-delivered
-- code only on a first attestation that names its list entry (ROOT_ATTEST_OWN).
ALTER TABLE "CredentialToken" DROP CONSTRAINT "CredentialToken_purpose_check";
ALTER TABLE "CredentialToken"
  ADD CONSTRAINT "CredentialToken_purpose_check" CHECK (
    ("purpose"::text = 'FIRST_ATTESTATION' AND "codeHash" IS NOT NULL AND "attesterId" IS NOT NULL AND "verificationNote" IS NOT NULL)
    OR ("purpose"::text IN ('RESET', 'INVITE') AND "codeHash" IS NULL AND "attesterId" IS NULL)),
  ADD CONSTRAINT "CredentialToken_code_delivery_check" CHECK (
    "codeDelivery" = 'ATTESTER'
    OR ("purpose"::text = 'FIRST_ATTESTATION' AND "namedPersonId" IS NOT NULL)),
  ADD CONSTRAINT "CredentialToken_code_released_check" CHECK ("codeReleasedAt" IS NULL OR "codeDelivery" = 'VENDOR');

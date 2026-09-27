-- Document engine phase 3 (docs/document-engine/SPEC.md §9, owner decisions 2026-09-27): every issued
-- PDF carries a PAdES seal made with the legal company's own key and a self-issued certificate (no
-- external CA, signing time from the server clock). The private key is stored encrypted with
-- DATA_ENCRYPTION_KEY (src/lib/crypto.ts), so escrowing that key also escrows the seal keys.

-- CreateTable
CREATE TABLE "DocumentSealKey" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "certDer" BYTEA NOT NULL,
    "keyEnc" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "serialHex" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "DocumentSealKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSealKey_fingerprint_key" ON "DocumentSealKey"("fingerprint");
CREATE INDEX "DocumentSealKey_companyId_idx" ON "DocumentSealKey"("companyId");

-- One key in force per company (a race between two first issuances creates one; the loser rereads).
CREATE UNIQUE INDEX "DocumentSealKey_one_active" ON "DocumentSealKey"("companyId") WHERE "retiredAt" IS NULL;

-- A key is never deleted or changed; it can only be retired once (documents sealed with it stay verifiable).
CREATE FUNCTION "document_seal_key_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DocumentSealKey rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."certDer", NEW."keyEnc", NEW."fingerprint", NEW."serialHex", NEW."notBefore", NEW."notAfter", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."certDer", OLD."keyEnc", OLD."fingerprint", OLD."serialHex", OLD."notBefore", OLD."notAfter", OLD."createdById", OLD."createdAt")
     OR OLD."retiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'DocumentSealKey % is immutable', OLD."fingerprint" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DocumentSealKey_guard"
  BEFORE UPDATE OR DELETE ON "DocumentSealKey"
  FOR EACH ROW EXECUTE FUNCTION "document_seal_key_guard"();

-- AlterTable: the key that sealed the document (null: issued before the seal existed).
ALTER TABLE "IssuedDocument" ADD COLUMN "sealKeyId" TEXT;
CREATE INDEX "IssuedDocument_sealKeyId_idx" ON "IssuedDocument"("sealKeyId");
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_sealKeyId_fkey" FOREIGN KEY ("sealKeyId") REFERENCES "DocumentSealKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The guard now also covers the seal key.
CREATE OR REPLACE FUNCTION "issued_document_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IssuedDocument rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."number", NEW."legalCompanyId", NEW."employeeId", NEW."jobApplicationId", NEW."typeKey", NEW."requestId",
      NEW."snapshotId", NEW."snapshotSha256", NEW."approvalId", NEW."signatoryId", NEW."authorizationId",
      NEW."templateRef", NEW."templateSha256", NEW."rendererId", NEW."rendererVersion", NEW."typstSha256",
      NEW."fontsSha256", NEW."pdfStandard", NEW."storedName", NEW."pdfSha256", NEW."pdfSize",
      NEW."verifyTokenHash", NEW."validUntil", NEW."issuedAt", NEW."issuedById", NEW."createdAt", NEW."sealKeyId")
     IS DISTINCT FROM
     (OLD."id", OLD."number", OLD."legalCompanyId", OLD."employeeId", OLD."jobApplicationId", OLD."typeKey", OLD."requestId",
      OLD."snapshotId", OLD."snapshotSha256", OLD."approvalId", OLD."signatoryId", OLD."authorizationId",
      OLD."templateRef", OLD."templateSha256", OLD."rendererId", OLD."rendererVersion", OLD."typstSha256",
      OLD."fontsSha256", OLD."pdfStandard", OLD."storedName", OLD."pdfSha256", OLD."pdfSize",
      OLD."verifyTokenHash", OLD."validUntil", OLD."issuedAt", OLD."issuedById", OLD."createdAt", OLD."sealKeyId") THEN
    RAISE EXCEPTION 'IssuedDocument % is immutable (DOC-07)', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'ISSUED' AND NEW."status" IN ('REVOKED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'IssuedDocument status % -> % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'ISSUED' AND (NEW."revokedAt", NEW."revokedById", NEW."revokeReason", NEW."supersededById")
     IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById", OLD."revokeReason", OLD."supersededById") THEN
    RAISE EXCEPTION 'IssuedDocument % is already closed', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."purgedAt" IS NOT NULL AND NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" THEN
    RAISE EXCEPTION 'IssuedDocument % purge mark cannot change', OLD."number" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

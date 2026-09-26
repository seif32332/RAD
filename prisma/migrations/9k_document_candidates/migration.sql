-- Documents for job applicants (owner decision 2026-09-26: the job offer is issued to a candidate
-- who has no employee file yet). A request / issued document belongs to exactly one subject: an
-- employee or a job application. The candidate answers the offer through a private link
-- (CandidateDocumentAccess), so an acknowledgement may have no user / employee (via LINK).

-- AlterTable
ALTER TABLE "DocumentAcknowledgement" ADD COLUMN     "via" TEXT NOT NULL DEFAULT 'PORTAL',
ALTER COLUMN "employeeId" DROP NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "DocumentRequest" ADD COLUMN     "jobApplicationId" TEXT,
ALTER COLUMN "employeeId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "IssuedDocument" ADD COLUMN     "jobApplicationId" TEXT,
ALTER COLUMN "employeeId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CandidateDocumentAccess" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateDocumentAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateDocumentAccess_documentId_key" ON "CandidateDocumentAccess"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateDocumentAccess_tokenHash_key" ON "CandidateDocumentAccess"("tokenHash");

-- CreateIndex
CREATE INDEX "DocumentRequest_jobApplicationId_idx" ON "DocumentRequest"("jobApplicationId");

-- CreateIndex
CREATE INDEX "IssuedDocument_jobApplicationId_idx" ON "IssuedDocument"("jobApplicationId");

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_jobApplicationId_fkey" FOREIGN KEY ("jobApplicationId") REFERENCES "JobApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_jobApplicationId_fkey" FOREIGN KEY ("jobApplicationId") REFERENCES "JobApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateDocumentAccess" ADD CONSTRAINT "CandidateDocumentAccess_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "IssuedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one subject.
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_one_subject" CHECK (("employeeId" IS NULL) <> ("jobApplicationId" IS NULL));
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_one_subject" CHECK (("employeeId" IS NULL) <> ("jobApplicationId" IS NULL));
ALTER TABLE "DocumentAcknowledgement" ADD CONSTRAINT "DocumentAcknowledgement_who" CHECK (
  ("via" = 'PORTAL' AND "userId" IS NOT NULL AND "employeeId" IS NOT NULL) OR ("via" = 'LINK' AND "userId" IS NULL)
);

-- The new subject column is as immutable as the rest of an issued document (DOC-07).
CREATE OR REPLACE FUNCTION "issued_document_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IssuedDocument rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."number", NEW."legalCompanyId", NEW."employeeId", NEW."jobApplicationId", NEW."typeKey", NEW."requestId",
      NEW."snapshotId", NEW."snapshotSha256", NEW."approvalId", NEW."signatoryId", NEW."authorizationId",
      NEW."templateRef", NEW."templateSha256", NEW."rendererId", NEW."rendererVersion", NEW."typstSha256",
      NEW."fontsSha256", NEW."pdfStandard", NEW."storedName", NEW."pdfSha256", NEW."pdfSize",
      NEW."verifyTokenHash", NEW."validUntil", NEW."issuedAt", NEW."issuedById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."number", OLD."legalCompanyId", OLD."employeeId", OLD."jobApplicationId", OLD."typeKey", OLD."requestId",
      OLD."snapshotId", OLD."snapshotSha256", OLD."approvalId", OLD."signatoryId", OLD."authorizationId",
      OLD."templateRef", OLD."templateSha256", OLD."rendererId", OLD."rendererVersion", OLD."typstSha256",
      OLD."fontsSha256", OLD."pdfStandard", OLD."storedName", OLD."pdfSha256", OLD."pdfSize",
      OLD."verifyTokenHash", OLD."validUntil", OLD."issuedAt", OLD."issuedById", OLD."createdAt") THEN
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

-- The acknowledgement guard now also covers how the answer was given.
CREATE OR REPLACE FUNCTION "document_acknowledgement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DocumentAcknowledgement rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."documentId", NEW."employeeId", NEW."userId", NEW."decision", NEW."via", NEW."acknowledgedAt")
     IS DISTINCT FROM (OLD."id", OLD."documentId", OLD."employeeId", OLD."userId", OLD."decision", OLD."via", OLD."acknowledgedAt")
     OR (NEW."comment" IS DISTINCT FROM OLD."comment" AND NEW."comment" IS NOT NULL) THEN
    RAISE EXCEPTION 'DocumentAcknowledgement is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A candidate link is never rewritten or deleted (its lifetime is expiresAt).
CREATE FUNCTION "candidate_document_access_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CandidateDocumentAccess is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "CandidateDocumentAccess_guard"
  BEFORE UPDATE OR DELETE ON "CandidateDocumentAccess"
  FOR EACH ROW EXECUTE FUNCTION "candidate_document_access_guard"();

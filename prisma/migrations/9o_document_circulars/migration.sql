-- Administrative decisions and circulars (docs/document-engine/SPEC.md §15 item 37, 2026-09-27): a
-- document of the legal company itself, addressed to a group of employees (the whole company,
-- branches, departments or named employees). It has no single subject; each recipient is a row
-- here and acknowledges having read it, once.

-- A document without employee and without candidate is allowed for circulars only.
ALTER TABLE "DocumentRequest" DROP CONSTRAINT "DocumentRequest_one_subject";
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_one_subject" CHECK (
  (("employeeId" IS NULL) <> ("jobApplicationId" IS NULL))
  OR ("employeeId" IS NULL AND "jobApplicationId" IS NULL AND "typeKey" = 'ADMIN_CIRCULAR')
);
ALTER TABLE "IssuedDocument" DROP CONSTRAINT "IssuedDocument_one_subject";
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_one_subject" CHECK (
  (("employeeId" IS NULL) <> ("jobApplicationId" IS NULL))
  OR ("employeeId" IS NULL AND "jobApplicationId" IS NULL AND "typeKey" = 'ADMIN_CIRCULAR')
);

-- CreateTable
CREATE TABLE "CircularRecipient" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircularRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CircularRecipient_documentId_employeeId_key" ON "CircularRecipient"("documentId", "employeeId");
CREATE INDEX "CircularRecipient_employeeId_idx" ON "CircularRecipient"("employeeId");

-- AddForeignKey
ALTER TABLE "CircularRecipient" ADD CONSTRAINT "CircularRecipient_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "IssuedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CircularRecipient" ADD CONSTRAINT "CircularRecipient_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The distribution is fixed at issuance; the only change is the acknowledgement, once.
CREATE FUNCTION "circular_recipient_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CircularRecipient rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."documentId", NEW."employeeId", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."documentId", OLD."employeeId", OLD."createdAt")
     OR OLD."acknowledgedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CircularRecipient is decided (acknowledged once)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CircularRecipient_guard"
  BEFORE UPDATE OR DELETE ON "CircularRecipient"
  FOR EACH ROW EXECUTE FUNCTION "circular_recipient_guard"();

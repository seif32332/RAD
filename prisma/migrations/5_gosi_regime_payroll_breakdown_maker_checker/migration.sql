-- CreateEnum
CREATE TYPE "GosiRegime" AS ENUM ('OLD', 'NEW', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('NATIONAL_ID', 'IQAMA', 'BORDER_NUMBER', 'PASSPORT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeaveType" ADD VALUE 'MATERNITY';
ALTER TYPE "LeaveType" ADD VALUE 'PATERNITY';
ALTER TYPE "LeaveType" ADD VALUE 'BEREAVEMENT';
ALTER TYPE "LeaveType" ADD VALUE 'MARRIAGE';
ALTER TYPE "LeaveType" ADD VALUE 'HAJJ';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TerminationReason" ADD VALUE 'ARTICLE_81';
ALTER TYPE "TerminationReason" ADD VALUE 'ARTICLE_87';
ALTER TYPE "TerminationReason" ADD VALUE 'CONTRACT_EXPIRY';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "gosiEstablishmentNumber" TEXT,
ADD COLUMN     "molEstablishmentNumber" TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "gosiNumber" TEXT,
ADD COLUMN     "gosiRegime" "GosiRegime" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "gosiRegistrationSource" TEXT,
ADD COLUMN     "idType" "IdType",
ALTER COLUMN "nationality" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Allowance" ADD COLUMN     "countsTowardGosi" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payroll" ADD COLUMN     "bonusAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "gosiEmployee" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "gosiEmployer" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "leaveDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "loansDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "otherDeductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "violationsDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "paidById" TEXT,
ADD COLUMN     "requestedById" TEXT;

-- AlterTable
ALTER TABLE "UploadedFile" ADD COLUMN     "category" TEXT;

-- CreateTable
CREATE TABLE "GosiRate" (
    "id" TEXT NOT NULL,
    "regime" "GosiRegime" NOT NULL,
    "isSaudi" BOOLEAN NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "employeeRate" DOUBLE PRECISION NOT NULL,
    "employerRate" DOUBLE PRECISION NOT NULL,
    "minWage" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "maxWage" DOUBLE PRECISION NOT NULL DEFAULT 45000,
    "isProvisional" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GosiRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "details" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GosiRate_regime_isSaudi_effectiveFrom_key" ON "GosiRate"("regime", "isSaudi", "effectiveFrom");

-- CreateIndex
CREATE INDEX "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_idempotencyKey_key" ON "NotificationOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_createdAt_idx" ON "NotificationOutbox"("status", "createdAt");


-- ---------------------------------------------------------------------------
-- Data backfill
-- ---------------------------------------------------------------------------

-- Saudi employees who joined THIS employer before the new Social Insurance Law took effect
-- (2024-07-03) were necessarily insured before it: they stay on the OLD regime. Everyone else
-- stays UNKNOWN until HR confirms from the GOSI certificate (a later hire may still be OLD if
-- they had prior contributions, so the regime is never derived from the hire date alone).
UPDATE "Employee" SET "gosiRegime" = 'OLD', "gosiRegistrationSource" = 'تاريخ التعيين قبل 2024-07-03 (ترحيل آلي)'
WHERE "joinDate" < '2024-07-03' AND "nationality" IN ('سعودي', 'سعودية', 'SAUDI', 'Saudi', 'saudi');

-- Housing allowances were detected by name; make it an explicit flag.
UPDATE "Allowance" SET "countsTowardGosi" = TRUE
WHERE "isMonthly" = TRUE AND ("name" ILIKE '%سكن%' OR "name" ILIKE '%housing%');

-- Dated GOSI contribution rates (percent of contributory wage = basic + housing, capped 1,500..45,000).
-- OLD regime: employee 9% annuities + 0.75% SANED; employer 9% + 0.75% SANED + 2% occupational hazards.
-- NEW regime (new entrants from 2024-07-03): annuity share rises 0.5 point per side every 1 July
-- from 2025 to 2028. Marked PROVISIONAL: corroborated by several secondary sources (vendor knowledge
-- bases and payroll consultancies) but not yet confirmed from the official GOSI text.
INSERT INTO "GosiRate" ("id", "regime", "isSaudi", "effectiveFrom", "employeeRate", "employerRate", "minWage", "maxWage", "isProvisional", "source") VALUES
  ('gosi-old-saudi-2000',    'OLD', TRUE,  '2000-01-01', 9.75,  11.75, 1500, 45000, FALSE, 'GOSI FAQ (employer): 21.5% total for Saudis'),
  ('gosi-old-nonsaudi-2000', 'OLD', FALSE, '2000-01-01', 0,     2,     1500, 45000, FALSE, 'Occupational hazards 2% employer-only for non-Saudis'),
  ('gosi-new-saudi-2024',    'NEW', TRUE,  '2024-07-03', 9.75,  11.75, 1500, 45000, TRUE,  'New Social Insurance Law: same rates until the first step'),
  ('gosi-new-saudi-2025',    'NEW', TRUE,  '2025-07-01', 10.25, 12.25, 1500, 45000, TRUE,  'Annuity +0.5/side (ZenHR/Jisr KB, Mercans) — confirm with GOSI'),
  ('gosi-new-saudi-2026',    'NEW', TRUE,  '2026-07-01', 10.75, 12.75, 1500, 45000, TRUE,  'Annuity +0.5/side — confirm with GOSI'),
  ('gosi-new-saudi-2027',    'NEW', TRUE,  '2027-07-01', 11.25, 13.25, 1500, 45000, TRUE,  'Annuity +0.5/side — confirm with GOSI'),
  ('gosi-new-saudi-2028',    'NEW', TRUE,  '2028-07-01', 11.75, 13.75, 1500, 45000, TRUE,  'Annuity +0.5/side — confirm with GOSI'),
  ('gosi-new-nonsaudi-2024', 'NEW', FALSE, '2024-07-03', 0,     2,     1500, 45000, FALSE, 'Occupational hazards 2% employer-only for non-Saudis')
ON CONFLICT ("regime", "isSaudi", "effectiveFrom") DO NOTHING;

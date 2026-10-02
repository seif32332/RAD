-- 9zf_payroll_gateway (master plan P1-PAY-A: BL-PAY-006 with Payroll.companyId; pay-to-be.md §17 as
-- amended by arc-conformance.md ARC-PAY-A7; DOMAIN_BOUNDARIES §5.2 payroll owns PayrollMonth)
--
-- Order (BL-PAY-012): after every 9* letter up to 9ze; the next free letter at implementation time.
-- Trial step (BL-PAY-024): the gateway spike ran on Postgres 16 before this migration was written
-- (src/modules/platform/__tests__/money-gateway.it.test.ts). The code of the same release is the only
-- writer of the new columns; the extension of money.gateway refuses any other write to these tables.
--
-- 1. PayrollMonth: one row per legal company and month (ARC-PAY-A7), status CHECK (ARCH-015).
-- 2. Payroll: companyId, payrollMonthId (the line's company and month), actor columns (BR-PAY-006).
--    Kept: UNIQUE (employeeId, month, year) until BL-PAY-008b prorates a mid-month transfer (a line in
--    a second company would pay the month twice today). Added: UNIQUE (payrollMonthId, employeeId).
-- 3. Actor columns on Loan, Deduction, OvertimeRequest, Allowance, Settlement; Allowance.status;
--    PaymentRequest.beneficiaryEmployeeId (cache, §17) + approvedAt / paidAt. Every *ById is a FK to
--    User ON DELETE RESTRICT (BR-PAY-011: no SetNull on an actor).
--
-- Backfill (idempotent: every UPDATE only touches NULL columns):
--   Payroll.companyId      := the employee's legal company, else its actual company. Rows still NULL
--                             are listed by RAISE NOTICE and stay NULL; the CHECK Payroll_companyId_required
--                             (NOT VALID) refuses any NEW row without a company, and is VALIDATED here when
--                             nothing is left unresolved.
--   PayrollMonth           := one per (companyId, year, month) of the resolved lines; status PAID when every
--                             line is PAID, APPROVED when none is DRAFT, else CALCULATED.
--   Payroll.payrollMonthId := that month.
--   Allowance.status       := APPROVED (existing allowances were effective when written).
--   PaymentRequest.beneficiaryEmployeeId := the employee of the linked record (EMPLOYEE, SETTLEMENT, LOAN, VISA).
-- Legacy approvers stay NULL (the attestation of BR-PAY-015 is BL-PAY-009).
--
-- Rollback: the previous release ignores the new columns and table (expand only); drop them to undo.

-- AlterTable
ALTER TABLE "Allowance" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'APPROVED';

-- AlterTable
ALTER TABLE "Deduction" ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "issuedById" TEXT;

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "financeReviewedById" TEXT,
ADD COLUMN     "forgivenById" TEXT,
ADD COLUMN     "hrApprovedById" TEXT,
ADD COLUMN     "managerApprovedById" TEXT,
ADD COLUMN     "ownerApprovedById" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" TEXT,
ADD COLUMN     "transferredById" TEXT;

-- AlterTable
ALTER TABLE "OvertimeRequest" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT;

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "beneficiaryEmployeeId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payroll" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "generatedById" TEXT,
ADD COLUMN     "paidById" TEXT,
ADD COLUMN     "payrollMonthId" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "paidById" TEXT;

-- CreateTable
CREATE TABLE "PayrollMonth" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3),
    "calculatedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollMonth_year_month_idx" ON "PayrollMonth"("year", "month");

-- CreateIndex
CREATE INDEX "PayrollMonth_status_idx" ON "PayrollMonth"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollMonth_companyId_year_month_key" ON "PayrollMonth"("companyId", "year", "month");

-- CreateIndex
CREATE INDEX "Payroll_companyId_year_month_idx" ON "Payroll"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Payroll_payrollMonthId_employeeId_key" ON "Payroll"("payrollMonthId", "employeeId");

-- AddForeignKey
ALTER TABLE "Allowance" ADD CONSTRAINT "Allowance_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allowance" ADD CONSTRAINT "Allowance_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_payrollMonthId_fkey" FOREIGN KEY ("payrollMonthId") REFERENCES "PayrollMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollMonth" ADD CONSTRAINT "PayrollMonth_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollMonth" ADD CONSTRAINT "PayrollMonth_calculatedById_fkey" FOREIGN KEY ("calculatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollMonth" ADD CONSTRAINT "PayrollMonth_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollMonth" ADD CONSTRAINT "PayrollMonth_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_managerApprovedById_fkey" FOREIGN KEY ("managerApprovedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_hrApprovedById_fkey" FOREIGN KEY ("hrApprovedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_ownerApprovedById_fkey" FOREIGN KEY ("ownerApprovedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_transferredById_fkey" FOREIGN KEY ("transferredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_financeReviewedById_fkey" FOREIGN KEY ("financeReviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_forgivenById_fkey" FOREIGN KEY ("forgivenById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_beneficiaryEmployeeId_fkey" FOREIGN KEY ("beneficiaryEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- State columns (ARCH-015)
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "PayrollMonth" ADD CONSTRAINT "PayrollMonth_status_check"
  CHECK ("status" IN ('DRAFT', 'CALCULATED', 'LINES_APPROVED', 'APPROVED', 'EXPORTED', 'PAID', 'PAYMENT_EXCEPTION'));
ALTER TABLE "PayrollMonth" ADD CONSTRAINT "PayrollMonth_period_check"
  CHECK ("month" BETWEEN 1 AND 12 AND "year" BETWEEN 2000 AND 2100);
ALTER TABLE "Allowance" ADD CONSTRAINT "Allowance_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'));

-- ---------------------------------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------------------------------
UPDATE "Payroll" p
   SET "companyId" = COALESCE(e."legalCompanyId", e."actualCompanyId")
  FROM "Employee" e
 WHERE e."id" = p."employeeId" AND p."companyId" IS NULL
   AND COALESCE(e."legalCompanyId", e."actualCompanyId") IS NOT NULL;

INSERT INTO "PayrollMonth" ("id", "companyId", "year", "month", "status", "updatedAt")
SELECT gen_random_uuid()::text, p."companyId", p."year", p."month",
       CASE
         WHEN bool_and(p."status" = 'PAID') THEN 'PAID'
         WHEN bool_or(p."status" = 'DRAFT') THEN 'CALCULATED'
         ELSE 'APPROVED'
       END,
       CURRENT_TIMESTAMP
  FROM "Payroll" p
 WHERE p."companyId" IS NOT NULL
 GROUP BY p."companyId", p."year", p."month"
ON CONFLICT ("companyId", "year", "month") DO NOTHING;

UPDATE "Payroll" p
   SET "payrollMonthId" = m."id"
  FROM "PayrollMonth" m
 WHERE p."payrollMonthId" IS NULL AND m."companyId" = p."companyId" AND m."year" = p."year" AND m."month" = p."month";

UPDATE "PaymentRequest" r SET "beneficiaryEmployeeId" = r."entityId"
 WHERE r."beneficiaryEmployeeId" IS NULL AND r."entityType" = 'EMPLOYEE'
   AND EXISTS (SELECT 1 FROM "Employee" e WHERE e."id" = r."entityId");
UPDATE "PaymentRequest" r SET "beneficiaryEmployeeId" = s."employeeId"
  FROM "Settlement" s WHERE r."beneficiaryEmployeeId" IS NULL AND r."entityType" = 'SETTLEMENT' AND s."id" = r."entityId";
UPDATE "PaymentRequest" r SET "beneficiaryEmployeeId" = l."employeeId"
  FROM "Loan" l WHERE r."beneficiaryEmployeeId" IS NULL AND r."entityType" = 'LOAN' AND l."id" = r."entityId";
UPDATE "PaymentRequest" r SET "beneficiaryEmployeeId" = v."employeeId"
  FROM "Visa" v WHERE r."beneficiaryEmployeeId" IS NULL AND r."entityType" = 'VISA' AND v."id" = r."entityId" AND v."employeeId" IS NOT NULL;

-- A line always carries its company from now on (DOMAIN_BOUNDARIES §1.5 "no operational entity without
-- a known company"). Legacy rows the backfill could not resolve are reported and keep NULL.
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_companyId_required" CHECK ("companyId" IS NOT NULL AND "payrollMonthId" IS NOT NULL) NOT VALID;

DO $$
DECLARE
  unresolved INTEGER;
BEGIN
  SELECT count(*) INTO unresolved FROM "Payroll" WHERE "companyId" IS NULL OR "payrollMonthId" IS NULL;
  IF unresolved = 0 THEN
    ALTER TABLE "Payroll" VALIDATE CONSTRAINT "Payroll_companyId_required";
  ELSE
    RAISE NOTICE '9zf_payroll_gateway: % Payroll row(s) have no resolvable company (employee without legal or actual company); they keep companyId NULL and stay visible to unrestricted users only. Fix the employee''s company, then run: UPDATE "Payroll" … and VALIDATE CONSTRAINT "Payroll_companyId_required".', unresolved;
  END IF;
END $$;

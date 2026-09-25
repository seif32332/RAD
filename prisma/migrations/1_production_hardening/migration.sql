-- 1_production_hardening
-- Generated with:
--   prisma migrate diff --from-schema-datamodel <0_baseline schema> --to-schema-datamodel prisma/schema.prisma --script
-- then made re-runnable (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS) so it also applies cleanly to a
-- tenant database that already received some of these objects through `prisma db push`.
-- Purely additive: no DROP TABLE, no DROP COLUMN, no column type changes. Every new NOT NULL column has a default.
-- Foreign keys are re-created (same columns) only to change ON DELETE CASCADE -> RESTRICT.
-- Requires PostgreSQL >= 12 (ALTER TYPE ... ADD VALUE inside the migration transaction).

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';

-- DropForeignKey
ALTER TABLE "Administration" DROP CONSTRAINT IF EXISTS "Administration_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Branch" DROP CONSTRAINT IF EXISTS "Branch_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_branchId_fkey";

-- DropForeignKey
ALTER TABLE "Leave" DROP CONSTRAINT IF EXISTS "Leave_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "Deduction" DROP CONSTRAINT IF EXISTS "Deduction_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "Investigation" DROP CONSTRAINT IF EXISTS "Investigation_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "Loan" DROP CONSTRAINT IF EXISTS "Loan_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "AccidentClaim" DROP CONSTRAINT IF EXISTS "AccidentClaim_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "TerminationRequest" DROP CONSTRAINT IF EXISTS "TerminationRequest_employeeId_fkey";

-- AlterTable
ALTER TABLE "Nationality" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "taxCertificateUrl" TEXT;

-- AlterTable
ALTER TABLE "WorkSchedule" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "CompanyDocument" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Leave" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Allowance" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "isPaid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "paidInPayrollId" TEXT,
ADD COLUMN IF NOT EXISTS "payrollMonth" INTEGER,
ADD COLUMN IF NOT EXISTS "payrollYear" INTEGER,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "OvertimeRequest" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Deduction" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "TelecomSim" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "UtilityMeter" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "SystemSetting" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Circular" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "EvaluationTemplateSection" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "EvaluationTemplateItem" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "EvaluationItemScore" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE IF NOT EXISTS "LoanInstallment" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "payrollId" TEXT,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LoanInstallment_payrollId_idx" ON "LoanInstallment"("payrollId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LoanInstallment_year_month_idx" ON "LoanInstallment"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LoanInstallment_loanId_month_year_key" ON "LoanInstallment"("loanId", "month", "year");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Company_commercialRegExp_idx" ON "Company"("commercialRegExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Company_trademarkExpDate_idx" ON "Company"("trademarkExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Administration_companyId_idx" ON "Administration"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Branch_companyId_idx" ON "Branch"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Branch_administrationId_idx" ON "Branch"("administrationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Branch_munLicenseExp_idx" ON "Branch"("munLicenseExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Branch_civilDefenseExp_idx" ON "Branch"("civilDefenseExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Branch_rentContractExp_idx" ON "Branch"("rentContractExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSchedule_branchId_idx" ON "WorkSchedule"("branchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Department_branchId_idx" ON "Department"("branchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_legalCompanyId_idx" ON "Employee"("legalCompanyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_actualCompanyId_idx" ON "Employee"("actualCompanyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_administrationId_idx" ON "Employee"("administrationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_branchId_idx" ON "Employee"("branchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_departmentId_idx" ON "Employee"("departmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_directManagerId_idx" ON "Employee"("directManagerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_isTerminated_employmentStatus_idx" ON "Employee"("isTerminated", "employmentStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_iqamaOrIdExp_idx" ON "Employee"("iqamaOrIdExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_passportExp_idx" ON "Employee"("passportExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_healthCertificateExp_idx" ON "Employee"("healthCertificateExp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_contractEndDate_idx" ON "Employee"("contractEndDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TransferRequest_employeeId_idx" ON "TransferRequest"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TransferRequest_status_idx" ON "TransferRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CompanyDocument_companyId_idx" ON "CompanyDocument"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CompanyDocument_expirationDate_idx" ON "CompanyDocument"("expirationDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Attendance_date_idx" ON "Attendance"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Leave_employeeId_status_idx" ON "Leave"("employeeId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Leave_status_idx" ON "Leave"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Leave_startDate_endDate_idx" ON "Leave"("startDate", "endDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Visa_employeeId_idx" ON "Visa"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Visa_status_idx" ON "Visa"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Allowance_employeeId_idx" ON "Allowance"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Allowance_payrollYear_payrollMonth_idx" ON "Allowance"("payrollYear", "payrollMonth");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Allowance_paidInPayrollId_idx" ON "Allowance"("paidInPayrollId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payroll_year_month_idx" ON "Payroll"("year", "month");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payroll_status_idx" ON "Payroll"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PromissoryNote_status_idx" ON "PromissoryNote"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PromissoryNote_dueDate_idx" ON "PromissoryNote"("dueDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LegalContract_status_idx" ON "LegalContract"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LegalContract_endDate_idx" ON "LegalContract"("endDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lawsuit_status_idx" ON "Lawsuit"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OvertimeRequest_employeeId_idx" ON "OvertimeRequest"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OvertimeRequest_status_idx" ON "OvertimeRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OvertimeRequest_date_idx" ON "OvertimeRequest"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkAssignment_employeeId_idx" ON "WorkAssignment"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkAssignment_status_idx" ON "WorkAssignment"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Deduction_employeeId_date_idx" ON "Deduction"("employeeId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Deduction_investigationId_idx" ON "Deduction"("investigationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Deduction_status_idx" ON "Deduction"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Deduction_payrollMonth_idx" ON "Deduction"("payrollMonth");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Investigation_employeeId_idx" ON "Investigation"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Investigation_status_idx" ON "Investigation"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Loan_employeeId_idx" ON "Loan"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Loan_status_idx" ON "Loan"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ComplianceViolation_companyId_idx" ON "ComplianceViolation"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ComplianceViolation_branchId_idx" ON "ComplianceViolation"("branchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ComplianceViolation_status_idx" ON "ComplianceViolation"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceCorrection_employeeId_idx" ON "AttendanceCorrection"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceCorrection_status_idx" ON "AttendanceCorrection"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobRequest_departmentId_idx" ON "JobRequest"("departmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobRequest_requesterId_idx" ON "JobRequest"("requesterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobRequest_status_idx" ON "JobRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobApplication_jobRequestId_idx" ON "JobApplication"("jobRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "JobApplication_status_idx" ON "JobApplication"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OnboardingRequest_requesterId_idx" ON "OnboardingRequest"("requesterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OnboardingRequest_status_idx" ON "OnboardingRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Asset_employeeId_idx" ON "Asset"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Asset_status_idx" ON "Asset"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MedicalInsurance_companyId_idx" ON "MedicalInsurance"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MedicalInsurance_expiryDate_idx" ON "MedicalInsurance"("expiryDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelecomSim_companyId_idx" ON "TelecomSim"("companyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelecomSim_branchId_idx" ON "TelecomSim"("branchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelecomSim_employeeId_idx" ON "TelecomSim"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UtilityMeter_branchId_idx" ON "UtilityMeter"("branchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UtilityMeter_legalCompanyId_idx" ON "UtilityMeter"("legalCompanyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UtilityMeter_actualCompanyId_idx" ON "UtilityMeter"("actualCompanyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_legalCompanyId_idx" ON "Vehicle"("legalCompanyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_actualCompanyId_idx" ON "Vehicle"("actualCompanyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_driverId_idx" ON "Vehicle"("driverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_isArchived_idx" ON "Vehicle"("isArchived");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_licenseExpDate_idx" ON "Vehicle"("licenseExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_insuranceExpDate_idx" ON "Vehicle"("insuranceExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_inspectionExpDate_idx" ON "Vehicle"("inspectionExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_operatingCardExpDate_idx" ON "Vehicle"("operatingCardExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_driverCardExpDate_idx" ON "Vehicle"("driverCardExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_drivingAuthExpDate_idx" ON "Vehicle"("drivingAuthExpDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccidentClaim_vehicleId_idx" ON "AccidentClaim"("vehicleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccidentClaim_status_idx" ON "AccidentClaim"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Settlement_employeeId_idx" ON "Settlement"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RenewalArchive_entityId_documentType_idx" ON "RenewalArchive"("entityId", "documentType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RenewalArchive_action_documentType_idx" ON "RenewalArchive"("action", "documentType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RenewalArchive_entityType_entityId_idx" ON "RenewalArchive"("entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TerminationRequest_employeeId_idx" ON "TerminationRequest"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TerminationRequest_status_idx" ON "TerminationRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CertifiedAgency_status_idx" ON "CertifiedAgency"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CertifiedAgency_endDate_idx" ON "CertifiedAgency"("endDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_status_idx" ON "PaymentRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_entityId_documentType_idx" ON "PaymentRequest"("entityId", "documentType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_entityType_entityId_idx" ON "PaymentRequest"("entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Circular_status_datePublished_idx" ON "Circular"("status", "datePublished");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OwnerRequest_status_idx" ON "OwnerRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationTemplateSection_templateId_idx" ON "EvaluationTemplateSection"("templateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationTemplateItem_sectionId_idx" ON "EvaluationTemplateItem"("sectionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationCycle_templateId_idx" ON "EvaluationCycle"("templateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationCycle_status_idx" ON "EvaluationCycle"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeeEvaluation_cycleId_idx" ON "EmployeeEvaluation"("cycleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeeEvaluation_employeeId_idx" ON "EmployeeEvaluation"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeeEvaluation_managerId_idx" ON "EmployeeEvaluation"("managerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeeEvaluation_status_idx" ON "EmployeeEvaluation"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationItemScore_evaluationId_idx" ON "EvaluationItemScore"("evaluationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationItemScore_itemId_idx" ON "EvaluationItemScore"("itemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvaluationApproval_evaluationId_idx" ON "EvaluationApproval"("evaluationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AssetRequest_requesterId_idx" ON "AssetRequest"("requesterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AssetRequest_requestedForId_idx" ON "AssetRequest"("requestedForId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AssetRequest_status_idx" ON "AssetRequest"("status");

-- AddForeignKey
ALTER TABLE "Administration" DROP CONSTRAINT IF EXISTS "Administration_companyId_fkey";
ALTER TABLE "Administration" ADD CONSTRAINT "Administration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" DROP CONSTRAINT IF EXISTS "Branch_companyId_fkey";
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_branchId_fkey";
ALTER TABLE "Department" ADD CONSTRAINT "Department_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" DROP CONSTRAINT IF EXISTS "Leave_employeeId_fkey";
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deduction" DROP CONSTRAINT IF EXISTS "Deduction_employeeId_fkey";
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" DROP CONSTRAINT IF EXISTS "Investigation_employeeId_fkey";
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" DROP CONSTRAINT IF EXISTS "Loan_employeeId_fkey";
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" DROP CONSTRAINT IF EXISTS "LoanInstallment_loanId_fkey";
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" DROP CONSTRAINT IF EXISTS "LoanInstallment_payrollId_fkey";
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_payrollId_fkey" FOREIGN KEY ("payrollId") REFERENCES "Payroll"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentClaim" DROP CONSTRAINT IF EXISTS "AccidentClaim_vehicleId_fkey";
ALTER TABLE "AccidentClaim" ADD CONSTRAINT "AccidentClaim_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_employeeId_fkey";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminationRequest" DROP CONSTRAINT IF EXISTS "TerminationRequest_employeeId_fkey";
ALTER TABLE "TerminationRequest" ADD CONSTRAINT "TerminationRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


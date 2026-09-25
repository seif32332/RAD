-- AlterEnum
ALTER TYPE "VisaStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "civilDefenseUrl" TEXT,
ADD COLUMN     "munLicenseUrl" TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "dataReviewNote" TEXT,
ALTER COLUMN "nationality" SET DEFAULT 'سعودي';

-- AlterTable
ALTER TABLE "OvertimeRequest" ADD COLUMN     "paidInPayrollId" TEXT,
ADD COLUMN     "paidInSettlementId" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "loansDeduction" DOUBLE PRECISION,
ADD COLUMN     "overtimeAmount" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "uploadedById" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_storedName_key" ON "UploadedFile"("storedName");

-- CreateIndex
CREATE INDEX "UploadedFile_uploadedById_idx" ON "UploadedFile"("uploadedById");

-- CreateIndex
CREATE INDEX "UploadedFile_employeeId_idx" ON "UploadedFile"("employeeId");

-- CreateIndex
CREATE INDEX "OvertimeRequest_paidInPayrollId_idx" ON "OvertimeRequest"("paidInPayrollId");

-- CreateIndex
CREATE INDEX "JobApplication_jobRequestId_candidatePhone_idx" ON "JobApplication"("jobRequestId", "candidatePhone");

-- CreateIndex
CREATE INDEX "EmployeeEvaluation_employeeId_status_idx" ON "EmployeeEvaluation"("employeeId", "status");

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data: canonical stored nationality for Saudi employees is now 'سعودي' (was a mix of 'SAUDI' and Arabic labels).
UPDATE "Employee" SET "nationality" = 'سعودي'
WHERE lower("nationality") IN ('saudi', 'ksa', 'sa', 'saudi arabia') OR "nationality" IN ('السعودية', 'سعودية');

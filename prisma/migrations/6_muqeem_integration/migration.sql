-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "moiNumber" TEXT,
ADD COLUMN     "muqeemPlatformId" TEXT;

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "externalVisaNumber" TEXT,
ADD COLUMN     "issuedViaMuqeemAt" TIMESTAMP(3),
ADD COLUMN     "returnBefore" TIMESTAMP(3),
ADD COLUMN     "visaDurationDays" INTEGER,
ADD COLUMN     "visaPdfUrl" TEXT;

-- CreateTable
CREATE TABLE "MuqeemTransaction" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "companyId" TEXT,
    "employeeId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "externalRef" TEXT,
    "httpStatus" INTEGER,
    "errorMessage" TEXT,
    "requestSummary" TEXT,
    "responseSummary" TEXT,
    "documentUrl" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MuqeemTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MuqeemTransaction_idempotencyKey_key" ON "MuqeemTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MuqeemTransaction_companyId_createdAt_idx" ON "MuqeemTransaction"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "MuqeemTransaction_employeeId_idx" ON "MuqeemTransaction"("employeeId");

-- CreateIndex
CREATE INDEX "MuqeemTransaction_entityType_entityId_idx" ON "MuqeemTransaction"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "MuqeemTransaction_status_idx" ON "MuqeemTransaction"("status");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_muqeemPlatformId_fkey" FOREIGN KEY ("muqeemPlatformId") REFERENCES "GovPlatform"("id") ON DELETE SET NULL ON UPDATE CASCADE;


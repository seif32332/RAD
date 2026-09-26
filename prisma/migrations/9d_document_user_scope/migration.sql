-- Official documents: limit back-office users to legal companies (docs/document-engine SPEC §10).
-- Expand-only (DEC-004): one new table. No rows = unrestricted, so existing users keep working.

-- CreateTable
CREATE TABLE "UserCompanyScope" (
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCompanyScope_pkey" PRIMARY KEY ("userId","companyId")
);

-- CreateIndex
CREATE INDEX "UserCompanyScope_companyId_idx" ON "UserCompanyScope"("companyId");

-- AddForeignKey
ALTER TABLE "UserCompanyScope" ADD CONSTRAINT "UserCompanyScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCompanyScope" ADD CONSTRAINT "UserCompanyScope_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


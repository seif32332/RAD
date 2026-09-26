-- CreateTable
CREATE TABLE "HeadcountPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT,
    "fromMonth" TIMESTAMP(3) NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 12,
    "attritionPct" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "basedOnId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeadcountPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedPosition" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "companyId" TEXT,
    "branchId" TEXT,
    "departmentId" TEXT,
    "nationalityClass" TEXT,
    "gosiRegime" TEXT,
    "gender" TEXT,
    "occupationName" TEXT,
    "basicSalary" DOUBLE PRECISION,
    "housingAllowance" DOUBLE PRECISION,
    "otherAllowances" DOUBLE PRECISION,
    "dependentsCount" INTEGER,
    "medicalClass" TEXT,
    "startMonth" TIMESTAMP(3),
    "exitEmployeeId" TEXT,
    "exitMonth" TIMESTAMP(3),
    "exitReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlannedPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanRaise" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT,
    "pct" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "effectiveMonth" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanRaise_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HeadcountPlan_status_createdAt_idx" ON "HeadcountPlan"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HeadcountPlan_companyId_idx" ON "HeadcountPlan"("companyId");

-- CreateIndex
CREATE INDEX "PlannedPosition_planId_idx" ON "PlannedPosition"("planId");

-- CreateIndex
CREATE INDEX "PlanRaise_planId_idx" ON "PlanRaise"("planId");

-- AddForeignKey
ALTER TABLE "PlannedPosition" ADD CONSTRAINT "PlannedPosition_planId_fkey" FOREIGN KEY ("planId") REFERENCES "HeadcountPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanRaise" ADD CONSTRAINT "PlanRaise_planId_fkey" FOREIGN KEY ("planId") REFERENCES "HeadcountPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


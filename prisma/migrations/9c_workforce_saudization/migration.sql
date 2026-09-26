-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "nitaqatActivityKey" TEXT;

-- CreateTable
CREATE TABLE "NitaqatActivity" (
    "key" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "code" TEXT,
    "sizeSegment" TEXT,
    "status" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "page" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NitaqatActivity_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "NitaqatCurve" (
    "id" TEXT NOT NULL,
    "activityKey" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "m" DOUBLE PRECISION NOT NULL,
    "c" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "page" INTEGER,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NitaqatCurve_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalizationDecision" (
    "id" TEXT NOT NULL,
    "groupNameAr" TEXT NOT NULL,
    "occupationsJson" TEXT NOT NULL,
    "phasesJson" TEXT NOT NULL,
    "minEstablishmentSize" INTEGER,
    "minWage" DOUBLE PRECISION,
    "scope" TEXT,
    "decisionNo" TEXT,
    "decisionDate" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "page" INTEGER,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalizationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NitaqatCurve_activityKey_band_year_key" ON "NitaqatCurve"("activityKey", "band", "year");

-- CreateIndex
CREATE INDEX "LocalizationDecision_groupNameAr_idx" ON "LocalizationDecision"("groupNameAr");

-- AddForeignKey
ALTER TABLE "NitaqatCurve" ADD CONSTRAINT "NitaqatCurve_activityKey_fkey" FOREIGN KEY ("activityKey") REFERENCES "NitaqatActivity"("key") ON DELETE CASCADE ON UPDATE CASCADE;


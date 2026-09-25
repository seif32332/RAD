-- 7_self_attendance: employee self clock-in / clock-out from the portal (GPS geofence + face
-- verification). Additive only: new tables, nullable / defaulted columns. No data backfill:
-- existing Attendance rows keep checkInSource / checkOutSource = NULL (entered before this feature).

-- CreateEnum
CREATE TYPE "PunchType" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PunchResult" AS ENUM ('ACCEPTED', 'FLAGGED', 'REJECTED');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "attendanceExemptReason" TEXT,
ADD COLUMN     "attendanceFaceExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "attendanceGeoExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "checkInSource" TEXT,
ADD COLUMN     "checkOutSource" TEXT,
ADD COLUMN     "flagged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AttendanceCorrection" ADD COLUMN     "punchId" TEXT;

-- CreateTable
CREATE TABLE "AttendanceLocation" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL DEFAULT 150,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceProfile" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "photoStoredName" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePunch" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceId" TEXT,
    "workDate" DATE NOT NULL,
    "type" "PunchType" NOT NULL,
    "result" "PunchResult" NOT NULL,
    "reasons" TEXT[],
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "distanceM" DOUBLE PRECISION,
    "locationId" TEXT,
    "locationName" TEXT,
    "radiusM" INTEGER,
    "faceScore" DOUBLE PRECISION,
    "livenessScore" DOUBLE PRECISION,
    "selfieStoredName" TEXT,
    "selfiePurgedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePunch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceLocation_branchId_idx" ON "AttendanceLocation"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "FaceProfile_employeeId_key" ON "FaceProfile"("employeeId");

-- CreateIndex
CREATE INDEX "AttendancePunch_employeeId_createdAt_idx" ON "AttendancePunch"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendancePunch_result_createdAt_idx" ON "AttendancePunch"("result", "createdAt");

-- CreateIndex
CREATE INDEX "AttendancePunch_workDate_idx" ON "AttendancePunch"("workDate");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_punchId_idx" ON "AttendanceCorrection"("punchId");

-- AddForeignKey
ALTER TABLE "AttendanceLocation" ADD CONSTRAINT "AttendanceLocation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceProfile" ADD CONSTRAINT "FaceProfile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_punchId_fkey" FOREIGN KEY ("punchId") REFERENCES "AttendancePunch"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "iqamaFeeYear" DOUBLE PRECISION,
ADD COLUMN     "medicalPremiumsJson" TEXT,
ADD COLUMN     "overtimeHourlyBasis" TEXT NOT NULL DEFAULT 'BASIC';


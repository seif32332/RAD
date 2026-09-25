-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN', 'GOV_RELATIONS', 'LEGAL_ADMIN', 'BRANCH_MANAGER', 'EMPLOYEE', 'DEPT_MANAGER', 'PURCHASING_AGENT');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('FULL_TIME', 'PART_TIME', 'FREELANCE');

-- CreateEnum
CREATE TYPE "AccommodationType" AS ENUM ('OUTSIDE_COMPANY', 'INSIDE_COMPANY');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'WPS');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('ANNUAL', 'DEDUCTED', 'SICK', 'EMERGENCY', 'UNPAID');

-- CreateEnum
CREATE TYPE "VisaStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'ISSUED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING_SUBMISSION', 'SUBMITTED', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "SettlementType" AS ENUM ('LEAVE_SETTLEMENT', 'END_OF_SERVICE');

-- CreateEnum
CREATE TYPE "TerminationReason" AS ENUM ('COMPANY_TERMINATION', 'RESIGNATION', 'PROBATION', 'ARTICLE_80');

-- CreateEnum
CREATE TYPE "RenewalAction" AS ENUM ('RENEWED', 'TERMINATED', 'PENDING_PAYMENT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING_OWNER', 'PENDING_FINANCE', 'PAID', 'COMPLETED', 'RETURNED');

-- CreateTable
CREATE TABLE "Nationality" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nationality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "allowedPages" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT,
    "avatarUrl" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "nameArabic" TEXT NOT NULL,
    "nameEnglish" TEXT,
    "unifiedNumber" TEXT,
    "commercialRegNum" TEXT NOT NULL,
    "commercialRegUrl" TEXT,
    "commercialRegDate" TIMESTAMP(3),
    "commercialRegExp" TIMESTAMP(3) NOT NULL,
    "commercialRegCost" DOUBLE PRECISION DEFAULT 0,
    "taxNumber" TEXT,
    "nationalAddress" TEXT,
    "nationalAddressUrl" TEXT,
    "establishmentDeedUrl" TEXT,
    "trademarkNumber" TEXT,
    "trademarkRegDate" TIMESTAMP(3),
    "trademarkExpDate" TIMESTAMP(3),
    "trademarkCertUrl" TEXT,
    "trademarkCost" DOUBLE PRECISION DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Administration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nameArabic" TEXT NOT NULL,
    "nameEnglish" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Administration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "administrationId" TEXT,
    "nameArabic" TEXT NOT NULL,
    "nameEnglish" TEXT,
    "city" TEXT,
    "district" TEXT,
    "street" TEXT,
    "branchCode" TEXT,
    "munLicenseNum" TEXT,
    "munLicenseStart" TIMESTAMP(3),
    "munLicenseExp" TIMESTAMP(3),
    "munLicenseCost" DOUBLE PRECISION DEFAULT 0,
    "civilDefenseNum" TEXT,
    "civilDefenseStart" TIMESTAMP(3),
    "civilDefenseExp" TIMESTAMP(3),
    "civilDefenseCost" DOUBLE PRECISION DEFAULT 0,
    "rentContractNum" TEXT,
    "rentContractStart" TIMESTAMP(3),
    "rentContractExp" TIMESTAMP(3),
    "rentOwnerName" TEXT,
    "rentOwnerPhone" TEXT,
    "rentContractAmount" DOUBLE PRECISION,
    "rentPaymentType" TEXT,
    "rentPaymentCount" INTEGER,
    "rentContractUrl" TEXT,
    "rentContractType" TEXT,
    "wasteContractNum" TEXT,
    "wasteContractStart" TIMESTAMP(3),
    "wasteContractExp" TIMESTAMP(3),
    "wasteCompanyName" TEXT,
    "wasteCompanyPhone" TEXT,
    "wasteContractUrl" TEXT,
    "safetyContractNum" TEXT,
    "safetyContractStart" TIMESTAMP(3),
    "safetyContractExp" TIMESTAMP(3),
    "safetyCompanyName" TEXT,
    "safetyCompanyPhone" TEXT,
    "safetyContractUrl" TEXT,
    "cameraContractNum" TEXT,
    "cameraContractStart" TIMESTAMP(3),
    "cameraContractExp" TIMESTAMP(3),
    "cameraCompanyName" TEXT,
    "cameraCompanyPhone" TEXT,
    "cameraContractUrl" TEXT,
    "buildingLicenseUrl" TEXT,
    "blueprintsUrl" TEXT,
    "engineeringHandoverUrl" TEXT,
    "installationCompleteUrl" TEXT,
    "externalPhotosUrls" TEXT,
    "locationUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSchedule" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shiftType" TEXT DEFAULT 'ONE_SHIFT',
    "startTime" TEXT,
    "endTime" TEXT,
    "startTime2" TEXT,
    "endTime2" TEXT,
    "flexibleHours" INTEGER,
    "isExemptFromAttendance" BOOLEAN DEFAULT false,
    "workDays" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "nameArabic" TEXT NOT NULL,
    "nameEnglish" TEXT,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "employeeId" TEXT NOT NULL,
    "biometricId" TEXT,
    "firstNameArabic" TEXT NOT NULL,
    "lastNameArabic" TEXT NOT NULL,
    "firstNameEnglish" TEXT,
    "lastNameEnglish" TEXT,
    "nationality" TEXT NOT NULL DEFAULT 'SAUDI',
    "iqamaOrIdNumber" TEXT NOT NULL,
    "iqamaOrIdExp" TIMESTAMP(3) NOT NULL,
    "iqamaRenewalCost" DOUBLE PRECISION DEFAULT 0,
    "passportNumber" TEXT,
    "passportExp" TIMESTAMP(3),
    "healthCertificateNum" TEXT,
    "healthCertificateExp" TIMESTAMP(3),
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "gender" TEXT NOT NULL,
    "maritalStatus" TEXT,
    "mobileNumber" TEXT,
    "email" TEXT,
    "ibanNumber" TEXT,
    "bankName" TEXT,
    "salaryPaymentMethod" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "legalCompanyId" TEXT,
    "actualCompanyId" TEXT,
    "administrationId" TEXT,
    "branchId" TEXT,
    "departmentId" TEXT,
    "jobTitle" TEXT,
    "directManagerId" TEXT,
    "workSchedule" TEXT,
    "accommodationType" "AccommodationType",
    "joinDate" TIMESTAMP(3) NOT NULL,
    "contractType" "ContractType" NOT NULL DEFAULT 'FULL_TIME',
    "contractEndDate" TIMESTAMP(3),
    "probationEndDate" TIMESTAMP(3),
    "noticePeriodDays" INTEGER DEFAULT 30,
    "leaveAccrualStartDate" TIMESTAMP(3),
    "basicSalary" DOUBLE PRECISION NOT NULL,
    "gosiDeduction" DOUBLE PRECISION DEFAULT 0,
    "isTerminated" BOOLEAN NOT NULL DEFAULT false,
    "terminationDate" TIMESTAMP(3),
    "employmentStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "workContractUrl" TEXT,
    "iqamaCopyUrl" TEXT,
    "healthCertificateUrl" TEXT,
    "passportCopyUrl" TEXT,
    "ibanCertificateUrl" TEXT,
    "resumeUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requesterId" TEXT,
    "fromBranchId" TEXT,
    "toBranchId" TEXT NOT NULL,
    "toWorkSchedule" TEXT,
    "reason" TEXT,
    "assetAction" TEXT DEFAULT 'RETAIN',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "hrNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "expirationDate" TIMESTAMP(3) NOT NULL,
    "isAlertSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "checkIn" TIMESTAMP(3),
    "checkOut" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMin" INTEGER NOT NULL DEFAULT 0,
    "overtimeMin" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leave" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" "LeaveType" NOT NULL DEFAULT 'ANNUAL',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "totalDays" INTEGER NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "isManagerApproved" BOOLEAN NOT NULL DEFAULT false,
    "managerApprovedAt" TIMESTAMP(3),
    "isHrApproved" BOOLEAN NOT NULL DEFAULT false,
    "hrApprovedAt" TIMESTAMP(3),
    "availableBalance" DOUBLE PRECISION,
    "paidDays" INTEGER,
    "unpaidDays" INTEGER,
    "dailyDeductionRate" DOUBLE PRECISION DEFAULT 30,
    "totalDeduction" DOUBLE PRECISION,
    "isOutsideKSA" BOOLEAN NOT NULL DEFAULT false,
    "exitReentryVisaCost" DOUBLE PRECISION DEFAULT 0,
    "flightTicketOption" TEXT,
    "flightTicketAmount" DOUBLE PRECISION,
    "workingDaysBeforeLeave" INTEGER,
    "isReturned" BOOLEAN NOT NULL DEFAULT false,
    "actualReturnDate" TIMESTAMP(3),
    "extensionFileUrl" TEXT,
    "extensionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visa" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "visaType" TEXT NOT NULL,
    "status" "VisaStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "deductedFrom" TEXT,
    "attachmentUrl" TEXT,
    "ticketStatus" TEXT,
    "airline" TEXT,
    "bookingRef" TEXT,
    "flightFrom" TEXT,
    "flightTo" TEXT,
    "departureDate" TIMESTAMP(3),
    "returnDate" TIMESTAMP(3),
    "ticketAttachmentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allowance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "isMonthly" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Allowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payroll" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "basicSalary" DOUBLE PRECISION NOT NULL,
    "totalAllowances" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtimeCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netSalary" DOUBLE PRECISION NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "paidAt" TIMESTAMP(3),
    "isFinalSettlement" BOOLEAN NOT NULL DEFAULT false,
    "settlementReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payroll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromissoryNote" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "creditorName" TEXT NOT NULL,
    "debtorName" TEXT NOT NULL,
    "companyRole" TEXT NOT NULL DEFAULT 'CREDITOR',
    "isOnDemand" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "idAttachment" TEXT,
    "noteAttachment" TEXT,
    "otherAttachment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "paymentAttachment" TEXT,
    "paymentDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromissoryNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalContract" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "firstParty" TEXT NOT NULL,
    "secondParty" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "contractAttachment" TEXT,
    "otherAttachment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lawsuit" (
    "id" TEXT NOT NULL,
    "caseType" TEXT NOT NULL,
    "plaintiff" TEXT NOT NULL,
    "defendant" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REFERRED',
    "lawFirmName" TEXT,
    "lawFirmContact" TEXT,
    "judgmentAttachment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lawsuit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OvertimeRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "supervisorId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'HOURS',
    "hours" DOUBLE PRECISION DEFAULT 0,
    "amount" DOUBLE PRECISION DEFAULT 0,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OvertimeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "supervisorId" TEXT,
    "destination" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_EMPLOYEE',
    "employeeApprovedAt" TIMESTAMP(3),
    "hrApprovedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deduction" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DEDUCTED',
    "category" TEXT DEFAULT 'ATTENDANCE',
    "violationType" TEXT,
    "occurrenceNumber" INTEGER DEFAULT 1,
    "severity" TEXT DEFAULT 'LOW',
    "lawArticle" TEXT,
    "isReferredToInvestigation" BOOLEAN NOT NULL DEFAULT false,
    "investigationId" TEXT,
    "hasObjection" BOOLEAN NOT NULL DEFAULT false,
    "objectionText" TEXT,
    "objectionDate" TIMESTAMP(3),
    "objectionStatus" TEXT,
    "hasFinancialImpact" BOOLEAN NOT NULL DEFAULT true,
    "deductionDays" INTEGER DEFAULT 0,
    "dailySalary" DOUBLE PRECISION,
    "isLinkedToPayroll" BOOLEAN NOT NULL DEFAULT false,
    "payrollMonth" TEXT,
    "issuedBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investigation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'HIGH',
    "status" TEXT NOT NULL DEFAULT 'OPENED',
    "findings" TEXT,
    "recommendation" TEXT,
    "finalDecision" TEXT,
    "penaltyAmount" DOUBLE PRECISION,
    "penaltyDays" INTEGER,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "suspensionStartDate" TIMESTAMP(3),
    "suspensionEndDate" TIMESTAMP(3),
    "investigatorName" TEXT,
    "investigatorRole" TEXT,
    "attachmentUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "monthlyInstallment" DOUBLE PRECISION NOT NULL,
    "remainingAmount" DOUBLE PRECISION NOT NULL,
    "isForgiven" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isManagerApproved" BOOLEAN NOT NULL DEFAULT false,
    "managerApprovedAt" TIMESTAMP(3),
    "isHrApproved" BOOLEAN NOT NULL DEFAULT false,
    "hrApprovedAt" TIMESTAMP(3),
    "isFinanceApproved" BOOLEAN NOT NULL DEFAULT false,
    "financeApprovedAt" TIMESTAMP(3),
    "receiptUrl" TEXT,
    "isFinanceTransferred" BOOLEAN NOT NULL DEFAULT false,
    "financeTransferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceViolation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "branchId" TEXT,
    "authority" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "correctivePeriod" INTEGER,
    "canObject" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "correctionType" TEXT DEFAULT 'GENERAL',
    "attachmentUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isManagerApproved" BOOLEAN NOT NULL DEFAULT false,
    "managerApprovedAt" TIMESTAMP(3),
    "managerComment" TEXT,
    "isHrApproved" BOOLEAN NOT NULL DEFAULT false,
    "hrApprovedAt" TIMESTAMP(3),
    "hrComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequest" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT,
    "requesterId" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "nationality" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "jobRequestId" TEXT NOT NULL,
    "candidateName" TEXT NOT NULL,
    "candidatePhone" TEXT NOT NULL,
    "candidateEmail" TEXT,
    "resumeUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "interviewDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "fullNameArabic" TEXT NOT NULL,
    "lastNameArabic" TEXT,
    "firstNameEnglish" TEXT,
    "lastNameEnglish" TEXT,
    "nationality" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "maritalStatus" TEXT,
    "iqamaOrIdNumber" TEXT NOT NULL,
    "iqamaOrIdExp" TIMESTAMP(3),
    "passportNumber" TEXT,
    "passportExp" TIMESTAMP(3),
    "mobileNumber" TEXT NOT NULL,
    "email" TEXT,
    "branchId" TEXT,
    "administrationId" TEXT,
    "departmentId" TEXT,
    "directManagerId" TEXT,
    "jobTitle" TEXT,
    "joinDate" TIMESTAMP(3),
    "contractType" TEXT,
    "bankName" TEXT,
    "ibanNumber" TEXT,
    "basicSalary" DOUBLE PRECISION,
    "iqamaCopyUrl" TEXT,
    "passportCopyUrl" TEXT,
    "ibanCertificateUrl" TEXT,
    "resumeUrl" TEXT,
    "workContractUrl" TEXT,
    "healthCertificateUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "hrNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "assetType" TEXT NOT NULL,
    "description" TEXT,
    "receiveDate" TIMESTAMP(3),
    "returnDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalInsurance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "insuranceIssuer" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "policyCost" DOUBLE PRECISION NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "medicalNetwork" TEXT,
    "coverageType" TEXT,
    "insuranceClass" TEXT,
    "benefitsUrl" TEXT,
    "coverageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicalInsurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelecomSim" (
    "id" TEXT NOT NULL,
    "simNumber" TEXT NOT NULL,
    "accountNumber" TEXT,
    "provider" TEXT,
    "plan" TEXT,
    "serviceType" TEXT,
    "companyId" TEXT,
    "branchId" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelecomSim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilityMeter" (
    "id" TEXT NOT NULL,
    "meterCode" TEXT,
    "meterNumber" TEXT,
    "accountNumber" TEXT,
    "meterPhotoUrl" TEXT,
    "branchId" TEXT,
    "legalCompanyId" TEXT,
    "actualCompanyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UtilityMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "vehicleCode" TEXT,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "modelYear" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sequenceNumber" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "legalCompanyId" TEXT,
    "actualCompanyId" TEXT,
    "licenseExpDate" TIMESTAMP(3),
    "insuranceExpDate" TIMESTAMP(3),
    "insuranceCost" DOUBLE PRECISION DEFAULT 0,
    "inspectionExpDate" TIMESTAMP(3),
    "operatingCardExpDate" TIMESTAMP(3),
    "operatingCardUrl" TEXT,
    "driverId" TEXT,
    "driverCardNumber" TEXT,
    "driverCardExpDate" TIMESTAMP(3),
    "drivingAuthorizationUrl" TEXT,
    "drivingAuthExpDate" TIMESTAMP(3),
    "vehiclePhotosUrl" TEXT,
    "registrationFormUrl" TEXT,
    "otherAttachmentsUrl" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccidentClaim" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "faultPercentageAgainst" DOUBLE PRECISION,
    "faultPercentageFor" DOUBLE PRECISION,
    "claimAmount" DOUBLE PRECISION,
    "insuranceCompany" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING_SUBMISSION',
    "najmReportUrl" TEXT,
    "estimatesUrl" TEXT,
    "accidentPhotosUrl" TEXT,
    "ibanUrl" TEXT,
    "otherAttachmentsUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccidentClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "SettlementType" NOT NULL,
    "terminationReason" "TerminationReason",
    "salaryBasis" TEXT,
    "lastWorkingDate" TIMESTAMP(3),
    "workingDaysInMonth" INTEGER,
    "workingDaysSalary" DOUBLE PRECISION,
    "yearsOfService" DOUBLE PRECISION,
    "endOfServiceAmount" DOUBLE PRECISION,
    "unusedLeaveDays" DOUBLE PRECISION,
    "leaveCompensation" DOUBLE PRECISION,
    "additionalEntitlements" DOUBLE PRECISION DEFAULT 0,
    "additionalDeductions" DOUBLE PRECISION DEFAULT 0,
    "additionalNotes" TEXT,
    "totalSettlement" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "transferReceiptUrl" TEXT,
    "ownerNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenewalArchive" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "action" "RenewalAction" NOT NULL,
    "oldExpDate" TIMESTAMP(3),
    "newExpDate" TIMESTAMP(3),
    "attachmentUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenewalArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminationRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "terminationType" TEXT NOT NULL,
    "reasonDetails" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "isManagerApproved" BOOLEAN NOT NULL DEFAULT false,
    "managerApprovedAt" TIMESTAMP(3),
    "isHrApproved" BOOLEAN NOT NULL DEFAULT false,
    "hrApprovedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertifiedAgency" (
    "id" TEXT NOT NULL,
    "agencyNumber" TEXT NOT NULL,
    "principalName" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "attachmentUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertifiedAgency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "accountNumber" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING_OWNER',
    "receiptUrl" TEXT,
    "returnReason" TEXT,
    "entityId" TEXT,
    "entityType" TEXT,
    "documentType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Circular" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "attachmentUrl" TEXT,
    "datePublished" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Circular_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerRequest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "assignedTo" TEXT,
    "attachmentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetType" TEXT NOT NULL DEFAULT 'GENERAL',
    "evalType" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationTemplateSection" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationTemplateSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationTemplateItem" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationCycle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "cycleType" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeEvaluation" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "managerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalScore" DOUBLE PRECISION,
    "finalRating" TEXT,
    "recommendation" TEXT,
    "recommendationReason" TEXT,
    "strengths" TEXT,
    "improvements" TEXT,
    "finalNotes" TEXT,
    "employeeAcknowledgedAt" TIMESTAMP(3),
    "employeeComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationItemScore" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "EvaluationItemScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationApproval" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "approverId" TEXT,
    "approverName" TEXT,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "actionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovPlatform" (
    "id" TEXT NOT NULL,
    "platformName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "authorizedPerson" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovPlatform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requestedForId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_HR',
    "hrNotes" TEXT,
    "hrApprovedAt" TIMESTAMP(3),
    "ownerNotes" TEXT,
    "ownerApprovedAt" TIMESTAMP(3),
    "purchasingNotes" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Nationality_label_key" ON "Nationality"("label");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_role_key" ON "RolePermission"("role");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Company_commercialRegNum_key" ON "Company"("commercialRegNum");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_biometricId_key" ON "Employee"("biometricId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_iqamaOrIdNumber_key" ON "Employee"("iqamaOrIdNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_employeeId_date_key" ON "Attendance"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Payroll_employeeId_month_year_key" ON "Payroll"("employeeId", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Administration" ADD CONSTRAINT "Administration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_administrationId_fkey" FOREIGN KEY ("administrationId") REFERENCES "Administration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_directManagerId_fkey" FOREIGN KEY ("directManagerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_legalCompanyId_fkey" FOREIGN KEY ("legalCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_actualCompanyId_fkey" FOREIGN KEY ("actualCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_administrationId_fkey" FOREIGN KEY ("administrationId") REFERENCES "Administration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDocument" ADD CONSTRAINT "CompanyDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visa" ADD CONSTRAINT "Visa_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allowance" ADD CONSTRAINT "Allowance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkAssignment" ADD CONSTRAINT "WorkAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceViolation" ADD CONSTRAINT "ComplianceViolation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceViolation" ADD CONSTRAINT "ComplianceViolation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequest" ADD CONSTRAINT "JobRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequest" ADD CONSTRAINT "JobRequest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_jobRequestId_fkey" FOREIGN KEY ("jobRequestId") REFERENCES "JobRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicalInsurance" ADD CONSTRAINT "MedicalInsurance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelecomSim" ADD CONSTRAINT "TelecomSim_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelecomSim" ADD CONSTRAINT "TelecomSim_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelecomSim" ADD CONSTRAINT "TelecomSim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityMeter" ADD CONSTRAINT "UtilityMeter_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityMeter" ADD CONSTRAINT "UtilityMeter_legalCompanyId_fkey" FOREIGN KEY ("legalCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityMeter" ADD CONSTRAINT "UtilityMeter_actualCompanyId_fkey" FOREIGN KEY ("actualCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_legalCompanyId_fkey" FOREIGN KEY ("legalCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_actualCompanyId_fkey" FOREIGN KEY ("actualCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentClaim" ADD CONSTRAINT "AccidentClaim_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminationRequest" ADD CONSTRAINT "TerminationRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationTemplateSection" ADD CONSTRAINT "EvaluationTemplateSection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EvaluationTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationTemplateItem" ADD CONSTRAINT "EvaluationTemplateItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "EvaluationTemplateSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationCycle" ADD CONSTRAINT "EvaluationCycle_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EvaluationTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeEvaluation" ADD CONSTRAINT "EmployeeEvaluation_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "EvaluationCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeEvaluation" ADD CONSTRAINT "EmployeeEvaluation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationItemScore" ADD CONSTRAINT "EvaluationItemScore_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "EmployeeEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationItemScore" ADD CONSTRAINT "EvaluationItemScore_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "EvaluationTemplateItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationApproval" ADD CONSTRAINT "EvaluationApproval_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "EmployeeEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetRequest" ADD CONSTRAINT "AssetRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetRequest" ADD CONSTRAINT "AssetRequest_requestedForId_fkey" FOREIGN KEY ("requestedForId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;


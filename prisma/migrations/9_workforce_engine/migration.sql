-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "isIndustrialLicensed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nitaqatActivity" TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "dependentsCount" INTEGER,
ADD COLUMN     "dependentsFeePaidBy" TEXT,
ADD COLUMN     "exitReason" TEXT,
ADD COLUMN     "exitVoluntary" BOOLEAN,
ADD COLUMN     "isDisabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isStudent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "medicalInsuranceClass" TEXT,
ADD COLUMN     "muawamaCertExpiry" TIMESTAMP(3),
ADD COLUMN     "occupationCode" TEXT,
ADD COLUMN     "occupationName" TEXT,
ADD COLUMN     "partTimeWeeklyHours" DOUBLE PRECISION,
ADD COLUMN     "qiwaContractDocumented" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qiwaContractDocumentedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Allowance" ADD COLUMN     "allowanceType" TEXT;

-- CreateTable
CREATE TABLE "RuleParameter" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "valueJson" TEXT,
    "unit" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceQuote" TEXT,
    "notes" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceAssumption" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "companyId" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION,
    "valueJson" TEXT,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceAssumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceCalculation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "title" TEXT,
    "engineVersion" TEXT NOT NULL,
    "ruleVersions" TEXT NOT NULL,
    "inputs" TEXT NOT NULL,
    "outputs" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryChange" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "basicSalary" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "isPlanned" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleParameter_domain_idx" ON "RuleParameter"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "RuleParameter_key_effectiveFrom_key" ON "RuleParameter"("key", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceAssumption_key_companyId_key" ON "WorkforceAssumption"("key", "companyId");

-- CreateIndex
CREATE INDEX "WorkforceCalculation_kind_createdAt_idx" ON "WorkforceCalculation"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "WorkforceCalculation_subjectType_subjectId_idx" ON "WorkforceCalculation"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "SalaryChange_employeeId_effectiveDate_idx" ON "SalaryChange"("employeeId", "effectiveDate");

-- AddForeignKey
ALTER TABLE "SalaryChange" ADD CONSTRAINT "SalaryChange_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- GOSI new-regime steps confirmed from primary sources (Royal Decree M/273 clause 3, Social Insurance Law
-- art. 15, GOSI contributions guide): annuities 9% -> 11% per side, +0.5 every 1 July 2025..2028.
UPDATE "GosiRate" SET "isProvisional" = FALSE,
  "source" = 'GOSI awareness.gosi.gov.sa/pdf/Contributions.pdf + Royal Decree M/273 (clause 3) + SI Law art. 15; verified 2026-09-26'
WHERE "regime" = 'NEW' AND "isSaudi" = TRUE;

-- Dated regulatory parameters with their source and verification status (verified 2026-09-26).
INSERT INTO "RuleParameter" ("id","key","domain","label","value","unit","effectiveFrom","status","sourceUrl","sourceQuote","notes","verifiedAt","verifiedBy") VALUES
 ('rp-gosi-max-wage','GOSI_MAX_CONTRIBUTORY_WAGE','GOSI','الحد الأعلى للأجر الخاضع للاشتراك',45000,'SAR_MONTH','2000-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/eaee8a20-3a54-4aaf-b0d9-b1ad00998962/1','يكون الحد الأعلى للأجر أو الراتب الخاضع للاشتراك (45,000)','نظام التأمينات الاجتماعية، المادة 8','2026-09-26','research'),
 ('rp-gosi-min-wage-old','GOSI_MIN_CONTRIBUTORY_WAGE_OLD','GOSI','الحد الأدنى للأجر الخاضع (النظام القديم)',1500,'SAR_MONTH','2000-01-01','VERIFIED_PRIMARY','https://www.gosi.gov.sa/GOSIOnline/FAQ_Employer?locale=en_US','minimum wage under the Annuities Branch is S.R. 1,500',NULL,'2026-09-26','research'),
 ('rp-gosi-min-wage-new','GOSI_MIN_CONTRIBUTORY_WAGE_NEW','GOSI','الحد الأدنى للأجر الخاضع (النظام الجديد)',1500,'SAR_MONTH','2024-07-03','PROVISIONAL','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/eaee8a20-3a54-4aaf-b0d9-b1ad00998962/1','الحد الأدنى للأجور أو الرواتب الذي تحدده الجهة المختصة','المادة 8 تحيل للجهة المختصة؛ 1,500 من مصادر ثانوية فقط','2026-09-26','research'),
 ('rp-gosi-inkind-housing','GOSI_IN_KIND_HOUSING_MONTHS','GOSI','تقدير السكن العيني بأجر (أشهر أساسية سنوياً)',2,'MONTHS','2000-01-01','VERIFIED_PRIMARY','https://www.gosi.gov.sa/GOSIOnline/FAQ_Employer?locale=en_US','بدل السكن العيني وتقدر قيمته بما يساوي الأجر أو الراتب الأساسي عن شهرين',NULL,'2026-09-26','research'),
 ('rp-ot-premium','OVERTIME_PREMIUM_PCT_OF_BASIC','LABOR_LAW','علاوة العمل الإضافي (% من الأجر الأساسي)',50,'PERCENT','2025-02-19','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','أجر الساعة مضافاً إليه (50%) من أجره الأساسي','المادة 107. تفسير «أجر الساعة» (أساسي أم إجمالي) بانتظار المستشار: افتراض OVERTIME_HOURLY_BASIS','2026-09-26','research'),
 ('rp-ot-cap','OVERTIME_ANNUAL_CAP_HOURS','LABOR_LAW','سقف العمل الإضافي السنوي',720,'HOURS_YEAR','2025-02-19','VERIFIED_PRIMARY','https://www.hrsd.gov.sa/en/knowledge-centre','may not exceed seven hundred and twenty hours','يجوز الزيادة بموافقة العامل؛ رقم مادة اللائحة غير مؤكد','2026-09-26','research'),
 ('rp-notice-employer','NOTICE_DAYS_EMPLOYER','LABOR_LAW','مدة الإشعار عند إنهاء صاحب العمل (عقد غير محدد، أجر شهري)',60,'DAYS','2025-02-19','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','من طرف صاحب العمل... (ستين) يوماً','المادة 75 بعد تعديل م/44','2026-09-26','research'),
 ('rp-notice-employee','NOTICE_DAYS_EMPLOYEE','LABOR_LAW','مدة الإشعار عند استقالة العامل (عقد غير محدد)',30,'DAYS','2025-02-19','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','من طرف العامل... (ثلاثين) يوماً','المادة 75','2026-09-26','research'),
 ('rp-art77-days','ART77_DAYS_PER_YEAR','LABOR_LAW','تعويض الإنهاء غير المشروع (أيام عن كل سنة)',15,'DAYS','2015-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','أجر خمسة عشر يوماً عن كل سنة','المادة 77 (عقد غير محدد المدة)','2026-09-26','research'),
 ('rp-art77-min','ART77_MIN_MONTHS','LABOR_LAW','الحد الأدنى لتعويض الإنهاء غير المشروع (أشهر)',2,'MONTHS','2015-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','يجب ألا يقل التعويض عن أجر العامل لمدة شهرين','المادة 77','2026-09-26','research'),
 ('rp-annual-leave','ANNUAL_LEAVE_DAYS','LABOR_LAW','الإجازة السنوية',21,'DAYS_YEAR','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','لا تقل مدتها عن واحد وعشرين يومًا','المادة 109','2026-09-26','research'),
 ('rp-annual-leave-5y','ANNUAL_LEAVE_DAYS_AFTER_5Y','LABOR_LAW','الإجازة السنوية بعد 5 سنوات متصلة',30,'DAYS_YEAR','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','تزاد إلى ثلاثين يومًا إذا أمضى خمس سنوات متصلة','المادة 109','2026-09-26','research'),
 ('rp-probation','PROBATION_MAX_DAYS','LABOR_LAW','الحد الأقصى لفترة التجربة',180,'DAYS','2025-02-19','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','على ألا يزيد مجموع المدة في جميع الأحوال على (مائة وثمانين) يوماً','المادة 53','2026-09-26','research'),
 ('rp-maternity','MATERNITY_WEEKS','LABOR_LAW','إجازة الوضع بأجر كامل',12,'WEEKS','2025-02-19','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','إجازة وضع بأجر كامل لمدة (اثني عشر) أسبوعاً','المادة 151؛ في النظام الجديد تدفع التأمينات تعويض الأمومة بشروط','2026-09-26','research'),
 ('rp-levy-within','EXPAT_LEVY_WITHIN_SAUDI_COUNT','EXPAT_FEES','المقابل المالي للوافد ضمن عدد السعوديين',700,'SAR_MONTH','2020-01-01','VERIFIED_PRIMARY','https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis','700 SAR monthly for each non-Saudi employee not exceeding the number of Saudi employees','الأساس عدد السعوديين مقابل الوافدين وليس لون النطاق','2026-09-26','research'),
 ('rp-levy-above','EXPAT_LEVY_ABOVE_SAUDI_COUNT','EXPAT_FEES','المقابل المالي للوافد الزائد عن عدد السعوديين',800,'SAR_MONTH','2020-01-01','VERIFIED_PRIMARY','https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis','800 SAR monthly for each non-Saudi employee exceeding the number of Saudi employees',NULL,'2026-09-26','research'),
 ('rp-levy-industrial','INDUSTRIAL_LEVY_CANCELLED','EXPAT_FEES','إلغاء المقابل المالي للمنشآت الصناعية المرخّصة',1,'FLAG','2025-12-17','VERIFIED_PRIMARY','https://www.spa.gov.sa/en/N2468180','Cabinet approved the cancellation of the expat levy on licensed industrial establishments','قرار مجلس الوزراء 17 ديسمبر 2025','2026-09-26','research'),
 ('rp-small-est-max','SMALL_EST_MAX_WORKERS','EXPAT_FEES','حجم المنشأة الصغيرة المشمولة بالإعفاء',9,'WORKERS','2024-02-01','VERIFIED_PRIMARY','https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis','establishments with 9 employees or less','الإعفاء ممدد 3 سنوات من فبراير 2024 (تاريخ الانتهاء ثانوي)','2026-09-26','research'),
 ('rp-small-est-owner','SMALL_EST_EXEMPT_OWNER_ONLY','EXPAT_FEES','وافدون معفون (المالك متفرغ فقط)',2,'WORKERS','2024-02-01','VERIFIED_PRIMARY','https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis','exemption for 2 non-Saudi employees',NULL,'2026-09-26','research'),
 ('rp-small-est-saudi','SMALL_EST_EXEMPT_WITH_SAUDI','EXPAT_FEES','وافدون معفون (المالك + سعودي متفرغ)',4,'WORKERS','2024-02-01','VERIFIED_PRIMARY','https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis','The exemption is then granted during one financial year for 4 non-Saudi employees.',NULL,'2026-09-26','research'),
 ('rp-work-permit','WORK_PERMIT_FEE_YEAR','EXPAT_FEES','رسوم رخصة العمل',100,'SAR_YEAR','2020-01-01','VERIFIED_PRIMARY','https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis','100 SAR annually for each non-Saudi employee',NULL,'2026-09-26','research'),
 ('rp-iqama','IQAMA_FEE_YEAR','EXPAT_FEES','رسوم الإقامة (قطاع خاص)',650,'SAR_YEAR','2020-01-01','PROVISIONAL',NULL,NULL,'مؤكَّد من مصادر ثانوية فقط؛ my.gov.sa تذكر أن الكلفة متغيرة','2026-09-26','research'),
 ('rp-dependent','DEPENDENT_FEE_MONTH','EXPAT_FEES','رسوم المرافق',400,'SAR_MONTH','2020-07-01','VERIFIED_PRIMARY','https://www.mof.gov.sa/budget/Documents/FBP%20Final.pdf','100 في أول سنة، ثم 200، 300، 400 ريال','من يدفعها: سياسة لكل موظف (dependentsFeePaidBy)','2026-09-26','research'),
 ('rp-erv-single','EXIT_REENTRY_SINGLE_BASE','EXPAT_FEES','تأشيرة خروج وعودة مفردة (حتى شهرين)',200,'SAR','2019-10-16','CORROBORATED_SECONDARY',NULL,'200 ريال لشهرين أو أقل','+100 لكل شهر إضافي؛ التمديد من الخارج مضاعف','2026-09-26','research'),
 ('rp-erv-single-extra','EXIT_REENTRY_SINGLE_EXTRA_MONTH','EXPAT_FEES','تأشيرة مفردة: كل شهر إضافي',100,'SAR','2019-10-16','CORROBORATED_SECONDARY',NULL,NULL,NULL,'2026-09-26','research'),
 ('rp-erv-multi','EXIT_REENTRY_MULTI_BASE','EXPAT_FEES','تأشيرة خروج وعودة متعددة (حتى 3 أشهر)',500,'SAR','2019-10-16','CORROBORATED_SECONDARY',NULL,NULL,'+200 لكل شهر إضافي','2026-09-26','research'),
 ('rp-erv-multi-extra','EXIT_REENTRY_MULTI_EXTRA_MONTH','EXPAT_FEES','تأشيرة متعددة: كل شهر إضافي',200,'SAR','2019-10-16','CORROBORATED_SECONDARY',NULL,NULL,NULL,'2026-09-26','research'),
 ('rp-hrdf-base','HRDF_BASE_PCT','HRDF','دعم التوظيف: النسبة الأساسية من الأجر',30,'PERCENT','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf','30% of wage for 24 months','مشروط بقبول هدف والتقديم بين اليوم 91 و180 من التسجيل في التأمينات','2026-09-26','research'),
 ('rp-hrdf-bonus','HRDF_BONUS_PCT_EACH','HRDF','دعم التوظيف: زيادة لكل فئة',10,'PERCENT','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf',NULL,'ذو إعاقة، امرأة، منشأة صغيرة/متوسطة، قطاعات اقتصادية، خارج المدن الأربع، مهنة مستهدفة','2026-09-26','research'),
 ('rp-hrdf-cap','HRDF_CAP_SAR','HRDF','سقف دعم التوظيف الشهري',3000,'SAR_MONTH','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf','Total support must not exceed SAR (3000) or 50% of the wage, whichever is lower.',NULL,'2026-09-26','research'),
 ('rp-hrdf-cap-pct','HRDF_CAP_PCT_OF_WAGE','HRDF','سقف دعم التوظيف (% من الأجر)',50,'PERCENT','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf',NULL,NULL,'2026-09-26','research'),
 ('rp-hrdf-min','HRDF_MIN_WAGE','HRDF','أدنى أجر مؤهل لدعم التوظيف',4000,'SAR_MONTH','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf',NULL,NULL,'2026-09-26','research'),
 ('rp-hrdf-max','HRDF_MAX_WAGE','HRDF','أعلى أجر مؤهل لدعم التوظيف',15000,'SAR_MONTH','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf',NULL,NULL,'2026-09-26','research'),
 ('rp-hrdf-months','HRDF_MONTHS','HRDF','مدة دعم التوظيف',24,'MONTHS','2026-08-01','VERIFIED_PRIMARY','https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf',NULL,NULL,'2026-09-26','research')
ON CONFLICT ("key","effectiveFrom") DO NOTHING;

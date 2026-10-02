-- 9za_rules (master plan P1-RULE; SOURCE_OF_TRUTH «القيم القانونية», ARCH-007, EV-5045)
--
-- 1. CompanyRuleOverride: a company's dated override of a regulatory value (DOMAIN_BOUNDARIES §5.2,
--    owned by rules). Sole writer: src/modules/rules/transitions.ts (setCompanyRuleOverride /
--    revokeCompanyRuleOverride), which checks the key's legal bound (catalogue.ts: MIN / MAX / FIXED)
--    before writing; readers go through rules.valueAt(key, companyId, d). Revocation keeps the row.
-- 2. The labour-law values the operational code used as constants, seeded as dated RuleParameter rows
--    with their source (the rows of 9_workforce_engine are not repeated). The code mirror is
--    src/modules/rules/catalogue.ts; rules-catalogue.test.ts fails when the two differ.
--
-- Expand only: nothing an earlier release reads changes.

CREATE TABLE "CompanyRuleOverride" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "CompanyRuleOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CompanyRuleOverride_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
);

CREATE UNIQUE INDEX "CompanyRuleOverride_companyId_key_effectiveFrom_key" ON "CompanyRuleOverride"("companyId", "key", "effectiveFrom");

CREATE INDEX "CompanyRuleOverride_companyId_key_idx" ON "CompanyRuleOverride"("companyId", "key");

ALTER TABLE "CompanyRuleOverride" ADD CONSTRAINT "CompanyRuleOverride_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Dated labour-law values (Labor Law art. 84, 85, 98, 109, 113, 114, 117, 151; verified 2026-09-28
-- against laws.boe.gov.sa for 84/85/98/109/117; the special leaves stay PROVISIONAL pending counsel, DEC-003).
INSERT INTO "RuleParameter" ("id","key","domain","label","value","unit","effectiveFrom","status","sourceUrl","sourceQuote","notes","verifiedAt","verifiedBy") VALUES
 ('rp-annual-leave-higher-after-years-2005','ANNUAL_LEAVE_HIGHER_AFTER_YEARS','LABOR_LAW','سنوات الخدمة المتصلة لاستحقاق الإجازة الأعلى',5,'YEARS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','تزاد إلى ثلاثين يومًا إذا أمضى خمس سنوات متصلة','المادة 109','2026-09-28','P1-RULE'),
 ('rp-sick-leave-full-pay-days-2005','SICK_LEAVE_FULL_PAY_DAYS','LABOR_LAW','الإجازة المرضية بأجر كامل (أيام في السنة)',30,'DAYS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','إجازة مرضية بأجر عن الثلاثين يومًا الأولى','المادة 117؛ النص مراجع في P1-RULE 2026-09-28','2026-09-28','P1-RULE'),
 ('rp-sick-leave-partial-pay-until-day-2005','SICK_LEAVE_PARTIAL_PAY_UNTIL_DAY','LABOR_LAW','آخر يوم مرضي بثلاثة أرباع الأجر (تراكمياً في السنة)',90,'DAYS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','الستين يومًا التالية','30 بأجر كامل + 60 بثلاثة أرباع الأجر','2026-09-28','P1-RULE'),
 ('rp-sick-leave-unpaid-until-day-2005','SICK_LEAVE_UNPAID_UNTIL_DAY','LABOR_LAW','آخر يوم مرضي دون أجر (تراكمياً في السنة)',120,'DAYS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','الثلاثين يومًا التي تلي ذلك','90 + 30 دون أجر خلال السنة الواحدة','2026-09-28','P1-RULE'),
 ('rp-sick-leave-partial-pay-pct-2005','SICK_LEAVE_PARTIAL_PAY_PCT','LABOR_LAW','نسبة الأجر في الشريحة المرضية الثانية',75,'PERCENT','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1',NULL,'ثلاثة أرباع الأجر للستين يوماً التالية (المادة 117)','2026-09-28','P1-RULE'),
 ('rp-eos-first-period-years-2005','EOS_FIRST_PERIOD_YEARS','LABOR_LAW','سنوات الشريحة الأولى لمكافأة نهاية الخدمة',5,'YEARS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','أجر نصف شهر عن كل سنة من السنوات الخمس الأولى','المادة 84','2026-09-28','P1-RULE'),
 ('rp-eos-months-per-year-first-period-2005','EOS_MONTHS_PER_YEAR_FIRST_PERIOD','LABOR_LAW','المكافأة عن كل سنة من الشريحة الأولى (أشهر أجر)',0.5,'MONTHS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','أجر نصف شهر عن كل سنة من السنوات الخمس الأولى','المادة 84','2026-09-28','P1-RULE'),
 ('rp-eos-months-per-year-after-2005','EOS_MONTHS_PER_YEAR_AFTER','LABOR_LAW','المكافأة عن كل سنة بعد الشريحة الأولى (أشهر أجر)',1,'MONTHS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','وأجر شهر عن كل سنة من السنوات التالية','المادة 84','2026-09-28','P1-RULE'),
 ('rp-eos-resignation-none-below-years-2005','EOS_RESIGNATION_NONE_BELOW_YEARS','LABOR_LAW','الاستقالة: لا مكافأة قبل (سنوات)',2,'YEARS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','ثلث المكافأة','المادة 85','2026-09-28','P1-RULE'),
 ('rp-eos-resignation-third-below-years-2005','EOS_RESIGNATION_THIRD_BELOW_YEARS','LABOR_LAW','الاستقالة: ثلث المكافأة قبل (سنوات)',5,'YEARS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','ثلثيها','المادة 85','2026-09-28','P1-RULE'),
 ('rp-eos-resignation-two-thirds-below-years-2005','EOS_RESIGNATION_TWO_THIRDS_BELOW_YEARS','LABOR_LAW','الاستقالة: ثلثا المكافأة قبل (سنوات)',10,'YEARS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','المكافأة كاملة','المادة 85','2026-09-28','P1-RULE'),
 ('rp-work-hours-per-day-max-2005','WORK_HOURS_PER_DAY_MAX','LABOR_LAW','الحد الأعلى لساعات العمل الفعلية في اليوم',8,'HOURS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','لا يجوز تشغيل العامل تشغيلًا فعليًّا أكثر من ثماني ساعات في اليوم الواحد','المادة 98','2026-09-28','P1-RULE'),
 ('rp-work-hours-per-week-max-2005','WORK_HOURS_PER_WEEK_MAX','LABOR_LAW','الحد الأعلى لساعات العمل الفعلية في الأسبوع',48,'HOURS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1',NULL,'المادة 98 (8 ساعات يومياً أو 48 أسبوعياً)','2026-09-28','P1-RULE'),
 ('rp-ramadan-work-hours-per-day-max-2005','RAMADAN_WORK_HOURS_PER_DAY_MAX','LABOR_LAW','ساعات العمل في رمضان للمسلمين (يومياً)',6,'HOURS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','تخفض ساعات العمل الفعلية خلال شهر رمضان للمسلمين، بحيث لا تزيد على ست ساعات في اليوم','المادة 98؛ يستهلكها التقويم (P1-CAL)','2026-09-28','P1-RULE'),
 ('rp-ramadan-work-hours-per-week-max-2005','RAMADAN_WORK_HOURS_PER_WEEK_MAX','LABOR_LAW','ساعات العمل في رمضان للمسلمين (أسبوعياً)',36,'HOURS','2005-01-01','VERIFIED_PRIMARY','https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1','أو ست وثلاثين ساعة في الأسبوع','المادة 98','2026-09-28','P1-RULE'),
 ('rp-maternity-unpaid-extension-days-2025','MATERNITY_UNPAID_EXTENSION_DAYS','LABOR_LAW','تمديد إجازة الوضع دون أجر',30,'DAYS','2025-02-19','PROVISIONAL','https://www.hrsd.gov.sa/en/knowledge-centre/articles/64410',NULL,'«شهر» دون أجر (HRSD)؛ بانتظار تأكيد المستشار (DEC-003)','2026-09-28','P1-RULE'),
 ('rp-paternity-days-2025','PATERNITY_DAYS','LABOR_LAW','إجازة المولود للأب',3,'DAYS','2025-02-19','PROVISIONAL','https://www.uqn.gov.sa/details?p=25379',NULL,'تعديل 2025 كما نقلته مصادر ثانوية؛ بانتظار تأكيد المستشار (DEC-003)','2026-09-28','P1-RULE'),
 ('rp-paternity-window-days-2025','PATERNITY_WINDOW_DAYS','LABOR_LAW','مهلة أخذ إجازة المولود من تاريخ الولادة',7,'DAYS','2025-02-19','PROVISIONAL','https://www.uqn.gov.sa/details?p=25379',NULL,'خلال سبعة أيام من الولادة (DEC-003)','2026-09-28','P1-RULE'),
 ('rp-marriage-leave-days-2025','MARRIAGE_LEAVE_DAYS','LABOR_LAW','إجازة الزواج',5,'DAYS','2025-02-19','PROVISIONAL','https://www.uqn.gov.sa/details?p=25379',NULL,'DEC-003','2026-09-28','P1-RULE'),
 ('rp-bereavement-days-2025','BEREAVEMENT_DAYS','LABOR_LAW','إجازة وفاة الزوج أو أحد الأصول أو الفروع',5,'DAYS','2025-02-19','PROVISIONAL','https://www.uqn.gov.sa/details?p=25379',NULL,'DEC-003','2026-09-28','P1-RULE'),
 ('rp-bereavement-sibling-days-2025','BEREAVEMENT_SIBLING_DAYS','LABOR_LAW','إجازة وفاة الأخ أو الأخت',3,'DAYS','2025-02-19','PROVISIONAL','https://www.uqn.gov.sa/details?p=25379',NULL,'DEC-003','2026-09-28','P1-RULE'),
 ('rp-hajj-leave-min-days-2005','HAJJ_LEAVE_MIN_DAYS','LABOR_LAW','إجازة الحج (الحد الأدنى)',10,'DAYS','2005-01-01','PROVISIONAL','https://www.hrsd.gov.sa/sites/default/files/2023-02/Labor.pdf',NULL,'لا تقل عن عشرة أيام ولا تزيد على خمسة عشر يوماً بما فيها عطلة عيد الأضحى (DEC-003)','2026-09-28','P1-RULE'),
 ('rp-hajj-leave-max-days-2005','HAJJ_LEAVE_MAX_DAYS','LABOR_LAW','إجازة الحج (الحد الأعلى النظامي)',15,'DAYS','2005-01-01','PROVISIONAL','https://www.hrsd.gov.sa/sites/default/files/2023-02/Labor.pdf',NULL,'DEC-003','2026-09-28','P1-RULE'),
 ('rp-hajj-min-service-years-2005','HAJJ_MIN_SERVICE_YEARS','LABOR_LAW','الخدمة المتصلة اللازمة لإجازة الحج',2,'YEARS','2005-01-01','PROVISIONAL','https://www.hrsd.gov.sa/sites/default/files/2023-02/Labor.pdf',NULL,'مرة واحدة طوال الخدمة بعد سنتين متصلتين (DEC-003)','2026-09-28','P1-RULE')

ON CONFLICT ("key","effectiveFrom") DO NOTHING;

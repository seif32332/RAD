// The typed catalogue of regulatory values (P1-RULE; SOURCE_OF_TRUTH row «القيم القانونية», ARCH-007).
//
// PURE and import-free (client pages import it through the module index). It is the ONE place in
// code where a legal value is written, and only as the mirror of the dated RuleParameter seed rows
// (migrations 9_workforce_engine and 9za_rules) and of the GosiRate seed (migration 5): the test
// rules-catalogue.test.ts parses those migrations and fails when a value here differs. It is on the
// documented ARCH-007 allow list (src/test/architecture/config.ts, LEGAL_SCAN_EXEMPT).
//
// At run time the registry wins: rules.valueAt(key, companyId, d) reads RuleParameter (dated, with
// source) and the company override (CompanyRuleOverride) and falls back to this catalogue only when
// the table has no version of the key (a database without the seed, a unit test).
//
// `bound` says which way a company override may move away from the legal value without a warning
// (DEC-PO-116 for the rest). Going past the bound needs an explicit acknowledgement (DEC-PO-126): the
// override is then accepted, recorded, flagged `belowLegal` wherever it is read, alerted to the owner
// and reported as an EXPLAINED discrepancy (INV-RULE-02):
//   MIN   the law is a floor: an override >= the legal value (more generous) needs no acknowledgement;
//   MAX   the law is a ceiling: an override <= the legal value needs no acknowledgement;
//   FREE  the law bounds nothing a company changes (still audited);
//   FIXED no company override (government fees, contribution rates, programme parameters).

export type RuleBound = 'MIN' | 'MAX' | 'FREE' | 'FIXED';
export type RuleSourceStatus = 'VERIFIED_PRIMARY' | 'CORROBORATED_SECONDARY' | 'PROVISIONAL' | 'CONFLICTING' | 'USER_INPUT';

export interface RuleVersionDef {
  /** 'YYYY-MM-DD', first day in force. */
  effectiveFrom: string;
  value: number;
  status: RuleSourceStatus;
  sourceUrl: string | null;
  sourceQuote: string | null;
  notes: string | null;
}

export interface RuleDef {
  key: string;
  domain: 'LABOR_LAW' | 'GOSI' | 'EXPAT_FEES' | 'HRDF';
  label: string;
  unit: string;
  /** Article / instrument, e.g. 'نظام العمل م109'. */
  article: string;
  bound: RuleBound;
  /** Ascending by effectiveFrom. */
  versions: readonly RuleVersionDef[];
}

const LABOR_LAW_URL = 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/08381293-6388-48e2-8ad2-a9a700f2aa94/1';
const SI_LAW_URL = 'https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/eaee8a20-3a54-4aaf-b0d9-b1ad00998962/1';
const GOSI_FAQ_URL = 'https://www.gosi.gov.sa/GOSIOnline/FAQ_Employer?locale=en_US';
const UQN_2025_AMENDMENT_URL = 'https://www.uqn.gov.sa/details?p=25379';
const HRSD_WOMEN_LEAVES_URL = 'https://www.hrsd.gov.sa/en/knowledge-centre/articles/64410';
const HRSD_LABOR_PDF_URL = 'https://www.hrsd.gov.sa/sites/default/files/2023-02/Labor.pdf';
const QIWA_PERMITS_URL = 'https://www.qiwa.sa/en/business-owners/hire-employees/how-issue-work-permits-non-saudis';
const HRDF_URL = 'https://www.hrdf.org.sa/media/nl4lhf5g/hrdf-programs-and-services-en.pdf';

/** 2025 amendment of the Labor Law (Royal Decree M/44), in force 2025-02-19. */
const AMENDMENT_2025 = '2025-02-19';

function ver(effectiveFrom: string, value: number, status: RuleSourceStatus, sourceUrl: string | null, sourceQuote: string | null = null, notes: string | null = null): RuleVersionDef {
  return { effectiveFrom, value, status, sourceUrl, sourceQuote, notes };
}

function def(key: string, domain: RuleDef['domain'], label: string, unit: string, article: string, bound: RuleBound, ...versions: RuleVersionDef[]): RuleDef {
  return { key, domain, label, unit, article, bound, versions };
}

export const RULE_CATALOGUE: readonly RuleDef[] = [
  // ---- Labor Law: annual leave (art. 109) ------------------------------------------------------
  def('ANNUAL_LEAVE_DAYS', 'LABOR_LAW', 'الإجازة السنوية', 'DAYS_YEAR', 'نظام العمل م109', 'MIN',
    ver('2005-01-01', 21, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'لا تقل مدتها عن واحد وعشرين يومًا', 'المادة 109')),
  def('ANNUAL_LEAVE_DAYS_AFTER_5Y', 'LABOR_LAW', 'الإجازة السنوية بعد 5 سنوات متصلة', 'DAYS_YEAR', 'نظام العمل م109', 'MIN',
    ver('2005-01-01', 30, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'تزاد إلى ثلاثين يومًا إذا أمضى خمس سنوات متصلة', 'المادة 109')),
  def('ANNUAL_LEAVE_HIGHER_AFTER_YEARS', 'LABOR_LAW', 'سنوات الخدمة المتصلة لاستحقاق الإجازة الأعلى', 'YEARS', 'نظام العمل م109', 'MAX',
    ver('2005-01-01', 5, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'تزاد إلى ثلاثين يومًا إذا أمضى خمس سنوات متصلة', 'المادة 109')),

  // ---- Labor Law: sick leave within one year (art. 117) ----------------------------------------
  def('SICK_LEAVE_FULL_PAY_DAYS', 'LABOR_LAW', 'الإجازة المرضية بأجر كامل (أيام في السنة)', 'DAYS', 'نظام العمل م117', 'MIN',
    ver('2005-01-01', 30, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'إجازة مرضية بأجر عن الثلاثين يومًا الأولى', 'المادة 117؛ النص مراجع في P1-RULE 2026-09-28')),
  def('SICK_LEAVE_PARTIAL_PAY_UNTIL_DAY', 'LABOR_LAW', 'آخر يوم مرضي بثلاثة أرباع الأجر (تراكمياً في السنة)', 'DAYS', 'نظام العمل م117', 'MIN',
    ver('2005-01-01', 90, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'الستين يومًا التالية', '30 بأجر كامل + 60 بثلاثة أرباع الأجر')),
  def('SICK_LEAVE_UNPAID_UNTIL_DAY', 'LABOR_LAW', 'آخر يوم مرضي دون أجر (تراكمياً في السنة)', 'DAYS', 'نظام العمل م117', 'MIN',
    ver('2005-01-01', 120, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'الثلاثين يومًا التي تلي ذلك', '90 + 30 دون أجر خلال السنة الواحدة')),
  def('SICK_LEAVE_PARTIAL_PAY_PCT', 'LABOR_LAW', 'نسبة الأجر في الشريحة المرضية الثانية', 'PERCENT', 'نظام العمل م117', 'MIN',
    ver('2005-01-01', 75, 'VERIFIED_PRIMARY', LABOR_LAW_URL, null, 'ثلاثة أرباع الأجر للستين يوماً التالية (المادة 117)')),

  // ---- Labor Law: end-of-service award (art. 84, 85) -------------------------------------------
  def('EOS_FIRST_PERIOD_YEARS', 'LABOR_LAW', 'سنوات الشريحة الأولى لمكافأة نهاية الخدمة', 'YEARS', 'نظام العمل م84', 'MAX',
    ver('2005-01-01', 5, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'أجر نصف شهر عن كل سنة من السنوات الخمس الأولى', 'المادة 84')),
  def('EOS_MONTHS_PER_YEAR_FIRST_PERIOD', 'LABOR_LAW', 'المكافأة عن كل سنة من الشريحة الأولى (أشهر أجر)', 'MONTHS', 'نظام العمل م84', 'MIN',
    ver('2005-01-01', 0.5, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'أجر نصف شهر عن كل سنة من السنوات الخمس الأولى', 'المادة 84')),
  def('EOS_MONTHS_PER_YEAR_AFTER', 'LABOR_LAW', 'المكافأة عن كل سنة بعد الشريحة الأولى (أشهر أجر)', 'MONTHS', 'نظام العمل م84', 'MIN',
    ver('2005-01-01', 1, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'وأجر شهر عن كل سنة من السنوات التالية', 'المادة 84')),
  def('EOS_RESIGNATION_NONE_BELOW_YEARS', 'LABOR_LAW', 'الاستقالة: لا مكافأة قبل (سنوات)', 'YEARS', 'نظام العمل م85', 'MAX',
    ver('2005-01-01', 2, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'ثلث المكافأة', 'المادة 85')),
  def('EOS_RESIGNATION_THIRD_BELOW_YEARS', 'LABOR_LAW', 'الاستقالة: ثلث المكافأة قبل (سنوات)', 'YEARS', 'نظام العمل م85', 'MAX',
    ver('2005-01-01', 5, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'ثلثيها', 'المادة 85')),
  def('EOS_RESIGNATION_TWO_THIRDS_BELOW_YEARS', 'LABOR_LAW', 'الاستقالة: ثلثا المكافأة قبل (سنوات)', 'YEARS', 'نظام العمل م85', 'MAX',
    ver('2005-01-01', 10, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'المكافأة كاملة', 'المادة 85')),

  // ---- Labor Law: notice, unlawful termination, probation (art. 53, 75, 77) ---------------------
  def('NOTICE_DAYS_EMPLOYER', 'LABOR_LAW', 'مدة الإشعار عند إنهاء صاحب العمل (عقد غير محدد، أجر شهري)', 'DAYS', 'نظام العمل م75', 'MIN',
    ver(AMENDMENT_2025, 60, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'من طرف صاحب العمل... (ستين) يوماً', 'المادة 75 بعد تعديل م/44')),
  def('NOTICE_DAYS_EMPLOYEE', 'LABOR_LAW', 'مدة الإشعار عند استقالة العامل (عقد غير محدد)', 'DAYS', 'نظام العمل م75', 'MIN',
    ver(AMENDMENT_2025, 30, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'من طرف العامل... (ثلاثين) يوماً', 'المادة 75')),
  def('ART77_DAYS_PER_YEAR', 'LABOR_LAW', 'تعويض الإنهاء غير المشروع (أيام عن كل سنة)', 'DAYS', 'نظام العمل م77', 'MIN',
    ver('2015-01-01', 15, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'أجر خمسة عشر يوماً عن كل سنة', 'المادة 77 (عقد غير محدد المدة)')),
  def('ART77_MIN_MONTHS', 'LABOR_LAW', 'الحد الأدنى لتعويض الإنهاء غير المشروع (أشهر)', 'MONTHS', 'نظام العمل م77', 'MIN',
    ver('2015-01-01', 2, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'يجب ألا يقل التعويض عن أجر العامل لمدة شهرين', 'المادة 77')),
  def('PROBATION_MAX_DAYS', 'LABOR_LAW', 'الحد الأقصى لفترة التجربة', 'DAYS', 'نظام العمل م53', 'MAX',
    ver(AMENDMENT_2025, 180, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'على ألا يزيد مجموع المدة في جميع الأحوال على (مائة وثمانين) يوماً', 'المادة 53')),

  // ---- Labor Law: working hours and overtime (art. 98, 107) ------------------------------------
  def('WORK_HOURS_PER_DAY_MAX', 'LABOR_LAW', 'الحد الأعلى لساعات العمل الفعلية في اليوم', 'HOURS', 'نظام العمل م98', 'MAX',
    ver('2005-01-01', 8, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'لا يجوز تشغيل العامل تشغيلًا فعليًّا أكثر من ثماني ساعات في اليوم الواحد', 'المادة 98')),
  def('WORK_HOURS_PER_WEEK_MAX', 'LABOR_LAW', 'الحد الأعلى لساعات العمل الفعلية في الأسبوع', 'HOURS', 'نظام العمل م98', 'MAX',
    ver('2005-01-01', 48, 'VERIFIED_PRIMARY', LABOR_LAW_URL, null, 'المادة 98 (8 ساعات يومياً أو 48 أسبوعياً)')),
  def('RAMADAN_WORK_HOURS_PER_DAY_MAX', 'LABOR_LAW', 'ساعات العمل في رمضان للمسلمين (يومياً)', 'HOURS', 'نظام العمل م98', 'MAX',
    ver('2005-01-01', 6, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'تخفض ساعات العمل الفعلية خلال شهر رمضان للمسلمين، بحيث لا تزيد على ست ساعات في اليوم', 'المادة 98؛ يستهلكها التقويم (P1-CAL)')),
  def('RAMADAN_WORK_HOURS_PER_WEEK_MAX', 'LABOR_LAW', 'ساعات العمل في رمضان للمسلمين (أسبوعياً)', 'HOURS', 'نظام العمل م98', 'MAX',
    ver('2005-01-01', 36, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'أو ست وثلاثين ساعة في الأسبوع', 'المادة 98')),
  def('OVERTIME_PREMIUM_PCT_OF_BASIC', 'LABOR_LAW', 'علاوة العمل الإضافي (% من الأجر الأساسي)', 'PERCENT', 'نظام العمل م107', 'MIN',
    ver(AMENDMENT_2025, 50, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'أجر الساعة مضافاً إليه (50%) من أجره الأساسي', 'المادة 107. تفسير «أجر الساعة» (أساسي أم إجمالي) بانتظار المستشار: افتراض OVERTIME_HOURLY_BASIS')),
  def('OVERTIME_ANNUAL_CAP_HOURS', 'LABOR_LAW', 'سقف العمل الإضافي السنوي', 'HOURS_YEAR', 'اللائحة التنفيذية لنظام العمل', 'MAX',
    ver(AMENDMENT_2025, 720, 'VERIFIED_PRIMARY', 'https://www.hrsd.gov.sa/en/knowledge-centre', 'may not exceed seven hundred and twenty hours', 'يجوز الزيادة بموافقة العامل؛ رقم مادة اللائحة غير مؤكد')),

  // ---- Labor Law: maternity and special leaves (art. 113, 114, 151; 2025 amendment) -------------
  def('MATERNITY_WEEKS', 'LABOR_LAW', 'إجازة الوضع بأجر كامل', 'WEEKS', 'نظام العمل م151', 'MIN',
    ver(AMENDMENT_2025, 12, 'VERIFIED_PRIMARY', LABOR_LAW_URL, 'إجازة وضع بأجر كامل لمدة (اثني عشر) أسبوعاً', 'المادة 151؛ في النظام الجديد تدفع التأمينات تعويض الأمومة بشروط')),
  def('MATERNITY_UNPAID_EXTENSION_DAYS', 'LABOR_LAW', 'تمديد إجازة الوضع دون أجر', 'DAYS', 'نظام العمل م151', 'MIN',
    ver(AMENDMENT_2025, 30, 'PROVISIONAL', HRSD_WOMEN_LEAVES_URL, null, '«شهر» دون أجر (HRSD)؛ بانتظار تأكيد المستشار (DEC-003)')),
  def('PATERNITY_DAYS', 'LABOR_LAW', 'إجازة المولود للأب', 'DAYS', 'نظام العمل م113', 'MIN',
    ver(AMENDMENT_2025, 3, 'PROVISIONAL', UQN_2025_AMENDMENT_URL, null, 'تعديل 2025 كما نقلته مصادر ثانوية؛ بانتظار تأكيد المستشار (DEC-003)')),
  def('PATERNITY_WINDOW_DAYS', 'LABOR_LAW', 'مهلة أخذ إجازة المولود من تاريخ الولادة', 'DAYS', 'نظام العمل م113', 'MIN',
    ver(AMENDMENT_2025, 7, 'PROVISIONAL', UQN_2025_AMENDMENT_URL, null, 'خلال سبعة أيام من الولادة (DEC-003)')),
  def('MARRIAGE_LEAVE_DAYS', 'LABOR_LAW', 'إجازة الزواج', 'DAYS', 'نظام العمل م113', 'MIN',
    ver(AMENDMENT_2025, 5, 'PROVISIONAL', UQN_2025_AMENDMENT_URL, null, 'DEC-003')),
  def('BEREAVEMENT_DAYS', 'LABOR_LAW', 'إجازة وفاة الزوج أو أحد الأصول أو الفروع', 'DAYS', 'نظام العمل م113', 'MIN',
    ver(AMENDMENT_2025, 5, 'PROVISIONAL', UQN_2025_AMENDMENT_URL, null, 'DEC-003')),
  def('BEREAVEMENT_SIBLING_DAYS', 'LABOR_LAW', 'إجازة وفاة الأخ أو الأخت', 'DAYS', 'نظام العمل م113', 'MIN',
    ver(AMENDMENT_2025, 3, 'PROVISIONAL', UQN_2025_AMENDMENT_URL, null, 'DEC-003')),
  def('HAJJ_LEAVE_MIN_DAYS', 'LABOR_LAW', 'إجازة الحج (الحد الأدنى)', 'DAYS', 'نظام العمل م114', 'MIN',
    ver('2005-01-01', 10, 'PROVISIONAL', HRSD_LABOR_PDF_URL, null, 'لا تقل عن عشرة أيام ولا تزيد على خمسة عشر يوماً بما فيها عطلة عيد الأضحى (DEC-003)')),
  def('HAJJ_LEAVE_MAX_DAYS', 'LABOR_LAW', 'إجازة الحج (الحد الأعلى النظامي)', 'DAYS', 'نظام العمل م114', 'FREE',
    ver('2005-01-01', 15, 'PROVISIONAL', HRSD_LABOR_PDF_URL, null, 'DEC-003')),
  def('HAJJ_MIN_SERVICE_YEARS', 'LABOR_LAW', 'الخدمة المتصلة اللازمة لإجازة الحج', 'YEARS', 'نظام العمل م114', 'MAX',
    ver('2005-01-01', 2, 'PROVISIONAL', HRSD_LABOR_PDF_URL, null, 'مرة واحدة طوال الخدمة بعد سنتين متصلتين (DEC-003)')),

  // ---- GOSI (Social Insurance Law) ---------------------------------------------------------------
  def('GOSI_MAX_CONTRIBUTORY_WAGE', 'GOSI', 'الحد الأعلى للأجر الخاضع للاشتراك', 'SAR_MONTH', 'نظام التأمينات م8', 'FIXED',
    ver('2000-01-01', 45000, 'VERIFIED_PRIMARY', SI_LAW_URL, 'يكون الحد الأعلى للأجر أو الراتب الخاضع للاشتراك (45,000)', 'نظام التأمينات الاجتماعية، المادة 8')),
  def('GOSI_MIN_CONTRIBUTORY_WAGE_OLD', 'GOSI', 'الحد الأدنى للأجر الخاضع (النظام القديم)', 'SAR_MONTH', 'نظام التأمينات', 'FIXED',
    ver('2000-01-01', 1500, 'VERIFIED_PRIMARY', GOSI_FAQ_URL, 'minimum wage under the Annuities Branch is S.R. 1,500')),
  def('GOSI_MIN_CONTRIBUTORY_WAGE_NEW', 'GOSI', 'الحد الأدنى للأجر الخاضع (النظام الجديد)', 'SAR_MONTH', 'نظام التأمينات م8', 'FIXED',
    ver('2024-07-03', 1500, 'PROVISIONAL', SI_LAW_URL, 'الحد الأدنى للأجور أو الرواتب الذي تحدده الجهة المختصة', 'المادة 8 تحيل للجهة المختصة؛ 1,500 من مصادر ثانوية فقط')),
  def('GOSI_IN_KIND_HOUSING_MONTHS', 'GOSI', 'تقدير السكن العيني بأجر (أشهر أساسية سنوياً)', 'MONTHS', 'نظام التأمينات', 'FIXED',
    ver('2000-01-01', 2, 'VERIFIED_PRIMARY', GOSI_FAQ_URL, 'بدل السكن العيني وتقدر قيمته بما يساوي الأجر أو الراتب الأساسي عن شهرين')),

  // ---- Expat fees (Qiwa / MoF) -------------------------------------------------------------------
  def('EXPAT_LEVY_WITHIN_SAUDI_COUNT', 'EXPAT_FEES', 'المقابل المالي للوافد ضمن عدد السعوديين', 'SAR_MONTH', 'قرار المقابل المالي', 'FIXED',
    ver('2020-01-01', 700, 'VERIFIED_PRIMARY', QIWA_PERMITS_URL, '700 SAR monthly for each non-Saudi employee not exceeding the number of Saudi employees', 'الأساس عدد السعوديين مقابل الوافدين وليس لون النطاق')),
  def('EXPAT_LEVY_ABOVE_SAUDI_COUNT', 'EXPAT_FEES', 'المقابل المالي للوافد الزائد عن عدد السعوديين', 'SAR_MONTH', 'قرار المقابل المالي', 'FIXED',
    ver('2020-01-01', 800, 'VERIFIED_PRIMARY', QIWA_PERMITS_URL, '800 SAR monthly for each non-Saudi employee exceeding the number of Saudi employees')),
  def('INDUSTRIAL_LEVY_CANCELLED', 'EXPAT_FEES', 'إلغاء المقابل المالي للمنشآت الصناعية المرخّصة', 'FLAG', 'قرار مجلس الوزراء 2025-12-17', 'FIXED',
    ver('2025-12-17', 1, 'VERIFIED_PRIMARY', 'https://www.spa.gov.sa/en/N2468180', 'Cabinet approved the cancellation of the expat levy on licensed industrial establishments', 'قرار مجلس الوزراء 17 ديسمبر 2025')),
  def('SMALL_EST_MAX_WORKERS', 'EXPAT_FEES', 'حجم المنشأة الصغيرة المشمولة بالإعفاء', 'WORKERS', 'إعفاء المنشآت الصغيرة', 'FIXED',
    ver('2024-02-01', 9, 'VERIFIED_PRIMARY', QIWA_PERMITS_URL, 'establishments with 9 employees or less', 'الإعفاء ممدد 3 سنوات من فبراير 2024 (تاريخ الانتهاء ثانوي)')),
  def('SMALL_EST_EXEMPT_OWNER_ONLY', 'EXPAT_FEES', 'وافدون معفون (المالك متفرغ فقط)', 'WORKERS', 'إعفاء المنشآت الصغيرة', 'FIXED',
    ver('2024-02-01', 2, 'VERIFIED_PRIMARY', QIWA_PERMITS_URL, 'exemption for 2 non-Saudi employees')),
  def('SMALL_EST_EXEMPT_WITH_SAUDI', 'EXPAT_FEES', 'وافدون معفون (المالك + سعودي متفرغ)', 'WORKERS', 'إعفاء المنشآت الصغيرة', 'FIXED',
    ver('2024-02-01', 4, 'VERIFIED_PRIMARY', QIWA_PERMITS_URL, 'The exemption is then granted during one financial year for 4 non-Saudi employees.')),
  def('WORK_PERMIT_FEE_YEAR', 'EXPAT_FEES', 'رسوم رخصة العمل', 'SAR_YEAR', 'رسوم رخصة العمل', 'FIXED',
    ver('2020-01-01', 100, 'VERIFIED_PRIMARY', QIWA_PERMITS_URL, '100 SAR annually for each non-Saudi employee')),
  def('IQAMA_FEE_YEAR', 'EXPAT_FEES', 'رسوم الإقامة (قطاع خاص)', 'SAR_YEAR', 'رسوم الإقامة', 'FIXED',
    ver('2020-01-01', 650, 'PROVISIONAL', null, null, 'مؤكَّد من مصادر ثانوية فقط؛ my.gov.sa تذكر أن الكلفة متغيرة')),
  def('DEPENDENT_FEE_MONTH', 'EXPAT_FEES', 'رسوم المرافق', 'SAR_MONTH', 'رسوم المرافقين', 'FIXED',
    ver('2020-07-01', 400, 'VERIFIED_PRIMARY', 'https://www.mof.gov.sa/budget/Documents/FBP%20Final.pdf', '100 في أول سنة، ثم 200، 300، 400 ريال', 'من يدفعها: سياسة لكل موظف (dependentsFeePaidBy)')),
  def('EXIT_REENTRY_SINGLE_BASE', 'EXPAT_FEES', 'تأشيرة خروج وعودة مفردة (حتى شهرين)', 'SAR', 'رسوم التأشيرات', 'FIXED',
    ver('2019-10-16', 200, 'CORROBORATED_SECONDARY', null, '200 ريال لشهرين أو أقل', '+100 لكل شهر إضافي؛ التمديد من الخارج مضاعف')),
  def('EXIT_REENTRY_SINGLE_EXTRA_MONTH', 'EXPAT_FEES', 'تأشيرة مفردة: كل شهر إضافي', 'SAR', 'رسوم التأشيرات', 'FIXED',
    ver('2019-10-16', 100, 'CORROBORATED_SECONDARY', null)),
  def('EXIT_REENTRY_MULTI_BASE', 'EXPAT_FEES', 'تأشيرة خروج وعودة متعددة (حتى 3 أشهر)', 'SAR', 'رسوم التأشيرات', 'FIXED',
    ver('2019-10-16', 500, 'CORROBORATED_SECONDARY', null, null, '+200 لكل شهر إضافي')),
  def('EXIT_REENTRY_MULTI_EXTRA_MONTH', 'EXPAT_FEES', 'تأشيرة متعددة: كل شهر إضافي', 'SAR', 'رسوم التأشيرات', 'FIXED',
    ver('2019-10-16', 200, 'CORROBORATED_SECONDARY', null)),

  // ---- HRDF employment support -------------------------------------------------------------------
  def('HRDF_BASE_PCT', 'HRDF', 'دعم التوظيف: النسبة الأساسية من الأجر', 'PERCENT', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 30, 'VERIFIED_PRIMARY', HRDF_URL, '30% of wage for 24 months', 'مشروط بقبول هدف والتقديم بين اليوم 91 و180 من التسجيل في التأمينات')),
  def('HRDF_BONUS_PCT_EACH', 'HRDF', 'دعم التوظيف: زيادة لكل فئة', 'PERCENT', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 10, 'VERIFIED_PRIMARY', HRDF_URL, null, 'ذو إعاقة، امرأة، منشأة صغيرة/متوسطة، قطاعات اقتصادية، خارج المدن الأربع، مهنة مستهدفة')),
  def('HRDF_CAP_SAR', 'HRDF', 'سقف دعم التوظيف الشهري', 'SAR_MONTH', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 3000, 'VERIFIED_PRIMARY', HRDF_URL, 'Total support must not exceed SAR (3000) or 50% of the wage, whichever is lower.')),
  def('HRDF_CAP_PCT_OF_WAGE', 'HRDF', 'سقف دعم التوظيف (% من الأجر)', 'PERCENT', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 50, 'VERIFIED_PRIMARY', HRDF_URL)),
  def('HRDF_MIN_WAGE', 'HRDF', 'أدنى أجر مؤهل لدعم التوظيف', 'SAR_MONTH', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 4000, 'VERIFIED_PRIMARY', HRDF_URL)),
  def('HRDF_MAX_WAGE', 'HRDF', 'أعلى أجر مؤهل لدعم التوظيف', 'SAR_MONTH', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 15000, 'VERIFIED_PRIMARY', HRDF_URL)),
  def('HRDF_MONTHS', 'HRDF', 'مدة دعم التوظيف', 'MONTHS', 'برامج هدف', 'FIXED',
    ver('2026-08-01', 24, 'VERIFIED_PRIMARY', HRDF_URL)),
];

/**
 * Mirror of the OLD-regime GosiRate seed rows (migration 5). GosiRate is the store of contribution
 * rates (owned by the rules module); this is only the fallback when that table is empty.
 */
export const GOSI_FALLBACK_RATES = [
  { regime: 'OLD', isSaudi: true, effectiveFrom: '2000-01-01', employeeRate: 9.75, employerRate: 11.75, minWage: 1500, maxWage: 45000, isProvisional: false },
  { regime: 'OLD', isSaudi: false, effectiveFrom: '2000-01-01', employeeRate: 0, employerRate: 2, minWage: 1500, maxWage: 45000, isProvisional: false },
] as const;

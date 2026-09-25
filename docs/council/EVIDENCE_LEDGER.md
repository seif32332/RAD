# سجل الأدلة — مجلس الخبراء

التصنيفات: FACT (تحقق مباشر)، VERIFIED_EXTERNAL (مصدر خارجي موثوق فُتح فعلاً)، INTERNAL (ملفات المشروع أو الاختبارات)، EXPERT_JUDGMENT، ASSUMPTION، HYPOTHESIS، ESTIMATE، UNKNOWN.

| # | الادعاء | التصنيف | المصدر | ملاحظات |
|---|---|---|---|---|
| 1 | ROLE_GROUPS.OWNER = ['SUPER_ADMIN','COMPANY_ADMIN']، وFINANCE تضم SUPER_ADMIN وCOMPANY_ADMIN وFINANCE_MANAGER وPAYROLL_ADMIN | FACT | src/lib/constants.ts:48,52 (grep في هذه الجلسة) |  |
| 2 | القيمة الافتراضية لـEmployee.nationality هي «سعودي» | FACT | prisma/schema.prisma:320 (grep في هذه الجلسة) |  |
| 3 | عمود GOSI في جدول الرواتب يُقرأ من fullEmp.gosiDeduction، والتصدير يتم عبر XLSX.utils.table_to_book من DOM | FACT | src/app/payrolls/page.tsx:373,701 (grep في هذه الجلسة) |  |
| 4 | 262 من 276 صف مسودة لسعوديين فيها gosiDeduction=0، فيظهر GOSI صفراً في الملف | FACT | scratchpad/council/redteam/gosi_sheet.mjs (تشغيل الفريق الأحمر) | على بيانات الاختبار؛ لم يُعد المجلس التشغيل |
| 5 | gosi_company_percentage='11.75' موجود في البذور ولا يقرؤه الكود | FACT | prisma/seed.mjs:81 (grep في هذه الجلسة)؛ عدم القراءة من grep الفريق الأحمر |  |
| 6 | مسار الملفات: «staff roles may read any file» | FACT | src/app/api/files/[...path]/route.ts:70,82 (grep في هذه الجلسة) |  |
| 7 | وكيل المشتريات ومدير الفرع حصلا على HTTP 200 لمستند موظف | FACT | اختبار حي للفريق الأحمر على :3458 بتاريخ 2026-09-24 | لم يُعده المجلس |
| 8 | تسجيل الدخول يفحص user.isActive فقط، والإنهاء لا يعطّل المستخدم | FACT | src/app/api/auth/login/route.ts:69 (grep في هذه الجلسة)؛ src/app/api/employees/[id]/route.ts:258-280 (INTERNAL) |  |
| 9 | صفحة الموقع تنشر: 3,000 ر.س/6 أشهر، 4,800/سنة، 7,200/سنتين، غير شاملة ضريبة 15%، «كل أقسام ومميزات النظام بدون استثناء»، وعدادات data-target=100 وdata-target=3 | FACT | scratchpad/council/redteam/radeef_hrms.html (فحصها المجلس بـgrep؛ جلبها الفريق الأحمر من https://radeef-sa.com/radeef) | نسخة محفوظة بتاريخ الجلب؛ قد تتغير الصفحة الحية |
| 10 | الموقع يقدّم رديف كشركة حلول موارد بشرية وإدارية وقانونية واستثمار أجنبي للمنشآت الصغيرة والمتوسطة، والنظام «منتجنا التقني» | VERIFIED_EXTERNAL | https://radeef-sa.com (نسخة محفوظة scratchpad/council/redteam/radeef_home.html) | قراءة الفريق الأحمر؛ المجلس لم يفحص نص الصفحة الرئيسية |
| 11 | GOSI ثابت 9.75% من (الأساسي+السكن) للسعوديين و0 لغيرهم، بسقف 45,000، بلا حصة صاحب العمل ولا تمييز للنظام | INTERNAL | src/lib/payroll-core.ts:18-20,32-60,404-419 |  |
| 12 | وعاء GOSI يلتقط البدلات المتكررة المطابقة لـ/سكن\|housing/ فقط | INTERNAL | src/lib/payroll-core.ts:134-139,419 |  |
| 13 | النظام الجديد يسري على من ليس لديهم مدد اشتراك قبل 3 يوليو 2024، ونسبة المعاشات 11% على كل طرف بعد زيادة تدريجية 0.5% سنوياً | VERIFIED_EXTERNAL | https://awareness.gosi.gov.sa/businessJourney.html | CONFLICTING EVIDENCE: المتخصص التنظيمي قرأ 4.5%/4.5% من الصفحة نفسها؛ قراءة الفريق الأحمر مقتبسة حرفياً ومؤيدة بـhttps://mercans.com/resources/statutory-alerts/saudi-arabia-gosi-contribution-rates-saned-unemployment-fund-2026/ . تحتاج قراءة بشرية موثقة |
| 14 | النظام القديم: 9.75% على الموظف و11.75% على صاحب العمل، وحد أدنى للأجر 1,500 وحد أقصى 45,000، والأجر = الأساسي + السكن | VERIFIED_EXTERNAL | https://www.gosi.gov.sa/GOSIOnline/FAQ_Employer?locale=en_US | فتحه المتخصص التنظيمي |
| 15 | نظام التأمينات الجديد اعتُمد وسرى في 3 يوليو 2024 | VERIFIED_EXTERNAL | https://www.spa.gov.sa/N2132517 |  |
| 16 | تعديلات نظام العمل (م/44): أمومة 12 أسبوعاً، أبوة 3 أيام، وفاة أخ أو أخت 3 أيام، تجربة حتى 180 يوماً، إشعار الموظف 30 يوماً | VERIFIED_EXTERNAL | https://www.morganlewis.com/pubs/2024/08/key-amendments-to-the-kingdom-of-saudi-arabia-labour-law-announced ; https://www.kslaw.com/news-and-insights/amendments-to-the-saudi-labor-law-approved | مصادر ثانوية (مكاتب محاماة)؛ تاريخ السريان متعارض: 19 مقابل 25 فبراير 2025 |
| 17 | أنواع الإجازات: ANNUAL وDEDUCTED وSICK وEMERGENCY وUNPAID فقط | INTERNAL | src/lib/leave.ts:10 |  |
| 18 | مسوغات التسوية: COMPANY_TERMINATION وRESIGNATION وPROBATION وARTICLE_80 فقط | INTERNAL | prisma/schema.prisma:1356-1361 |  |
| 19 | صيغة نهاية الخدمة وتخفيضات الاستقالة تطابق المادتين 84 و85، ولم تتغير في 2025 | VERIFIED_EXTERNAL | https://www.morganlewis.com/pubs/2024/08/key-amendments-to-the-kingdom-of-saudi-arabia-labour-law-announced ; src/lib/settlement.ts:76-96 |  |
| 20 | توليد الرواتب على مستوى المستأجر بلا مرشح شركة | INTERNAL | src/lib/payroll.ts:323-360 |  |
| 21 | نموذج Payroll إجمالي فقط، والمبالغ Float | INTERNAL | prisma/schema.prisma:643-671 |  |
| 22 | لا مراجع لـmudad أو qiwa أو muqeem أو absher أو whatsapp أو nitaqat في الكود | FACT | grep المتخصصين (product-capability-map, competitors) |  |
| 23 | WPS/مدد يُرفع عبر منصة مدد للأعمال | VERIFIED_EXTERNAL | https://www.hrsd.gov.sa/en/ministry-services/services/%D8%B1%D9%81%D8%B9-%D9%85%D9%84%D9%81-%D8%AD%D9%85%D8%A7%D9%8A%D8%A9-%D8%A7%D9%84%D8%A3%D8%AC%D9%88%D8%B1 | المواصفة والمواعيد والغرامات غير متحقق منها |
| 24 | هل WPS إلزامي لكل المنشآت أم لمن يزيد عن 50 موظفاً فقط | UNKNOWN | imarcgroup (مقتطف) مقابل ditrc.com وsafwahr.com | CONFLICTING EVIDENCE — do not use as a factual basis |
| 25 | جسر وZenHR وBayzat وMenaitech تعلن تكامل مدد وGOSI أصلياً | VERIFIED_EXTERNAL | https://www.jisr.net/en ; https://www.zenhr.com/en/hr-software-saudi-arabia ; https://www.bayzat.com/ksa/payroll ; https://menaitech.com/en/faqs/ |  |
| 26 | ZenHR تعلن إدارة كيانات وفروع متعددة وتنبيهات انتهاء الوثائق، وJisr تعلن إدارة الكيانات والشركات التابعة | VERIFIED_EXTERNAL | https://www.zenhr.com/en/enterprise-hr-software ; https://www.jisr.net/en/solutions/enterprise | فتحها الفريق الأحمر |
| 27 | لا منافس مباشر ينشر قائمة أسعار (جسر وZenHR بعرض سعر فقط) | VERIFIED_EXTERNAL | https://www.jisr.net/en/pricing ; https://www.zenhr.com/en/zenhr-pricing |  |
| 28 | Zoho Payroll KSA Standard: 35 ر.س للمنظمة + 7 ر.س لكل موظف إضافي (سنوي)؛ greytHR Growth: 60$ + 3$ لكل موظف | VERIFIED_EXTERNAL | https://www.zoho.com/en-sa/payroll/pricing/ ; https://www.greythr.com/middle-east/pricing/ | منتجات أضيق؛ للمرجعية فقط |
| 29 | ZenHR بـ8$ لكل مستخدم، وPalmHR بـ19 ر.س لكل موظف | UNKNOWN | snad.io ; neuralhr.ai | CONFLICTING EVIDENCE مع صفحات البائعين — UNVERIFIED, do not use as a factual basis |
| 30 | التسجيل في ضريبة القيمة المضافة إلزامي فوق 375,000 ر.س سنوياً | VERIFIED_EXTERNAL | https://zatca.gov.sa/en/eServices/Pages/eServices_002.aspx |  |
| 31 | مساران للتزويد: اللوحة تبني على الإنتاج وتضع .env داخل مجلد التطبيق، وops تكتشف المستأجرين من /etc/radeef/*.env | INTERNAL | radeef-manage/lib/ops.js:310-390,364 ; ops/deploy.sh:78-85 ; ops/backup.sh:446-456 |  |
| 32 | النشر يرحّل قبل الـcanary ويتوقف عند أول فشل، والتراجع لا يعيد القاعدة | INTERNAL | ops/deploy.sh:233,382,398-400 |  |
| 33 | قواعد المستأجرين بُنيت بـdb push وبها انحراف مخطط | INTERNAL | docs/DATABASE.md:3-5,79 |  |
| 34 | مجمّع اتصالات مستأجر واحد بلغ 9 تحت 40 طلباً متزامناً، ولوحة القيادة 4.2–6.3 ثانية وpayroll-hub 5.5–9.7 ثانية | FACT | scratchpad/council/redteam/rt_pool.txt | على localhost، وربما ملوث بحمل آخر |
| 35 | max_connections=100 على بيئة الاختبار | FACT | scratchpad/pg/council_dbsize.cjs (tech-scale) | قيمة الإنتاج UNKNOWN |
| 36 | سعة تقريبية 20–30 مستأجراً لكل خادم 16GB | ESTIMATE | tech-scale، من قياسات Windows ملوثة | لا تُستخدم للتسعير قبل قياس على Linux |
| 37 | /api/payroll-hub يعيد 9.56MB، و/employees فيها 16,930 عقدة DOM | FACT | council/ux_results.json ; curl |  |
| 38 | payroll-hub يستخدم findMany بلا take | INTERNAL | src/app/api/payroll-hub/route.ts:84-98 |  |
| 39 | الإيقاف عند days<=0، والتحذير عند days===7 أو 2 فقط، والإرسال مشروط بـSMTP | INTERNAL | radeef-manage/lib/ops.js:636-661 ; radeef-manage/lib/mailer.js:79-87 |  |
| 40 | POST مجهول إلى /api/internal/* أعاد 401 من الوكيل، ونقاط التنبيه تستجيب في 21–69ms | FACT | scratchpad/council/redteam/rt_single.txt |  |
| 41 | crypto.ts يشتق المفتاح من SESSION_SECRET عند غياب DATA_ENCRYPTION_KEY، ولا يوجد تدوير | INTERNAL | src/lib/crypto.ts:9-25 ; docs/RUNBOOK.md:324 |  |
| 42 | الملفات المرفوعة نص غير مشفر على القرص | INTERNAL | src/lib/storage.ts:1-60 |  |
| 43 | IP من سكربتات قديمة يُحدَّد جغرافياً في مركز بيانات Hostinger في باريس | VERIFIED_EXTERNAL | https://ipinfo.io/187.124.42.150 | مصدر واحد، وقد لا يكون IP الإنتاج الحالي |
| 44 | PDPL يقيّد النقل خارج المملكة، وSDAIA أصدرت لائحة لنقل البيانات | VERIFIED_EXTERNAL | https://dgp.sdaia.gov.sa/wps/portal/pdp/knowledgecenter/ |  |
| 45 | الإخطار بالاختراق خلال 72 ساعة | VERIFIED_EXTERNAL | https://www.multilaw.com/Multilaw/Multilaw/Data_Protection_Laws_Guide/DataProtection_Guide_SaudiArabia.aspx | مصدر ثانوي؛ النص الأساسي لم يُقرأ، ويحتاج تأكيد المستشار |
| 46 | لوائح CST لتقديم خدمات الحوسبة السحابية قائمة | VERIFIED_EXTERNAL | https://www.cst.gov.sa/en/regulations-and-licenses/regulations/Document-1550 | انطباقها على رديف UNKNOWN |
| 47 | Anthropic API المباشر: استدلال في 'us' أو 'global' فقط | VERIFIED_EXTERNAL | https://platform.claude.com/docs/en/manage-claude/data-residency |  |
| 48 | لا كود ولا اعتماديات ذكاء اصطناعي | FACT | grep متخصص الذكاء الاصطناعي |  |
| 49 | الاستيراد حفظ فرعاً ومديراً غير موجودين كـnull، وخزّن IBAN كـ'SA123456' دون تحذير | FACT | scratchpad/council/import_result.json |  |
| 50 | على بيانات الاختبار: 17 من 362 موظفاً نشطاً لديهم بريد (15 منها مكررة)، و24 لديهم IBAN | FACT | scratchpad/council/redteam/emails.mjs ; iban.mjs | بيانات اختبار؛ قيم الإنتاج UNKNOWN |
| 51 | واجهة الحضور تَعِد بربط آلي بالبصمة، ولا كود استيراد | INTERNAL | src/app/attendance/page.tsx:231,317 ; src/app/api/attendance-hub/route.ts:131 |  |
| 52 | المقترح يعلن «27+» ميزة ويصف 16، ويذكر 9 أدوار مقابل 11 فعلية | INTERNAL | docs/proposals/radeef-features-proposal.html:58 ; prisma/schema.prisma:22-34 |  |
| 53 | عرض تطبيق الجوال 800$ (400$ مقدماً + 400$ عند التسليم)، ورسوم المتاجر خارجه | INTERNAL | docs/proposals/radeef-mobile-app-proposal.html:327-365 |  |
| 54 | web push على iOS للتطبيقات المضافة للشاشة الرئيسية فقط | VERIFIED_EXTERNAL | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ |  |
| 55 | pg-boss يتطلب Node ≥ 22.12، بينما package.json يعلن node >=20.9 <25 | VERIFIED_EXTERNAL | https://github.com/timgit/pg-boss ; package.json engines (INTERNAL) |  |
| 56 | تسعير واتساب لكل رسالة حسب الدولة والفئة | VERIFIED_EXTERNAL | https://developers.facebook.com/docs/whatsapp/pricing/ | السعر السعودي بالريال UNKNOWN |
| 57 | تكلفة الخدمة 90–980 ر.س لكل مستأجر شهرياً، والتهيئة 240–2,400 ر.س | ESTIMATE | نموذج متخصص نموذج الأعمال؛ كل المدخلات افتراضات |  |
| 58 | الإيراد، وعدد العملاء الدافعين، وCAC، وchurn، والـICP | UNKNOWN | none |  |
| 59 | التمايز بـ«برج تحكم» لمجموعات متعددة السجلات التجارية | HYPOTHESIS | مستنتج من prisma/schema.prisma:120-247 وsrc/lib/alerts.ts:276-697 |  |
| 60 | تحديد المسؤولية لا يسري مع الغش أو الإهمال الجسيم | VERIFIED_EXTERNAL | https://www.dlapiper.com/en-gb/insights/publications/2023/08/overview-of-the-new-saudi-arabia-civil-transactions-law | مصدر ثانوي؛ النص الأساسي لم يُقرأ |

## ما زال غير مُتحقق منه

- جدول معدلات النظام الجديد لـGOSI: قراءة الفريق الأحمر (9%/9% ثم +0.5% سنوياً حتى 11%) مقابل قراءة المتخصص (4.5%/4.5%) من الصفحة نفسها. UNVERIFIED — do not use as a factual basis قبل قراءة بشرية موثقة
- تاريخ سريان تعديلات نظام العمل (19 أو 25 فبراير 2025) وأرقام المواد؛ النص الأساسي في أم القرى لم يُقرأ
- مواصفة ملف مدد/WPS ومواعيده وغراماته، ونطاق الإلزام حسب حجم المنشأة
- وجود APIs لقوى ومقيم وأبشر أعمال عبر شراكة، وطريقة المصادقة الحالية لهذه المنصات (نفاذ أم غيره)
- موقع الاستضافة الفعلي للمستأجرين الثلاثة، وموقع النسخ الخارجي وSMTP وجهاز المشغّل
- مهلة الإخطار بالاختراق (72 ساعة) وشروط تعيين مسؤول حماية البيانات؛ مصادر ثانوية فقط
- انطباق لوائح الحوسبة السحابية لـCST على رديف
- إنفاذية تحديد المسؤولية في نظام المعاملات المدنية (مصدر ثانوي)
- ربط استقالة المرأة بعد الولادة أو الزواج بالمادة 87 (EXPERT_JUDGMENT يحتاج المستشار)
- معاملة مواطني دول الخليج في GOSI
- خوارزمية رقم التحقق لهوية المواطن والمقيم
- اكتمال baseline الترحيلات على القواعد الحية، وتدوير كلمات المرور المكشوفة، ووجود ملفات مستأجر داخل مجلد مستأجر آخر
- ضبط SMTP وDATA_ENCRYPTION_KEY وcron النسخ في الإنتاج، وقيمة max_connections ونظام التشغيل
- ما يدفعه كل مستأجر، ووجود عقود، والتسجيل الضريبي
- استهلاك الذاكرة الفعلي لكل مستأجر على Linux، وزمن البناء على الإنتاج
- نسب البريد وIBAN وصيغة الهوية لدى المستأجرين الحقيقيين (القياسات على بيانات اختبار فقط)
- صفحة الموقع الحية بعد تاريخ الجلب (النسخة المحفوظة فقط فُحصت)
- اختبارا الاعتماد الذاتي وقراءة الملفات عبر الأدوار: أجراهما الفريق الأحمر ولم يُعدهما المجلس، والكود المتحقق منه يدعمهما
- تقديرات حجم السوق (359–785 مليون دولار) من ملخصات تسويقية لشركات أبحاث

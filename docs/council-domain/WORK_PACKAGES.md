# حزم العمل القابلة للتنفيذ دون موافقة المالك

## WP-1 — سلامة السجل التأديبي والتدقيقي

**المجال:** الشؤون القانونية / الموارد البشرية · **تغيير مخطط:** لا

### المهام
- investigations/route.ts: حذف إضافة «[تم إرسال إشعار للموظف بموعد التحقيق]» من buildCreateNotes، ورفض sendNotification أو تجاهله.
- investigations/page.tsx: القيمة الافتراضية لـsendNotification تصبح false، واستبدال نص «سيتم إرسال تنبيه آلي» بخانة «تم إبلاغ الموظف يدوياً» تُحفظ في notes بصيغة محايدة تذكر الطريقة والتاريخ.
- investigations/route.ts: يُرفض COMPLETED_GUILTY إذا كانت findings فارغة. تُقفل findings وfinalDecision بعد COMPLETED_*: الانتقال إلى CLOSED لا يقبل إعادة كتابتهما، وأي نص إضافي يُلحق بملحق مؤرخ داخل notes. يُسجَّل الإغلاق في التدقيق بالفعل CLOSE، مع النص السابق عند أي ملحق.
- investigations/route.ts: خفض الحد الأعلى لـpenaltyDays إلى 5 أيام. رفع isSuspended تلقائياً عند COMPLETED_* أو CLOSED. تصحيح نص الإيقاف في الصفحة حتى لا يدّعي تغيير حالة الموظف.
- payroll-hub/route.ts: خفض الحد الأعلى لـdeductionDays في CREATE_DEDUCTION إلى 5 أيام. الخصم الذي يتجاوز أجر يوم واحد ولا يرتبط بتحقيق يُنشأ بحالة PENDING_AMOUNT_APPROVAL بدل DEDUCTED، حتى لـHR. عدّ occurrenceNumber يقتصر على مخالفات النوع نفسه خلال 180 يوماً قبل تاريخ المخالفة. تحذير في الرد إذا كان تاريخ المخالفة أقدم من 30 يوماً.
- penalties/page.tsx: حذف اقتراح «فصل من العمل» و«إنذار شفهي» الآليين من penaltyScale، وتحويل الجدول إلى «مرجع إرشادي، والمرجع لائحة المنشأة المعتمدة».
- settings/users/[id]/route.ts: تحويل DELETE إلى تعطيل (isActive=false) مع إبطال الجلسة وتسجيل ذلك في التدقيق. settings/users/page.tsx: زر «تعطيل» بدل «حذف».
- audit.ts: إضافة iban وibannumber وaccountnumber إلى REDACT_KEYS.

### الملفات
- src/app/api/legal/investigations/route.ts
- src/app/legal/investigations/page.tsx
- src/app/api/payroll-hub/route.ts
- src/app/penalties/page.tsx
- src/app/api/settings/users/[id]/route.ts
- src/app/settings/users/page.tsx
- src/lib/audit.ts
- src/lib/__tests__/c2-discipline.test.ts

### معايير القبول
- اختبار وحدة: buildCreateNotes({sendNotification:true}) لا يحتوي «تم إرسال إشعار».
- HTTP: UPDATE_STATUS إلى COMPLETED_GUILTY بلا findings يُرد عليه بـ400. وإعادة كتابة findings بعد COMPLETED_GUILTY يُرد عليها بـ409.
- HTTP: penaltyDays=6 يُرد عليه بـ400. وCREATE_DEDUCTION بـdeductionDays=6 يُرد عليه بـ400. وdeductionDays=3 بلا investigationId من hr-manager يُنشئ حالة PENDING_AMOUNT_APPROVAL.
- اختبار: مخالفتان من النوع نفسه بينهما 200 يوم تحصلان على occurrenceNumber=1 للثانية.
- HTTP: DELETE مستخدم له سطر تدقيق يعطّل الحساب، ويبقى AuditLog.userId غير null.
- اختبار: logAudit بتفاصيل {ibanNumber:'SA..'} تُخزَّن '[REDACTED]'.
- 559 اختباراً قائماً تبقى ناجحة، ولا ملف ترحيل جديد.

---

## WP-2 — حواجز الإنهاء والتصفية والالتزامات المفتوحة

**المجال:** الموارد البشرية / القانوني / اللوجستيات · **تغيير مخطط:** لا

### المهام
- settlements/route.ts: استبدال رفض employee.isTerminated (السطران 267 و275) بشرط «لا توجد تصفية END_OF_SERVICE غير مرفوضة للموظف».
- settlements/route.ts (superRefine وقراءة DB): PROBATION مسموح فقط إذا lastWorkingDate ≤ probationEndDate، أو ≤ joinDate + 180 يوماً عند غياب probationEndDate. ARTICLE_80 يتطلب article80Clause (1-9) في الطلب يُخزَّن في notes وتفاصيل التدقيق، ويتطلب وجود Investigation للموظف بحالة COMPLETED_GUILTY أو CLOSED بعد إدانة. غير ذلك يُرد بـ400 مع المبلغ الذي كان سيُسقط.
- settlements/route.ts (المعاينة): إضافة warnings للالتزامات المفتوحة: Asset ACTIVE، وTelecomSim مسندة، وVehicle.driverId، وإجازات APPROVED تبدأ بعد lastWorkingDate، وتأشيرات خروج وعودة غير ملغاة، وPaymentRequest معلقة مرتبطة بوثائق الموظف. قراءة فقط، ولا منع جديد على الخادم.
- employees/[id]/route.ts (PATCH terminate): رفض الإنهاء أثناء إجازة MATERNITY أو SICK سارية، إلا لـSUPER_ADMIN أو LEGAL_ADMIN مع reason مكتوب يُسجَّل في التدقيق. واشتراط reason نصي في كل الأحوال.
- employees/[id]/page.tsx: زر «إنهاء الخدمات» يوجّه إلى /settlements/new?employeeId=، مع إبقاء الإنهاء المباشر خياراً ثانوياً للأدوار المسموح لها مع سبب.
- leaves/[id]/action/route.ts (abscond): رفض قبل تجاوز تاريخ نهاية الإجازة، ورفض لنوعي MATERNITY وSICK. واشتراط reason وتأكيد صريح بإنذار كتابي مسجّل (acknowledgeWarningIssued=true).
- settlements/new/page.tsx: حذف عبارة «يتم الاحتساب تلقائياً حسب نظام العمل السعودي» واستبدالها بـ«أداة مساعدة، والقرار النظامي مسؤولية المنشأة». تصفير allowAssetsRetention عند تغيير النوع. عرض warnings الخادم. إخفاء المكافأة والصافي حتى يُختار السبب. حقل فقرة المادة 80.
- settlements/page.tsx: عرض «موعد الصرف النظامي» (lastWorkingDate + 7 أيام إذا أنهى صاحب العمل العقد، و+14 يوماً عند الاستقالة) مع شارة تأخر.

### الملفات
- src/app/api/settlements/route.ts
- src/app/settlements/new/page.tsx
- src/app/settlements/page.tsx
- src/app/api/employees/[id]/route.ts
- src/app/employees/[id]/page.tsx
- src/app/api/leaves/[id]/action/route.ts
- src/lib/__tests__/c2-termination.test.ts

### معايير القبول
- HTTP: موظف isTerminated بلا تصفية END_OF_SERVICE ينجح له POST /api/settlements (201). ومع وجود تصفية غير مرفوضة يُرد بـ409.
- HTTP: PROBATION لموظف joinDate=2021-01-01 وlastWorkingDate اليوم يُرد عليه بـ400.
- HTTP: ARTICLE_80 بلا تحقيق مُدان، أو بلا article80Clause، يُرد عليه بـ400 برسالة عربية تذكر المبلغ المُسقط.
- HTTP: ABSCOND على إجازة MATERNITY سارية يُرد عليه بـ409. وعلى إجازة سنوية لم تنتهِ يُرد بـ409.
- HTTP: PATCH terminate بلا reason يُرد عليه بـ400. وأثناء إجازة وضع من hr-manager يُرد بـ409.
- معاينة تصفية لموظف عنده Asset وTelecomSim ومركبة ترجع 3 تحذيرات على الأقل.
- لا يحتوي src/app/settlements/new/page.tsx على «حسب نظام العمل السعودي».
- 559 اختباراً قائماً تبقى ناجحة.

---

## WP-3 — حواجز جودة بيانات الموظف (الإنشاء والاستيراد)

**المجال:** البيانات / الموارد البشرية · **تغيير مخطط:** لا

### المهام
- employee.ts: استبدال zGenderOrDefault بـzRequiredGender (MALE أو FEMALE، والفارغ خطأ عربي)، وإضافة matchAllByName تُرجع كل المطابقات التامة.
- employees/route.ts (POST فقط): gender إلزامي. رفض birthDate في المستقبل، ورفض contractEndDate قبل joinDate، ورفض قسم لا يتبع الفرع المختار أو فرع لا يتبع الشركة. joinDate البعيد في المستقبل (أكثر من سنة) تحذير فقط، حفاظاً على بيانات الاختبار.
- employees/import/route.ts: صف جديد بلا جنس يصبح خطأ صف، وصف تحديث بلا جنس يحتفظ بالقيمة الحالية مع تحذير. تكرار رقم الهوية داخل الملف نفسه خطأ للصفين. أي تاريخ سنته أقل من 1900 خطأ برسالة «يبدو هجرياً، حوّله إلى ميلادي». تطابق تام لاسم الشركة أو الفرع مع أكثر من سجل خطأ يطلب الرقم أو الاسم الفريد.
- employee-shared.ts (employeeDataWarnings): تحذير لغير السعودي بلا contractEndDate (المادة 37)، وتحذير لآيبان يشاركه موظف آخر إن أمكن تمريره.
- EmployeeForm.tsx: gender بلا قيمة افتراضية (خيار «اختر»). تصحيح عنوان FREELANCE إلى «عمل حر/مستقل». تغيير نص خانة التأمينات إلى «تجاوز يدوي لحصة الموظف (يُحسب آلياً إذا لم تُفعَّل)».
- employees/import/page.tsx: تحديث تعليمات الاستيراد وحذف «إذا تُرك فارغاً يعتبر ذكر».

### الملفات
- src/lib/employee.ts
- src/lib/employee-shared.ts
- src/app/api/employees/route.ts
- src/app/api/employees/import/route.ts
- src/app/employees/_components/EmployeeForm.tsx
- src/app/employees/import/page.tsx
- src/lib/__tests__/c2-master-data.test.ts

### معايير القبول
- HTTP: POST /api/employees بلا gender يُرد عليه بـ400 برسالة عربية. وbirthDate غداً يُرد عليه بـ400. وcontractEndDate قبل joinDate يُرد عليه بـ400.
- استيراد تجريبي (validateOnly): صف جديد بلا جنس يظهر خطأً. وتاريخ «1448/05/10» يظهر خطأً بعبارة «هجري». وهوية مكررة في صفين تعطي خطأين. واسم شركة يطابق 3 شركات يظهر خطأً.
- تصدير الموظفين ثم إعادة استيرادهم تجريبياً على قاعدة الاختبار بلا أخطاء جديدة للصفوف القائمة، والتحذيرات مسموح بها.
- إذا فشل اختبار قائم بسبب قاعدة القسم والفرع، تتحول القاعدة إلى تحذير ويُسجَّل ذلك في وصف الـPR.
- 559 اختباراً قائماً تبقى ناجحة.

---

## WP-4 — تصحيح بوابة الموظف وتحديث البيانات ومسار المدير

**المجال:** تجربة المستخدم / الموارد البشرية · **تغيير مخطط:** لا

### المهام
- hr-workflows.ts (فرع DATA_UPDATE_PREFIX): حذف التعبيرين النمطيين الاحتياطيين ([0-9]{10} والآيبان الحر). يُطبَّق الجوال فقط من سطر موسوم «الجوال:» بصيغة ^05\d{8}$، والبريد فقط من سطر موسوم «البريد:». لا يُطبَّق الآيبان آلياً أبداً، بل تتضمن الرسالة «تغيير الآيبان يتطلب تعديلاً يدوياً في ملف الموظف بعد التحقق من شهادة الآيبان». الرسالة تذكر الحقول المطبقة فعلاً، أو «لم يُطبَّق أي حقل تلقائياً».
- hr-workflows.ts: طلبات GENERAL_REQUEST_PREFIX وDATA_UPDATE_PREFIX لا تشترط موافقة المدير المباشر، ويعتمدها HR مباشرة.
- dept-manager/route.ts وattendance-corrections/page.tsx (عرض المدير): استبعاد الطلبات التي تبدأ بـ«[طلب:» أو بادئة تحديث البيانات من طابور المدير.
- portal/page.tsx: نموذج «تحديث بياناتي» بحقول منظمة (الجوال، والبريد، والآيبان مع رفع شهادة) تُسلسَل إلى أسطر موسومة. نموذج الإجازة يعرض أنواع LEAVE_TYPES النظامية من src/lib/leave.ts (طارئة، ووضع، وأبوة، ووفاة مع القرابة، وزواج، وحج) مع eventDate. يُعرض الرصيد بصيغة «متاح · قيد الاعتماد». تُعرض مرحلة كل طلب وسبب الرفض.
- api/portal/route.ts: إرجاع stage (بانتظار المدير، بانتظار الموارد البشرية، معتمد، مرفوض) وmanagerComment وhrComment لكل طلب، ورصيد pending.
- api/portal/correction/route.ts: قبول correctionType (LATE أو EARLY_LEAVE أو ABSENT أو GENERAL) من البوابة.
- dept-manager/page.tsx: الرفض يطلب سبباً عبر promptDialog ويرسل reason، وأزرار الاعتماد والرفض بنص وارتفاع 44px ومسافة بينها.

### الملفات
- src/lib/hr-workflows.ts
- src/app/portal/page.tsx
- src/app/api/portal/route.ts
- src/app/api/portal/correction/route.ts
- src/app/api/dept-manager/route.ts
- src/app/dept-manager/page.tsx
- src/app/attendance-corrections/page.tsx
- src/lib/__tests__/c2-portal.test.ts

### معايير القبول
- اختبار وحدة: اعتماد طلب نصه «الآيبان: SA4420000001234567891234» لا يغيّر mobileNumber ولا ibanNumber، وupdatedFields=[].
- اختبار وحدة: «الجوال: 0551234567» يحدّث الجوال فقط، والرسالة تذكر «الجوال».
- HTTP: طلب «[طلب: شهادة راتب]» لا يظهر في GET /api/dept-manager، ويعتمده hr-manager مباشرة دون 409.
- HTTP: رفض المدير بلا reason يُرد عليه بـ400، والسبب يظهر في /api/portal للموظف.
- لقطة جوال بعرض 390px لنموذج الإجازة تعرض أنواع الإجازات النظامية.
- 559 اختباراً قائماً تبقى ناجحة.

---

## WP-5 — التقييم بلا درجات مولدة، والتوظيف بلا تسريب للملاحظات

**المجال:** الموارد البشرية (المواهب) · **تغيير مخطط:** لا

### المهام
- evaluations/route.ts: إزالة view=smart-suggest (يُرد 410 برسالة عربية) وحذف استعلام الإجازات المرتبط بها (268-310).
- scoring.ts: حذف suggestScores وعقوبات الإجازات والأقدمية، مع إبقاء حساب النتيجة والتقدير كما هو.
- evaluations/[id]/page.tsx: حذف قسم «المساعد الذكي» واقتراح درجات الانضباط، وإضافة رابط «سجل حضور الموظف» للقراءة فقط.
- applications/route.ts: بريد العرض يُبنى من حقل offerText مطلوب عند OFFERED، ولا يُستخدم notes احتياطياً. ملاحظات الانتقال تُلحق بالملاحظات السابقة بسطر مؤرخ فيه اسم الكاتب، ولا تحل محلها، فيبقى ما كتبه المرشح (الراتب المتوقع).
- applications/page.tsx: نافذة العرض لا تُملأ مسبقاً من notes، وفيها حقل منفصل لنص العرض مع معاينة قبل الإرسال. بطاقة المرشح تعرض أول سطر من طلبه (الراتب المتوقع).

### الملفات
- src/app/api/evaluations/route.ts
- src/app/api/evaluations/scoring.ts
- src/app/evaluations/[id]/page.tsx
- src/app/api/applications/route.ts
- src/app/applications/page.tsx
- src/lib/__tests__/c2-talent.test.ts

### معايير القبول
- HTTP: GET /api/evaluations?view=smart-suggest يُرد عليه بـ410، ولا تظهر كلمة «ذكي» في صفحة التقييم.
- اختبارات scoring القائمة للنتيجة والتقدير تبقى ناجحة.
- HTTP: نقل مرشح إلى INTERVIEW بملاحظة ثم إلى OFFERED بلا offerText يُرد عليه بـ400. ومع offerText يحتوي البريد المُعَد offerText فقط، لا الملاحظة الداخلية.
- بعد نقلتين للمرحلة يبقى نص «الراتب المتوقع» الأصلي موجوداً في notes.
- 559 اختباراً قائماً تبقى ناجحة، ويُحدَّث أي اختبار قائم لـsmart-suggest ليتوقع 410 مع ذكر ذلك في الـPR.

---

## WP-6 — أرقام صادقة في اللوحة وتقرير المالك وجاهزية المسير

**المجال:** تحليل البيانات / الرواتب · **تغيير مخطط:** لا

### المهام
- dashboard/route.ts: latestPayroll يصبح أحدث شهر بحالة APPROVED أو PAID لا يتجاوز الشهر الحالي بتوقيت الرياض، مع تسمية الشهر بالعربية. استبعاد category LEGAL من adminAlerts في totalAlerts. مقام معدل الحضور يستبعد من هم في إجازة معتمدة اليوم ومن لم يباشر بعد.
- payroll-hub/summary/route.ts: الشهر الافتراضي هو الشهر الحالي، أو أقرب شهر ≤ الحالي فيه أسطر، لا أكبر شهر مخزن. لا يُمس zYear.
- owner-reports/route.ts: إضافة مجاميع فعلية من أسطر Payroll بحالة APPROVED أو PAID للفترة (الإجمالي، وgosiEmployer، والإضافي، والمكافآت)، مع وسم «ناقص» للأشهر السابقة للترحيل 5 إذا كان gosiEmployer=0 لكل الأسطر. حذف caseNumber=subject وcourtName=lawFirmName، وإرجاع subject وlawFirmName بأسمائها. latest GOSI بمنطق الشهر المرجعي نفسه.
- owner-reports/page.tsx: فصل «فعلي» (الأشهر المنقضية) عن «تقديري» (المستقبل، مع استبعاد من لم يباشر). «N بند بلا تكلفة مسجلة» بدل 0. توزيع الإيجار حسب rentPaymentType وrentPaymentCount. عناوين أعمدة «الموضوع» و«مكتب المحاماة»، وترجمة REFERRED وCLOSED. تطبيق الفترة على جداول الطباعة. إزالة الخلفية الخارجية transparenttextures.com. تمييز المنتهي عن القريب.
- unified-alerts/page.tsx: عدّادان منفصلان، «مخاطر انتهاء الوثائق» و«بانتظار إجراء».
- page.tsx (اللوحة): حذف أسهم «الاتجاه» الثابتة، وتوحيد صيغة المال عبر formatMoney.
- payroll-core.ts وpayroll.ts (بلا تغيير في أي رقم): عند التوليد تُضاف رموز إلى reviewNote ويُضبط needsReview لكل من: CAP_PENALTY (غرامات الشهر أكثر من أجر 5 أيام)، وCAP_LOAN (القسط أكثر من 10%)، وCAP_HALF (الحسومات أكثر من 50% من المستحق بعد الغياب)، وNET_ZERO (الصافي ≤ 0)، وIBAN_MISSING أو IBAN_INVALID، وCASH، وBASIC_ZERO. وتُصحَّح علامة DEDUCTIONS_EXCEED لتشمل حالة التساوي.
- payrolls/page.tsx: فلتر «يحتاج مراجعة» حسب الرمز، وعرض عدد كل رمز في تأكيد الاعتماد. حذف money2 واستخدام lib/money.ts:formatMoney.

### الملفات
- src/app/api/dashboard/route.ts
- src/app/page.tsx
- src/app/api/payroll-hub/summary/route.ts
- src/app/api/owner-reports/route.ts
- src/app/owner-reports/page.tsx
- src/app/unified-alerts/page.tsx
- src/lib/payroll-core.ts
- src/lib/payroll.ts
- src/app/payrolls/page.tsx
- src/lib/__tests__/c2-reporting.test.ts

### معايير القبول
- HTTP على بيانات الاختبار: /api/dashboard لا يُرجع latestPayrollMonth بسنة أكبر من الحالية، وtotalAlerts يساوي hr + admin(غير LEGAL) + logistics + legal.
- اختبار وحدة: computePayrollLine للسيناريو (5,000، جزاءات 2,700، قسط 3,000) يُرجع صافياً مطابقاً للسلوك الحالي، وneedsReview=true، وreviewNote يحتوي CAP_PENALTY وNET_ZERO.
- اختبار وحدة: سطر بلا آيبان يحصل على IBAN_MISSING. اختبارات لقطات المسير القائمة (x-X-PAYROLL-breakdown) تبقى ناجحة دون تغيير الأرقام.
- /api/owner-reports لا يحتوي lawsuits[].caseNumber مساوياً لـsubject.
- تقرير المالك لفترة ماضية يعرض الرقم «الفعلي» من الأسطر المخزنة، مع وسم «تقديري» على المستقبل فقط.
- 559 اختباراً قائماً تبقى ناجحة.

---

## WP-7 — التنبيهات والتجديدات ووثائق الفروع والسجل التجاري

**المجال:** اللوجستيات / الشؤون القانونية / الامتثال · **تغيير مخطط:** لا

### المهام
- alerts.ts: إدخال عقود النفايات والسلامة والكاميرات في loadAdminAlertSources وbuildAdminAlerts بعتباتها الموجودة (123-125). تغيير رسالة السجل التجاري إلى «موعد التأكيد السنوي للسجل التجاري» وحذف «انتهى» و«ينتهي». حذف «مُحال للتنفيذ» الآلي، والنص حسب صفة الشركة: «مستحق لنا غير مسدد» أو «مستحق علينا، خطر تنفيذ»، وتسمية السند المتأخر «مستحق غير مسدد» بدل «انتهت».
- scripts/jobs.mjs وx-ops-jobs.test.ts: إضافة الفئات الثلاث إلى THRESHOLDS وCATEGORY_LABELS في الملخص اليومي، وتحديث الاختبار.
- renewals/route.ts: إضافة تواريخ وثائق المركبة الأربع الباقية (الفحص الدوري، وكرت التشغيل، وبطاقة السائق، والتفويض) من حقولها الموجودة. فصل ANNUAL_LEAVE_DUE وPROBATION في category مستقلة («استحقاقات الموظف»).
- renewals/action/route.ts: قبول أنواع المركبة الأربعة. رفض newExpDate ≤ اليوم ما لم يُرسل confirmPastDate=true. حذف LEGAL_CONTRACT وAGENCY من ENTITY_DATES، ويُرد عليهما بـ403 مع رسالة «يُدار من الشؤون القانونية». عنوان PaymentRequest يصبح: الاسم العربي للوثيقة، ثم اسم الموظف أو الفرع أو المركبة، ثم الرقم الوظيفي أو اسم الشركة.
- renewals/page.tsx: حقل «تاريخ الانتهاء الجديد» قابل للتعديل ومُعبأ بالاقتراح. تبويب مستقل لـ«استحقاقات الموظف». الوكالات والعقود القانونية للقراءة فقط مع رابط.
- branches/[branchId]/page.tsx: عرض مرفقات عقدي السلامة والكاميرات (بدل url={null})، وترجمة نوع الدفع، وشارة انتهاء لكل عقد.
- BranchForm.tsx: حقلا تكلفة رخصة البلدية وتكلفة الدفاع المدني.
- branches/page.tsx: عدّاد «تنتهي قريباً» يشمل كل وثائق الفرع حسب classifyExpiry والعتبات المضبوطة.
- legal-alerts/page.tsx: تسميات السند الجديدة وصفة الشركة.
- companies (نموذج الشركة وعرضها): تسمية حقل commercialRegExp «موعد التأكيد السنوي».

### الملفات
- src/lib/alerts.ts
- scripts/jobs.mjs
- src/lib/__tests__/x-ops-jobs.test.ts
- src/app/api/renewals/route.ts
- src/app/api/renewals/action/route.ts
- src/app/renewals/page.tsx
- src/app/branches/[branchId]/page.tsx
- src/app/branches/_components/BranchForm.tsx
- src/app/branches/page.tsx
- src/app/legal-alerts/page.tsx
- src/app/companies/
- src/lib/__tests__/c2-alerts.test.ts

### معايير القبول
- HTTP: فرع عقد سلامته منتهٍ يظهر في /api/admin/alerts، ومركبة فحصها الدوري منتهٍ تظهر في /api/renewals.
- grep: لا يوجد «انتهى السجل التجاري» ولا «مُحال للتنفيذ» في src ولا في scripts.
- HTTP: renew بتاريخ ماضٍ بلا confirmPastDate يُرد عليه بـ400. وPOST action لنوع AGENCY من gov-relations يُرد عليه بـ403.
- HTTP: عنوان طلب سداد تجديد الإقامة يحتوي اسم الموظف ولا يحتوي «(IQAMA)».
- x-ops-jobs.test.ts المحدَّث ناجح، و559 اختباراً قائماً تبقى ناجحة.

---

## WP-8 — بوابات الوصول في العهد والمركبات والمطالبات والطلبات الواردة

**المجال:** اللوجستيات / تجربة المستخدم · **تغيير مخطط:** لا

### المهام
- services/_lib.ts: ensureRefsExist بخيار activeOnly يرفض الموظف isTerminated بـ409 عند إسناد أصل أو شريحة أو مركبة. تطبيقه في assets و[id] (assign/transfer) وservices/telecom وvehicles POST وPUT.
- assets/route.ts وservices/telecom/route.ts: إضافة isTerminated إلى select الحائز، وفلتر ?heldByTerminated=1. assets/page.tsx: شارة «منتهي الخدمة» والفلتر.
- assets/_lib.ts وassets/[id]/route.ts: damage يتطلب reason (5 أحرف على الأقل)، ويُسجَّل في التدقيق مع الحائز والسبب. للشريحة تتغير الرسالة إلى «تم فصل الشريحة عن الموظف؛ راجع إلغاء الخط لدى المشغل».
- vehicles/_lib.ts وvehicles/route.ts: دالة normalizePlate (إزالة المسافات، وتوحيد أ إ آ إلى ا، وربط الحروف اللاتينية بما يقابلها في اللوحات السعودية، وتوحيد الأرقام). فحص التكرار عند الإنشاء وعند تغيير اللوحة يقارن القيم الموحدة. التحقق من سنة الموديل (4 أرقام معقولة).
- claims/_lib.ts: refine يجعل مجموع نسبتي الخطأ ≤ 100.
- incoming-requests/route.ts: PURCHASING_AGENT يقرأ ويعتمد فقط طلبات ASSET_REQUEST في مرحلة PENDING_PURCHASING، ولا يرى FINANCE_TYPES ولا غيرها. الإقفال يقبل existingAssetId اختيارياً لأصل VACANT يُسند بدل إنشاء أصل جديد.
- lib/menu.ts: إضافة PURCHASING_AGENT لصفحة /incoming-requests فقط، دون أي تغيير آخر في القائمة.
- incoming-requests/page.tsx: تعطيل «اعتماد» عندما يكون الطلب بانتظار المدير، مع سبب ظاهر. الرفض يطلب سبباً عبر promptDialog ويرسل reason. إخفاء الرصيد السنوي في بطاقات الإجازات غير السنوية.

### الملفات
- src/app/api/services/_lib.ts
- src/app/api/services/telecom/route.ts
- src/app/api/assets/route.ts
- src/app/api/assets/_lib.ts
- src/app/api/assets/[id]/route.ts
- src/app/assets/page.tsx
- src/app/api/vehicles/_lib.ts
- src/app/api/vehicles/route.ts
- src/app/api/vehicles/[id]/route.ts
- src/app/api/claims/_lib.ts
- src/app/api/incoming-requests/route.ts
- src/app/incoming-requests/page.tsx
- src/lib/menu.ts
- src/lib/__tests__/c2-logistics-access.test.ts

### معايير القبول
- HTTP: PATCH assign لأصل على موظف isTerminated يُرد عليه بـ409، وكذلك POST vehicle بـdriverId منتهٍ.
- HTTP: damage بلا reason يُرد عليه بـ400.
- HTTP: مركبة بلوحة 'LF أ ب ج1234' بعد وجود 'LF ا ب ج 1234' يُرد عليها بـ409.
- HTTP: مطالبة بنسبتي 75 و75 يُرد عليها بـ400.
- HTTP: purchasing-agent يطلب GET /api/incoming-requests فيحصل على 200 بعناصر ASSET_REQUEST فقط، بلا loans ولا deductions. وAPPROVE في مرحلة PENDING_PURCHASING يُرد عليه بـ200. وAPPROVE على loan يُرد عليه بـ403.
- واجهة: زر الاعتماد معطّل على بطاقة «بانتظار موافقة المدير المباشر»، والرفض يطلب سبباً.
- r3-shell-menu.test.ts و559 اختباراً قائماً تبقى ناجحة.

---


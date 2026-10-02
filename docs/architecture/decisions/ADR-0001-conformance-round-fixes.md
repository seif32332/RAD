# ADR-0001: تصحيحات الدستور من جولة المطابقة الأولى

- **التاريخ:** 2026-09-27
- **الحالة:** ACCEPTED (بقرار المستخدم في المحادثة: «اعتمد ADR-0001 كله»)
- **المصدر:** جولة مجلس PeopleOS RUN-106. ثلاثة مهندسي أنظمة (opus) قارنوا تصاميم PAY وLEV وLCY وOFF وONB وWFE وREQ بالدستور، ووجدوا فيه تناقضات داخلية وفجوات.
- **قرارات المستخدم المرتبطة:**
  - DEC-PO-118: اعتماد P-7.
  - DEC-PO-119: سجل الحالة هو الحقيقة.
  - DEC-PO-120: فحوص السلامة ثابتة.
  - DEC-PO-121: مشغّل مهام من نفس الكود.

## التغييرات

| # | القاعدة القديمة | القاعدة الجديدة | السبب | المواضع |
|---|---|---|---|---|
| 1 | مثال اعتماد الإجازة يكتب `DayRecord` داخل معاملة الإجازة | معاملة الإجازة تكتب Leave وLeaveLedgerEntry والتدقيق والحدث فقط. و`time` يكتب `DayRecord` باستهلاك `leave.request.approved` | تناقض مع ARCH-002 (الإجازة لا تكتب جداول الحضور) | LIFECYCLE_MODEL §2.1 |
| 2 | "الكاتب الوحيد: `money.gateway`" في بعض الصفوف | **البوابة حارس، والكاتب هو الوحدة المالكة.** العملية المالية تُسجَّل في البوابة، والبوابة تتحقق من الفاعل والقواعد ومفتاح العملية، ثم تستدعي دالة انتقال الوحدة المالكة، وهي وحدها تكتب | تناقض بين SOURCE_OF_TRUTH وDOMAIN_BOUNDARIES، وتعارض مع ARCH-002 | SOURCE_OF_TRUTH، ARCH-004 |
| 3 | ContractPeriod ملك "contracts" في موضع، وlifecycle في موضع آخر | ملك **lifecycle** (`lifecycle.applyContract`)، ويشمل التجربة ونتيجتها ونهايتها | تناقض داخلي | DOMAIN_MODEL §1.2، SOURCE_OF_TRUTH |
| 4 | lifecycle "يستهلك" `offboarding.exit.approved` | **offboarding يستدعي `lifecycle.transitionEmploymentState` مباشرة** (نداء لأسفل) في نفس معاملة ملف الخروج. وonboarding يستدعي `lifecycle.hire`. ولا تستهلك lifecycle أحداث وحدات فوقها لتغيير الحالة | تناقض مع اتجاه الاعتماد | DOMAIN_BOUNDARIES §5.3، §5.5 |
| 5 | ترتيب الطبقات يضع onboarding وrecruitment وassets بجانب lifecycle | ترتيب صريح من الأسفل: platform/iam، ثم rules/calendar، ثم people/org، ثم lifecycle، ثم compensation، ثم decisions، ثم leave، ثم time، ثم payroll/finance، ثم assets/benefits، ثم onboarding، ثم recruitment، ثم offboarding، ثم requests/performance/learning/workforce/documents/gov، ثم reporting. والنواة workflow فوق platform/iam فقط | الوضوح، ونداءات حقيقية (recruitment ← onboarding؛ offboarding ← assets) | DOMAIN_BOUNDARIES §5.3 |
| 6 | قائمة أحداث ناقصة | أحداث جديدة: `employment.exitAmended`، `employment.voided`، `employment.lastWorkingDayChanged`، `contract.periodOpened`، `compensation.bankIdentityOpened`، `financialChange.decided`، `payroll.line.approved/reversed`، `money.guard.blocked`، `exit.withdrawn`، `workflow.task.notRequired`، `workflow.instance.returned/blocked/effectFailed/awaitingRequirement`، `workflow.delegation.created/revoked`، `requests.*.decided/assigned`، `assets.custody.changed`، `onboarding.request.approved`. و**leave تستهلك** `payroll.line.approved/reversed` و`payroll.adjustment.*` لإسقاط `settledByMonth` | مطلوبة لتعديلات PAY وLEV وWFE وOFF | DOMAIN_BOUNDARIES §5.5 |
| 7 | لا فئات متوقعة لحالات مشروعة | INV-WF-01: RETURNED (المسؤول هو الطالب)، وPAUSED بسبب مسمى ووحدة مالكة، وAWAITING_REQUIREMENT أقل من يوم ← EXPECTED. INV-LEV-02: حالة `LeaveAdjustmentCase` مفتوحة مع تنبيه HR (مسار DEC-PO-079) ← EXPLAINED وغير موقِفة. INV-EFF-02: `PENDING_INITIAL_COMPENSATION` أثناء انتظار أول تغيير مالي ← EXPECTED | منع إنذارات كاذبة على حالات صممها المالك | ARCHITECTURE_INVARIANTS §4.2 |
| 8 | لا مالك للهوية البنكية | `BankIdentityPeriod` حقيقة مؤرخة تملكها **compensation**: الآيبان مشفراً، والبصمة، وآخر 4 أرقام، والبنك، وطريقة الدفع. وvalidFrom = تاريخ التطبيق، **ولا تُؤرَّخ رجعياً أبداً**. وأعمدة البنك على Employee إسقاط | فجوة | DOMAIN_MODEL، SOURCE_OF_TRUTH، DOMAIN_BOUNDARIES §5.2 |
| 9 | القاعدة 4 للفترات: التصحيح استبدال فقط | **استثناء واحد مسمى:** نهاية فترة التوظيف (`EmploymentPeriod.validTo`) تُعدَّل في مكانها، بما في ذلك إعادتها NULL عند إعادة الفتح (DEC-PO-043)، بدالة lifecycle وحدها، وكل تعديل مسجل في `EmploymentStateChange` الذي لا يُعدَّل ولا يُحذف. ومعرّف الفترة ثابت. وأي تصحيح لبدايتها (مثل تصحيح تاريخ المباشرة) = استبدال | قرار مالك قائم (DEC-PO-043) مع الحفاظ على التاريخ | DOMAIN_MODEL §1.3 |
| 10 | حالة الموظف: الحقل مصدر الحقيقة (DEC-PO-029) | `EmploymentStateChange` (سجل لا يُعدَّل) هو الحقيقة، والحقل إسقاط تكتبه **نفس الدالة الوحيدة في نفس المعاملة** (DEC-PO-119). الإسقاط = حالة `to` لآخر تغيير غير مستبدل **بترتيب التسجيل**، ويشمل ذلك تعييناً بتاريخ نفاذ مستقبلي | قرار المستخدم | DOMAIN_MODEL، SOURCE_OF_TRUTH، INV-LCY-01 |
| 11 | "الشركة ترفع الخطورة ولا تخفض BLOCKING إلا بتنبيه" | **ثوابت السلامة ثابتة ولا تُعطَّل ولا تُخفَّض** (DEC-PO-120): INV-EFF-01، INV-ORG-01، INV-PAY-01..05، INV-GOSI-01، INV-ATT-02، INV-LEV-01، INV-EOS-01، INV-DOC-01، INV-SCOPE-01. الاختلاف فيها يُشرح (EXPLAINED بشخص ثانٍ) أو يُتنازل عنه (WAIVED بشخصين وتنبيه المالك)، **ولا تستطيع الشركة تغيير هذه الشروط**. بقية الثوابت تبقى خطورتها افتراضاً قابلاً للتعديل (DEC-PO-116) | قرار المستخدم | ARCHITECTURE_INVARIANTS §4.3 |
| 12 | المهام "يُقترح" بناؤها من TypeScript | **إلزامي** (DEC-PO-121): حزمة P1-FND-JOBS تبني المهام من نفس كود الوحدات. يُحذف كل منطق عمل مكرر في `scripts/` واختبارات التطابق التي كانت تحرسه. ولا مسار HTTP داخلي لإعادة الفحص | قرار المستخدم | LIFECYCLE_MODEL §2.5، ARCH-008 |
| 13 | الـoutbox بلا صلاحية | `NotificationOutbox.expiresAt`، والمستهلك يعيد التحقق من صلاحية الإشعار قبل الإرسال (مثال: المهمة ما زالت مفتوحة) | تنفيذ INV-EVT-01 | DOMAIN_MODEL، ARCHITECTURE_INVARIANTS |
| 14 | عقد النطاق بلا صفوف للموافقات والعهد والتوظيف | `WorkflowInstance`/`Task` بـcompanyId (شركة المستفيد عند البدء)، ولا مستفيدين من شركتين إلا بنوع يعلن `crossCompany`. والتفويض بـ`companyIds[]` ضمن نطاق الطرفين. و`Asset.companyId` إلزامي، والحجز داخل الشركة. و`JobRequest.companyId` و`OnboardingRequest.companyId` إلزاميان | فجوات | DOMAIN_BOUNDARIES §5.4.3 |
| 15 | حالات ملف الخروج في الدستور تخالف تصميم OFF | الدستور يحيل حالات ExitCase إلى OFF (مخزنة: OPEN/CLOSED/CANCELLED، والمراحل مشتقة). وINV-OFF-01 يُغلق بوصول ملغى **أو** داخل نافذة المستندات فقط (DEC-PO-057) | تعارض تسمية، وقرار مالك | LIFECYCLE_MODEL §2.3، INV-OFF-01 |
| 16 | "المولّد ≠ المعتمد ≠ الصارف" للمسير | التوليد عملية نظام (SYSTEM) يطلقها شخص مسجَّل، ولا يغيّر التوليد أي رقم معتمد. وفصل الصلاحيات حسب قرارات PAY (DEC-PO-005/014/015/028): المعتمد ≠ المصدِّر ≠ مؤكد الدفع، والمستفيد لا يعتمد سطره | مطابقة قرارات قائمة | LIFECYCLE_MODEL §2.3 |
| 17 | إجراءات الإسقاط غير محددة | `leaveAccrualStartDate` إسقاط من دفتر الإجازة، و`probationEndDate` إسقاط من ContractPeriod. ولا يُضاف `probationOutcome` على Employee | منع نسخ ثانية | SOURCE_OF_TRUTH |

## الأثر

- التعديلات المسماة في `.claude/councils/people-os/outputs/workflows/arc-conformance.md` (WF-ARC-001) تُبنى على هذا الـADR.
- الخطة الرئيسية تضيف P1-FND-JOBS.
- لا أثر على الكود الحالي (لا تنفيذ بعد).

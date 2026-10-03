# 3. مصدر الحقيقة (Source of Truth)

لكل معلومة في رديف صف واحد في هذا الجدول. إضافة معلومة جديدة إلى النظام تبدأ بإضافة صفها هنا.

**المصطلحات:**
- **الحقيقة**: الجدول الذي يُرجَع إليه عند الخلاف.
- **الكاتب الوحيد**: دالة الانتقال في الوحدة المالكة، وتفرضها اختبارات ARCH. **بوابة المال حارس لا كاتب** (ADR-0001 #2): العملية المالية مسجلة في `money.gateway`، التي تتحقق من الفاعل وقواعد PAY ومفتاح العملية، ثم تستدعي دالة الوحدة المالكة.
- **الإسقاطات**: نسخ للقراءة يكتبها المُسقِط فقط، ويطابقها ثابت.
- **القراءة الصحيحة**: كيف يقرأ من يحتاج المعلومة.

## 3.1 الجدول

| المعلومة | الحقيقة | الكاتب الوحيد | الإسقاطات | القراءة الصحيحة | الحالي (تدقيق) | الحزمة |
|---|---|---|---|---|---|---|
| هل الموظف في الخدمة؟ ومنذ متى؟ | `EmploymentStateChange` (الحقيقة، DEC-PO-119) + `EmploymentPeriod` | `lifecycle.transitionEmploymentState` | `Employee.employmentState`، `isTerminated`، `terminationDate` | `effectiveContext(e,d).employment/state`، أو قارئات LCY الموحدة (BR-LCY-010) | مكرر: `isTerminated` + `employmentStatus`، والإنهاء المباشر لا يكتب الثاني (EV-12020) | P1-LCY |
| في إجازة الآن؟ | محسوب من `Leave` المعتمدة + التقويم | — (محسوب) | لا يُخزَّن | `leave.isOnLeave(e,d)` | يُخزَّن ON_LEAVE ولا يُمسح (EV-3016) | P0-06، P1-LCY |
| الراتب الأساسي والبدلات الثابتة وأساس GOSI | `CompensationPeriod` | `compensation.applyDecision` (من ChangeOrder أو FinancialChange أو التهيئة) | `Employee.basicSalary`، `housingAllowance`… (للعرض والبحث فقط) | الحسابات المالية: `effectiveContext(e,d).compensation` فقط. ولا حساب مالي يقرأ `Employee.basicSalary` (ARCH-011) | 7 أماكن، والتعديل المباشر بلا تاريخ (EV-12025، EV-1901) | P1-FND، P1-PAY-B |
| طلب تغيير مالي أو آيبان | `EmployeeFinancialChange` (REQUEST، بتاريخ نفاذ) | `compensation.decide/apply` (عملية مسجلة في البوابة) | — | لا تُقرأ منه أرقام؛ المطبَّق يصبح فترة أو هوية بنكية | — | P1-PAY-B |
| الشركة النظامية والفعلية والفرع والقسم والمدير والمنصب ومركز التكلفة ونمط العمل | `AssignmentPeriod` | `org.applyAssignment` (من قرار نقل أو ترقية أو تهيئة) | `Employee.legalCompanyId`، `branchId`، `departmentId`، `directManagerId`، `workSchedule` | `effectiveContext(e,d).assignment` | مساران للنقل لا يحدّثان الشركة، والجدول بمطابقة اسم (EV-1038، EV-12016، EV-12018) | P3-ORG |
| نظام GOSI والمنشأة | `GosiRegistrationPeriod` | `payroll.registerGosi` | `Employee.gosiRegime` | `effectiveContext(e,d).gosi` | عمود على الموظف | P3-PAY |
| نسب GOSI | `GosiRate` (مؤرخ) | ترحيل أو إعداد إداري | — | `gosi.rateAt(regime, nationalityClass, d)` | صحيح (EV-5006) | — |
| القيم القانونية (أيام الإجازة، الإنذار، التجربة، سقف الإضافي، الرسوم) | `RuleParameter` (مؤرخ، بمصدر) + تجاوز الشركة | إعداد إداري مدقق | — | `rules.valueAt(key, companyId, d)`. لا ثابت قانوني في الكود (ARCH-007) | مكرر: ثوابت في الكود لا تقرأ السجل (EV-5045) | P1-RULE |
| العقد (النوع، النهاية، التجربة ونتيجتها، التجديدات) | `ContractPeriod` | `lifecycle.applyContract` (تهيئة، ملحق عقد، تجديد، قرار التجربة) | `Employee.contractEndDate`، `probationEndDate` (ولا يُضاف `probationOutcome` على Employee) | `effectiveContext(e,d).contract` | ثلاثة كتّاب (EV-12004) | P3-ORG |
| نمط العمل، والعطل، ورمضان | `WorkPattern`، `HolidayCalendar` | `time.calendar` (إعداد) | — | `time.dayType(e,d)` | غير موجود، و`workDays` لا يُقرأ (EV-3006، EV-3007) | P1-CAL |
| حالة اليوم (حاضر، غائب، إجازة، عطلة، مهمة…) | `DayRecord` | `time.closeDay` / `time.correctDay` | لوحات الحضور | `time.dayRecords(e, period)` | لا غياب يُسجل (EV-3009) | P3-ATT |
| البصمات | `AttendancePunch` | `time.punch` (ذاتي أو استيراد) | `Attendance` اليومي (إسقاط) | عبر `DayRecord` | موجود | P3-ATT |
| ساعات العمل الإضافي | `DayRecord` (من البصمات) + قرار اعتماد | `time.approveOvertime` | — | مدخلات المسير عبر البوابة | يدوي بلا ربط بالبصمات (EV-3024) | P3-ATT |
| رصيد الإجازة | `LeaveLedgerEntry` (بسلالة التوظيف `employmentLineageId`، ADR-0002 #17) | `leave.post` (عبر الانتقالات والتسويات والمهمة الشهرية) | رصيد معروض، و`leaveAccrualStartDate` | `leave.balance(e, d, lineage)` = مجموع دفتر السلالة | محسوب متفرقاً، والصرف النقدي لا يُنقص الرصيد (EV-3053) | P3-LEV |
| أثر الإجازة المالي المتوقع | `Leave.deductionSchedule` (جدول يومي بنسخة) | leave.* | — | `leave.deductionFor` و`leave.expectedByMonth` | — | P3-LEV |
| ما سُوِّي من الإجازة وفروقه | بنود LEAVE في مراجعات لقطة السطر، و`LeaveCaseResolution` | payroll (approveLines، reverse، createAdjustment، resolve/registerResolution/markEffective/voidResolution) | `LeaveAdjustmentCase` (إسقاط، `payroll.leaveCase.recompute` وحدها) | `payroll.leaveSettled(leaveId)`؛ ولا تقرأ leave المسير (ADR-0002 #7، WF-LEV-002) | `settledByMonth` مخطط في LEV v11.1 ولم يُبنَ | P3-LEV، P3-PAY |
| تغطية التسوية لأيام المسير | `PayrollCoverage` | `payroll.coverage.record/release` (يستدعيها offboarding) | — | payroll تستبعد الأيام المغطاة | حذف المسودات عند اعتماد التسوية (`finance.ts:583`) | P3-OFF |
| أثر الإجازة في سطر المسير | سطر مسير أو سطر فرق مرتبط بـ`sourceLeaveId` | `payroll` عبر البوابة | — | من المسير | يضيع إن كان الشهر مغلقاً (EV-3047) | P3-LEV، P3-PAY |
| ربط الإجازة بالتأشيرة | FK `Visa.leaveId` | `gov.visa.openForLeave` | — | FK | معرّف داخل نص (EV-12011) | P3-LEV |
| المسير المعتمد | `PayrollMonth` + `PayrollLine` + اللقطة | `payroll.approve` | ملف Excel، ملف WPS، القسائم | اللقطة فقط | شهر واحد لكل العميل (EV-4003) | P3-PAY |
| ملف WPS | `BankExport` (تصدير للقطة) | `payroll.export` | — | لا يعيد الحساب | غير موجود (EV-4022) | P5-WPS |
| الدفع الفعلي | رد البنك أو مدد + `PaymentRequest` | `finance.confirmPayment` | حالة PAID | المطابقة | — | P5-WPS |
| القروض والأقساط | `Loan`، `LoanInstallment` | `payroll.loans.*` (عملية مسجلة في البوابة) | — | المسير يقرأ الأقساط المستحقة | خارج فصل الصلاحيات (EV-4214) | P3-PAY |
| الاستقطاعات والجزاءات والمكافآت | `Deduction` / `Bonus` | `payroll.deductions.*` (عملية مسجلة في البوابة) | — | مرتبطة بسطر واحد (INV-PAY-02) | — | P1-PAY-A |
| سبب الخروج وتاريخه | `ExitCase` (قاموس سبب واحد) | `offboarding` | `Employee.exitReason`، `terminationDate` | `ExitCase` | ثلاثة قواميس (EV-12021) | P3-OFF |
| التسوية | `Settlement` + بنودها المفصلة واللقطة | `offboarding.settle` عبر البوابة | مستند كشف التسوية | اللقطة | تسقط بنوداً (EV-4313) | P3-OFF |
| الصلاحية والوصول | `User` + الصلاحيات + نطاق الشركة | `iam` | الجلسة | `authz.can(user, action, resource)` | مجموعات أدوار ثابتة، وRolePermission شكلي (EV-9016) | P1-SCOPE، P6-AUTHZ |
| الهوية البنكية (IBAN) | `BankIdentityPeriod` (لا تُؤرَّخ رجعياً) | `compensation.applyBankIdentity` (من FinancialChange معتمد) | `Employee.ibanNumber` | `effectiveContext`، واللقطة في المسير | — | P1-PAY-B |
| البريد للتواصل | `Employee.email` | `people` | — | — | منفصل عن `User.email` (مقصود، ويُنبَّه عند الاختلاف) | P4-CORE |
| المستندات الرسمية | `IssuedDocument` + `DocumentEvent` (سلسلة) | `documents` | — | — | صحيح (EV-2035) | — |
| الإجماليات والمؤشرات | الاستعلام القانوني لكل نطاق (§3.2) | — | لوحات وتقارير ونماذج قراءة | عبر خدمة الاستعلام القانوني | استعلامات مكررة | P4-RPT |
| قرار الموافقة على طلب (من يعتمد، في أي مرحلة، وما النتيجة) | `WorkflowInstance` + `WorkflowTask` (REQUEST) | انتقالات `src/modules/workflow/transitions/*` (`workflow.start/act/cancel/pause/resume/closeExternally/recheck/resubmit/restartRound`) | حالة الطلب نفسه يكتبها محوّل وحدته عند القرار (G10)، ولا يكتبها المحرك | `workflow` queries (`instanceOf`، `tasksForUser`، `timelineOf`)؛ وقرّاء المعتمدين `*ById` ∪ `approversOf` | قرارات متفرقة لكل نوع طلب بلا محرك (WFE AS-IS) | P2-WFE (ADR-0006) (BL-WFE-001/002) |
| مسار الموافقة لكل نوع طلب وشركة | `WorkflowDefinition` (FACT بإصدارات؛ المفعَّل لا يتغير، G6). ويسجّل الصف تأليفه وإيقافه: `createdById` و`lastEditedById` و`activatedById` و`activationSelfAct`، و`retireRequestedById`/`retireRequestedAt` مع ما راجعه الطالب (`retireFallbackId`، `retireRelaxations`؛ يُعاد حسابهما عند التأكيد، فإن تغيّرا رُفض التأكيد ومُسح الطلب) و`retiredById` و`retireSelfAct` (DEC-PO-146/147؛ قيدا 9zn `two_person_activation` و`two_person_retire`) | `workflow.saveDefinitionDraft/activateDefinition/retireDefinition` | — | تعريف الشركة المفعَّل، وإلا تعريف المستأجر | مسارات ثابتة في الكود | P2-WFE (ADR-0006، ADR-0012) (BL-WFE-001/003/007) |
| إشعارات ملخص المالك من الوحدات فوق platform | صفوف `AuditRecord` بالفعلين `CONTROL_RELAXED` (إرخاء ضابط، `after.relaxations`) و`AUTO_APPROVED_BY_DEFINITION` (اعتماد آلي)؛ الاسمان ثابتان في platform | الوحدة صاحبة الانتقال في معاملته (اليوم `workflow`) | — | `platform.controlRelaxationRecords`، `platform.auditCountsByCompany` (ملخص iam) | لا يوجد | BL-WFE-003 (ADR-0012) |
| تفويض صلاحية الاعتماد | `ApprovalDelegation` (FACT؛ الحالة الوحيدة الإلغاء) | انتقالات تفويض `src/modules/workflow` (الحزمة D) | — | `workflow` queries مع فلتر `companyIds` | لا يوجد | P2-WFE (ADR-0006) (BL-WFE-006) |
| ربط حساب المستخدم بملف الموظف | `UserEmployeeLink` (خطوتان: اقتراح ثم تأكيد) | `iam.proposeLink/confirmLink/rejectLink/endLink` (والإقرار للروابط القديمة) | `Employee.userId` | الجلسة (session) | كتابة مباشرة لـ`Employee.userId` من الإعدادات | BL-PAY-005 (ADR-0007) |
| هوية الشخص الحقيقي (إقرار المعتمد) | أعمدة الهوية على `User` + سجل `AuditRecord` | `iam.attestIdentity`، `iam.completeCredentialSetup`؛ وتُسقطها `resetCredentials` و`promoteApprover` و`iam.vendor.namedPerson` (سحب الشخص المسمّى، DEC-PO-143) | — | `iam.identityOf`، `iam.countsTowardEnforced` | لا يوجد | BL-PAY-005 (ADR-0007) |
| جذر المستأجر TENANT_ROOT | `User.tenantRoot` | `iam.vendor.setRoot` (لوحة المورّد فقط، BL-PAY-017)؛ و`rootSuspendedAt` تكتبه `iam.identity.resetCredentials` و`changeDecide` و`iam.vendor.suspendRoot` و`setRoot` (ولاحقاً BL-LCY-010) | — | `iam` | لا يوجد | BL-PAY-005/017 (ADR-0007، ADR-0008) |
| رابط بيانات الدخول لمرة واحدة | `CredentialToken` (REQUEST) | `iam` | — | `iam` | المسؤول يضع كلمة مرور غيره | BL-PAY-005 (ADR-0007) |
| تغيير هوية يحتاج شخصين | `IdentityChangeRequest` (REQUEST) | `iam.decideChangeRequest` | — | `iam` | تعطيل أو تخفيض المعتمد بشخص واحد | BL-PAY-005 (ADR-0007) |
| الأشخاص المسمَّون للمالك (DEC-PO-018) | `TenantNamedPerson` بنوع NAMED_PERSON؛ رقم الهوية مجزأ بمفتاح فقط | `iam.vendor.*` | — | `iam.namedPersonOf`، `iam.namedLinkIntact` | لا يوجد | BL-PAY-022 (ADR-0008) |
| جهة اتصال المالك (DEC-PO-022) | `TenantNamedPerson` بنوع OWNER_CONTACT (بدل `TenantControls.ownerEmail/ownerMobile` في pay-to-be §17) | `iam.vendor.*` | — | `iam` | لا يوجد | BL-PAY-022 (ADR-0008) |
| ربط الحساب بالشخص المسمّى (RT-PAY-1403) | `TenantNamedPerson.userId` و`linkedAt` (بدل عمود `User.namedPersonId`)؛ «فك الربط عند تغيير البريد» محسوب (`emailSetAt > linkedAt`) | `iam.vendor.*` | — | `iam.namedLinkIntact` | لا يوجد | BL-PAY-022 (ADR-0008) |
| وضع الضوابط controlsMode لكل شركة نظامية (BR-PAY-020، DEC-PO-144) | محسوب لكل شركة، بلا نسخة مخزنة: إن لم تعلّمها رديف جاهزة فـENFORCED، وإلا فـENFORCED إن عمل فيها معتمدان مُقرّ بهما أو أكثر (`countsTowardEnforced` ونطاق `UserCompanyScope`؛ دور المالك أو غياب صفوف النطاق = كل الشركات)، وإلا SINGLE_OPERATOR | سجل التغيّرات فقط: `iam.recordControlsMode` (AuditRecord + `iam.controls.modeChanged` لكل شركة) | — | `platform.resolveOperatorMode(db, companyId)` بشركة الفعل (محلّل تسجّله iam: `iam.readControlsMode`)؛ الشركة المجهولة ENFORCED | إعداد يدوي `platform.operatorMode` للمستأجر كله | BL-PAY-021 (ADR-0009) |
| جاهزية الشركة لوضع الضوابط المحسوب (DEC-PO-144) | `ControlsReadiness` (صف مفتوح واحد لكل شركة؛ ATTESTED أو ONE_PERSON) | `iam.vendor.setControlsReadiness` (لوحة المورّد فقط، عملية بوابة VENDOR_ONLY) | — | `iam.readinessOf`، `iam.readyCompanies` | لا يوجد | BL-PAY-021 (ADR-0009) |
| ملخص المالك الشهري | صف `NotificationOutbox` بمفتاح `owner-digest:<YYYY-MM>:<contactId>`، بقسم لكل شركة | مهمة iam `owner-digest` | — | أمر المورّد `digest` | لا يوجد | BL-PAY-021 (ADR-0009) |

## 3.2 الاستعلامات القانونية (Canonical Queries): التقارير

التقرير **لا يحسب** مؤشراً بنفسه؛ يجمع نتائج خدمات الاستعلام القانوني لكل نطاق:

| المؤشر | الخدمة المالكة |
|---|---|
| عدد الموظفين (Headcount)، المعينون، الخارجون، الدوران (Turnover) | lifecycle + org (`employment.headcountAt`، `employment.movements(period)`) |
| الغياب، التأخير، نسبة الحضور، الإضافي بالساعات | time (`time.metrics(period)`) |
| تكلفة الرواتب، GOSI صاحب العمل، الإضافي بالمبلغ | payroll (`payroll.costs(period)` من المسيرات المعتمدة فقط) |
| تكلفة القوى العاملة الشاملة (رسوم، تأمين، سكن…) | workforce (يستدعي payroll + rules) |
| الإجازات والأرصدة والالتزام | leave |
| السعودة ونطاقات | workforce/nitaqat (يستدعي employment + assignment) |
| وقت التوظيف ومسار المرشحين | recruitment |
| تكلفة التدريب والساعات | learning |

**ثابت INV-RPT-01 (المصحح):** كل رقم في لوحة أو تقرير أو تصدير = نتيجة الاستعلام القانوني لنطاقه لنفس الفترة والنطاق. ولا يُشترط أن تأتي كل التقارير من المسير.

## 3.2.1 الفترات الافتتاحية

دالة واحدة `openLegacyPeriod(type, …)` في P1-FND-EFF تكتب كل الفترات الافتتاحية `LEGACY_OPENING`، ويستدعيها ترحيل كل جدول فترات. و`org.applyAssignment` بحده الأدنى جزء من P1-FND-EFF (ADR-0002 #8).

## 3.3 قاعدة إضافة معلومة جديدة

1. أضف صفها في §3.1 قبل كتابة الترحيل.
2. إن كانت تتغير عبر الزمن وتؤثر على مال أو حق فهي فترة نافذة (DOMAIN_MODEL §1.3).
3. لا تضف عموداً على `Employee` إلا هوية ثابتة أو إسقاطاً مسمّى بمُسقِطه.
4. أضف الثابت الذي يطابق أي إسقاط جديد (ARCHITECTURE_INVARIANTS §2).

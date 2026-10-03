# 5. حدود الوحدات (Domain Boundaries)

## 5.1 الشكل المستهدف: تطبيق واحد بوحدات معزولة (Modular Monolith)

```text
src/modules/<domain>/
  index.ts          ← الواجهة العامة الوحيدة (دوال قراءة + أوامر). لا تستورد الوحدات الأخرى غيرها
  transitions.ts    ← دوال الانتقال (الكاتب الوحيد لجداول الوحدة)
  queries.ts        ← الاستعلامات القانونية للوحدة (SOURCE_OF_TRUTH §3.2)
  events.ts         ← أسماء الأحداث وحمولاتها
  consumers.ts      ← مستهلكو أحداث الوحدات الأخرى
  scope.ts          ← عقد النطاق للوحدة (§4)
  sql/              ← أي SQL خام، مراجَع
  __tests__/
```

الكود الحالي في `src/lib/*` و`src/app/api/*` **يُنقل تدريجياً** مع كل حزمة من الخطة، ولا يُنقل دفعة واحدة. ويحرس الانتقالَ الخطُّ الأساسي في اختبارات ARCH.

**استثناء iam (ADR-0008):** `src/modules/iam/vendor-cli.ts` نقطة دخول iam الخاصة بسطر الأوامر، تشغّلها لوحة المورّد وحدها عبر SSH؛ و`transitions/vendor.ts` (كتّاب TENANT_ROOT و`TenantNamedPerson`) لا يصدّره `index.ts`، فلا يصل إليه مسار ولا صفحة ولا مهمة.

المسارات (`src/app/api/**/route.ts`) رقيقة: تتحقق من المدخلات، وتبني السياق، وتستدعي الوحدة، وتعيد الاستجابة. **لا منطق عمل في المسار.**

## 5.2 ملكية الجداول

كل نموذج في `schema.prisma` له مالك واحد. الكتابة للمالك فقط (ARCH-002)، والقراءة من خارجه عبر واجهته.

| الوحدة | تملك (الحالي) | تملك (جديد في الخطة) |
|---|---|---|
| **platform** | AuditLog (قديم، يُكتب بالإضافة فقط، ADR-0003)، SystemSetting، JobRun، NotificationOutbox، UploadedFile | DomainEvent، EventConsumption، OperationLog، AuditRecord (سجل التدقيق غير القابل للتعديل، ADR-0003)، Discrepancy، InvariantRun |
| **iam** | User، RolePermission، UserCompanyScope | Permission، RoleGrant (P6-AUTHZ)، MfaFactor، UserEmployeeLink، CredentialToken، IdentityChangeRequest (BL-PAY-005، ADR-0007)، TenantNamedPerson (BL-PAY-022، ADR-0008) |
| **rules** | RuleParameter، GosiRate | CompanyRuleOverride |
| **calendar** | WorkSchedule (يصبح WorkPattern) | HolidayCalendar، RamadanPeriod |
| **org** | Company، Administration، Branch، Department، TransferRequest (يُدمج في قرار النقل الموحد، P3-ORG) | AssignmentPeriod، Position، JobGrade، CostCenter |
| **people** | Employee (الهوية فقط)، Nationality | EmergencyContact، Dependent، EmployeeNote، CustomFieldValue |
| **lifecycle** | (الإسقاطات على Employee: employmentState، isTerminated، terminationDate) | EmploymentPeriod، EmploymentStateChange، EmploymentMigrationReview (ADR-0004)، ContractPeriod |
| **compensation** | Allowance، SalaryChange (يُدمج) | CompensationPeriod، BankIdentityPeriod، EmployeeFinancialChange (PAY) |
| **decisions** | EmployeeChangeOrder | — (يطبق عبر compensation وorg وlifecycle) |
| **time** | Attendance، AttendancePunch، AttendanceLocation، FaceProfile، AttendanceCorrection، OvertimeRequest، WorkAssignment | DayRecord، AttendancePeriodClose، DeviceImport |
| **leave** | Leave (مع `deductionSchedule` بنسخة، WF-LEV-002) | LeaveLedgerEntry (بسلالة التوظيف)، CarryOverConsent (LEV) |
| **payroll** | Payroll (يصبح PayrollLine)، Deduction، Loan، LoanInstallment | PayrollMonth، PayrollSnapshot، PayrollAdjustment، GosiRegistrationPeriod، BankExport، PayrollCoverage، LeaveAdjustmentCase (إسقاط)، LeaveCaseResolution، ResolutionHold، EmployeeDebt (WF-LEV-002، ADR-0002 #7) |
| **finance** | PaymentRequest | BankConfirmation |
| **offboarding** | TerminationRequest، Settlement | ExitCase، ExitClearanceItem، ExitTask (OFF)، SettlementEffect (ADR-0004) |
| **recruitment** | JobRequest، JobApplication | — |
| **onboarding** | OnboardingRequest | OnboardingTask |
| **performance** | EvaluationTemplate، EvaluationTemplateSection، EvaluationTemplateItem، EvaluationCycle، EmployeeEvaluation، EvaluationItemScore، EvaluationApproval | Goal، Feedback360، ImprovementPlan |
| **learning** | — | Course، TrainingRequest، Enrollment، Certificate، Skill |
| **benefits** | MedicalInsurance | InsuranceEnrollment |
| **assets** | Asset، AssetRequest، TelecomSim، UtilityMeter، Vehicle، AccidentClaim | — |
| **gov** | Visa، MuqeemTransaction، GovPlatform، RenewalArchive، ComplianceViolation، CompanyDocument (ميت، يُحذف) | QiwaSync، GosiSync |
| **legal** | PromissoryNote، LegalContract، Lawsuit، Investigation، CertifiedAgency | — |
| **documents** | BrandProfile، DocumentAsset، Signatory، SigningAuthorization، DocumentTypeSetting، DocumentRequest، DocumentSnapshot، DocumentApproval، DocumentRenderJob، IssuedDocument، DocumentSealKey، DocumentAcknowledgement، DocumentTextOverride، CircularRecipient، CandidateDocumentAccess، DocumentCounter، DocumentEvent، Circular (قديم، يُدمج في ADMIN_CIRCULAR) | DocumentFileVersion |
| **requests** | OwnerRequest | GeneralRequest، DataUpdateRequest، MedicalInsuranceRequest (REQ) |
| **workflow** | — | WorkflowDefinition، WorkflowInstance، WorkflowTask، ApprovalDelegation (WFE) |
| **workforce** | WorkforceAssumption، WorkforceCalculation، NitaqatActivity، NitaqatCurve، LocalizationDecision، HeadcountPlan، PlannedPosition، PlanRaise | — |
| **reporting** | — (لا جداول. تقرأ الاستعلامات القانونية، ونماذج قراءة إن لزم) | ReadModel* |

**`Employee` حالة خاصة:** الجدول ملك `people`، لكن أعمدة الإسقاط عليه ملك كتّابها: lifecycle للحالة، وcompensation للراتب، وorg للتعيين، وiam لرابط الدخول `userId` (إسقاط `UserEmployeeLink`، ADR-0007). ويُفرض ذلك على مستوى **العمود** (ARCH-003).

## 5.3 اتجاه الاعتماد (بلا دوائر)

يُسمح للوحدة باستدعاء الواجهة العامة لما **تحتها** فقط:

```text
(الأعلى يستدعي الأدنى فقط. والأحداث هي القناة الوحيدة من الأسفل للأعلى)

reporting
requests · performance · learning · workforce · documents · gov
offboarding
recruitment
onboarding
assets · benefits
payroll
finance              (تحت payroll: ADR-0002 #7. لا تستدعي payroll ولا offboarding)
time
leave
decisions
compensation
lifecycle            (يشمل ContractPeriod)
people · org
rules · calendar
iam · platform

workflow core  ← يعتمد على platform وiam فقط. محوّلات كل وحدة تعيش داخلها وتُسجَّل لدى المحرك،
                 ومنافذ القراءة (سلسلة المدير، التوفر، أيام العمل، حالة المستفيد) تسجلها org وleave
                 وcalendar وlifecycle (ADR-0001 #5)
```

**قواعد التفصيل:**

- **الحضور والإجازة:** `time` يقرأ `leave.isOnLeave`، و`leave` يقرأ `calendar` فقط، فلا دائرة بينهما. وجداول التقويم في وحدة مستقلة تحت الاثنين لهذا السبب.
- **المسير:** `payroll` يقرأ مدخلات `time` (بعد إغلاق الفترة) و`leave` و`compensation` و`lifecycle` عبر واجهاتها، ولا يقرأ جداولها.
- **الخروج:** `offboarding` يستدعي `lifecycle.transition` و`payroll.finalLine` و`leave.balance` و`assets.custodyOf`. ولا يستدعي `lifecycle` الخروج أبداً؛ يعلم به من حدث.
- **الموافقات:** `workflow` لا يعرف أي وحدة. الوحدات **تسجّل محوّلات (adapters)** لديه، فالمحرك يقرر، والمحوّل ينفذ الأثر في وحدته.
- **المستندات:** `documents` تقرأ الحقائق عبر الواجهات لتصيير المستند. ولا تُنشئ الوحدات مستندات بنداء مباشر داخل معاملاتها؛ تُصدر حدثاً، و`documents` تستهلكه (ARCH-017).
- **التكاملات:** `gov` تقرأ لقطة المسير المعتمد (WPS) وحقائق الموظف، وتكتب نتائج التكامل في جداولها، ثم تُصدر أحداثاً.

## 5.4 عقد نطاق الشركة

### 5.4.1 الطبقات، بالترتيب

```text
Request
 ↓
Tenant Context        ← قاعدة البيانات والأسرار ومجلد الملفات لكل عميل (موجود وقوي)
 ↓
Actor                 ← الجلسة، والتحقق من قاعدة البيانات، وMFA (P6)
 ↓
Company Scope         ← الشركات المسموحة للفاعل: UserCompanyScope، أو كل الشركات لدور مالك صريح
 ↓
Authorization Policy  ← authz.can(actor, action, resource{companyId, employeeId, ownerId…}): إجراء وحقل ومستوى سجل
 ↓
Domain Service        ← يستقبل ScopedContext صريحاً، ويمرره لكل استعلام، ويرفض العمل بدونه
 ↓
Prisma scope extension← دفاع إضافي: أي استعلام على نموذج ذي نطاق بلا سياق يرمي خطأ (fail-closed)
 ↓
DB constraints        ← companyId NOT NULL وFK على النماذج التشغيلية (وRLS خيار مستقبلي)
```

**امتداد Prisma ليس مصدر الصلاحية.** القرار في `authz.can` وفي الخدمة، والامتداد شبكة أمان. وسبب ذلك أن كثيراً من العمليات لا يغطيها فلتر تلقائي: التجميع (aggregate/groupBy)، وSQL الخام، والمعاملات المركبة، والمهام، والتقارير، والتصدير، والعمليات الإدارية بين الشركات.

### 5.4.2 أنواع السياق

| السياق | من | ما يسمح به |
|---|---|---|
| `ScopedContext(companyIds)` | أي مستخدم | القراءة والكتابة داخل `companyIds` فقط |
| `SelfContext(employeeId)` | الموظف في البوابة | سجلاته فقط؛ `employeeId` من الجلسة لا من العميل (قائم وصحيح، EV-6008) |
| `TeamContext(managerId)` | المدير | فريقه حسب الفرع والقسم والتقارير المباشرة، داخل شركته (قائم، EV-6009) |
| `CrossCompanyContext(reason)` | دور مالك صريح، أو عملية مسماة | عبر الشركات، ويُسجَّل السبب في التدقيق لكل عملية |
| `SystemContext(job)` | المهام المجدولة | تمر على **كل شركة على حدة** بـScopedContext لكل شركة، إلا المهام المعرفة عابرةً للشركات (مثل تنظيف الـoutbox) |

### 5.4.3 العقد لكل وحدة

| الوحدة | مفتاح النطاق | القراءة | الكتابة | عمليات عابرة للشركات مسموحة | ملاحظات |
|---|---|---|---|---|---|
| org | `Company.id` / `Branch.companyId` | الشركات المسموحة | ADMIN داخل النطاق | إنشاء شركة (مالك) | — |
| people / lifecycle / compensation | `AssignmentPeriod.legalCompanyId` النافذ | حسب التعيين النافذ اليوم، والتاريخي حسب تعيين الفترة | داخل النطاق | نقل بين شركتين: يتطلب نطاق الشركتين أو مالكاً | الموظف المنقول يظهر لكل شركة في فترتها فقط |
| time / leave | شركة التعيين النافذ في تاريخ السجل | كذلك | كذلك | — | — |
| payroll / finance | `PayrollMonth.companyId` | مسيرات الشركات المسموحة | التوليد والاعتماد والصرف لكل شركة على حدة | ملخص المالك المجمع (قراءة) | لا اعتماد مجمّع لعدة شركات |
| offboarding | شركة التعيين عند الخروج | كذلك | كذلك | — | — |
| documents | `legalCompanyId` للمستند (قائم) | كذلك | كذلك | — | النموذج الوحيد المطبق اليوم (EV-9017) |
| gov | `companyId` (يضاف لـGovPlatform) | كذلك | كذلك | — | كلمات المرور لكل شركة (EV-5021) |
| workforce / reporting | الشركات المسموحة | تجميع داخل النطاق فقط | — | تقارير المجموعة للمالك | الاستعلام القانوني يأخذ `companyIds` معاملاً إلزامياً |
| requests / workflow | شركة المستفيد | المكلَّف يرى مهامه، وHR يرى نطاقه | — | — | تفويض الموافقة داخل الشركة، أو بسياق عابر مسجل |
| recruitment / onboarding | `JobRequest.companyId` و`OnboardingRequest.companyId` (إلزاميان، ADR-0001 #14) | كذلك | كذلك | فحص أهلية إعادة التعيين عبر الشركات: `CrossCompanyContext('rehire-eligibility')` يعيد الأهلية فقط | FK من OnboardingRequest إلى JobApplication |
| workflow | `WorkflowInstance.companyId` = شركة المستفيد عند البدء | المكلَّف يرى مهامه، وHR نطاقه | — | نوع يعلن `crossCompany` فقط. والتفويض بـ`companyIds[]` ضمن نطاق الطرفين | ADR-0001 #14 |
| assets | `Asset.companyId` (إلزامي) | الشركات المسموحة | الحجز والتسليم داخل الشركة | نقل عهدة بين شركتين بسياق عابر مسجل | ADR-0001 #14 |
| communications (تعاميم) | الشركة المصدرة | موظفو الشركة المستهدفة فقط | — | تعميم لكل المجموعة (مالك) | Circular القديم بلا نطاق (EV-6027) يُدمج |

### 5.4.4 التجميع وSQL الخام والتصدير

- كل دالة تجميع أو SQL خام تأخذ `companyIds: string[]` **إلزامياً**، ولا قيمة افتراضية. وفحص ARCH-009 يمنع غير ذلك.
- التصدير (Excel، WPS، PDF) يمر بنفس الاستعلام القانوني بنفس السياق، ويُسجَّل في التدقيق بالنطاق.
- الاختبار الإلزامي (INV-SCOPE-01): لكل مسار API، مستخدم من الشركة (أ) لا يحصل على أي صف من الشركة (ب) في القوائم والتفاصيل والتجميع والتصدير.

## 5.5 الأحداث الرئيسية لكل وحدة

| الوحدة | تُصدر | تستهلك |
|---|---|---|
| lifecycle | `employment.hired`، `employment.noticeStarted`، `employment.exitCancelled`، `employment.exitAmended`، `employment.lastWorkingDayChanged`، `employment.terminated`، `employment.rehired`، `employment.voided`، `contract.periodOpened` | لا شيء يغيّر الحالة. onboarding يستدعي `lifecycle.hire`، وoffboarding يستدعي `transitionEmploymentState` مباشرة (ADR-0001 #4) |
| compensation | `compensation.periodOpened`، `compensation.bankIdentityOpened`، `financialChange.decided` | `decisions.order.due`، `employment.terminated` (إلغاء التغييرات المستقبلية المعلقة)، `employment.hired/rehired` (`payrollReady`) (ADR-0002 #6) |
| org | `assignment.periodOpened` (يشمل تغيّر الشركة) | `decisions.order.due` |
| time | `attendance.dayClosed`، `attendance.periodClosed`، `overtime.approved` | `leave.request.approved/cancelled`، `assignment.periodOpened` (الجيوفنس) |
| leave | `leave.request.approved/rejected/cancelled/edited` (بـversion وprevRange وnewRange)، `leave.balance.posted` | `employment.hired` (بدء الاستحقاق)، `employment.terminated` (إيقاف)، `compensation.periodOpened` (إعادة تسعير جدول الخصم، BL-LEV-013). **ولا تستهلك أحداث payroll** (ADR-0002 #7) |
| payroll | `payroll.month.calculated/approved/exported/paid`، `payroll.line.approved/reversed`، `payroll.adjustment.created`، `payroll.leaveCase.changed/leaverRouted`، `payroll.debt.*`، `money.guard.blocked` | `attendance.periodClosed`، `leave.*` (إعادة حساب حالات الفروق)، `finance.paymentRequest.paid` (طلبات LEAVE_CASE فقط)، `compensation.periodOpened` (فرق رجعي إن كان الشهر مغلقاً)، `employment.*` (إعادة توليد مسودة الموظف، ونظام GOSI عند إعادة التعيين) (ADR-0002 #6) |
| offboarding | `exit.opened/withdrawn/approved/lastDayReached/settled/closed` | `exit.opened` (بناء المسودة والإخلاء والمهام) |
| workflow | `workflow.task.assigned/notRequired/overdue/escalated`، `workflow.instance.decided/returned/blocked/effectFailed/awaitingRequirement`، `workflow.delegation.created/revoked` | — (تستدعيه المحوّلات. وسياسة الخروج تطبقها مستهلكات الوحدات المالكة لـ`employment.*`) |
| requests | `requests.*.decided`، `requests.ownerRequest.assigned` | — |
| assets | `assets.request.*`، `assets.custody.changed` | `employment.terminated` (سياسة الخروج للطلبات) |
| onboarding | `onboarding.request.approved` | `employment.terminated` (سياسة الخروج لحالات التهيئة والتجربة، ADR-0002 #6) |
| documents | `document.issued`، `document.acknowledged` | معظم أحداث الوحدات الأخرى (إصدار آلي) |
| platform/notifications | — | كل الأحداث ذات قالب إشعار |
| gov | `wps.fileSent/bankConfirmed`، `muqeem.*`، `gosi.*` | `payroll.month.approved`، `employment.terminated` |

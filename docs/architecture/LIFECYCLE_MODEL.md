# 2. نموذج الدورات (Lifecycle Model)

## 2.1 المبدأ: الانتقال متزامن، والأثر الجانبي غير متزامن

> **Business state transitions are synchronous; side effects are asynchronous.**

| داخل المعاملة (ذرّي، ينجح كله أو يفشل كله) | بعد المعاملة (من الحدث، قابل لإعادة التشغيل) |
|---|---|
| تغيير حالة الكيان | الإشعارات (بريد، داخل التطبيق، دفع) |
| كتابة الحقائق المترتبة: حركة الرصيد، الفترة النافذة، سطر الفرق | إصدار المستندات (خطاب، شهادة) |
| تحديث الإسقاطات المباشرة (مثل `Employee.basicSalary`) | بناء نماذج القراءة والتقارير |
| سجل التدقيق | المهام في محرك الموافقات للمرحلة التالية، إن لم تكن جزءاً من الانتقال |
| كتابة `DomainEvent` في الـoutbox | التكاملات الخارجية (مقيم، GOSI، البنك) |

مثال (اعتماد إجازة):

```text
BEGIN
  leave.status = APPROVED                      (انتقال)
  LeaveLedgerEntry(TAKEN, -days)               (حقيقة، وحدة leave)
  AuditLog                                     (تدقيق)
  DomainEvent('leave.request.approved', key)   (outbox)
COMMIT
→ مستهلكون: time يكتب DayRecord(LEAVE) (وإن كانت الأيام في فترة مغلقة: حدث يُنتج سطر فرق في payroll)،
  وإشعار الموظف، وخطاب الإجازة (LEAVE_APPROVAL)، وتأشيرة خروج وعودة، وتحديث لوحة الفريق
```

الانتقال يكتب **حقائق وحدته فقط** (ARCH-002). وما يخص وحدة أخرى يصلها بحدث، أو بنداء **لأسفل** إلى واجهتها العامة داخل نفس المعاملة عندما يكون جزءاً من صحة الانتقال (مثل offboarding ← lifecycle.transitionEmploymentState).

**نجاح الانتقال لا يعتمد على نجاح أي مستهلك.** فشل البريد أو المستند لا يلغي الاعتماد؛ يُعاد تشغيله، ويظهر في المصالحة (INV-EVT-01) إن تأخر.

**استثناء واحد:** إن كان الأثر شرطاً قانونياً لصحة الانتقال (مثال: ملف WPS لا يُعتبر مُرسلاً إلا برد البنك)، فهو **انتقال مستقل** بحالة خاصة (SENT ← CONFIRMED)، وليس أثراً جانبياً.

## 2.2 عدم التكرار (Idempotency): نفس العملية ← نفس النتيجة

كل عملية تغيّر حالة تقبل **مفتاح عملية** (`operationKey`) ويُتحقق منه:

1. **طلبات HTTP المغيِّرة:** العميل يرسل `Idempotency-Key`، أو يُشتق المفتاح من (المستخدم، الكيان، الانتقال، نسخة الكيان). وجدول `OperationLog(operationKey UNIQUE, result)` يعيد النتيجة المخزنة عند الإعادة.
2. **الانتقالات:** حماية بنسخة الكيان (`updateMany where status = FROM and version = V`). الإعادة بعد النجاح تجد الحالة تغيرت فتعيد النتيجة السابقة لا خطأً مكرراً.
3. **الحقائق المترتبة:** مفتاح فريد في قاعدة البيانات يمنع التكرار، مثل `LeaveLedgerEntry UNIQUE(sourceType, sourceId, kind)`، و`PayrollLine UNIQUE(payrollMonthId, employeeId)`، و`PayrollAdjustment UNIQUE(sourceType, sourceId, targetMonth)`.
4. **الأحداث:** `DomainEvent.idempotencyKey UNIQUE`. وكل مستهلك يسجل `(consumer, eventId)` في `EventConsumption UNIQUE` قبل أثره، أو يستخدم مفتاحاً طبيعياً في أثره (مثل `NotificationOutbox.idempotencyKey` الحالي).
5. **المهام المجدولة:** كل تشغيل يعالج عناصر بمفاتيح طبيعية، وتشغيلان متتاليان على نفس البيانات يُنتجان نفس الحالة (موجود في `JobRun`، ويُعمَّم).
6. **مستهلك لا يستطيع تطبيق أثره** (ADR-0002 #14)، مثلاً لأن الهدف لم يعد DRAFT: يسجل استهلاكاً بنتيجة مسماة (`RETRO_ROUTED`)، ويوجّه الأثر إلى مسار بديل موجود ومسمى (فرق رجعي، أو تسوية، أو دين، أو مهمة HR). ولا يترك الحدث معلقاً. والهدف الذي ما زال قابلاً للعكس يُعكس ولا يُوجَّه.
7. **ترتيب الأقفال** (ADR-0002 #2): أي معاملة تكتب لأكثر من موظف، أو تكتب إسقاطاً على Employee ضمن دفعة، تستدعي أولاً `people.lockEmployees(tx, ids)` بترتيب المعرّف تصاعدياً، ثم أقفال المحوّل، ثم تكتب (ARCH-019).

**اختبار إلزامي لكل انتقال:** استدعاؤه مرتين (تتابعاً وتزامناً) ينتج نفس الحالة ونفس عدد الحقائق والأحداث والإشعارات (ARCH-014).

## 2.3 آلات الحالة الأساسية

كل آلة حالة لها: قائمة حالات (enum أو CHECK)، وجدول انتقالات مسموحة، ودالة انتقال واحدة، وحدث لكل انتقال. التفاصيل في تصاميم PeopleOS المذكورة.

### التوظيف (LCY، الكاتب الوحيد: `transitionEmploymentState`)

```text
(none) ─hire─► ACTIVE ─notice─► NOTICE ─lastDay─► TERMINATED ─rehire─► ACTIVE (فترة جديدة)
                 │                │
                 └──terminateNow──┴──► TERMINATED
NOTICE ─cancelExit─► ACTIVE
```

- "في إجازة" و"متأخر عن العودة" **حالتان محسوبتان** من الإجازات والتقويم (BR-LCY-008)، وليستا حالتين مخزنتين.
- `isTerminated` و`employmentState` على Employee إسقاطان يكتبهما `transitionEmploymentState` وحده، ثم يُحذف `employmentStatus` (BL-LCY-009).

### الأجر والتعيين (compensation / org)

```text
Decision (ChangeOrder | FinancialChange | ExitCase | Onboarding)
   ─approve─► PENDING_EFFECT ─(validFrom reached | immediate)─► APPLIED ──► CompensationPeriod / AssignmentPeriod
                                   └─cancel─► CANCELLED (قبل النفاذ فقط)
```

القرار المعتمد بتاريخ نفاذ مستقبلي يُطبَّق بمهمة يومية **أو** عند توليد المسير، أيهما أسبق، بنفس الدالة. والإنهاء يلغي القرارات المستقبلية المعلقة (فجوة التدقيق L5).

### الإجازة (LEV)

`DRAFT ← PENDING_MANAGER ← PENDING_HR ← APPROVED ← (IN_PROGRESS محسوبة) ← RETURNED | CLOSED`، مع `REJECTED` و`CANCELLED`. التعديل بعد الاعتماد انتقال يرفع `version` جدول الخصم، وأثره المالي حالة فرق في payroll (ADR-0002 #7، WF-LEV-002).

### الحضور لكل يوم (ATT، يُصمَّم)

`EXPECTED ← (punches) ← PROVISIONAL ← (period close) ← FINAL`. ويُعاد فتح اليوم فقط بتصحيح معتمد، فينتج سطر فرق إن كان الشهر مغلقاً.

### المسير لكل شركة وشهر (PAY)

```text
DRAFT ─generate─► CALCULATED ─review─► LINES_APPROVED ─approve─► APPROVED ─export─► EXPORTED ─bankConfirm─► PAID
   ▲                  │                                                          │
   └──regenerate──────┘ (قبل الاعتماد فقط)                          reject/partial ─► PAYMENT_EXCEPTION
```

- الاعتماد يأخذ **لقطة** (Snapshot) لكل سطر: المدخلات، والقواعد ونسخها، والنتيجة. بعدها لا يُعاد حساب الشهر.
- **ملف WPS تصدير للقطة، لا حاسبة.** المولّد يقرأ اللقطة المعتمدة فقط ولا يعيد أي حساب: `Snapshot ← WPS Generator ← File ← Bank/Mudad Response ← Reconciliation`.
- التوليد عملية نظام (SYSTEM) يطلقها شخص مسجَّل، ولا يغيّر رقماً معتمداً. وفصل الصلاحيات حسب قرارات PAY (DEC-PO-005/014/015/028): المعتمد ≠ المصدِّر ≠ مؤكد الدفع، والمستفيد لا يعتمد سطره (ADR-0001 #16).

### الخروج (OFF)

حالات ExitCase حسب تصميم OFF: مخزنة `OPEN | CLOSED | CANCELLED`، والمراحل (سحب، إنذار، إخلاء، تسوية) مشتقة من بنوده (ADR-0001 #15). آخر يوم عمل ينفذ انتقال LCY `lastDay` آلياً. والتسوية تُحسب من `effectiveContext` وكل البنود المفتوحة (INV-EOS-01).

### طلب عبر المحرك (WFE)

`WorkflowInstance: RUNNING ← (tasks) ← APPROVED | REJECTED | CANCELLED | PAUSED`. **المحرك يقرر الموافقة. والأثر على الكيان يطبقه محوّل الوحدة المالكة (adapter)**، لا المحرك نفسه.

## 2.4 الأحداث

- الاسم: `<domain>.<entity>.<pastTenseVerb>` (مثل `leave.request.approved`، و`payroll.month.approved`، و`employment.state.changed`).
- الحمولة: معرّفات وقيم دنيا (لا بيانات شخصية زائدة)، و`occurredAt`، و`effectiveDate`، و`companyId`، و`actorId`، و`idempotencyKey`.
- الترتيب مضمون لكل (نوع كيان، معرّف كيان) فقط، ولا ترتيب عام.
- المستهلك **لا يغيّر حالة وحدة أخرى مباشرة**؛ يستدعي واجهتها العامة، فتصبح عملية جديدة بمفتاح مشتق من الحدث.

## 2.5 المهام المجدولة

`scripts/jobs.mjs` مشغّل فقط: يختار العناصر المستحقة ويستدعي **دوال الوحدات نفسها**. ولا قاعدة عمل داخل مجلد المهام (ARCH-008). **إلزامي** (DEC-PO-121، ADR-0001 #12): حزمة P1-FND-JOBS تبني المهام من نفس كود TypeScript للوحدات، فيُحذف كل منطق مكرر (applyEmployeeChanges، وحدود الإنذار، ونسخة المحرك في `scripts/lib/workflow.mjs`) مع اختبارات التطابق التي كانت تحرسه، ولا يوجد مسار HTTP داخلي لإعادة الفحص.

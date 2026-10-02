# ملاحظات إصدار 2026-10: النشر والترقية على مستأجر قائم

هذه المذكرة لمن ينشر على سيرفر مستأجرين قائم. الإصدار هو **الإيداعان المحليان** `c4530e3` (الدستور المعماري والمرحلة 0 والمرحلة 1) و`1a54a60` (الرواتب تقرأ التوظيف من دورة الحياة، وتشغيل حالة فترة الإشعار) فوق `b556235` (القرارات الإدارية والتعاميم). الأوامر والمسارات هنا كما في [`RUNBOOK.md`](RUNBOOK.md) و[`../ops/`](../ops)، والمصطلحات نفسها: `<tenant>` أحد المستأجرين.

ما لم أتحقق منه في الملفات مكتوب بعلامة «يُتحقق منه».

**نطاق الإصدار.** ما في الإيداعين فقط. الترحيل `9zg_financial_change` والمؤقت `radeef-jobs@apply-financial-changes.timer` والمسارات `financial-changes` موجودة في شجرة العمل **غير مودعة** وليست من هذا الإصدار. انشر من الإيداع (`--ref 1a54a60` أو الوسم الذي يُنشأ عليه) لا من شجرة عمل غير نظيفة، وإلا دخلت معه. «يُتحقق منه»: هل هذا الإصدار مدفوع إلى `origin/master` وله وسم؛ الإيداعان محليان حسب الحالة وقت كتابة المذكرة.

---

## 1. محتوى الإصدار

**المرحلة 0 (إيقاف النزيف)**
- **CI على `master`:** كان `ci.yml` يستمع لفرع `main` فلم يعمل على الدفع. أُضيفت وظيفتا `integration` (Postgres 16 مع خدمة التصيير) و`face-service` (pytest) وبناء حزمة المهام.
- **مؤقتات كل المهام:** مؤقت لكل مهمة في `ops/systemd`، والسكربت `ops/jobs-setup.sh` يثبتها ويفعّلها، واختبار `ops-job-timers.test.ts` يفشل إن أُضيفت مهمة بلا مؤقت.
- **النسخ الاحتياطي:** الرفع الخارجي المشفر **إلزامي افتراضياً** (rclone crypt أو age)، وتمرين استعادة شهري آلي يكتب نتيجته في `JobRun`.
- **التهيئة (9r):** طلبات التوظيف والتهيئة تحمل `companyId`، وتُملأ الشركة النظامية والفعلية للموظفين الحاليين حيث يمكن اشتقاقها دون تخمين.
- **إصلاح «في إجازة» (9s):** الحالة تُحسب من الإجازات المعتمدة ولا تُخزَّن، وكل صف بقي بقيمة `ON_LEAVE` يعود `ACTIVE` مع حفظ القيمة السابقة في `AuditLog`.
- **صندوق البريد الصادر:** أي رسالة غير مرسلة عمرها أكثر من `OUTBOX_TTL_HOURS` تصبح `EXPIRED` ولا تُرسل أبداً، فلا يخرج رصيد قديم عند أول تفعيل للإرسال.
- **المصالحة:** تقرير قراءة فقط `scripts/reconcile-report.mjs`، ثم مهمة `reconcile` الكاملة في المرحلة 1.
- **قرار النقل (9p):** قرار نقل الموظف (فرع أو قسم أو مدير مباشر) عبر أمر التغيير نفسه كالترقية، وخيارات لكل شركة لنوع المستند.

**المرحلة 1أ (الأساسات)**
- **الأحداث والتدقيق (9t):** `DomainEvent` (صندوق صادر بمفتاح فريد) و`EventConsumption` و`OperationLog` (العملية المكررة تعيد النتيجة المسجلة) و`AuditRecord` (تدقيق لا يُعدَّل ولا يُحذف). جدول `AuditLog` القديم باقٍ كما هو.
- **الفترات النافذة (9u):** `EmploymentPeriod` و`CompensationPeriod` و`AssignmentPeriod`، لا تُحذف صفوفها (مشغّل)، ويُفتح لكل موظف قائم فترة افتتاحية `LEGACY_OPENING`.
- **الثوابت والفروقات (9w):** `Discrepancy` و`InvariantRun`، ولوحة `/settings/integrity`.
- **قيود قاعدة البيانات (9x):** قيود CHECK على أعمدة الحالة، ومفاتيح أجنبية للمراجع النصية وللفاعلين، و`Restrict` بدل `Cascade` على التاريخ القانوني، وحذف جدول `CompanyDocument` الميت.
- **طبقة النطاق `iam`:** سياقات النطاق وعميل Prisma الذي يرفض القراءة والكتابة بلا سياق، وتطبيقها على مسارات API (عدا المستندات والمسارات العامة).
- **مشغّل المهام:** المهام صارت كود TypeScript للوحدات (`src/jobs/registry.ts`) مجمّعاً في `dist/jobs/jobs.cjs`، وأُضيفت مهمتا `reconcile` و`domain-events`.
- **المطابقة المعمارية:** اختبارات `src/test/architecture` بخط أساس سقّاطة لا يزيد (`npm run test:arch`، `npm run arch:baseline`).

**المرحلة 1ب (الهيكل الفقري)**
- **الحالة الوظيفية (9y، 9zd):** حالة التوظيف حقيقة مسجلة في `EmploymentStateChange` (ACTIVE / NOTICE / TERMINATED) بكاتب وحيد في وحدة lifecycle. الترحيل 9y يفتح حالة افتتاحية لكل موظف ويسجل أكواد المراجعة، و9zd ينقل سجل أثر اعتماد التسوية إلى جدول `SettlementEffect` وأكواد المراجعة إلى `EmploymentMigrationReview`.
- **التقويم (9z):** `WorkSchedule` يصير نمط العمل (`companyId` وأيام عمل منظمة)، والموظف يرتبط بالنمط بمفتاح أجنبي، وجداول `HolidayCalendar` و`RamadanPeriod` لكل شركة، وتُزرع الإجازات الرسمية ثابتة التاريخ لعامي 2026 و2027.
- **القواعد (9za، 9ze):** القيم النظامية في وحدة `rules` (`RuleParameter` مؤرخة)، وتجاوز الشركة (`CompanyRuleOverride`) لا ينزل عن الحد النظامي إلا باقرار مسجل.
- **مفاتيح الشركة (9zb):** `companyId` لجداول المنصات الحكومية والعقود والقضايا والكمبيالات والوكالات والعهد.
- **بوابة المال والرواتب (9zf):** `PayrollMonth` لكل شركة نظامية وشهر، و`Payroll.companyId`، وأعمدة الفاعلين على القروض والاستقطاعات والإضافي والبدلات والتسويات، وفصل المهام.

**الإيداع `1a54a60`**
- أهلية الرواتب وتوليدها يقرآن فترات التوظيف من lifecycle: موظف في فترة الإشعار يُحتسب راتب شهر الخروج بالتناسب فقط، والفجوة بين إنهاء الخدمة وإعادة التعيين لا تُدفع.
- قارئات التسويات تتخطى التسويات الملغاة (`REJECTED`، `REVERSED`) وتعدّ فترة التوظيف الحالية فقط، فلا تعطل تسوية نهاية خدمة قديمة موظفاً أُعيد تعيينه.
- أحداث lifecycle تحمل `affectsFrom`، فنقل آخر يوم عبر شهرين يصحح الشهرين.
- فحص تاريخ التسوية (409) وحارس على القروض أثناء تسوية نهاية خدمة حية.
- `NOTICE_STATE_RELEASED = true` في `src/lib/constants.ts`: حالة الإشعار تعمل فعلاً.

---

## 2. قبل النشر

### 2.1 نسخة احتياطية
`deploy.sh` يأخذ `pg_dump` لكل مستأجر قبل الترحيل (`/var/backups/radeef/<tenant>/pre-deploy-<ts>.dump`)، لكن خذ نسخة مستقلة أولاً وتأكد أنها وصلت إلى الخارج:
```bash
sudo /opt/radeef/src/ops/backup.sh --all
ls -lh /var/backups/radeef/<tenant>/daily | tail -3
```
**تنبيه:** هذا الإصدار يجعل الرفع الخارجي المشفر إلزامياً، فإن لم يُضبط قبل الجدولة يخرج `backup.sh` بـ1 بعد اكتمال النسخ المحلي (القسم 5.4 أدناه). اضبطه **قبل** النشر حتى لا تكون نسخة ما قبل النشر محلية فقط.

أنشر على مستأجر واحد أولاً (RUNBOOK 3.1)، وراجع القسم 2.2 على كل مستأجر قبل تشغيل الترحيل عليه.

### 2.2 ترحيلات قد توقف النشر على بيانات سيئة
ينفذ `deploy.sh` الأمر `prisma migrate deploy`، وأي ترحيل يفشل يوقف المستأجر عند مرحلة `migrate` (والنشر يكمل لغيره ما لم تبلغ `--max-migrate-failures`، الافتراضي 1). الجداول في هذه الفقرة هي ما تفحصه قبل النشر.

**أ) `9x_db_constraints`: جدول `CompanyDocument` غير فارغ.** يتوقف الترحيل برسالة صريحة بدل حذف البيانات. افحص:
```sql
SELECT count(*) FROM "CompanyDocument";
```
إن كان العدد صفراً فلا شيء يلزم. وإلا (وهذا من نص رسالة الترحيل نفسها):
```bash
# 1) صدّر الصفوف واحفظها مع سجلات الشركة
psql "$DATABASE_URL" -c '\copy "CompanyDocument" TO '"'"'/var/backups/radeef/<tenant>/CompanyDocument.csv'"'"' CSV HEADER'
# 2) احذفها
psql "$DATABASE_URL" -c 'DELETE FROM "CompanyDocument";'
# 3) أعد وسم الترحيل الفاشل كمُرجَع ثم انشر من جديد
node node_modules/prisma/build/index.js migrate resolve --rolled-back 9x_db_constraints --schema prisma/schema.prisma
sudo -iu radeef /opt/radeef/src/ops/deploy.sh --ref <ref> <tenant>
```
(الكود لا يقرأ هذا الجدول ولا يكتب فيه حسب تعليق الترحيل.) «يُتحقق منه»: مسار `prisma` وملف البيئة في أمر `migrate resolve` يختلفان بين وضعي PM2 وDocker؛ استخدم الطريقة نفسها التي يشغّل بها `deploy.sh` الترحيل (`ops/deploy.sh` أسطر 259 إلى 265 للـPM2).

**ب) `9x_db_constraints`: قيود وسيطة `NOT VALID` مع `NOTICE`.** لا يتوقف النشر هنا:
- قيود CHECK على أعمدة الحالة (38 قيداً حسب خطة المرحلة 1) تُضاف `NOT VALID` ثم تُتحقق إن كانت كل الصفوف الحالية مقبولة. من وجد قيمة خارج القائمة يبقى قيده `NOT VALID` (يُنفَّذ على الصفوف الجديدة والمعدّلة فقط) ويصدر `NOTICE`: `9x_db_constraints: ... left NOT VALID`.
- مفتاح أجنبي يشير إلى صف غير موجود (يتيم) في عمود يقبل NULL يُضبط NULL وتُحفظ القيمة القديمة في `AuditLog` مع `NOTICE`.
- `TransferRequest.toBranchId` (عمود إلزامي) لا يُعدَّل: يبقى مفتاحه الأجنبي `NOT VALID` مع `NOTICE` إن وُجد يتيم.

ماذا تفعل: سجّل الإخراج (`NOTICE`) من سجل النشر، ثم بعد النشر شغّل المصالحة وراجع `/settings/integrity` (القسم 8). الصفوف المخالفة تحتاج تصحيحاً يدوياً ثم `VALIDATE CONSTRAINT` لاحقاً؛ لا تُجبر النشر بحذف القيد. «يُتحقق منه»: هل تظهر هذه الصفوف كفروقات في المصالحة؛ التعليق يقول إن مهمة المصالحة تسردها لكن لم أفحص الفحوص واحداً واحداً.

**ج) `9r_onboarding_company` و`9zb_scope_company_keys`: `NOTICE` بأعداد صفوف بلا شركة.** الترحيلان لا يخمّنان: ما لم تُشتق شركته يبقى `NULL`. الصف بلا شركة **يراه المالك والمستخدم بلا نطاق فقط ولا يراه مستخدم مقيّد بنطاق** (الإخفاق مغلق). خذ أعداد `NOTICE` من سجل النشر وأصلحها بعده (اختر الشركة يدوياً) إن كان لديك مستخدمون مقيّدون.

**د) `9zd_lcy_tables`: يجب أن يُنشر مع كوده.** الترحيل يحذف العمود `Settlement.approvalEffects` ومشغّله ودالته بعد نقل محتواه إلى `SettlementEffect`. الإصدار السابق يكتب هذا العمود عند اعتماد التسوية، فإن بقي كود قديم يعمل على قاعدة رُحّلت فستفشل الاعتمادات. لذلك: لا تشغّل `migrate deploy` يدوياً ثم تؤخر تبديل الكود، ولا تُبقِ نسخة قديمة تعمل على القاعدة الجديدة؛ استخدم `deploy.sh` الذي يرحّل ثم يبدّل في الدورة نفسها. ويتوقف الترحيل برسالة `settlement effect log(s) are not version 1; move them by hand first` إن وُجد سجل أثر بإصدار غير 1: انقله يدوياً أو راجع المطوّر قبل المتابعة («يُتحقق منه»: لا أعرف أن إصداراً غير 1 ظهر في أي بيئة).

**هـ) `9zf_payroll_gateway`: `Payroll.companyId`.** يُملأ من الشركة النظامية للموظف ثم الفعلية. الصفوف التي لا شركة لموظفها تبقى `NULL` ويصدر `NOTICE`: `9zf_payroll_gateway: N Payroll row(s) have no resolvable company ...`. عندها يبقى القيد `Payroll_companyId_required` **غير متحقَّق منه (`NOT VALID`)**: يرفض أي سطر راتب **جديد** بلا شركة، ولا يُتحقق من القديم. الحل: أسند شركة للموظف المعني (نظامية أو فعلية) ثم عُد. «يُتحقق منه»: الإجراء الدقيق لإعادة ملء الأسطر القديمة بعد إسناد الشركة؛ الترحيل لا يُعاد تشغيله، فتحتاج `UPDATE` يدوياً (اسأل المطوّر قبل تنفيذه).

**و) ترتيب الأحرف.** الأحرف المتخطاة (`9q`، `9v`، `9zc`) ليست ترحيلات ناقصة: الدليل هو مجلد `prisma/migrations`، وفيه هذه القائمة فقط. لا تُنشئ ترحيلاً بحرف متخطى ولا بأرقام `10+`.

---

## 3. قائمة الترحيلات بالترتيب

| الترحيل | ما يفعله |
|---|---|
| `9p_transfer_decision` | قرار نقل الموظف، وخيارات لكل شركة لنوع المستند، ويُحدّث حارس أمر التغيير |
| `9r_onboarding_company` | `companyId` لطلبات التوظيف والتهيئة، وملء شركة الموظفين الحاليين (أعمدة قابلة للـNULL، وإعادة التشغيل لا تغيّر شيئاً) |
| `9s_on_leave_reset` | بيانات فقط: `ON_LEAVE` ← `ACTIVE`، والقيمة السابقة في `AuditLog` |
| `9t_platform_events_audit` | أربعة جداول جديدة: `DomainEvent`، `EventConsumption`، `OperationLog`، `AuditRecord` |
| `9u_effective_periods` | `EmploymentPeriod`، `CompensationPeriod`، `AssignmentPeriod`، وقيود `EXCLUDE` (`btree_gist`) ومشغلات منع الحذف، وفتح الفترات الافتتاحية |
| `9w_invariants_discrepancies` | `Discrepancy` و`InvariantRun` |
| `9x_db_constraints` | حذف `CompanyDocument` (يتوقف إن لم يكن فارغاً)، وقيود CHECK والمفاتيح الأجنبية، و`Restrict` على التاريخ القانوني |
| `9y_employment_state` | `EmploymentState` و`Employee.employmentState` و`EmploymentStateChange`، وفتح حالة افتتاحية لكل موظف |
| `9z_calendar` | نمط العمل (`WorkSchedule`)، و`Employee.workPatternId`، و`HolidayCalendar` و`RamadanPeriod` والإجازات الرسمية 2026 و2027 |
| `9za_rules` | `CompanyRuleOverride`، وزرع القيم النظامية المؤرخة في `RuleParameter` |
| `9zb_scope_company_keys` | `companyId` للمنصات الحكومية والعقود والقضايا والكمبيالات والوكالات والعهد |
| `9zd_lcy_tables` | `SettlementEffect` و`EmploymentMigrationReview`، وحذف `Settlement.approvalEffects` |
| `9ze_rule_override_ack` | أعمدة الاقرار على `CompanyRuleOverride` لتجاوز ما دون الحد النظامي |
| `9zf_payroll_gateway` | `PayrollMonth`، و`Payroll.companyId`/`payrollMonthId`، وأعمدة الفاعلين، و`Allowance.status` |

(الترحيل `9zg_financial_change` غير مودع وخارج هذا الإصدار.)

للتفاصيل: رأس كل ملف `prisma/migrations/<name>/migration.sql`، و[`DATABASE.md`](DATABASE.md) للترحيلات عموماً.

---

## 4. متغيرات البيئة

في `/etc/radeef/<tenant>.env` لكل مستأجر (وفي `/etc/radeef/backup.conf` لما يخص النسخ).

| المتغير | الملف | مطلوب؟ | الأثر |
|---|---|---|---|
| `OWNER_ALERT_EMAIL` | بيئة المستأجر | اختياري، فارغ = لا تنبيه | بريد المالك المسجل لدى رديف؛ يستقبل تنبيه ضبط قاعدة دون الحد النظامي (DEC-PO-126، DEC-PO-022) |
| `OUTBOX_TTL_HOURS` | بيئة المستأجر | اختياري، الافتراضي 72 (حدّه من 1 إلى 720) | عمر الرسالة غير المرسلة قبل أن تصير `EXPIRED`. غير مذكور في `.env.example`، وموثق في RUNBOOK 4.1 |
| `SMTP_HOST`، `SMTP_PORT`، `SMTP_USER`، `SMTP_PASS`، `SMTP_FROM` | بيئة المستأجر | مطلوب **للإرسال الفعلي فقط** | المزود المعتمد Amazon SES (DEC-PO-130)، مثل `SMTP_HOST="email-smtp.<region>.amazonaws.com"` والمنفذ 587؛ خطوات الإعداد في RUNBOOK 4.1 |
| `OUTBOX_SEND` | بيئة المستأجر | اختياري، الافتراضي `false` | بلا `"true"` **و** SMTP كاملة تبقى `outbox-dispatch` تجريبية |
| `RCLONE_REMOTE` | `backup.conf` | **مطلوب افتراضياً** (أو `ALLOW_LOCAL_ONLY=1`) | وجهة النسخ الخارجي |
| `BACKUP_AGE_RECIPIENTS` | `backup.conf` | مطلوب إن لم يكن الـremote من نوع `crypt` | ملف المفتاح العام لتشفير age؛ المفتاح الخاص يبقى خارج السيرفر؛ والرفع غير المشفر مرفوض |
| `ALLOW_LOCAL_ONLY` | `backup.conf` | اختياري، الافتراضي 0 | `1` يقبل نسخاً محلياً فقط (غير مستحسن للإنتاج) |
| `BACKUP_PING_URL` | `backup.conf` | اختياري | نبض المراقبة؛ يُرسل `/fail` أيضاً عند غياب النسخ الخارجي |
| `DRILL_PG_URL` | `backup.conf` | **مطلوب لتمرين الاستعادة** (بدونه يخرج السكربت بخطأ) | دور Postgres بصلاحية `CREATEDB` للقواعد المؤقتة `radeef_drill_<tenant>` |
| `DRILL_PING_URL` | `backup.conf` | اختياري | نبض نجاح أو فشل التمرين |

متغيرات أخرى: `JOBS_APP_DIR` و`JOB_TIMEOUT` في `ops/run-jobs.sh` لها افتراضيات (`/opt/radeef/src` و`30m`) ولا يلزم تغييرها. لم أجد في `.env.example` ولا `Dockerfile` متغيراً إلزامياً جديداً غير ما سبق. «يُتحقق منه»: متغيرات `UPLOAD_DIR` و`APP_URL` مطلوبة لبعض المهام (المهام التي تكتب ملفات أو ترسل روابط)، وكانت موجودة سابقاً؛ تأكد أنها مضبوطة في كل ملف بيئة.

---

## 5. خطوات جديدة على السيرفر

### 5.1 البناء
`npm run build` صار `next build && node scripts/build-jobs.mjs`: يبني أيضاً `dist/jobs/jobs.cjs`. `deploy.sh` يشغّل هذا الأمر ويبني الحزمة في `/opt/radeef/src` (حيث تشغّل `run-jobs.sh` المهام في وضع PM2). بعد أي تعديل على مهمة يلزم البناء. تحقق بعد النشر:
```bash
cd /opt/radeef/src && ls -l dist/jobs/jobs.cjs && node scripts/jobs.mjs --list
```
في وضع Docker الصورة تنسخ `dist/jobs` مع `nodemailer` و`zod`، وتفشل عملية بناء الصورة إن تعذر تحميل الحزمة (`RUN node scripts/jobs.mjs --list`).

### 5.2 مؤقتات المهام: أحد عشر مهمة
ملفات المؤقتات في `ops/systemd` أحد عشر مهمة: `apply-employee-changes` و`deactivate-terminated` و`documents-integrity` و`documents-retention` و`domain-events` و`employment-notice-end` و`employment-state-opening` و`expiry-digest` و`outbox-dispatch` و`purge-attendance-biometrics` و`reconcile`. المهام الأربع الأحدث عن مؤقتات النسخة السابقة: `domain-events` (كل 5 دقائق) و`reconcile` (03:15) و`employment-notice-end` (00:20) و`employment-state-opening` (02:40)، بتوقيت الرياض.
```bash
sudo /opt/radeef/src/ops/jobs-setup.sh            # ينسخ الوحدات ويفعّل كل المؤقتات
sudo /opt/radeef/src/ops/jobs-setup.sh --check    # يخرج بـ1 إن كان مؤقت غير مفعل
systemctl list-timers "radeef-jobs@*"
```
المهام تعمل لكل مستأجر عبر `ops/run-jobs.sh` (ويتخطى `RADEEF_JOBS="off"`). بديل cron: `ops/jobs-setup.sh --cron > /etc/cron.d/radeef-jobs`.
**ملاحظة توثيق:** نص RUNBOOK 4.1 وجدول `ops/README.md` ما زالا يذكران «تسع» و«سبع» مهام؛ العدد الصحيح من ملفات المؤقتات و`run-jobs.sh` أحد عشر (لم أعدّل هذين الملفين في هذه المهمة). وإن نشرت من شجرة عمل غير نظيفة فسيجد `jobs-setup.sh` مؤقتاً ثانياً عشر (`apply-financial-changes`) غير مودع.

**تجربة قبل الاعتماد على المؤقتات** (لا تكتب شيئاً في المهام التي تدعم `--dry-run`):
```bash
cd /opt/radeef/src && sudo -u radeef node --env-file=/etc/radeef/<tenant>.env scripts/jobs.mjs reconcile --dry-run
```

### 5.3 تمرين الاستعادة الشهري
يحتاج `DRILL_PG_URL` (القسم 4) ودوراً بصلاحية `CREATEDB`:
```bash
sudo -u postgres psql -c "CREATE ROLE radeef_drill LOGIN CREATEDB PASSWORD '<random>'"
# في /etc/radeef/backup.conf:
#   DRILL_PG_URL=postgresql://radeef_drill:<random>@127.0.0.1:5432/postgres
sudo install -m 0644 /opt/radeef/src/ops/systemd/radeef-restore-drill.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now radeef-restore-drill.timer   # يوم 2 من كل شهر 05:30 بتوقيت الرياض
```
النتائج: `SELECT "startedAt", status, details FROM "JobRun" WHERE job = 'restore-drill' ORDER BY "startedAt" DESC;`. التمرين لا يلمس قاعدة المستأجر.

### 5.4 النسخ الخارجي المشفر إلزامي
بلا remote خارجي يكتمل النسخ المحلي ثم يخرج `backup.sh` بـ1 ويرسل `/fail`. أحد طريقين في `/etc/radeef/backup.conf` (`chmod 600`)، بالتفصيل في RUNBOOK 3.4:
```bash
# أ) remote من نوع crypt في rclone
RCLONE_REMOTE=radeef-crypt:
# ب) remote عادي مع تشفير age لكل ملف (المفتاح الخاص لا يبقى على السيرفر)
RCLONE_REMOTE=b2:radeef-backups
BACKUP_AGE_RECIPIENTS=/etc/radeef/backup-age.pub
```
`backup.sh` يرفض رفع بيانات الموظفين إن كان الـremote ليس `crypt` ولا `BACKUP_AGE_RECIPIENTS` مضبوطاً. لتجربة يدوية: `sudo /opt/radeef/src/ops/backup.sh --all` ويجب أن ينتهي السطر الأخير بـ`(offsite: age)` أو `(offsite: crypt)`.

---

## 6. تغييرات سلوك يلاحظها المستخدمون

- **نطاق الشركة للمستخدم المقيّد:** المستخدم الذي له صفوف في `UserCompanyScope` يرى بياناته شركاته فقط في مسارات API (الموظفون، الإجازات، الحضور، الدفعات، الرواتب، العقود وغيرها)؛ المالك والمستخدم بلا نطاق يريان كل الشركات. صف بلا `companyId` (انظر 2.2 ج) لا يراه المقيّد. المستخدم الذي كان يرى شركات غيره سيلاحظ نقصاً، وهذا مقصود. المستندات والمسارات العامة خارج هذا التغيير حسب خطة المرحلة 1.
- **إنشاء الشركات للمالك فقط:** `POST /api/companies` صار لـ`SUPER_ADMIN` و`COMPANY_ADMIN` فقط (`ROLE_GROUPS.OWNER`) ويُسجَّل في تدقيق عبر السياق العابر للشركات؛ **الموارد البشرية لا تنشئ شركات** لكنها تعدّل شركاتها (`companies/[id]`).
- **الرواتب لكل شركة:** توليد المسير يتم شركة شركة (`PayrollMonth` لكل شركة نظامية وشهر)، والشركة المعتمدة أو المدفوعة شهرها تُتخطى مع سبب (و409 إن كانت كلها كذلك). `POST /api/payroll-hub/generate` يقبل `companyId` اختيارياً، وبدونه يعمل على كل شركات نطاق المستخدم. الحقل `UNIQUE (employeeId, month, year)` باقٍ، فنقل موظف بين شركتين في منتصف الشهر لا يُقسَّم بعد.
- **فصل المهام:** من طلب مبلغاً أو كان مستفيداً منه لا يعتمده ولا يصرفه، **بلا استثناء لأي دور**: أُلغيت استثناءات `SUPER_ADMIN` وإعداد `allow_self_approval` ومرور `UNKNOWN_REQUESTER`. تقديم طلب لنفسه مسموح. في وضع المشغّل الوحيد (`SINGLE_OPERATOR`) لا يُرفض الفعل بل يُسجَّل `SELF_ACT_SINGLE_OPERATOR` لمراجعة المالك. «يُتحقق منه»: كيف يُفعَّل وضع المشغّل الوحيد في مستأجر محدد.
- **حالة فترة الإشعار:** تعمل `NOTICE` (انظر 1). الموظفون الذين وُجد لهم عند الترحيل `isTerminated` مع تاريخ إنهاء مستقبلي يُسجَّلون `TERMINATED` مع كود مراجعة `NOTICE_CANDIDATE` (HR تقرر)، ولا يتحولون آلياً إلى `NOTICE` حسب رأس `9y`. راجع `EmploymentMigrationReview` بعد النشر.
- **تكرار العملية يعيد النتيجة الأولى:** النداء المكرر لعملية تغيّر الحالة (بالمفتاح نفسه، مثل ترويسة `Idempotency-Key` في توليد المسير) يعيد النتيجة المسجلة ولا يكرر الأثر.
- **تجاوز القواعد دون الحد النظامي يحتاج اقراراً:** ضبط قاعدة الشركة تحت الحد الأدنى النظامي (أو فوق الأعلى) يُقبل فقط مع اقرار مسجل (من، ومتى، والسبب) وتنبيه المالك إن ضُبط `OWNER_ALERT_EMAIL`، ويظهر كفرق «مشروح» غير مانع. القيم ذات النوع `FIXED` ترفض التجاوز نهائياً.
- **ما يُحسب «في إجازة»:** من الإجازات المعتمدة التي تغطي اليوم، لا من الحقل المخزن.
- **أخرى:** الإجازات الرسمية ثابتة التاريخ تظهر مزروعة لعامي 2026 و2027، وعيدا الفطر والأضحى لا تُولَّدان وتُدخلها الموارد البشرية كل عام.

---

## 7. الرجوع (Rollback)

**الكود:** `deploy.sh --rollback <tenant>` يعيد الكود فقط (RUNBOOK 3.2).

**الترحيلات:** معظمها «توسعي فقط»: الإصدار السابق يتجاهل الجداول والأعمدة الجديدة (9t، 9u، 9w، 9y، 9za، 9ze، 9zf حسب تعليقات رؤوسها). لكن:
- **9zd:** حذف `Settlement.approvalEffects`. الكود السابق يكتبه، فلا تعد إلى كود ما قبل 9zd على قاعدة رُحّلت. تعليق الترحيل نفسه: الرجوع بإعادة إضافة العمود وإعادة بنائه من `SettlementEffect`.
- **9x:** حذف جدول `CompanyDocument` (فارغ حين مرّ)، وتغيير المفاتيح الأجنبية إلى `Restrict`، وإضافة القيود. حذف الجدول لا يُلغى إلا باستعادة النسخة.
- **9s:** القيمة القديمة `ON_LEAVE` محفوظة في `AuditLog` فقط (صف لكل موظف).
- **9r وغيره:** أعمدة `companyId` المملوءة قابلة للـNULL ولا ضرر منها على الكود السابق.

**جداول لا تقبل الحذف أو التعديل (مشغّلات):** `DomainEvent` و`EventConsumption` و`AuditRecord` و`EmploymentPeriod` و`CompensationPeriod` و`AssignmentPeriod` و`EmploymentStateChange` و`SettlementEffect` و`EmploymentMigrationReview` (التعديل مقصور على الحل). التراجع عن بياناتها لا يكون إلا بإسقاط الجدول نفسه، وهذا ما تقوله تعليقات 9u و9y. فعملياً:

- مشكلة بالكود فقط ← `deploy.sh --rollback` (قبل أي حركة تكتب في الجداول الجديدة هو آمن).
- مشكلة بالترحيل ← استعادة نسخة ما قبل النشر:
```bash
sudo /opt/radeef/src/ops/restore.sh <tenant> /var/backups/radeef/<tenant>/pre-deploy-<ts>.dump
```
أي بيانات أُدخلت بعد النسخة تضيع، فقرر ذلك بوعي (RUNBOOK 3.2). كلما طال الزمن بعد النشر زاد ما يضيع، فاتخذ القرار في أول ساعات.

---

## 8. فحوص بعد النشر

1. **المؤقتات والمهام:**
```bash
sudo /opt/radeef/src/ops/jobs-setup.sh --check
cd /opt/radeef/src && node scripts/jobs.mjs --list
systemctl list-timers "radeef-jobs@*"
```
(الخيار `--check` موجود في `jobs-setup.sh` وليس في `scripts/jobs.mjs`؛ الأخير يعرف `--list` و`--dry-run`.)
2. **سجل المهام بعد أول تشغيل:**
```sql
SELECT job, status, "startedAt", left(details, 200) FROM "JobRun" ORDER BY "startedAt" DESC LIMIT 20;
```
3. **المصالحة:** شغّل `reconcile` ثم افتح `/settings/integrity` وراجع الفروقات المفتوحة، خصوصاً ما نتج عن `NOT VALID` و`NOTICE` في القسم 2.2:
```bash
sudo -u radeef /opt/radeef/src/ops/run-jobs.sh reconcile <tenant>
```
   فحص لم يعمل يجعل التشغيل `FAILED`. وتقرير القراءة فقط: `scripts/reconcile-report.mjs` («يُتحقق منه»: طريقة تشغيله وحدودها؛ لم أقرأ السكربت).
4. **تمرين الاستعادة:**
```bash
sudo /opt/radeef/src/ops/restore-drill.sh <tenant>
```
   ثم النتيجة `SUCCEEDED` في `JobRun` حيث `job = 'restore-drill'`.
5. **نسخ احتياطي بنسخة خارجية:** `sudo /opt/radeef/src/ops/backup.sh --all` وتأكد أن السطر الأخير يذكر `offsite`.
6. **فحص الصحة:** `curl -fsS https://<domain>/api/health`.
7. **تجربة مسير بلا اعتماد:** افتح `/payroll` (مركز الرواتب) بمستخدم مخوّل، ولّد مسودة شهر **غير معتمد** لشركة واحدة (`POST /api/payroll-hub/generate` بـ`companyId`)، وقارن أسطرها بآخر مسير معتمد: الأسماء والمبالغ وشركة كل سطر. لا تعتمد ولا تصرف أثناء الفحص. توليد المسودة يعيد توليد المسودات DRAFT لذلك الشهر والشركة (حسب تعليق المسار)، فاعمل الفحص على شهر لا مسودة مهمة فيه. «يُتحقق منه»: مسار الصفحة `/payroll` بالضبط، وأن توليد المسودة لا يمس شهراً معتمداً (المسار يتخطى الشهر المعتمد حسب تعليقه).
8. **أرقام الإذن:** سجّل دخول مستخدماً مقيّد النطاق وآخر بلا نطاق، وتأكد أن الأول لا يرى إلا شركاته، وأن حساب HR لا يملك إنشاء شركة.
9. **ما بعد الترحيل:** راجع `EmploymentMigrationReview` (الصفوف غير المحلولة) واعرضها على الموارد البشرية:
```sql
SELECT count(*) FROM "EmploymentMigrationReview";
```

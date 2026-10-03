# ADR-0009: computed controls mode per company, Radeef's readiness mark, and the owner digest (BL-PAY-021)

- **التاريخ:** 2026-10-03
- **الحالة:** ACCEPTED (المالك، 2026-10-03، DEC-PO-144).
- **المشكلة:** BL-PAY-021 يستبدل الإعداد المؤقت `platform.operatorMode` بوضع ضوابط محسوب من حقائق الهوية، ويضيف ملخصاً شهرياً للمالك. وقرر المالك (DEC-PO-144) أن يُحسب الوضع **لكل شركة نظامية**، وألا يُطبَّق على شركة قبل أن تعلّمها رديف «جاهزة». لا صف لهذه المعلومات في SOURCE_OF_TRUTH، ولا مالك لجدول الجاهزية في §5.2، ولا منفذ مسجل في DOMAIN_BOUNDARIES، والأحداث الجديدة غير مدرجة في §5.5.

## القرار

1. **SOURCE_OF_TRUTH §3.1**، ثلاثة صفوف جديدة:

| المعلومة | الحقيقة | الكاتب الوحيد | الإسقاطات | القراءة الصحيحة | الحالي (تدقيق) | الحزمة |
|---|---|---|---|---|---|---|
| وضع الضوابط controlsMode لكل شركة نظامية (BR-PAY-020، DEC-PO-144) | محسوب لكل شركة، بلا نسخة مخزنة: إن لم تعلّمها رديف جاهزة فـENFORCED، وإلا فـENFORCED إن عمل فيها معتمدان مُقرّ بهما أو أكثر (`countsTowardEnforced` ونطاق `UserCompanyScope`؛ دور المالك أو غياب صفوف النطاق = كل الشركات)، وإلا SINGLE_OPERATOR | سجل التغيّرات فقط: `iam.recordControlsMode` (AuditRecord + `iam.controls.modeChanged` لكل شركة) | — | `platform.resolveOperatorMode(db, companyId)` بشركة الفعل (محلّل تسجّله iam: `iam.readControlsMode`)؛ الشركة المجهولة ENFORCED | إعداد يدوي `platform.operatorMode` للمستأجر كله | BL-PAY-021 (ADR-0009) |
| جاهزية الشركة لوضع الضوابط المحسوب (DEC-PO-144) | `ControlsReadiness` (صف مفتوح واحد لكل شركة؛ ATTESTED أو ONE_PERSON) | `iam.vendor.setControlsReadiness` (لوحة المورّد فقط، عملية بوابة VENDOR_ONLY) | — | `iam.readinessOf`، `iam.readyCompanies` | لا يوجد | BL-PAY-021 (ADR-0009) |
| ملخص المالك الشهري | صف `NotificationOutbox` بمفتاح `owner-digest:<YYYY-MM>:<contactId>`، بقسم لكل شركة | مهمة iam `owner-digest` | — | أمر المورّد `digest` | لا يوجد | BL-PAY-021 (ADR-0009) |

   يحل هذا محل `TenantControls.controlsMode/modeChangedAt` في pay-to-be §17؛ لا جدول TenantControls.
2. **DOMAIN_BOUNDARIES §5.2**، صف iam: يُضاف `ControlsReadiness` (BL-PAY-021، ADR-0009). ويُضاف إلى استثناء iam في §5.1 أن `transitions/vendor.ts` يكتب `ControlsReadiness` أيضاً.
3. **§5.3**: لوحدة platform منفذ قراءة لوضع الضوابط (`registerOperatorModeResolver`) تسجّله iam، بنمط منافذ محرك الموافقات نفسه. وكل قارئ يمرّر شركة الفعل؛ وعمليات البوابة تعرّف `companyOf` إن لم يمرّر المستدعي الشركة. ولا يمرّر أي مستدعٍ وضعاً.
4. **§5.4.2**: `owner-digest` مهمة SystemContext معلنة عابرة للشركات (iam `CROSS_COMPANY_JOBS`)، تقرأ سجلات كل الشركات للمالك ولا تكتب إلا صف الصندوق الصادر.
5. **§5.4.3**: صف iam (وضع الضوابط): مفتاح النطاق الشركة النظامية للفعل؛ مسار الشريط يجيب كل مستخدم عن شركاته فقط (نطاق الموظف = شركة ملفه)، ولا يذكر شركة خارجها؛ والملخص المجمع للمالك وحده.
6. **§5.5**: تُصدر iam `iam.controls.modeChanged` (لكل شركة) و`iam.ownerDigest.queued` و`iam.vendor.controlsReadinessChanged`، وتستهلك `iam.controls.modeChanged` (تنبيه المالك عند النزول إلى SINGLE_OPERATOR). ويستهلك محرك الموافقات `iam.controls.modeChanged` (X-WFE-012) ويقرأ `resolveOperatorMode` بشركة المثيل وقت الفعل.

## العواقب

- قارئ واحد للوضع في كل مكان، بشركة الفعل؛ الشركة المجهولة أو غير الجاهزة ENFORCED (fail closed).
- كل الشركات القائمة والجديدة تبدأ غير جاهزة: لا يتغيّر سلوك أي شركة حتى تعلّمها رديف.
- خروج معتمد يُحسب في ENFORCED ويُنزل شركته تحت معتمدَين يحتاج معتمداً آخر مُقرّاً به (lifecycle `assertFinancialApproverExit` عبر منفذ iam `approverExitEffect`، DEC-PO-021).
- `UserCompanyScope` (أين يُحتسب المعتمد) جدول هوية تحرسه البوابة: كاتبه الوحيد في التطبيق `iam.setUserCompanyScope` (عملية `iam.user.scope`)، وتغيير يُنزل شركة تحت معتمدَين يصبح طلب تغيير بشخصين `CHANGE_SCOPE` يعتمده صاحب الحساب أو معتمد آخر مُقرّ به (DEC-PO-021، مراجعة الأمن النهائية).
- حذف الإعداد المؤقت وإنشاء `ControlsReadiness` (ترحيل 9zm).

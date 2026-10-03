# ADR-0012: approval-engine guardrails in the constitution (package C)

- **التاريخ:** 2026-10-03
- **الحالة:** ACCEPTED (المالك، 2026-10-03، DEC-PO-147).
- **المشكلة:** الحزمة C (BL-WFE-003) أضافت إلى محرك الموافقات استهلاك `iam.controls.modeChanged`، وأعمدة تأليف المسار وإيقافه على `WorkflowDefinition` (الترحيل 9zn)، وسجلَّي تدقيق يقرؤهما ملخص المالك. الدستور لا يذكرها: صف workflow في DOMAIN_BOUNDARIES §5.5 يقول إنه لا يستهلك شيئاً، بينما صف iam يقول إن المحرك يستهلك `iam.controls.modeChanged`. وصف `WorkflowDefinition` في SOURCE_OF_TRUTH لا يذكر من كتب المسار ومن فعّله ومن طلب إيقافه.

## القرار

1. DOMAIN_BOUNDARIES §5.5، صف workflow، عمود «تستهلك»: `iam.controls.modeChanged` (X-WFE-012: يعيد فحص المثيلات RUNNING وBLOCKED لتلك الشركة، المستهلك `workflow.controlsModeRecheck`).
2. SOURCE_OF_TRUTH، صف «مسار الموافقة لكل نوع طلب وشركة»: يسجّل الصف `createdById` و`lastEditedById` (آخر من حرّر المسودة) و`activatedById` و`activationSelfAct`، و`retireRequestedById`/`retireRequestedAt` مع ما راجعه الطالب (`retireFallbackId`، `retireRelaxations`؛ يُعاد حسابهما عند التأكيد، فإن تغيّرا رُفض التأكيد ومُسح الطلب) و`retiredById` و`retireSelfAct` (DEC-PO-146، DEC-PO-147). الكاتب الوحيد انتقالات `workflow` نفسها. والقيود في قاعدة البيانات: `WorkflowDefinition_two_person_activation` و`WorkflowDefinition_two_person_retire`، والزناد يمنع تغيير تأليف الإصدار المفعَّل وإيقاف الإصدار الموقوف (G6).
3. سجلّا `CONTROL_RELAXED` و`AUTO_APPROVED_BY_DEFINITION` في `AuditRecord` إشعاران لملخص المالك تكتبهما وحدات فوق platform في معاملة انتقالها. اسماهما ثابتان في platform (`CONTROL_RELAXED_ACTION`، `AUTO_APPROVED_ACTION`) لأن الملخص (iam) أدنى من تلك الوحدات ولا يستوردها. الكاتب اليوم: `workflow`.

لا تغيير في السلوك من هذا القرار نفسه: يوثّق ما بنته الحزمة C.

## العواقب

- محرك الموافقات يستورد platform وiam فقط كما كان، ويستهلك حدثاً من iam (اتجاه الاعتماد صحيح).
- أي وحدة أخرى تريد إدخال إرخاء ضابط في ملخص المالك تكتب `CONTROL_RELAXED` بالشكل نفسه (`after.relaxations`، `after.subject`).
- إغلاق المثيل خارجياً بفعل إنسان (`closeExternally`) يبقى صارماً في G1 وG1b بلا استثناء المشغّل الواحد حتى يقرر ذلك تصميم إنهاء الخدمة في المرحلة 3 (DEC-PO-147).

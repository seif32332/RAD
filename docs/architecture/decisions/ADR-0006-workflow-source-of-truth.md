# ADR-0006: source-of-truth rows for the approval engine

- **التاريخ:** 2026-10-03
- **الحالة:** ACCEPTED (موافقة المالك 2026-10-03، DEC-PO-140).
- **المشكلة:** المرحلة 2 تبني جداول محرك الموافقات (`AUDIT/16_PHASE2_AB_SPEC.md` §2). ملكية الجداول الأربعة مسجلة في DOMAIN_BOUNDARIES §5.2 (السطر 51)، لكن SOURCE_OF_TRUTH §3.1 بلا صف لها، و§3.3 القاعدة 1 تشترط الصف قبل كتابة الترحيل.

## القرار

تُضاف ثلاثة صفوف إلى SOURCE_OF_TRUTH §3.1، ولا يتغير شيء آخر في الدستور:

| المعلومة | الحقيقة | الكاتب الوحيد | الإسقاطات | القراءة الصحيحة | الحالي (تدقيق) | الحزمة |
|---|---|---|---|---|---|---|
| قرار الموافقة على طلب (من يعتمد، في أي مرحلة، وما النتيجة) | `WorkflowInstance` + `WorkflowTask` (REQUEST) | انتقالات `src/modules/workflow/transitions/*` (`workflow.start/act/cancel/pause/resume/closeExternally/recheck/resubmit/restartRound`) | حالة الطلب نفسه يكتبها محوّل وحدته عند القرار (G10)، ولا يكتبها المحرك | `workflow` queries (`instanceOf`، `tasksForUser`، `timelineOf`)؛ وقرّاء المعتمدين `*ById` ∪ `approversOf` | قرارات متفرقة لكل نوع طلب بلا محرك (WFE AS-IS) | P2-WFE (BL-WFE-001/002) |
| مسار الموافقة لكل نوع طلب وشركة | `WorkflowDefinition` (FACT بإصدارات؛ المفعَّل لا يتغير، G6) | `workflow.saveDefinitionDraft/activateDefinition/retireDefinition` | — | تعريف الشركة المفعَّل، وإلا تعريف المستأجر | مسارات ثابتة في الكود | P2-WFE (BL-WFE-001/007) |
| تفويض صلاحية الاعتماد | `ApprovalDelegation` (FACT؛ الحالة الوحيدة الإلغاء) | انتقالات تفويض `src/modules/workflow` (الحزمة D) | — | `workflow` queries مع فلتر `companyIds` | لا يوجد | P2-WFE (BL-WFE-006) |

- لا فترات نافذة (DOMAIN_MODEL §1.3 لا ينطبق): المواعيد أيام عمل، ونافذة التفويض صلاحية منحة لا فترة.
- لا عمود جديد على `Employee` (§3.3 القاعدة 3).
- بلا تغيير على ARCH-* أو INV-*؛ INV-WF-01 مسجل أصلاً (ARCHITECTURE_INVARIANTS السطر 103).
- قيد DEC-PO-139: لا نوع طلب له أثر مالي على المحرك في المرحلة 2 (`CHECK hasPayEffect = false`).

## العواقب

- الترحيل `<letter>_workflow_engine` يُكتب بعد قبول هذا القرار.
- الصفوف الثلاثة تُضاف إلى SOURCE_OF_TRUTH §3.1 مع الترحيل نفسه.

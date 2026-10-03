# ADR-0007: identity controls (BL-PAY-005)

- **التاريخ:** 2026-10-03
- **الحالة:** ACCEPTED (المالك، 2026-10-03، DEC-PO-141).
- **المشكلة:** BL-PAY-005 يضيف ثلاثة جداول لوحدة iam ويحوّل `Employee.userId` إلى إسقاط لرابط الحساب بالموظف. فحصا ARCH-002.owner وARCH-002 يفشلان حتى تُسجَّل الملكية والإسقاط في الدستور.

## القرار

1. DOMAIN_BOUNDARIES §5.2: صف **iam** يضيف إلى عمود الجداول الجديدة: `UserEmployeeLink`، `CredentialToken`، `IdentityChangeRequest`.
2. «Employee حالة خاصة» وإعداد `EMPLOYEE_PROJECTIONS`: يُضاف `userId: 'iam'`. `Employee.userId` إسقاط الوصول لـ`UserEmployeeLink`، وكاتبه الوحيد `projectAccessLink` (src/modules/iam/transitions/identity.ts).
3. SOURCE_OF_TRUTH §3.1، صفوف جديدة:

| المعلومة | الحقيقة | الكاتب الوحيد | الإسقاطات | القراءة الصحيحة | الحالي (تدقيق) | الحزمة |
|---|---|---|---|---|---|---|
| ربط حساب المستخدم بملف الموظف | `UserEmployeeLink` (خطوتان: اقتراح ثم تأكيد) | `iam.proposeLink/confirmLink/rejectLink/endLink` (والإقرار للروابط القديمة) | `Employee.userId` | الجلسة (session) | كتابة مباشرة لـ`Employee.userId` من الإعدادات | BL-PAY-005 (ADR-0007) |
| هوية الشخص الحقيقي (إقرار المعتمد) | أعمدة الهوية على `User` + سجل `AuditRecord` | `iam.attestIdentity`، `iam.completeCredentialSetup`؛ وتُسقطها `resetCredentials` و`promoteApprover` | — | `iam.identityOf`، `iam.countsTowardEnforced` | لا يوجد | BL-PAY-005 (ADR-0007) |
| جذر المستأجر TENANT_ROOT | `User.tenantRoot` | لوحة المورّد فقط (BL-PAY-017)؛ و`rootSuspendedAt` تكتبه `iam.resetCredentials` (ولاحقاً BL-LCY-010) | — | `iam` | لا يوجد | BL-PAY-005/017 (ADR-0007) |
| رابط بيانات الدخول لمرة واحدة | `CredentialToken` (REQUEST) | `iam` | — | `iam` | المسؤول يضع كلمة مرور غيره | BL-PAY-005 (ADR-0007) |
| تغيير هوية يحتاج شخصين | `IdentityChangeRequest` (REQUEST) | `iam.decideChangeRequest` | — | `iam` | تعطيل أو تخفيض المعتمد بشخص واحد | BL-PAY-005 (ADR-0007) |

4. مجموعة الحماية في `money.gateway` تشمل جداول الهوية وأعمدتها (pay-to-be §2). قائمة MONEY_MODELS في ARCH-004 بلا تغيير.
5. عقد النطاق لوحدة iam على مستوى المستأجر: مسارات الإدارة تشترط نطاق كل الشركات، وصاحب الحساب يوافق على طلبه هو.

## العواقب

- ARCH-002.owner يعود إلى 0، وARCH-002 ينقص 3 مدخلات ولا يزيد.
- متابعة مقترحة: فحص مطابقة أن `Employee.userId` يساوي الرابط المفتوح.

# ADR-0008: TENANT_ROOT and the owner's named people from the vendor panel (BL-PAY-017 / BL-PAY-022)

- **التاريخ:** 2026-10-03
- **الحالة:** ACCEPTED (المالك، 2026-10-03، DEC-PO-143).
- **المشكلة:** BL-PAY-017/022 يضيف جدول `TenantNamedPerson` لوحدة iam ونقطة دخول سطر أوامر للمورّد. فحص ARCH-002.owner يفشل حتى تُسجَّل الملكية، وصف TENANT_ROOT في ADR-0007 يحتاج كاتبه الفعلي.

## القرار

1. DOMAIN_BOUNDARIES §5.2، صف **iam**: يُضاف `TenantNamedPerson` (BL-PAY-022). و§5.1: `src/modules/iam/vendor-cli.ts` نقطة دخول iam الخاصة بسطر الأوامر، يشغّلها لوحة المورّد وحدها عبر SSH؛ و`transitions/vendor.ts` لا يصدّره `index.ts`.
2. SOURCE_OF_TRUTH §3.1، صفوف جديدة، كاتبها الوحيد `iam.vendor.*` (`transitions/vendor.ts`):

| المعلومة | الحقيقة | الكاتب الوحيد | الإسقاطات | القراءة الصحيحة | الحالي (تدقيق) | الحزمة |
|---|---|---|---|---|---|---|
| الأشخاص المسمَّون للمالك (DEC-PO-018) | `TenantNamedPerson` بنوع NAMED_PERSON؛ رقم الهوية مجزأ بمفتاح فقط | `iam.vendor.*` | — | `iam.namedPersonOf`، `iam.namedLinkIntact` | لا يوجد | BL-PAY-022 (ADR-0008) |
| جهة اتصال المالك (DEC-PO-022) | `TenantNamedPerson` بنوع OWNER_CONTACT (بدل `TenantControls.ownerEmail/ownerMobile` في pay-to-be §17) | `iam.vendor.*` | — | `iam` | لا يوجد | BL-PAY-022 (ADR-0008) |
| ربط الحساب بالشخص المسمّى (RT-PAY-1403) | `TenantNamedPerson.userId` و`linkedAt` (بدل عمود `User.namedPersonId`)؛ «فك الربط عند تغيير البريد» محسوب (`emailSetAt > linkedAt`) | `iam.vendor.*` | — | `iam.namedLinkIntact` | لا يوجد | BL-PAY-022 (ADR-0008) |

3. صف TENANT_ROOT في ADR-0007: الكاتب `iam.vendor.setRoot`. و`rootSuspendedAt`: `iam.identity.resetCredentials` و`changeDecide` و`iam.vendor.suspendRoot` و`setRoot`؛ ويُضاف BL-LCY-010 لاحقاً.
4. تسليم رمز ROOT_ATTEST_OWN (RT-PAY-1405): `CredentialToken.codeDelivery = VENDOR`، يُكشف لمشغّل المورّد مرة واحدة (`codeReleasedAt`). والدعوة INVITE غرض من أغراض رابط بيانات الدخول.

5. صف «هوية الشخص الحقيقي» (ADR-0007): يُضاف `iam.vendor.namedPerson` إلى ما يُسقط الإقرار (سحب شخص مسمّى بعد إقراره، DEC-PO-143).

## العواقب

- ARCH-002.owner يعود إلى 0.

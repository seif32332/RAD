# ADR-0005: only the owning module writes its kind of effective period

- **التاريخ:** 2026-09-28
- **الحالة:** ACCEPTED (قرار المستخدم «الوحدة المالكة فقط»، DEC-PO-129).
- **المشكلة:** ARCH-002/004/005 تقول إن كاتب جدول الفترة هو دالة الانتقال في الوحدة المالكة، وARCH-012 يقول إن الكاتب الوحيد هو `platform/effective`. والطبقة المشتركة تصل كل جدول عبر سجل الأنواع، فلا يرى الفحص الساكن من يستدعيها لأي نوع.

## القرار

- `platform/effective` هي **الكاتب الفعلي الوحيد** لجداول الفترات (ARCH-012 باقٍ).
- **ولا يستدعيها لنوع ما إلا الوحدة المالكة لذلك النوع**: `EMPLOYMENT` من `src/modules/lifecycle`، و`COMPENSATION` من `src/modules/compensation`، و`ASSIGNMENT` من `src/modules/org`، وكل نوع جديد يعلن مالكه في سجل الأنواع.
- الاستثناء الوحيد: `openLegacyPeriod` و`backfillLegacyOpenings` (الافتتاح القديم، ADR-0002 #8)، ويستدعيها الترحيل ومهمة الافتتاح.
- يُضاف فحص معماري **ARCH-021**: أي استدعاء لـ`openPeriod` أو `closePeriod` أو `supersedePeriod` بنوع ثابت من خارج الوحدة المالكة له يفشل.

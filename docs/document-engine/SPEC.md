# محرك إصدار المستندات — مراجعة المعمارية والتصميم المطوّر

هذه الوثيقة تراجع مقترح «Multi-Tenant Document Issuance Engine»، ثم تعيد صياغته على واقع رديف.

- **القرارات الحاكمة:** [ADR-001.md](ADR-001.md) (DOC-01 إلى DOC-12). عند التعارض، الـADR هو الحاكم.
- **تجربة المصيّر:** [POC.md](POC.md).

آخر مراجعة: 2026-09-26.

---

## 0. الخلاصة

الاتجاه العام صحيح: فصل النوع عن القالب عن الإصدار، ولقطة بيانات ثابتة، وQR بمعرّف معتم، وسجل تدقيق، ووحدة داخل monolith لا خدمة مصغّرة.

لكن المقترح مكتوب لـSaaS بمخطط مشترك، ورديف ليس كذلك. وفيه سبع فجوات تمنع تنفيذه كما هو:

| # | الفجوة | أثرها |
|---|---|---|
| 1 | يفترض `tenant_id` على كل جدول | DEC-004 رفض المخطط المشترك (الخيار D). العزل بين العملاء بنيوي: عملية وقاعدة لكل عميل. الحدود الحقيقية داخل العميل هي **الشركة**. |
| 2 | يربط الهوية بالمستأجر | العميل الواحد يملك عدة سجلات تجارية (`Company`). والموظف له **شركة نظامية** (`legalCompanyId`) و**شركة فعلية** (`actualCompanyId`). الخطاب الرسمي يصدر باسم الشركة النظامية، لأن البنك والسفارة يطابقان السجل التجاري مع التأمينات ومقيم. |
| 3 | «PDF Renderer» صندوق أسود | لا توجد مكتبة PDF في `package.json`. وكل عملية عميل تستهلك 300 إلى 400 ميجابايت (DEC-004)، فإضافة Chromium داخلها غير مقبولة. هذا هو قرار DOM-018 نفسه، وحلّه في §3. |
| 4 | آلة حالات واحدة تخلط سير العمل بحالة التوليد | `GENERATING` و`SIGNING` حالات مهمة تقنية لا حالات عمل. تُفصل إلى طلب ومستند صادر (§5). |
| 5 | لا ترقيم | الرقم الرسمي يجب أن يكون متسلسلاً بلا فجوات لكل شركة وسنة، ولا يضيع إذا فشل التوليد (§7). |
| 6 | الختم والتوقيع مجرد أصول مرفوعة | من يستطيع وضع صورة الختم يستطيع تزوير خطاب. الختم يحتاج **مصفوفة تفويض** لا مجرد رفع صورة (§9). |
| 7 | «مصمم مستندات» و«فواتير» في النطاق | المصمم بالسحب والإفلات مشروع مستقل ويفتح باب حقن القوالب. والفواتير في المملكة تخضع لفاتورة (ZATCA) بمتطلبات XML وختم تشفيري لا يغطيها محرك PDF. وعقد العمل الرسمي يوثَّق في قوى. كلها خارج النطاق (§14). |

---

## 1. ما يُبقى من المقترح كما هو

- **النوع ≠ القالب ≠ اللقطة ≠ المستند الصادر.** أهم فكرة في المقترح.
- **المستند الصادر غير قابل للتعديل.** التصحيح يعني إصداراً جديداً يلغي القديم (`SUPERSEDED`).
- **لقطة البيانات عند الإصدار.** الراتب في الخطاب يبقى 15,000 ولو صار 18,000 بعد شهر.
- **عقد بيانات (Data Contract) مكتوب الأنواع.** القالب لا يصل إلى قاعدة البيانات، ويرى الحقول المسموحة فقط.
- **QR يحمل معرّفاً معتماً** لا بيانات شخصية.
- **فصل التوقيع المرئي عن التوقيع الرقمي.** صورة التوقيع على PDF ليست توقيعاً إلكترونياً نظامياً.
- **Modular monolith.** رديف كذلك أصلاً، والمحرك وحدة في `src/lib/documents/`.

---

## 2. خريطة المفاهيم: المقترح ← رديف

| المقترح | في رديف |
|---|---|
| Tenant | نسخة العميل: عملية PM2 وقاعدة Postgres ومجلد ملفات مستقل. لا يلزم أي عمود `tenantId`. |
| BrandProfile على Tenant | `BrandProfile` على **Company**، واحد لكل سجل تجاري. |
| `legal_name`, `vat_number`, `commercial_registration`, `address` | تُقرأ من `Company` (`nameArabic`، `taxNumber`، `commercialRegNum`، `unifiedNumber`، `nationalAddress`). لا تُكرَّر في BrandProfile، فالمصدر واحد. |
| User → Membership → Tenant | الدور (`Role`) وعلاقة الموظف. **فجوة قائمة:** المستخدم الإداري غير محصور بشركة اليوم. المحرك يعوّضها جزئياً: جهة الإصدار تُشتق ولا يختارها المستخدم (§10). |
| Object Storage | `UPLOAD_DIR` المحلي، مع مسار مستقل للمستندات الصادرة وليس `/api/files` (§11). |
| `verify.your-saas.sa/d/…` | نطاق العميل نفسه: `https://<عميل>/v/<token>`. |
| لا microservices | متفق. الاستثناء الوحيد خدمة التصيير الجانبية، على نمط `radeef-face` نفسه (§3). |
| Document Designer | مؤجل. المرحلة الأولى قوالب في الكود، والعميل يعدّل الهوية والنصوص فقط (§4.3). |

---

## 3. قرار DOM-018: أين يُصيَّر الـPDF

### البدائل

| البديل | Arabic/RTL | الذاكرة | سطح الهجوم | الحتمية |
|---|---|---|---|---|
| A. Chromium (Puppeteer) داخل كل عملية عميل | ممتاز | +300 ميجابايت لكل عميل | كبير | لا |
| B. خدمة Chromium مشتركة (Gotenberg) | ممتاز | ~500 ميجابايت إلى 1 جيجابايت مرة واحدة | كبير. HTML قد يجلب `file://` أو عناوين داخلية (SSRF) إن لم يُغلق | لا |
| C. مكتبة JS داخل العملية (pdfmake / pdf-lib) | ضعيف: تشكيل الحروف العربية وثنائية الاتجاه غير مكتملة | منخفض | صغير | نعم |
| D. **Typst في خدمة جانبية مشتركة** | جيد: تشكيل عبر rustybuzz ودعم RTL | ~50 إلى 150 ميجابايت | صغير: لا شبكة ولا JavaScript | **نعم: نفس المدخلات ونفس النسخة تعطي نفس البايتات** |

### القرار: D (Typst 0.15.1). اجتاز الـPOC في 2026-09-26 ([POC.md](POC.md))

خدمة `radeef-render` تعمل مثل `radeef-face` تماماً:

- نسخة واحدة لكل خادم تخدم كل العملاء، على `127.0.0.1` فقط، وبـ`Authorization: Bearer $RENDER_SERVICE_TOKEN`.
- عديمة الحالة: تستقبل القالب واللقطة والأصول في الطلب نفسه، وتعيد البايتات، ولا تكتب شيئاً ولا تسجّل المحتوى.
- نفس تحصين systemd في `ops/systemd/radeef-face.service`: `DynamicUser`، و`IPAddressDeny=any`، و`InaccessiblePaths` لبيانات العملاء، و`MemoryMax`.
- الخطوط: **IBM Plex Sans Arabic** (Regular وMedium وBold، ثابتة static) فقط، مثبتة بالبصمة في `fonts.lock`، لأن تغيّر الخط يغيّر البايتات.
  - Noto Naskh Arabic مرفوض، لأنه متاح كخط متغيّر فقط، وTypst يتجاهل أوزانه.
  - Amiri مؤجل.
- الأعلام: `--ignore-system-fonts --ignore-embedded-fonts --creation-timestamp <issuedAt> --pdf-standard a-2b`، و`fallback: false` في القالب.
- فحص تغطية الأحرف قبل التصيير، لأن Typst يرسم المربع الفارغ بصمت ([POC.md](POC.md) §C1).
- الواجهة والتشغيل بالتفصيل في [POC.md](POC.md) §H. **الخدمة مبنية:** `services/render/` (README فيه الواجهة)، وتشغيلها في `docs/RUNBOOK.md` §6.

**لماذا الحتمية مهمة:** اختبارات golden تقارن البايتات. وعند النزاع («هذا الخطاب مزوَّر») يُعاد التصيير من اللقطة المحفوظة بنفس نسخة القالب والمصيّر، ويُقارن الـhash. لكن **البايتات المخزنة تبقى مصدر الحقيقة**، وإعادة التصيير دليل إضافي فقط.

**القالب لا يُبنى بدمج النصوص.** بيانات اللقطة تُمرَّر إلى Typst ملف JSON يقرؤه القالب بـ`json()`. لا يُحقن أي نص من المستخدم داخل ترميز Typst. هذا يغلق حقن القوالب من الأساس.

**شرط القبول:** الـPOC المعزول بمعاييره القابلة للاختبار في [POC.md](POC.md). إذا فشل Typst في شرط جوهري يُعتمد Gotenberg عبر نفس واجهة `DocumentRenderer` (ADR DOC-01)، بشبكة معطلة بالكامل، وأصول مضمّنة، ودون JavaScript.

---

## 4. النموذج

### 4.1 ما يعيش في الكود وما يعيش في القاعدة

| الطبقة | المكان | السبب |
|---|---|---|
| نوع المستند (DocumentType) وعقد البيانات والمزوّد | الكود: `src/lib/documents/types/*.ts` | منطق مختبر ومراجَع، وله إصدار مع رديف نفسه. |
| القالب (Template) | الكود: `src/lib/documents/templates/<type>/<locale>@<version>.typ`، ويُرسل مع طلب التصيير (`outputFileTracingIncludes` لبناء standalone) | لا حقن، ويمر بمراجعة الكود، وله اختبارات golden، والمحرك يعرف بصمته بالضبط. |
| سياسة النوع لكل شركة (تفعيل، اعتماد، صلاحية، موقّع افتراضي) | القاعدة: `DocumentTypeSetting` | يغيّرها العميل من الإعدادات. |
| نصوص قابلة للتخصيص (فقرة الافتتاح، التذييل) | القاعدة: `DocumentTextOverride` (صفوف لا تُعدَّل، وكل تعديل صف جديد) | تخصيص دون مصمم. |
| الهوية (شعار، ألوان، بادئة الترقيم) | القاعدة: `BrandProfile` + أصول مخزنة بعنوان المحتوى (sha256) | الشعار القديم يبقى متاحاً لإعادة تصيير المستندات القديمة. |

### 4.2 تعريف نوع مستند

```ts
// src/lib/documents/types/salary-certificate.ts
export const salaryCertificate = defineDocumentType({
  key: 'SALARY_CERTIFICATE',
  code: 'SAL', // رمز الترقيم (DOC-02): ثابت بعد أول إصدار
  contractVersion: 1,
  labels: { ar: 'خطاب تعريف بالراتب', en: 'Salary Certificate' },

  // مدخلات الطالب: تدخل اللقطة كما هي
  params: z.object({
    addressee: z.string().trim().max(120).default('إلى من يهمه الأمر'),
    language: z.enum(['ar', 'en', 'ar-en']).default('ar'),
  }),

  // عقد البيانات: هذا كل ما يراه القالب
  data: z.object({
    employee: z.object({ fullNameAr: z.string(), fullNameEn: z.string().nullable(), employeeNumber: z.string(),
      nationality: z.string(), idNumber: z.string(), jobTitle: z.string(), joinDate: isoDate }),
    company: z.object({ legalNameAr: z.string(), legalNameEn: z.string().nullable(), crNumber: z.string(),
      unifiedNumber: z.string().nullable() }),
    salary: z.object({ basic: money, housing: money, transport: money, other: money, total: money }),
  }),

  provider: loadSalaryCertificateData, // (tx, { employeeId, legalCompanyId, asOf }) => Data
  validate: [requireActiveEmployee, requireLegalCompany, requirePositiveSalary],

  readRoles: ROLE_GROUPS.PAYROLL,  // من يرى بيانات الراتب ويصدرها
  selfService: true,               // يطلبه الموظف من البوابة لنفسه
  defaults: { requiresApproval: false, validityDays: 90, signatory: 'DEFAULT_HR' },
  templates: { ar: 'salary-certificate/ar@1', en: 'salary-certificate/en@1', 'ar-en': 'salary-certificate/ar-en@1' },
});
```

**اللقطة قانونية الشكل (canonical)** حتى يكون الـhash ثابتاً:

- المبالغ نصوص عشرية بمنزلتين (`"15000.00"`) لا `Float`، لأن `Float` في المخطط يسبب انحرافاً في التسلسل. التحويل عبر `src/lib/money.ts`.
- التواريخ `YYYY-MM-DD` بتوقيت الرياض.
- المفاتيح مرتبة (JCS، RFC 8785).
- اللقطة تحتوي حقول العقد فقط، لا سجل الموظف كاملاً. هذا تقليل للبيانات الشخصية المحفوظة إلى الأبد.

**نموذج العرض (render model)** يُبنى من اللقطة في `src/lib/documents/render-model.ts` (ADR DOC-01):
- مبالغ منسّقة (لاتينية أو مشرقية حسب إعداد الشركة).
- التاريخ الميلادي والهجري (أم القرى عبر ICU، مع جدول أسماء أشهر إنجليزية خاص بالمحرك).
- QR بصيغة SVG من مكتبة `qrcode` الحالية.
- حذف الحركات العربية من كل النصوص.

القالب يعرض النصوص كما هي فقط.

**قواعد كتابة القوالب** (من الـPOC):
1. `#set text(fallback: false)`، ولا `#import "@preview/…"`.
2. النص العربي الثابت بلا حركات ولا تنوين («اعتبارا» لا «اعتباراً»)، لأن Typst يكرر علامات التشكيل في طبقة النص.
3. لا يُضمَّن اسم لاتيني طويل في نص عربي جارٍ. يوضع في العمود الإنجليزي أو في جدول بيانات.
4. الأرقام اللاتينية داخل النص العربي تُلف بـ`text(dir: ltr)`.
5. المبالغ بمحاذاة يمنى داخل العمود، فتقع الفواصل العشرية على خط واحد.
6. كتلة التوقيع والختم والـQR داخل `block(breakable: false)`، و`table.header` للجداول.
7. الـQR لا يقل عن 30 مم مع الهامش (نحو 24 مم للرمز).

### 4.3 الجداول (مسودة Prisma)

```prisma
model BrandProfile {
  id            String  @id @default(uuid())
  companyId     String  @unique
  logoAssetId   String?            // DocumentAsset
  primaryColor  String  @default("#0F4C81")
  numberPrefix  String             // مثل "ACM" ← ACM-SAL-2026-000184
  numerals      String  @default("latn") // latn | arab
  addressAr     String?
  addressEn     String?
  phone         String?
  email         String?
  website       String?
  footerAr      String?
  footerEn      String?
  updatedAt     DateTime @updatedAt
}

/// أصل ثابت بعنوان المحتوى: الملف لا يُستبدل أبداً، والتغيير يعني أصلاً جديداً
model DocumentAsset {
  id        String   @id @default(uuid())
  companyId String
  kind      String   // LOGO | SIGNATURE | STAMP
  sha256    String   @unique
  mimeType  String   // png فقط، بعد فحص البايتات السحرية
  createdById String?
  createdAt DateTime @default(now())
}

model Signatory {
  id              String   @id @default(uuid())
  companyId       String
  userId          String?  // إن كان له حساب: يعتمد بنفسه
  nameAr          String
  nameEn          String?
  titleAr         String
  titleEn         String?
  signatureAssetId String?
  stampAssetId    String?
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  @@index([companyId, isActive])
}

/// تفويض صريح وقابل للإلغاء والتدقيق (ADR DOC-04). لا يُعدَّل: الإلغاء يملأ revokedAt، والتغيير صف جديد
model SigningAuthorization {
  id             String    @id @default(uuid())
  signatoryId    String
  legalCompanyId String
  typeKey        String
  mode           String    // PRE_AUTHORIZED
  scope          Json?     // مثل { maxTotalSalary: "30000.00" }
  validFrom      DateTime
  validUntil     DateTime?
  grantedById    String    // ROLE_GROUPS.OWNER
  grantedAt      DateTime  @default(now())
  acceptedAt     DateTime? // قبول الموقّع نفسه (إن كان له حساب). بدونه لا يسري
  revokedAt      DateTime?
  revokedById    String?
  revokeReason   String?
  @@index([signatoryId, typeKey, legalCompanyId])
}

model DocumentTypeSetting {
  id               String  @id @default(uuid())
  companyId        String
  typeKey          String
  enabled          Boolean @default(true)
  selfService      Boolean
  requiresApproval Boolean
  validityDays     Int?
  signatoryId      String?
  @@unique([companyId, typeKey])
}

model DocumentRequest {
  id              String   @id @default(uuid())
  typeKey         String
  legalCompanyId String   // مشتقة: employee.legalCompanyId، لا يختارها المستخدم
  employeeId      String
  requestedById   String?
  source          String   // PORTAL | HR | SYSTEM
  params          Json
  status          String   // §5
  snapshotId      String?  @unique
  issuedDocumentId String? @unique
  rejectReason    String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([status, createdAt])
  @@index([employeeId])
}

/// لا تُعدَّل بعد الإنشاء
model DocumentSnapshot {
  id              String   @id @default(uuid())
  typeKey         String
  contractVersion Int
  data            Json     // canonical
  dataSha256      String
  brand           Json     // قيم الهوية وsha256 الأصول وقت اللقطة
  createdAt       DateTime @default(now())
}

model DocumentApproval {
  id             String   @id @default(uuid())
  requestId      String
  approverId     String
  decision       String   // APPROVED | REJECTED
  snapshotSha256 String   // الاعتماد مربوط بالبيانات التي رآها المعتمد (ADR DOC-05)
  note           String?
  decidedAt      DateTime @default(now())
  invalidatedAt  DateTime? // تغيّرت بيانات جوهرية قبل الإصدار
  invalidReason  String?   // STALE_SNAPSHOT
  @@index([requestId])
}

/// معالجة تقنية فقط (ADR DOC-08): لا تظهر في حالة الطلب ولا حالة المستند
model DocumentRenderJob {
  id              String   @id @default(uuid())
  requestId       String   @unique
  legalCompanyId  String
  number          String   // محجوز قبل التصيير، ثابت عبر المحاولات (DOC-02)
  verifyTokenHash String   @unique
  status          String   // QUEUED | RENDERING | FAILED | DONE
  attempts        Int      @default(0)
  lastError       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([legalCompanyId, number])
  @@index([status])
}

/// يُنشأ فقط بعد وجود البايتات وبصمتها. الأعمدة الموسومة (i) يحميها trigger من UPDATE (DOC-07)
model IssuedDocument {
  id              String    @id @default(uuid())
  number          String    // (i) ACM-2026-000184
  legalCompanyId  String    // (i)
  employeeId      String    // (i) onDelete: Restrict. السجل يبقى ولو حُذف الموظف
  typeKey         String    // (i)
  requestId       String    @unique // (i)
  snapshotId      String    @unique // (i)
  snapshotSha256  String    // (i)
  approvalId      String?   // (i) null إن كانت السياسة لا تطلب اعتماداً
  signatoryId     String?   // (i)
  authorizationId String?   // (i) SigningAuthorization الذي سمح بطباعة التوقيع
  templateRef     String    // (i) typst:salary-certificate/ar-en@1
  templateSha256  String    // (i)
  pdfStandard     String    // (i) a-2b
  rendererId      String    // (i) typst | gotenberg
  rendererVersion String    // (i)
  fontsSha256     String    // (i) بصمة حزمة الخطوط
  storagePath     String    // (i) documents/<legalCompanyId>/<yyyy>/<id>.pdf
  pdfSha256       String    // (i)
  verifyTokenHash String    @unique // (i) sha256(token)؛ الرمز نفسه داخل الـQR فقط
  validUntil      DateTime? // (i) يُحسب مرة عند الإصدار من validityDays
  issuedAt        DateTime  // (i)
  issuedById      String?   // (i)
  status          String    // ISSUED | REVOKED | SUPERSEDED. لا EXPIRED
  revokedAt       DateTime?
  revokedById     String?
  revokeReason    String?
  supersededById  String?   @unique
  @@unique([legalCompanyId, number])
  @@index([employeeId, issuedAt])
  @@index([status])
}

model DocumentCounter {
  legalCompanyId String
  typeCode       String // SAL | EMP | EXP ... من سجل الأنواع، ثابت
  year           Int
  next           Int    @default(1)
  @@id([legalCompanyId, typeCode, year])
}

/// سجل إلحاق فقط، بسلسلة hash
model DocumentEvent {
  id         String   @id @default(uuid())
  seq        BigInt   @unique @default(autoincrement())
  requestId  String?
  documentId String?
  type       String   // §12
  actorId    String?
  ip         String?
  meta       Json?
  prevHash   String
  hash       String   // sha256(prevHash + canonical(event))
  at         DateTime @default(now())
  @@index([documentId])
  @@index([requestId])
}
```

**لا يوجد جدول Templates أو TemplateVersions.** القالب ملف في الكود، ومرجعه وhash محتواه يُحفظان على كل مستند صادر. هذا يحقق هدف المقترح في §8 دون جدول يُدار يدوياً.

---

## 5. دورة الحياة

آلتا حالات بدل آلة واحدة.

**الطلب (سير العمل):**

```
DRAFT ──► PENDING_APPROVAL ──► APPROVED ──► ISSUED
  │          ▲      │              │
  │          │      └──► REJECTED  │
  │          └─── (لقطة قديمة: إبطال الاعتماد ولقطة جديدة) ──┘
  └──► CANCELLED
```

- الانتقال من DRAFT إلى APPROVED مباشرة إذا كانت السياسة لا تطلب اعتماداً.
- الطلب يبقى `APPROVED` طوال التصيير وإعادة محاولاته. التقدم التقني في `DocumentRenderJob` (QUEUED / RENDERING / FAILED / DONE)، ولا يظهر في حالة الطلب (ADR DOC-08). الواجهة تعرض «قيد التجهيز» من المهمة.

**المستند الصادر (الأثر):**

```
ISSUED ──► REVOKED
   └─────► SUPERSEDED (أُصدر بديل برقم جديد)
```

- **`EXPIRED` لا تُخزَّن.** تُحسب `validUntil != null && now > validUntil` وقت العرض، و`validUntil` نفسه يُحسب مرة عند الإصدار من `validityDays`.
- **اللقطة القديمة (ADR DOC-05):** عند الإصدار يُعاد بناء اللقطة ويُقارن الـhash. إذا تغيّر حقل جوهري: يُبطل الاعتماد (`invalidatedAt`، `STALE_SNAPSHOT`)، وتُنشأ لقطة جديدة، ويعود الطلب إلى `PENDING_APPROVAL`، ويُشعَر المعتمد. لا يصدر شيء، ولا يُحجز رقم.

---

## 6. خط الإصدار

دالة واحدة `issueDocument(requestId, actor)` في `src/lib/documents/issue.ts`:

1. **التفويض:** دور المستخدم في `readRoles` للنوع، أو الموظف نفسه إذا كان `selfService`. لا يُقبل `employeeId` من الطلب في البوابة، بل من الجلسة.
2. **جهة الإصدار:** `employee.legalCompanyId`، ويُرفض الطلب إن كانت فارغة. إذا اختلفت الشركة الفعلية يظهر تنبيه لموظف الموارد البشرية ولا يتغير المُصدِر.
3. **البيانات:** المزوّد ← تحقق zod ← قواعد `validate` (موظف نشط، راتب أكبر من صفر، إقامة غير منتهية تظهر تحذيراً لا منعاً).
4. **اللقطة:** canonical ثم SHA-256 ثم حفظ.
5. **السياسة:** إن لزم اعتماد ← `PENDING_APPROVAL` وإشعار عبر `NotificationOutbox` وينتهي الخط هنا.
6. **فحص اللقطة والتوقيع:** إعادة بناء اللقطة ومقارنتها بالمعتمدة (DOC-05)، ثم تحديد هل تُطبع صورة التوقيع (DOC-04: اعتماد الموقّع نفسه أو `SigningAuthorization` ساري ومطابق).
7. **معاملة قصيرة:** حجز الرقم (§7)، وتوليد رمز التحقق، وإنشاء `DocumentRenderJob` بحالة `QUEUED` ومعه الرقم، وحدث `NUMBER_RESERVED`.
8. **التصيير خارج المعاملة:** `DocumentRenderer.render()` بالقالب واللقطة والأصول والرقم ورابط التحقق. ثم `SignatureProvider.seal()` إن وُجد (مرحلة 3).
9. **الكتابة مرة واحدة:** ملف مؤقت ثم fsync ثم rename، وفشل إذا كان الملف موجوداً. ثم SHA-256 للبايتات.
10. **الإتمام في معاملة:** إنشاء `IssuedDocument` بكل حقول DOC-07، والمهمة `DONE`، والطلب `ISSUED`، وحدث `ISSUED`، وإشعار الموظف «خطابك جاهز».
11. **الفشل:** المهمة `FAILED` مع `attempts` و`lastError`، وتعيدها `scripts/jobs.mjs` بالرقم نفسه. لا يُنشأ `IssuedDocument`، والرقم لا يضيع ولا يُعاد استخدامه.

**الإصدار الجماعي** (قسائم الشهر، شهادات حملة بنكية) يمر عبر `JobRun` بتوازٍ محدود (2 لكل عميل)، حتى لا يخنق عميلٌ واحد الخدمة المشتركة.

---

## 7. الترقيم

- الصيغة: `<numberPrefix>-<TYPE>-<YYYY>-<000000>` (ADR DOC-02)، لكل شركة نظامية ونوع مستند وسنة ميلادية.
- الحجز داخل المعاملة:
  `UPDATE "DocumentCounter" SET next = next + 1 WHERE ... RETURNING next - 1`
  مع upsert أول مرة في السنة. قفل الصف يضمن عدم تكرار الرقم تحت التزامن.
- الرقم يُحجز **قبل** التصيير لأنه مطبوع داخل الـPDF. لذلك لا فجوات إلا بإلغاء صريح، والإلغاء مسجّل.
- الرقم معروض للبشر فقط، ولا يصلح للتحقق لأنه قابل للتخمين. التحقق بالرمز المعتم.

---

## 8. التحقق العام

**الرابط:** `https://<نطاق العميل>/v/<token>`. الرمز 128 بت عشوائي بترميز base32 (26 حرفاً). يُحفظ `sha256(token)` فقط، فتسريب القاعدة لا يعطي روابط صالحة.

**الصفحة** عامة بلا جلسة، مع `rate-limit` (`src/lib/rate-limit.ts`). وتعرض بياناً وصفياً أدنى ومقصوداً (ADR DOC-06):

| يظهر | لا يظهر (افتراضياً ودائماً) |
|---|---|
| الحالة: ساري / ملغى (بتاريخه) / مستبدل / منتهي الصلاحية | اسم الموظف، ولو مقنّعاً |
| نوع المستند ورقمه | الراتب وأي مبلغ |
| الاسم النظامي للشركة المُصدرة | رقم الإقامة أو الهوية، والجنسية والمسمى |
| تاريخ الإصدار (ميلادي وهجري) وتاريخ انتهاء الصلاحية | أي حقل من عقد البيانات |

إضافة أي حقل لهذه الصفحة تعديلٌ على الـADR، وليست إعداداً للعميل.

**مطابقة الملف دون رفعه:** زر «تحقق من الملف». يختار المستلم الـPDF، فيُحسب SHA-256 في المتصفح عبر `crypto.subtle` ويُقارن بـ`pdfSha256`. الملف لا يغادر جهاز المستلم، ويُكشف أي تعديل ولو بحرف.

**طبقة النص ليست أداة تحقق.** نسخ النص العربي من الـPDF يختلف حسب العارض. poppler وMuPDF يعكسان المحارف المركبة لأي منتج PDF، بما فيه Chromium ([POC.md](POC.md) §B1). لا يُوعد العميل بدقة النسخ واللصق، والتحقق بالـQR والبصمة فقط.

كل زيارة تسجّل حدث `DOCUMENT_VERIFIED` بعنوان IP مقتطع (/24). والصفحة ترسل `Referrer-Policy: no-referrer` و`X-Robots-Tag: noindex`.

---

## 9. التوقيع والختم وتفويض الصلاحية

أربعة مستويات، ولا يُدّعى أي مستوى لم يُنفَّذ:

| المستوى | ما هو | المرحلة |
|---|---|---|
| مرئي | صورة توقيع وختم على الصفحة | 1 |
| مرتبط بالنظام | QR + سجل hash + صفحة تحقق. هذا ما يجعل المستند قابلاً للتحقق فعلاً | 1 |
| ختم رقمي PAdES بمفتاح المنشأة | تعديل أي بايت يُبطل التوقيع في Acrobat. المفتاح يُودَع مثل `DATA_ENCRYPTION_KEY` (DEC-004 بند 8) | 3 |
| توقيع من مزود ثقة معتمد | عبر `SignatureProvider` للمستندات التي تحتاج حجية أعلى | 3، عند الطلب |

**صياغة الواجهة:** «مستند صادر من النظام وقابل للتحقق». لا تُستخدم «موقّع إلكترونياً» قبل المستوى الثالث.

**مصفوفة التفويض:** هذه أهم إضافة على المقترح، لأن الختم أداة تزوير إذا أُسيء استخدامه.

- أربع طبقات منفصلة (ADR DOC-04): **الأصل** (`DocumentAsset`)، و**التفويض** (`SigningAuthorization`)، و**الاعتماد** (`DocumentApproval`)، و**الإصدار** (`IssuedDocument`). وجود صورة التوقيع وحده لا يطبعها.
- صورة التوقيع تُطبع فقط في إحدى حالتين، عند لحظة الإصدار:
  1. الموقّع نفسه (`Signatory.userId`) اعتمد هذه اللقطة.
  2. `SigningAuthorization` ساري: غير ملغى، وضمن مدته، ومقبول من الموقّع، ومطابق لنوع المستند والشركة النظامية، والمستند داخل `scope`.
- التفويض يمنحه المالك صراحة، ويُلغى بـ`revokedAt`. المنح والقبول والإلغاء أحداث في `DocumentEvent`، وكل مستند يحفظ `authorizationId` الذي استخدمه.
- إن لم تتحقق أي حالة: يُطبع الاسم والمسمى دون صورة، أو يُمنع الإصدار إن اشترطت سياسة النوع التوقيع.
- رفع أصل توقيع أو ختم أو استبداله: للمالك فقط (`ROLE_GROUPS.OWNER`)، ويُسجَّل حدثاً، ويُشعَر كل الموقّعين في الشركة.
- الأصول لا تُخدم عبر `/api/files` أبداً، وتُقرأ من القرص للمصيّر فقط.

---

## 10. الأمن والصلاحيات

- **العزل بين العملاء:** بنيوي (DEC-004)، ولا يحتاج كوداً في المحرك.
- **العزل بين الشركات داخل العميل:** جهة الإصدار مشتقة من الموظف ولا يرسلها العميل. والموقّع يجب أن يتبع جهة الإصدار نفسها، ويُتحقق من ذلك في الخادم. الإداري غير محصور بشركة اليوم؛ حصر المستخدمين بالشركات فجوة عامة في رديف تُعالج خارج هذه الوثيقة.
- **IDOR:** كل مسار يبدأ بـ«من يحق له هذا المستند؟» لا بـ`findUnique({ id })` فقط. الموظف يرى مستنداته، والأدوار ترى الأنواع التي تملك `readRoles` لها.
- **التنزيل:** مسار مخصص `/api/documents/[id]/pdf` بتفويض على مستوى المستند، مع حدث `DOCUMENT_DOWNLOADED`. **لا** يمر عبر `/api/files`، الذي أثبت DEC-008 أنه مفتوح لكل الأدوار الإدارية.
- **الراتب:** أنواع فيها مبالغ تحمل `readRoles: PAYROLL`. الموظف يطلب خطابه بنفسه، ولا يرى خطابات غيره.
- **المصيّر:** بلا شبكة، وبلا وصول لملفات العملاء، وبرمز خدمة، مثل `radeef-face`.
- **النصوص المخصصة:** نص عادي مع متغيرات `{{employee.fullNameAr}}`. عند الحفظ يُتحقق أن كل متغير موجود في عقد النوع، وتُمرَّر إلى القالب بيانات لا ترميزاً.

---

## 11. التخزين والاحتفاظ

- المسار: `<UPLOAD_DIR>/documents/<companyId>/<yyyy>/<documentId>.pdf`، والأصول في `<UPLOAD_DIR>/document-assets/<sha256>.png`.
- الكتابة مرة واحدة: لا استبدال ولا حذف من التطبيق.
- الصيغة PDF/A-2b للأرشفة طويلة الأمد. نجحت في الـPOC.
- داخل النسخ الاحتياطي الحالي تلقائياً لأنه تحت `UPLOAD_DIR`، ويجب التحقق من ذلك في `ops/`.
- التشفير مؤجل حسب DEC-008 بند 4 حتى إيداع المفاتيح، ويُعتمد تشفير القرص حتى ذلك الحين.
- **الاحتفاظ:** 10 سنوات بعد انتهاء الخدمة، ثم حذف الملف واللقطة بمهمة مجدولة، مع بقاء صف السجل بلا بيانات شخصية (ADR DOC-09). الإلغاء وحده لا يحذف شيئاً. و`employeeId` بـ`Restrict` حتى لا يمحو حذف الموظف سجل ما صدر باسمه.

---

## 12. التدقيق

`DocumentEvent` جدول مستقل عن `AuditLog`، للأسباب التالية:

- **إلحاق فقط:** دور قاعدة البيانات للتطبيق يُمنح `INSERT, SELECT` دون `UPDATE, DELETE` على هذا الجدول، عبر ترحيل.
- **سلسلة hash:** كل حدث يحمل hash السابق. أي حذف أو تعديل في الوسط يكسر السلسلة، وتفحصها مهمة ليلية.
- الأحداث: `REQUEST_CREATED`، `SNAPSHOT_CREATED`، `APPROVAL_REQUESTED`، `APPROVED`، `REJECTED`، `APPROVAL_INVALIDATED`، `NUMBER_RESERVED`، `RENDER_FAILED`، `ISSUED`، `VIEWED`، `DOWNLOADED`، `REVOKED`، `SUPERSEDED`، `VERIFIED`، `ASSET_CHANGED`، `SIGNATORY_CHANGED`، `AUTHORIZATION_GRANTED`، `AUTHORIZATION_ACCEPTED`، `AUTHORIZATION_REVOKED`، `POLICY_CHANGED`.
- تُرسل نسخة من الأحداث إلى `logAudit` أيضاً، لتظهر في شاشة التدقيق الحالية وتُشحن خارج الخادم مع بقية السجلات (DEC-008 بند 5).

---

## 13. الربط بما هو موجود

| الموجود اليوم | بعد المحرك |
|---|---|
| البوابة: «شهادة أو خطاب» يُرسل `AttendanceCorrection` بنوع `GENERAL` ونص حر، وتصدره الموارد البشرية يدوياً خارج النظام (`src/app/portal/page.tsx:894`) | `DocumentRequest` بـ`source: PORTAL`. الأنواع المفعّلة بلا اعتماد تصدر فوراً، والبقية تدخل طابور «طلبات المستندات» |
| `src/app/evaluations/print/[evalId]` طباعة من المتصفح | نوع `EVALUATION_REPORT`، ويبقى الطباعة حلاً احتياطياً |
| اعتماد التسوية (`Settlement`) | يقترح النظام «شهادة خبرة» و«إخلاء طرف» (DOM-005) بحدث `SYSTEM` |
| التحقيق والخصم | «خطاب إنذار» و«محضر تحقيق» بلقطة مربوطة بالقرار |
| محرك القرارات، الوحدة 10 (تصدير PDF) | يستخدم نفس `radeef-render`، دون ترقيم ولا تحقق، لأنه تقرير داخلي لا مستند رسمي |
| `SalaryChange` | مصدر الراتب في اللقطة: آخر تغيير مطبّق (`isPlanned = false`) حتى تاريخ الإصدار |

**التاريخ الهجري:** `Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura')` في Node مع ICU الكامل، ويُحسب في الخادم ويدخل اللقطة نصاً. المصيّر لا يحسب تواريخ.

---

## 14. المراحل

| المرحلة | المحتوى | معيار الإنهاء |
|---|---|---|
| **0. POC** | مصيّر Typst معزول وقالب شهادة راتب واحد، دون تغيير في التطبيق | كل معايير [POC.md](POC.md) |
| **1. النواة** ✅ مبنية ومُختبرة (2026-09-26): الجداول والترحيل 11 مع triggers، و`src/lib/documents/`، وواجهات API، وصفحة التحقق `/v/<token>`، وصفحتا `/documents` و`/documents/settings`، وبطاقة البوابة. 12 اختبار تكامل على Postgres حقيقي وخدمة التصيير. | الجداول، والمحرك، والترقيم، وصفحة التحقق، و`BrandProfile`، والموقّعون، ومسار التنزيل. الأنواع: تعريف بالراتب، وتعريف بدون راتب، وشهادة خبرة. وربط البوابة | موظف يطلب خطاباً من الجوال ويستلمه PDF، وبنك يتحقق منه بالـQR |
| **2. سير العمل** | الاعتماد، والنصوص المخصصة، ومصفوفة التفويض، والإلغاء والاستبدال. وأنواع جديدة: إنذار، وإخلاء طرف، وتسوية، وتقييم، وقسيمة راتب جماعية | كل الأنواع أعلاه دون طباعة يدوية خارج النظام |
| **3. الحجية** | ختم PAdES، و`SignatureProvider`، وملحق عقد يقبله الموظف | فتح المستند في Acrobat يظهر توقيعاً سليماً |
| لاحقاً، عند طلب فعلي | مصمم قوالب مرئي | عميلان على الأقل يطلبانه |

**خارج النطاق صراحة:**

- **الفواتير وعروض الأسعار:** تخضع لفاتورة (ZATCA)، وتحتاج XML (UBL) وختماً تشفيرياً وربطاً بالهيئة. محرك منفصل إن احتيج.
- **عقد العمل الرسمي:** يوثَّق في منصة قوى. رديف يصدر ملحقات ومسودات فقط.
- **نسخ نماذج حكومية:** لا تُصدر مستندات تحاكي شكل جهة حكومية.

---

## 15. قرارات مطلوبة من المالك

1. ~~المصيّر~~: حُسم في ADR DOC-01 (Typst أولاً، وGotenberg بديلاً إن فشل الـPOC). النتيجة في [POC.md](POC.md).
2. ~~الاعتماد الافتراضي~~ **حُسم:**
   - تعريف الراتب والتعريف وشهادة الخبرة تصدر فوراً إذا وُجد تفويض مسبق ساري للموقّع، وإلا تنتظر اعتماده.
   - الإنذار والمستندات التأديبية دائماً باعتماد.
   - كل شركة تغيّر ذلك من `DocumentTypeSetting`.
3. ~~مدة الصلاحية~~ **حُسم:** 90 يوماً لخطابات الراتب والتعريف، وبلا انتهاء لشهادة الخبرة. قابلة للتغيير لكل شركة.
4. ~~الاسم في صفحة التحقق~~: حُسم في ADR DOC-06، فلا اسم.
5. ~~مدة الاحتفاظ~~ **حُسم:** 10 سنوات بعد انتهاء الخدمة، ثم حذف الملف واللقطة وبقاء صف السجل بلا بيانات شخصية (ADR DOC-09). يؤكده المستشار ضمن DEC-008.
6. ~~التفويض المسبق~~: حُسم في ADR DOC-04. مسموح بتفويض صريح ومقيد وقابل للإلغاء، ويقبله الموقّع.
7. ~~صيغة الرقم~~ **حُسم:** `<prefix>-<TYPE>-<YYYY>-<000000>` بتسلسل مستقل لكل نوع (ADR DOC-02).
8. ~~حذف التشكيل~~ **حُسم:** الأسماء والنصوص تُطبع بلا حركات (نموذج العرض، ADR DOC-01).

---

## 16. طريقة التحقق

- **Golden:** لكل قالب ولغة، لقطة ثابتة تعطي SHA-256 محفوظاً في الاختبار. أي تغيير في القالب أو الخط أو المصيّر يكسره عمداً.
- **الترقيم تحت التزامن:** 50 إصداراً متوازياً لنفس الشركة تعطي 50 رقماً متتالياً بلا تكرار ولا فجوة.
- **اللقطة القديمة:** تغيير `SalaryChange` بعد الاعتماد يوقف الإصدار.
- **IDOR:** موظف يطلب `/api/documents/<مستند غيره>/pdf` فيحصل على 404. ووكيل المشتريات يطلب خطاب راتب فيحصل على 403.
- **جهة الإصدار:** موظف شركته النظامية A وشركته الفعلية B يصدر خطابه بهوية A وسجلها التجاري.
- **التحقق العام:** رمز خاطئ يعطي 404 بزمن ثابت. ومستند ملغى يعرض «ملغى» بتاريخه. وتعديل بايت واحد في الـPDF يجعل «تحقق من الملف» يفشل.
- **سلسلة التدقيق:** حذف حدث يدوياً من القاعدة تكتشفه المهمة الليلية.
- **المصيّر معزول:** من داخل الخدمة، `curl` لأي عنوان خارجي يفشل، وقراءة `/var/lib/radeef` تفشل.

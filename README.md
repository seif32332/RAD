<div align="center">

# رديف — Radeef HRMS

### نظام إدارة الموارد البشرية والكيانات المؤسسية

**منصة متكاملة لإدارة شؤون الموظفين والكيانات القانونية في المملكة العربية السعودية**

![Next.js](https://img.shields.io/badge/Next.js-16.1-black?logo=next.js)
![React](https://img.shields.io/badge/React-19.2-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Prisma](https://img.shields.io/badge/Prisma-5.22-2D3748?logo=prisma)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-336791?logo=postgresql)
![TailwindCSS](https://img.shields.io/badge/Tailwind-4-38B2AC?logo=tailwindcss)

</div>

---

## نبذة عن المشروع

**رديف (Radeef)** نظام إدارة موارد بشرية (HRMS) صُمم للسوق السعودي لتلبية احتياجات الشركات ذات الهياكل التنظيمية المعقدة (شركات متعددة ← إدارات ← فروع ← أقسام). يغطي النظام العمليات الإدارية من أرشفة بيانات الموظفين ووثائقهم إلى مسير الرواتب والتسويات المالية والإدارة القانونية واللوجستيات.

يُشغَّل النظام بنموذج **نسخة لكل عميل (single-tenant per instance)**: الكود واحد، ولكل عميل عملية تطبيق مستقلة وقاعدة بيانات مستقلة ومجلد ملفات مستقل ونطاق مستقل، فلا تختلط بيانات عميل بآخر.

> **حالة الجاهزية:** راجع [`PRODUCTION_READINESS_PLAN.md`](PRODUCTION_READINESS_PLAN.md) لنتائج المراجعة الكاملة وخطة الإصلاح، و[`docs/RUNBOOK.md`](docs/RUNBOOK.md) للإجراءات الفورية المطلوبة على السيرفر.

---

## البنية التقنية

| الطبقة | التقنية | الإصدار |
|---|---|---|
| الإطار | Next.js (App Router, `output: 'standalone'`) | 16.1 |
| الواجهة | React | 19.2 |
| اللغة | TypeScript (strict) | 5.x |
| التنسيق | Tailwind CSS | 4.x |
| قاعدة البيانات | PostgreSQL | 14 أو أحدث (16 مُوصى به) |
| ORM والترحيل | Prisma + `prisma migrate` | 5.22.0 |
| التحقق من المدخلات | zod | 3.x |
| الجلسات | jose (JWT HS256 في cookie) | 5.x |
| كلمات المرور | bcryptjs | 3.x |
| Excel | exceljs 4.4 و SheetJS (`xlsx` 0.20.3 من CDN الرسمي) | — |
| البريد | nodemailer | 6.x |
| الاختبارات | Vitest | 3.x |
| Node.js | يُشترط `>=20.9 <25` (يُوصى بـ 22 LTS) | — |

**حجم الكود:** نحو 90 صفحة، وأكثر من 110 ملف مسار API، و62 موديل Prisma، مع مجموعة اختبارات Vitest تغطي منطق الرواتب والتسويات والصلاحيات والتكاملات.

---

## هيكل المشروع

```
radeef/
├── prisma/
│   ├── schema.prisma            # مخطط قاعدة البيانات (62 موديل)
│   ├── migrations/              # 0_baseline + ترحيلات لاحقة (prisma migrate)
│   └── seed.mjs                 # بذرة idempotent: الجنسيات، الإعدادات الافتراضية، مدير أولي اختياري
├── scripts/
│   ├── create-admin.mjs         # إنشاء مستخدم أو إعادة تعيين كلمة مروره
│   └── muqeem-mock.mjs          # خادم محاكاة محلي لمنصة مقيم (للتطوير والاختبار فقط)
├── src/
│   ├── proxy.ts                 # يحجب كل صفحة ومسار API بلا جلسة صالحة
│   ├── app/                     # الصفحات (companies, employees, leaves, payrolls, settlements, legal, ...)
│   │   └── api/                 # مسارات الـ API + /api/health
│   ├── components/              # AppShell, DashboardLayout, ui/feedback (toast, confirmDialog) ...
│   ├── context/                 # Providers
│   └── lib/                     # auth, session, http, validation, dates, money, audit, crypto,
│                                # storage, mailer, payroll, settlement, leave, constants, prisma,
│                                # muqeem/ (تكامل مقيم), self-attendance, geo ...
├── ops/                         # سكربتات النشر والنسخ الاحتياطي والاستعادة وإنشاء مستأجر + قالب Nginx
├── services/face/               # خدمة داخلية للتحقق من الوجه في تسجيل الحضور الذاتي (لا تُكشف للإنترنت)
├── docs/                        # RUNBOOK.md, DATABASE.md, integrations/ (مقيم), قرارات المراجعة
├── radeef-manage/               # لوحة إدارة المستأجرين (خدمة مستقلة)
├── Dockerfile, docker-compose.yml, ecosystem.config.js
└── .env.example                 # كل متغيرات البيئة موثقة
```

---

## التشغيل المحلي

### المتطلبات
- Node.js 22 (أو أي إصدار بين 20.9 و 24)
- PostgreSQL 14+ محلي أو في حاوية

### الخطوات

```bash
# 1. تثبيت الحزم (postinstall يشغّل prisma generate تلقائيًا)
npm ci

# 2. ملف البيئة
cp .env.example .env
# عدّل DATABASE_URL، وضع قيمًا عشوائية لـ SESSION_SECRET و DATA_ENCRYPTION_KEY:
#   openssl rand -base64 48   # SESSION_SECRET
#   openssl rand -base64 32   # DATA_ENCRYPTION_KEY

# 3. إنشاء الجداول وتطبيق الترحيلات (لا تستخدم prisma db push)
npx prisma migrate deploy

# 4. البيانات الأساسية (آمنة للتكرار)
npm run db:seed

# 5. أول مدير نظام (يطبع كلمة مرور لمرة واحدة)
npm run admin:create -- admin@example.com

# 6. خادم التطوير
npm run dev          # http://localhost:3000
```

> لا يوجد حساب مدير مدمج في الكود. أنشئ المدير الأول بـ `npm run admin:create`، أو عبر `ADMIN_EMAIL`/`ADMIN_PASSWORD` مع `npm run db:seed` (تُستخدم فقط إذا لم يوجد SUPER_ADMIN نشط).

### أوامر npm

| الأمر | الوظيفة |
|---|---|
| `npm run dev` | خادم التطوير |
| `npm run build` | بناء الإنتاج (standalone) |
| `npm start` / `npm run start:standalone` | تشغيل البناء (`next start` أو `node .next/standalone/server.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint على المشروع (`any` الصريح تحذير مؤقتًا، لا تُضف جديدًا) |
| `npm test` | اختبارات Vitest |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | البذرة idempotent |
| `npm run admin:create -- <email> [--role ROLE] [--name "الاسم"]` | إنشاء مستخدم أو إعادة تعيين كلمة مروره |

تفاصيل الترحيلات وتبنّيها على قواعد البيانات الحية: [`docs/DATABASE.md`](docs/DATABASE.md).

---

## المصادقة والصلاحيات

- **الجلسة:** بعد تسجيل الدخول يُصدر السيرفر JWT موقّعًا (HS256) بـ `SESSION_SECRET` داخل cookie باسم `radeef_session` بخصائص `httpOnly` و`SameSite=Lax` و`Secure` في الإنتاج، وصلاحيتها 12 ساعة افتراضيًا (قابلة للتعديل من سياسة الأمان). تسجيل الخروج أو تغيير كلمة المرور يُبطل كل الجلسات السابقة للمستخدم. لا يُحفظ الدور ولا معرف المستخدم في `localStorage`.
- **الحماية العامة:** `src/proxy.ts` يحجب كل الصفحات ومسارات `/api` بلا جلسة صالحة. المسارات العامة فقط: `/login`، `/apply/*`، `/api/auth/login|logout`، `/api/health`، `/api/apply/*`، و`/api/upload` (رفع مقيّد لطلبات التوظيف).
- **التفويض على السيرفر:** كل مسار API يستدعي `requireUser(ROLE_GROUPS.X)` من `src/lib/auth.ts` (401 بلا جلسة، 403 لدور غير مسموح). مسارات الخدمة الذاتية تأخذ `employeeId` من الجلسة فقط.
- **تسجيل الدخول:** رسالة خطأ موحدة وتحديد معدل المحاولات، وكلمات المرور مخزنة بـ bcrypt.
- **الأدوار (11، من enum `Role` في Prisma):**

| الدور | الوصف |
|---|---|
| `SUPER_ADMIN` | مدير النظام |
| `COMPANY_ADMIN` | صاحب العمل / مدير الشركة |
| `HR_MANAGER` | مدير الموارد البشرية |
| `FINANCE_MANAGER` | المدير المالي |
| `PAYROLL_ADMIN` | مسؤول الرواتب |
| `GOV_RELATIONS` | العلاقات الحكومية |
| `LEGAL_ADMIN` | الإدارة القانونية |
| `BRANCH_MANAGER` | مدير الفرع / المشرف المباشر |
| `DEPT_MANAGER` | مدير الإدارة / القسم |
| `PURCHASING_AGENT` | مسؤول المشتريات |
| `EMPLOYEE` | موظف (خدمة ذاتية فقط) |

- **الملفات المرفوعة:** تُحفظ في `UPLOAD_DIR` خارج `public/`، وتُخدَّم فقط عبر المسار المحمي `/api/files/...` مع قائمة أنواع مسموحة وفحص توقيع الملف وحد 10MB (5MB للزوار). كل ملف مصنّف (هوية، جواز، صحي، بنكي، عقد، أخرى)، والوثائق الشخصية لا يقرؤها إلا الموارد البشرية والرواتب والإدارة والموظف نفسه، مع تسجيل كل قراءة. روابط `/uploads/...` القديمة تُعاد توجيهها داخليًا إلى المسار المحمي.
- **الحقول الحساسة** (مثل كلمات مرور المنصات الحكومية) مشفرة بـ AES-256-GCM بمفتاح `DATA_ENCRYPTION_KEY`.

---

## النشر

كل ما يخص التشغيل في مجلد [`ops/`](ops) ودليل التشغيل [`docs/RUNBOOK.md`](docs/RUNBOOK.md). لا تُبنَ أي نسخة فوق التطبيق العامل، ولا تُستخدم `prisma db push` في الإنتاج.

### الخيار المُوصى به: Docker Compose

- صورة واحدة (`Dockerfile`: node:22-alpine متعدد المراحل، مستخدم غير root، `HEALTHCHECK` على `/api/health`).
- حاوية لكل مستأجر في `docker-compose.yml`، منشورة على `127.0.0.1` فقط، مع `env_file` من `/etc/radeef/<tenant>.env` (صلاحية 600) و volume للملفات في `/var/lib/radeef/<tenant>/uploads`.
- PostgreSQL يبقى على السيرفر المضيف (خارج compose) بدور وقاعدة مستقلين لكل مستأجر.

```bash
sudo ops/deploy.sh --mode docker --all          # بناء الصورة مرة واحدة ثم لكل مستأجر: backup → migrate → canary → switch
sudo ops/deploy.sh --mode docker --rollback <tenant> # الرجوع للصورة السابقة (بلا تراجع عن قاعدة البيانات)
```

### البديل: PM2 على السيرفر الحالي

`ecosystem.config.js` يعرّف تطبيقًا لكل مستأجر يشغّل `.next/standalone/server.js` من مجلد الإصدار الحالي (`/opt/radeef/<tenant>/current`) بمستخدم النظام `radeef` لا root، في وضع cluster ليكون `pm2 reload` بلا توقف.

```bash
sudo -iu radeef /opt/radeef/src/ops/deploy.sh --all        # بناء مرة واحدة، ثم لكل مستأجر backup → migrate → canary → reload
sudo -iu radeef /opt/radeef/src/ops/deploy.sh --rollback <tenant>
```

### مستأجر جديد

```bash
sudo ops/new-tenant.sh --email ops@example.com <tenant> <domain> <port>
```
ينشئ دور Postgres وقاعدة بيانات بكلمة مرور عشوائية، وملف `/etc/radeef/<tenant>.env` بأسرار مولدة بـ `openssl rand`، والمجلدات، وموقع Nginx من `ops/nginx/tenant.conf.template` (HTTPS + HSTS + ترويسات أمان + صفحة صيانة عامة) وشهادة Let's Encrypt.

---

## النسخ الاحتياطي

```bash
# cron يومي على السيرفر
15 2 * * * /opt/radeef/src/ops/backup.sh --all >>/var/log/radeef/backup.log 2>&1
```
- `pg_dump -Fc` مُتحقَّق منه + أرشيف للملفات المرفوعة لكل مستأجر، مع الاحتفاظ بـ 7 يومية و4 أسبوعية و6 شهرية.
- نسخة خارج السيرفر عبر `rclone` عند ضبط `RCLONE_REMOTE` (استخدم remote مشفّرًا من نوع crypt).
- الاستعادة: `ops/restore.sh <tenant> <file.dump> [--uploads <file.uploads.tar.gz>]`. اختبر الاستعادة شهريًا.

---

## ملاحظات أمنية

- لا تُكتب أي كلمة مرور أو مفتاح أو عنوان سيرفر داخل الكود أو السكربتات أو التوثيق. كل الأسرار في ملف بيئة كل مستأجر على السيرفر، وإجراءات تدويرها في [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- لا تُرفع ملفات `.env` أبدًا؛ القالب الوحيد المسموح هو `.env.example`. الـ CI يشغّل gitleaks على كل دفعة.
- حسابات المنصات الحكومية (ومنها حساب مقيم) تُحفظ مشفرة في خزنة المنصات داخل النظام، لا في ملفات البيئة.
- احتفظ بـ `DATA_ENCRYPTION_KEY` لكل مستأجر في مدير كلمات مرور: فقدانه يجعل الحقول المشفرة غير قابلة للقراءة.
- Nginx يستبدل `X-Forwarded-For` بعنوان العميل الحقيقي (التطبيق يثق بأول قيمة فيه لتحديد المعدل وسجل التدقيق).

---

## الميزات الرئيسية

- **الكيانات والهيكل التنظيمي:** شركات متعددة ووثائقها (سجل تجاري، رقم ضريبي، شهادة ضريبية)، هيكل شركة ← إدارة ← فرع ← قسم، تراخيص الفروع وعقود الإيجار.
- **الموظفون:** ملف شامل بالوثائق والعقود، استيراد جماعي من Excel (القالب يُولَّد من النظام نفسه)، فلاتر متعددة المستويات.
- **الحضور:** تسجيل يومي، جداول عمل، طلبات تصحيح الحضور، ربط أجهزة البصمة عبر `biometricId`، وتسجيل حضور ذاتي من بوابة الموظف بالموقع الجغرافي (نطاق الفرع) والتحقق من الوجه.
- **الإجازات والتأشيرات:** مسار موافقات، حساب الرصيد، أنواع الإجازات النظامية، تأشيرات خروج وعودة ونهائي.
- **الرواتب والمالية:** مسير شهري بالبدلات والمكافآت والخصومات وأقساط السلف، التأمينات الاجتماعية بنظاميها القديم والجديد، سقف الجزاء النظامي (أجر خمسة أيام)، التسويات ونهاية الخدمة محسوبة على السيرفر، المطالبات وأوامر الدفع مع فصل صلاحيات الطلب والاعتماد والصرف.
- **الإدارة القانونية:** السندات لأمر، العقود، القضايا، التحقيقات الإدارية بنتائج مكتوبة وقرار مقفل بعد الحكم.
- **التكامل مع منصة مقيم (Elm):** مطابقة المقيمين مع ملفات الموظفين، إصدار تأشيرات الخروج والعودة وتمديدها وإلغاؤها، تجديد الإقامة، تحديث بيانات الجواز، والخروج النهائي من التصفية المعتمدة. كل عملية محمية من التنفيذ المزدوج ومسجلة، والعمليات مجهولة النتيجة لا تُعاد تلقائيًا. التفاصيل في [`docs/integrations/muqeem/README.md`](docs/integrations/muqeem/README.md).
- **اللوجستيات والخدمات:** المركبات، شرائح الاتصالات، عدادات الكهرباء والمياه، العهد والأصول.
- **البوابات والتنبيهات:** بوابة الموظف والمدير والمالك، تنبيهات موحدة للوثائق المنتهية أو القريبة من الانتهاء، سجل تدقيق للعمليات.

---

## ملاحظات للمطورين

- **التواريخ:** القيم التي هي "تاريخ فقط" تُخزَّن عند منتصف الليل UTC. استخدم `src/lib/dates.ts` (`today()`, `parseDateOnly()`, `formatDate()` ...) والعرض ميلادي بأرقام لاتينية.
- **المال:** الحقول `Float` في قاعدة البيانات؛ قرّب كل مبلغ محسوب بـ `roundMoney` من `src/lib/money.ts`.
- **الحالات:** استخدم الثوابت في `src/lib/constants.ts` (`LEAVE_STATUS`, `LOAN_STATUS`, `PAYROLL_STATUS` ...)، ولا تكتب نص حالة يدويًا.
- **الـ API:** `parseBody(req, zodSchema)` للتحقق، و`handleApiError(err, 'ctx')` للأخطاء (لا يُرجع رسالة الخطأ الخام)، و`logAudit` للعمليات الحساسة، و`prisma` من `@/lib/prisma` فقط.
- **الواجهة:** `toast` و`confirmDialog` من `src/components/ui/feedback.tsx` بدل `alert`/`confirm`.
- **تغيير المخطط:** `npx prisma migrate dev --name <وصف>` محليًا ثم مراجعة ملف SQL قبل الدمج (انظر `docs/DATABASE.md`).

---

## الترخيص

هذا المشروع خاص ومحمي. جميع الحقوق محفوظة. لا يُسمح بالنسخ أو التوزيع بدون إذن مسبق.

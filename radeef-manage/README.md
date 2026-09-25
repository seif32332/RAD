# radeef-manage — لوحة وأداة إدارة النسخ (Tenants)

لوحة ويب (Express + SQLite) وأداة سطر أوامر تتصلان بسيرفر الإنتاج عبر SSH لإدارة نسخ رديف:
إنشاء نسخة جديدة، تشغيل/إيقاف/إعادة تشغيل، التراخيص وتواريخ الانتهاء، الإيقاف عند انتهاء
الترخيص، النسخ الاحتياطي اليومي، والحذف الآمن.

> **تحذير:** هذه الأداة تنفّذ أوامر على السيرفر بصلاحيات مستخدم SSH (غالباً root). من يصل إليها
> يصل إلى بيانات كل العملاء. **لا تفتح المنفذ 3099 للعامة أبداً.**

## التشغيل

```bash
cd radeef-manage
cp .env.example .env        # ثم املأ القيم (انظر الجدول)
npm ci --omit=dev           # أو npm install أول مرة
npm start                   # اللوحة على http://127.0.0.1:3099
node cli.js help            # أداة سطر الأوامر (نفس التحقق ونفس العمليات)
```

الخدمة **ترفض البدء** إذا غاب `ADMIN_USERNAME` / `ADMIN_PASSWORD` أو كانت كلمة المرور أقل من 12 حرفاً،
أو إذا غابت بيانات SSH أو بصمة مفتاح السيرفر `SSH_HOST_FINGERPRINT`.

### الوصول الآمن

الخيار المفضل: نفق SSH من جهازك:

```bash
ssh -L 3099:127.0.0.1:3099 admin@manager-host   # ثم افتح http://localhost:3099
# في هذه الحالة فقط يمكن ضبط COOKIE_SECURE=false إذا رفض المتصفح الكوكي على http
```

أو عبر nginx مع TLS وقائمة IP مسموح بها:

```nginx
server {
    listen 443 ssl;
    server_name manage.example.com;
    ssl_certificate     /etc/letsencrypt/live/manage.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/manage.example.com/privkey.pem;

    allow 203.0.113.10;     # عناوين المكتب / VPN فقط
    deny  all;

    location / {
        proxy_pass http://127.0.0.1:3099;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;            # لبث سجل التثبيت (SSE)
        proxy_read_timeout 3600s;
    }
}
```

## المتغيرات المطلوبة

| المتغير | الوصف |
|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | حساب المشغّل الوحيد (≥ 12 حرفاً) |
| `SSH_HOST`, `SSH_USER` | السيرفر المستضيف للنسخ |
| `SSH_KEY_PATH` (مفضل) أو `SSH_PASSWORD` | المصادقة |
| `SSH_HOST_FINGERPRINT` | بصمة مفتاح السيرفر `SHA256:...` (من `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` على السيرفر) لمنع MITM |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` | اتصال مدير PostgreSQL كما يُرى من السيرفر. تُرسل كلمة المرور عبر stdin وليس في سطر الأوامر؛ أو اتركها فارغة واستخدم `~/.pgpass` على السيرفر |
| `RELEASE_DIRS` | قائمة مسموحة بمجلدات إصدار نظيفة تُنسخ منها النسخ الجديدة |

باقي المتغيرات موثقة في `.env.example`.

## ما الذي تغيّر أمنياً (مقارنة بالإصدار السابق)

- **لا حقن أوامر:** كل مُدخل يمر بتحقق صارم (`lib/validate.js`): اسم النسخة `^[a-z][a-z0-9-]{1,29}$`،
  النطاق FQDN، القالب من قائمة `RELEASE_DIRS` فقط، وكل وسيط shell يُقتبس بـ `shq()`، وكل معرّف SQL
  بـ `sqlIdent()`. الملفات (`.env`، إعدادات nginx، الصفحات) تُكتب عبر SFTP وليس `echo`.
- **لا أسرار في سطر الأوامر:** كلمة مرور Postgres وبيانات المدير الأولي تُمرر عبر stdin.
- **الجلسات:** رمز عشوائي (32 بايت) يُحفظ في ذاكرة الخادم مع انتهاء صلاحية، في كوكي
  `HttpOnly; SameSite=Strict; Secure`. لا شيء في `localStorage` ولا في الروابط. مقارنة بزمن ثابت
  وحدّ لمحاولات الدخول (5 لكل IP كل 15 دقيقة).
- **لا CORS**، ترويسات أمان (CSP، X-Frame-Options...)، والاستماع على `127.0.0.1` افتراضياً.
- **لا إيقاف صامت للعملاء:** عمليات PM2 غير المسجلة تظهر كـ "غير مسجلة" ولا تُضاف تلقائياً ولا
  تُوقف أبداً. الإيقاف التلقائي فقط لنسخة لها `end_date` حدده المسؤول (إنشاء/تجديد/تعديل الترخيص).
  السجلات القديمة (ومنها التي أضافتها النسخة السابقة تلقائياً) تُرحّل بـ `auto_suspend = 0`.
  لتفعيل الإيقاف لنسخة قديمة: "تجديد الترخيص" أو "تعديل تاريخ الانتهاء" من اللوحة.
- **صفحة صيانة عامة** عند 502/503/504 (تعطل أو إعادة نشر). صفحة "الاشتراك غير نشط" تظهر فقط
  عندما تكون النسخة موقوفة فعلاً. ملف nginx واحد لكل نطاق: `sites-available/<domain>.conf` مع
  رابط في `sites-enabled`، ويُختبر بـ `nginx -t` ويُستعاد السابق عند الفشل.
- **نسخ احتياطي يومي** (`BACKUP_CRON`, الافتراضي 02:30 بتوقيت الرياض): `pg_dump -Fc` لكل قاعدة
  بيانات غير قالبية إلى `BACKUP_DIR/daily` مع حذف ما هو أقدم من 14 يوماً. يوجد زر "نسخ احتياطي الآن"
  و`node cli.js backup`.
- **الحذف الآمن:** يتطلب كتابة اسم النسخة (يُتحقق منه في الخادم)، ولا يحذف شيئاً قبل نجاح
  `pg_dump` وأرشفة مجلد التطبيق ومجلد البيانات إلى `BACKUP_DIR/deleted` (لا تُحذف تلقائياً).
  النسخ غير المسجلة لا يمكن حذفها من اللوحة.
- **النسخ الجديدة** تُنشأ من مجلد إصدار نظيف (وليس نسخ `/root/dar` مع ملفات عميل آخر)، بقاعدة
  بيانات ودور PostgreSQL مستقلين لكل عميل، و`npx prisma migrate deploy` ثم `node prisma/seed.mjs`
  (بدلاً من `db push --accept-data-loss`)، وأسرار `SESSION_SECRET` و`DATA_ENCRYPTION_KEY` من
  `crypto.randomBytes(32)`، و`UPLOAD_DIR=/var/lib/radeef/<tenant>/uploads`. كلمة مرور المدير الأولي
  عشوائية وتُعرض للمشغّل **مرة واحدة فقط**.

## تجهيز مجلد الإصدار (مرة لكل إصدار)

```bash
git clone --branch <release-tag> <repo> /opt/radeef/release
cd /opt/radeef/release && npm ci && npx prisma generate
# لا تضع .env ولا uploads هنا
```

## أوامر CLI

```
node cli.js list
node cli.js create <name> <domain> --email <client_email> [--admin-email <e>] [--months N] [--template <dir>]
node cli.js start|stop|restart <name>
node cli.js delete <name>
node cli.js adopt <name> <domain> [--email e] [--end-date YYYY-MM-DD]
node cli.js renew <name> <months>
node cli.js backup
node cli.js check-licenses
node cli.js employees        # عدد الموظفين النشطين لكل نسخة (قراءة فقط)
node cli.js commercial <name> [--price N] [--currency SAR] [--cycle annual] [--paid-until YYYY-MM-DD] [--vat-rate N] [--includes-vat true|false]
node cli.js notices          # آخر رسائل الترخيص ونتيجتها
```

الأداة واللوحة تشتركان في `database.sqlite`. لا تشغّل عمليتي إنشاء/حذف متزامنتين من الأداة واللوحة معاً.

## ملاحظات

- إذا فُقدت كلمة مرور المدير الأولي (انقطع الاتصال قبل ظهورها): على السيرفر داخل مجلد النسخة
  `npm run admin:create -- <email> --role SUPER_ADMIN`.
- النسخ القديمة التي لها ملف nginx باسم مختلف عن `<domain>.conf` أو `<domain>`: أعد تسميته قبل
  "تسجيلها" في اللوحة حتى لا يتكرر `server_name` عند الإيقاف/التجديد.
- النسخ الاحتياطي اليومي يشمل قواعد البيانات فقط؛ خذ لقطات دورية لـ `/var/lib/radeef` (الملفات
  المرفوعة) وانسخ `BACKUP_DIR` إلى مكان خارج السيرفر.

## التراخيص والتذكير (DEC-009)

- **الإيقاف بعد تاريخ الانتهاء فقط:** تاريخ الانتهاء هو **آخر يوم مدفوع**، فتبقى النسخة تعمل طوال ذلك اليوم
  وتُوقف في أول فحص بعده (`days < 0`). الشرط السابق `days <= 0` كان يُفقد العميل آخر يوم مدفوع. التجديد في
  آخر يوم يمدّد من تاريخ الانتهاء نفسه.
- **تذكير يومي خلال آخر `LICENSE_REMINDER_DAYS` يوماً (افتراضي 14)**، مرة واحدة فقط لكل نسخة في اليوم: يُحجز سطر
  في جدول `license_notices` (SQLite) **قبل** الإرسال، فإعادة تشغيل اللوحة (`LICENSE_CHECK_ON_START`) أو تكرار
  "فحص التراخيص" لا يكرر الرسالة. تُسجَّل النتيجة `sent` أو `skipped:<السبب>` أو `failed:<الخطأ>`
  (`node cli.js notices` أو `GET /api/license-notices`).
- لم يُنفذ بعد لأنه يحتاج قرار المالك: مهلة "قراءة فقط" بدل `pm2 stop`، وتأكيد المشغّل للإيقاف في نافذة الرواتب،
  وشريط تنبيه داخل التطبيق.

## الموظفون النشطون والحقول التجارية (DEC-007)

- عمود **موظفون نشطون**: `SELECT count(*) FROM "Employee" WHERE "isTerminated" = false` على قاعدة كل نسخة
  مسجلة، عبر psql بجلسة `default_transaction_read_only = on` و`statement_timeout = 10s`. تُحفظ النتيجة مؤقتاً
  10 دقائق (`GET /api/tenants/employees?refresh=1` لإعادة الحساب).
- **حقول تجارية اختيارية** لكل نسخة (السعر، العملة، دورة الفوترة، مدفوع حتى، نسبة الضريبة، هل السعر شامل
  الضريبة) في `database.sqlite`، **فارغة افتراضياً** ويعدّلها المشغّل من اللوحة (`POST /api/tenants/commercial`).
  لا تُصدر فواتير ولا تؤثر على الترخيص. لا تُفترض نسبة ضريبة: التسجيل الضريبي وفوترة زاتكا ما زالا UNKNOWN.

## متغيرات SMTP للنسخ الجديدة

كل ملف `.env` لنسخة جديدة يحوي `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` بقيم `TENANT_SMTP_*` من ملف اللوحة (فارغة
حتى يعتمد المالك مزود البريد ويُدرج في `docs/processors.md`). نموذج الإنشاء وسجل التثبيت يعرضان المتغيرات الناقصة
قبل التثبيت (تحذير لا يمنع الإنشاء).

## قاعدة البيانات لكل نسخة جديدة (DEC-004)

- `DATABASE_URL` بـ `connection_limit=5&pool_timeout=20`.
- `ALTER ROLE <role> SET statement_timeout = '30s'` و`idle_in_transaction_session_timeout = '60s'`.
- `prisma migrate deploy` يعمل برابط فيه `options=-c lock_timeout=10s -c statement_timeout=15min` (لا ينتظر خلف قفل
  طويل، ولا يخضع لحد 30 ثانية الخاص بالتطبيق).

## النسخ الاحتياطي للوحة نفسها (DEC-004)

كل تشغيل نسخ احتياطي (`BACKUP_CRON`، زر "نسخ احتياطي الآن"، `node cli.js backup`) يبدأ بنسخة من السجل
`database.sqlite` (`VACUUM INTO`، متسقة أثناء العمل) ومن ملف `.env` الخاص باللوحة، بصلاحية 600، إلى
`PANEL_BACKUP_DIR` (افتراضي `radeef-manage/backups`)، ثم يرفعهما إلى `BACKUP_DIR/panel` على السيرفر ليُنسخا خارجياً
مع باقي النسخ. فشلها يظهر باسم `panel-registry` ضمن القواعد الفاشلة.

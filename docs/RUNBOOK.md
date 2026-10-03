# دليل التشغيل — Radeef HRMS (RUNBOOK)

هذا الدليل لمالك السيرفر ومن يتولى التشغيل. القسم 1 **إجراءات فورية** يجب تنفيذها قبل أي نشر للنسخة الجديدة، والقسم 2 الانتقال من الترتيب الحالي (تطبيق يعمل كـ root من `/root`) إلى الترتيب الجديد، والقسم 3 عمليات اليوم الثاني.

المصطلحات: `<tenant>` أحد `radeef` أو `rakan` أو `dar` (أو مستأجر جديد)، و`<domain>` نطاقه، و`<port>` منفذه المحلي (3000 / 3001 / 3002).

مرجعيات: [`../README.md`](../README.md)، [`DATABASE.md`](DATABASE.md) (الترحيلات)، [`../PRODUCTION_READINESS_PLAN.md`](../PRODUCTION_READINESS_PLAN.md)، سكربتات [`../ops/`](../ops).

---

## 1. إجراءات فورية (اليوم)

كانت هذه القيم مكتوبة نصًا داخل ملفات في المستودع (19+ ملفًا) وتُعتبر **مسرّبة**: كلمة مرور root لـ SSH، عنوان IP السيرفر، كلمة مرور مستخدم `postgres`، سرّ الجلسة الثابت لـ `dar`، وكلمة المرور الافتراضية `admin123` لحساب مدير `dar`، إضافة إلى حساب دخول خلفي ثابت في كود تسجيل الدخول القديم. حذفها من الملفات لا يكفي: هي في تاريخ git وعلى أي جهاز نُسخ إليه المستودع. **دوّرها كلها.**

### 1.1 SSH: مفاتيح بدل كلمة المرور، وإيقاف دخول root بكلمة مرور

من جهازك المحلي:
```bash
ssh-keygen -t ed25519 -C "radeef-ops"             # إن لم يكن لديك مفتاح
```
على السيرفر (ما زلت متصلًا كـ root، **لا تغلق الجلسة** حتى تتأكد من الدخول الجديد):
```bash
adduser --disabled-password --gecos "" ops
usermod -aG sudo ops
install -d -m 700 -o ops -g ops /home/ops/.ssh
# الصق المفتاح العام (id_ed25519.pub) في:
nano /home/ops/.ssh/authorized_keys && chown ops:ops /home/ops/.ssh/authorized_keys && chmod 600 /home/ops/.ssh/authorized_keys
passwd ops                                       # كلمة مرور لـ sudo فقط (لا تُستخدم لـ SSH)
```
من نافذة **ثانية** تأكد أن `ssh ops@<server>` و`sudo -v` يعملان، ثم:
```bash
cat >/etc/ssh/sshd_config.d/99-radeef-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
EOF
sshd -t && systemctl reload ssh
passwd root                                      # كلمة مرور عشوائية طويلة، تُحفظ في مدير كلمات المرور
```
فحص الاختراق (كلمة المرور كانت مكشوفة):
```bash
cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys   # احذف أي مفتاح لا تعرفه
last -a | head -50; lastb -a | head -20
journalctl -u ssh --since "-30 days" | grep -i "accepted" | awk '{print $NF, $(NF-3)}' | sort | uniq -c
crontab -l; ls /etc/cron.d /etc/systemd/system; ss -ltnp
```
الجدار الناري: التطبيق الحالي (`next start`) يستمع على `0.0.0.0` فيمكن الوصول إلى المنافذ 3000-3002 مباشرة متجاوزًا Nginx:
```bash
ufw default deny incoming
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable && ufw status verbose
```
(Postgres 5432 ولوحة `radeef-manage` يجب ألا يكونا مفتوحين للإنترنت. أوقف `radeef-manage` أو اربطه بـ `127.0.0.1` حتى تُصلح ثغرة حقن الأوامر.)
يُنصح أيضًا: `apt install fail2ban unattended-upgrades`.

### 1.2 Postgres: تدوير كلمة المرور ودور مستقل لكل مستأجر

```bash
sudo -u postgres psql -c '\l'          # حدد اسم قاعدة كل مستأجر (dar = dar_erp)
```
1. اجعل `postgres` بدون دخول شبكي: في `pg_hba.conf` يبقى `local all postgres peer` فقط، ثم دوّر كلمة مروره:
   ```bash
   sudo -u postgres psql -c "ALTER ROLE postgres PASSWORD '$(openssl rand -hex 32)';"
   ```
2. لكل مستأجر أنشئ دورًا مالكًا لقاعدته (استبدل `dar_app` و`dar_erp`):
   ```bash
   PW="$(openssl rand -hex 32)"; echo "احفظ: $PW"
   sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
   CREATE ROLE dar_app LOGIN PASSWORD '$PW' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   ALTER DATABASE dar_erp OWNER TO dar_app;
   REVOKE ALL ON DATABASE dar_erp FROM PUBLIC;
   \connect dar_erp
   ALTER SCHEMA public OWNER TO dar_app;
   DO \$\$
   DECLARE r record;
   BEGIN
     FOR r IN SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public' LOOP
       EXECUTE format('ALTER TABLE public.%I OWNER TO dar_app', r.n);
     END LOOP;
     FOR r IN SELECT sequence_name AS n FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
       EXECUTE format('ALTER SEQUENCE public.%I OWNER TO dar_app', r.n);
     END LOOP;
     FOR r IN SELECT t.typname AS n FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace
              WHERE ns.nspname = 'public' AND t.typtype = 'e' LOOP
       EXECUTE format('ALTER TYPE public.%I OWNER TO dar_app', r.n);
     END LOOP;
   END \$\$;
   SQL
   ```
3. `pg_hba.conf`: `host <db> <role> 127.0.0.1/32 scram-sha-256` (ولـ Docker: `host <db> <role> 172.16.0.0/12 scram-sha-256` مع `listen_addresses = 'localhost,172.17.0.1'`)، ثم `systemctl reload postgresql`.
4. ضع `DATABASE_URL` الجديد في `/etc/radeef/<tenant>.env` (القسم 1.3). المستأجرون الجدد يحصلون على كل هذا تلقائيًا من `ops/new-tenant.sh`.

### 1.3 ملف بيئة لكل مستأجر: SESSION_SECRET و DATA_ENCRYPTION_KEY

```bash
sudo install -d -m 755 /etc/radeef
sudo cp /opt/radeef/src/.env.example /etc/radeef/dar.env      # أو من نسخة المستودع لديك
sudo nano /etc/radeef/dar.env
```
- `DATABASE_URL` بالدور الجديد و`?schema=public&connection_limit=10&pool_timeout=20`.
- `SESSION_SECRET` = `openssl rand -base64 48` (قيمة جديدة؛ **لا تعِد استخدام** سرّ `dar` القديم).
- `DATA_ENCRYPTION_KEY` = `openssl rand -base64 32`. **إلزامي في الإنتاج**: التطبيق يرفض التشغيل المشفَّر بدونه، ولا يشتق مفتاحًا من `SESSION_SECRET` بعد الآن. احفظه في مدير كلمات المرور **وخارج السيرفر** قبل أول تشغيل، ولا تغيّره بعدها؛ فقدانه يعني فقدان كلمات مرور المنصات الحكومية المشفرة نهائيًا، ومفاتيح الختم الرقمي للمستندات (`DocumentSealKey`): يتوقف إصدار المستندات بخطأ `SEAL_FAILED` حتى يُتقاعد المفتاح القديم (`UPDATE "DocumentSealKey" SET "retiredAt" = now() WHERE "retiredAt" IS NULL AND "companyId" = '<id>'`)، فيُنشئ الإصدار التالي شهادة جديدة. المستندات المختومة سابقاً تبقى قابلة للتحقق بشهاداتها المحفوظة.
  - **مستأجر كان يعمل على النسخة السابقة** (شفّرت كلمات المرور بمفتاح مشتق من `SESSION_SECRET`): اضبط المفتاح على القيمة المشتقة نفسها مرة واحدة كي تبقى البيانات مقروءة:
    ```bash
    printf 'radeef-data-key:%s' "$SESSION_SECRET_OLD" | sha256sum | cut -d' ' -f1
    ```
    ضع الناتج في `DATA_ENCRYPTION_KEY`، ثم شغّل `scripts/encrypt-gov-passwords.mjs` تجريبياً للتأكد أن كلمات المرور تُقرأ، ثم دوّر `SESSION_SECRET` بحرية.
  - التدوير لاحقاً: `DATA_ENCRYPTION_KEY_ID` (افتراضي `k1`) يُكتب في كل نص مشفَّر جديد، والمفاتيح القديمة تبقى مقروءة عبر `DATA_ENCRYPTION_KEY_<KID>`.
- `PORT` (3000 / 3001 / 3002) و`UPLOAD_DIR=/var/lib/radeef/<tenant>/uploads`.
```bash
sudo chown radeef:radeef /etc/radeef/*.env && sudo chmod 600 /etc/radeef/*.env
```
(مستخدم `radeef` يُنشأ في القسم 2.1.)

### 1.4 المدير الأول وإغلاق الحسابات المكشوفة

حُذف حساب الدخول الخلفي الثابت والمقارنة النصية لكلمات المرور من الكود، لذا تسجيل الدخول يتم فقط بحسابات حقيقية في قاعدة البيانات. بعد نشر النسخة الجديدة لكل مستأجر:
```bash
cd /opt/radeef/src
sudo -u radeef node --env-file=/etc/radeef/dar.env scripts/create-admin.mjs owner@company.sa --customer-admin
```
حساب جديد يحتاج `--customer-admin` (أول مسؤول يُسلَّم للعميل) أو `--vendor-staff` (حساب لفريق رديف) (BL-PAY-005). إعادة التعيين لحساب ليس من رديف تُسقط إقرار هويته حتى يقرّه مسؤول آخر مُقرّ به.
يطبع كلمة مرور عشوائية **مرة واحدة**. نفس الأمر مع بريد موجود يعيد تعيين كلمة مروره: نفّذه على `admin@dar.com` (كلمة مروره القديمة `admin123` مكشوفة) وعلى أي حساب بكلمة مرور ضعيفة معروفة. راجع جدول المستخدمين وعطّل من لا تعرفه من صفحة الإعدادات ← المستخدمين.

### 1.5 تبنّي الترحيلات

نفّذ [`DATABASE.md`](DATABASE.md) — "One-time adoption of migrations" لكل مستأجر على حدة، **بعد** نسخة احتياطية. من الآن: لا `prisma db push` في الإنتاج أبدًا؛ النشر يستخدم `prisma migrate deploy` مسبوقًا بـ `pg_dump` (يفعلها `ops/deploy.sh` تلقائيًا).

### 1.6 نقل الملفات المرفوعة من `public/uploads` إلى `UPLOAD_DIR`

الملفات القديمة في `public/uploads` داخل كل نسخة (`/root`, `/root/rakan`, `/root/dar`، وربما `/var/www/radeef`). انتبه: سكربت النشر القديم كان ينسخ `/root/` إلى المستأجرين الآخرين، فقد تحتوي مجلدات مستأجر على ملفات مستأجر آخر. انقل لكل مستأجر **فقط الملفات التي تشير إليها قاعدته**:
```bash
T=dar; SRC=/root/dar/public/uploads; DST=/var/lib/radeef/$T/uploads
sudo install -d -m 750 -o radeef -g radeef "$DST"           # Docker: -o 1001 -g 1001
# الأسماء المشار إليها في قاعدة المستأجر (/uploads/<name> أو /api/files/<name>):
sudo -u postgres pg_dump --data-only dar_erp | tr '\t' '\n' \
  | grep -oE "/(uploads|api/files)/[^\"',;)<>\\]+" \
  | sed -E 's#^/(uploads|api/files)/##' | sort -u > /tmp/$T-referenced.txt
wc -l /tmp/$T-referenced.txt; sudo ls "$SRC" | wc -l      # قارن العددين وراجع عينات قبل النسخ
sudo rsync -a --files-from=/tmp/$T-referenced.txt "$SRC/" "$DST/"
sudo chown -R radeef:radeef "$DST"                           # Docker: 1001:1001
```
الروابط القديمة `/uploads/<name>` تبقى صالحة (تُحوَّل داخليًا إلى `/api/files/<name>` المحمي). احتفظ بالمجلدات القديمة حتى تتأكد، ثم احذفها.

### 1.6.1 تسجيل الملفات القديمة وتشفير كلمات مرور المنصات الحكومية

بعد تطبيق الترحيلات ونقل الملفات، نفّذ لكل مستأجر (بملف البيئة الخاص به):

```bash
# 1) تسجيل الملفات المرفوعة سابقاً في جدول UploadedFile (بدونه يرى الموظف 403 على مستنداته القديمة)
node --env-file=/etc/radeef/<tenant>.env scripts/register-legacy-uploads.mjs          # تجربة بلا كتابة
node --env-file=/etc/radeef/<tenant>.env scripts/register-legacy-uploads.mjs --apply  # تنفيذ

# 2) تشفير كلمات مرور المنصات الحكومية المخزنة نصاً (يرفض الكتابة إن كان المفتاح خاطئاً)
node --env-file=/etc/radeef/<tenant>.env scripts/encrypt-gov-passwords.mjs
node --env-file=/etc/radeef/<tenant>.env scripts/encrypt-gov-passwords.mjs --apply
```

ملاحظات:
- `DATA_ENCRYPTION_KEY` يجب ضبطه **قبل** تشغيل سكربت التشفير ولا يُغيَّر بعده، لأن تغييره يجعل كلمات المرور المشفرة غير قابلة للقراءة.
- تسجيل الخروج يُنهي جلسات المستخدم على **كل** الأجهزة، وكذلك تغيير كلمة المرور.
- ضع التطبيق خلف Nginx دائماً: التطبيق يعتمد على ترويسة `X-Real-IP` التي يضبطها Nginx لحساب محاولات الدخول.
- الترحيل `4_cancel_visas_of_cancelled_leaves` ينظّف تأشيرات قديمة لإجازات ملغاة، ويُطبَّق تلقائياً مع `npm run db:migrate`.

### 1.7 نسخة احتياطية فورية + النسخ اليومي

قبل أي تغيير آخر:
```bash
sudo install -d -m 700 /var/backups/radeef/manual
for db in dar_erp <radeef_db> <rakan_db>; do
  sudo -u postgres pg_dump -Fc -f /var/backups/radeef/manual/$db-$(date +%F).dump $db
done
```
انسخها **خارج السيرفر** (`scp` إلى جهازك أو مخزن خارجي). بعد إعداد `/etc/radeef/*.env` فعّل النسخ اليومي (القسم 3.4).

### 1.8 تنظيف تاريخ git

إن كان المستودع على GitHub أو أي خادم git: بعد التدوير أعلاه، نظّف التاريخ بـ [`git filter-repo`](https://github.com/newren/git-filter-repo) (`--replace-text` بقائمة القيم المسرّبة)، ثم `push --force` لكل الفروع والوسوم، واطلب من كل من لديه نسخة أن يعيد الاستنساخ. الـ CI (gitleaks) سيفشل حتى يتم ذلك. التدوير أهم من التنظيف: اعتبر القيم القديمة معروفة للجميع.

---

## 2. الانتقال إلى الترتيب الجديد

الهدف: مستخدم نظام `radeef` غير root، الكود في `/opt/radeef/src`، الإصدارات في `/opt/radeef/releases`، البيانات في `/var/lib/radeef/<tenant>`، الأسرار في `/etc/radeef`، النسخ في `/var/backups/radeef`. اختر **PM2** (الأقرب للوضع الحالي) أو **Docker** (المُوصى به على المدى البعيد).

### 2.1 التحضير المشترك

```bash
sudo apt install -y git curl postgresql-client nginx certbot rsync
# مستخدم الخدمة (uid 1001 = مستخدم الصورة في Docker)
sudo groupadd --system --gid 1001 radeef && sudo useradd --system --uid 1001 --gid 1001 -m -s /bin/bash radeef && sudo passwd -l radeef
sudo install -d -m 755 /opt/radeef /etc/radeef /var/lib/radeef /var/backups/radeef
sudo install -d -m 750 -o radeef -g radeef /opt/radeef/releases /var/log/radeef /opt/radeef/{radeef,rakan,dar} /var/lib/radeef/{radeef,rakan,dar}
sudo chown radeef:radeef /var/backups/radeef
# نسخة المستودع (مفتاح نشر للقراءة فقط على GitHub)
sudo -u radeef git clone <repo-url> /opt/radeef/src
```
ثم ملفات `/etc/radeef/<tenant>.env` (القسم 1.3) ونقل الملفات (1.6).

Nginx لكل نطاق موجود (يعطّل ملف الموقع القديم الذي يخدم نفس النطاق، يضيف HTTPS وصفحة صيانة عامة):
```bash
sudo /opt/radeef/src/ops/new-tenant.sh --nginx-only --email ops@company.sa dar dar.radeef-sa.com 3002
```
(ملف `ops/nginx/dar.radeef-sa.com.conf.legacy` هو الإعداد القديم للمرجعية فقط.)

### 2.2 مسار PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pm2
sudo -iu radeef pm2 install pm2-logrotate
sudo -iu radeef pm2 set pm2-logrotate:max_size 20M
sudo -iu radeef pm2 set pm2-logrotate:retain 14
sudo -iu radeef pm2 set pm2-logrotate:compress true
```
1. **ابنِ الإصدار بدون تبديل** (التطبيق القديم يبقى يعمل):
   ```bash
   sudo -iu radeef /opt/radeef/src/ops/deploy.sh --build-only        # يطبع RELEASE_ID
   ```
2. **نافذة صيانة قصيرة**: أوقف تطبيقات root القديمة ثم انشر الإصدار (نسخة احتياطية + ترحيل + canary + تشغيل):
   ```bash
   sudo -i pm2 delete radeef rakan dar && sudo -i pm2 save --force         # PM2 الخاص بـ root
   sudo -iu radeef /opt/radeef/src/ops/deploy.sh --release <RELEASE_ID> radeef rakan dar
   ```
   (إن لم تُكمل تبني الترحيلات في 1.5 بعد، فافعل ذلك قبل هذه الخطوة.)
3. التشغيل التلقائي بعد إعادة الإقلاع:
   ```bash
   sudo -iu radeef pm2 save
   sudo env PATH=$PATH pm2 startup systemd -u radeef --hp /home/radeef
   sudo systemctl disable pm2-root 2>/dev/null || true
   ```
4. تحقق من `https://<domain>/api/health` لكل مستأجر، ثم أنشئ المديرين (1.4).
5. بعد أسبوع مستقر: أرشف `/root/src`, `/root/rakan`, `/root/dar` (`tar czf`) خارج السيرفر ثم احذفها.

### 2.3 مسار Docker (بديل)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo cp /opt/radeef/src/docker-compose.yml /opt/radeef/docker-compose.yml
```
- في `/etc/radeef/<tenant>.env` استخدم `host.docker.internal` بدل `localhost` في `DATABASE_URL`، واضبط Postgres على `listen_addresses = 'localhost,172.17.0.1'` مع قاعدة `pg_hba` للشبكة `172.16.0.0/12` (القسم 1.2).
- مجلدات الملفات مملوكة لـ `1001:1001`.
- لإضافة مستأجر جديد أضف خدمة له في `/opt/radeef/docker-compose.yml` على نمط الخدمات الموجودة.
```bash
sudo /opt/radeef/src/ops/deploy.sh --mode docker --build-only      # يطبع radeef:<sha>
sudo -i pm2 delete radeef rakan dar && sudo -i pm2 save --force           # نافذة الصيانة
sudo /opt/radeef/src/ops/deploy.sh --mode docker --release radeef:<sha> radeef rakan dar
```
الحاويات تُعاد تلقائيًا بعد الإقلاع (`restart: unless-stopped`).

---

## 3. عمليات اليوم الثاني

### 3.1 نشر إصدار جديد
```bash
sudo -iu radeef /opt/radeef/src/ops/deploy.sh --all                      # PM2، من origin/main
sudo -iu radeef /opt/radeef/src/ops/deploy.sh --ref v1.4.0 dar           # إصدار/مستأجر محدد
sudo /opt/radeef/src/ops/deploy.sh --mode docker --all                   # Docker
```
لكل مستأجر: `pg_dump` إلى `/var/backups/radeef/<tenant>/pre-deploy-<ts>.dump` ← `prisma migrate deploy` + seed ← canary على `PORT+1000` حتى ينجح `/api/health` ← التبديل ← فحص صحة، مع رجوع تلقائي للإصدار السابق إن فشل. يُحتفظ بآخر 5 إصدارات. جرّب النشر أولًا على مستأجر واحد (مثل `dar`) ثم الباقي.

### 3.2 الرجوع (Rollback)
```bash
sudo -iu radeef /opt/radeef/src/ops/deploy.sh --rollback dar             # PM2
sudo /opt/radeef/src/ops/deploy.sh --mode docker --rollback dar           # Docker
```
يعيد **الكود** فقط. إن كان الترحيل نفسه هو المشكلة، استعد نسخة ما قبل النشر:
```bash
sudo /opt/radeef/src/ops/restore.sh dar /var/backups/radeef/dar/pre-deploy-<ts>.dump
```
(أي بيانات أُدخلت بعد النسخة ستضيع؛ قرر ذلك بوعي.)

### 3.3 السجلات والمراقبة
- التطبيق: `sudo -iu radeef pm2 logs dar` أو `/var/log/radeef/dar.{out,err}.log`؛ Docker: `docker logs -f dar`.
- Nginx: `/var/log/nginx/<tenant>.{access,error}.log`.
- الصحة: `curl -fsS https://<domain>/api/health` (يرجع 503 إن تعذر الوصول لقاعدة البيانات). أضف كل نطاق إلى خدمة مراقبة خارجية (UptimeRobot / Better Stack) على هذا المسار، مع تنبيه بالبريد/واتساب.
- الموارد: `pm2 monit`، `docker stats`، `df -h /var/lib/radeef /var/backups`.

### 3.4 النسخ الاحتياطي
```bash
sudo crontab -e
15 2 * * * /opt/radeef/src/ops/backup.sh --all >>/var/log/radeef/backup.log 2>&1
```
- الاحتفاظ: 7 يومية، 4 أسبوعية (الأحد)، 6 شهرية (يوم 1)، ونسخ ما قبل النشر/الاستعادة 30 يومًا.
- **خارج السيرفر ومشفّر: إلزامي افتراضياً** (الخطة الرئيسية P0-04). بدون remote خارجي يكتمل النسخ المحلي ثم يخرج `backup.sh` بـ1 ويرسل `/fail`. والرفع لا يتم أبداً بلا تشفير، بأحد طريقين في `/etc/radeef/backup.conf` (`chmod 600`):
  - remote من نوع `crypt` في rclone فوق التخزين (Backblaze B2 / Hetzner Storage Box / S3). السكربت يتحقق من النوع عبر `rclone listremotes --long`:
    ```
    RCLONE_REMOTE=radeef-crypt:
    BACKUP_PING_URL=https://hc-ping.com/<uuid>
    ```
  - أو remote عادي مع تشفير age لكل ملف قبل الرفع. **المفتاح الخاص لا يبقى على السيرفر** (يُحفظ عند المالك وفي خزنة):
    ```
    RCLONE_REMOTE=b2:radeef-backups
    BACKUP_AGE_RECIPIENTS=/etc/radeef/backup-age.pub
    ```
    (`apt install age`، و`age-keygen -o owner.key` على جهاز آخر، ثم انسخ سطر المفتاح العام إلى الملف.) فك التشفير عند الاستعادة: `age -d -i owner.key -o x.dump x.dump.age`.
  - `ALLOW_LOCAL_ONLY=1` يقبل نسخاً محلياً فقط (بيئة تطوير، أو سيرفر له نسخ خارجي آخر). غير مستحسن للإنتاج.
- **تمرين استعادة شهري آلي** (`ops/restore-drill.sh`): لكل مستأجر يتحقق من sha256 أحدث نسخة يومية، ويستعيدها في قاعدة مؤقتة `radeef_drill_<tenant>` (لا يلمس قاعدة المستأجر)، ويتحقق من الترحيلات مقارنةً بالقاعدة الحية، ثم يحذف المؤقتة، ويكتب النتيجة صفاً في `JobRun` للمستأجر (`job = 'restore-drill'`). يحتاج دوراً بصلاحية CREATEDB:
  ```bash
  sudo -u postgres psql -c "CREATE ROLE radeef_drill LOGIN CREATEDB PASSWORD '<random>'"
  # في /etc/radeef/backup.conf:
  #   DRILL_PG_URL=postgresql://radeef_drill:<random>@127.0.0.1:5432/postgres
  #   DRILL_PING_URL=https://hc-ping.com/<uuid>   (اختياري)
  sudo install -m 0644 /opt/radeef/src/ops/systemd/radeef-restore-drill.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now radeef-restore-drill.timer   # يوم 2 من كل شهر 05:30
  sudo /opt/radeef/src/ops/restore-drill.sh dar   # تشغيل يدوي
  ```
  النتائج: `SELECT "startedAt", status, details FROM "JobRun" WHERE job = 'restore-drill' ORDER BY "startedAt" DESC;`

### 3.5 مستأجر جديد
```bash
sudo /opt/radeef/src/ops/new-tenant.sh --email ops@company.sa acme acme.radeef-sa.com 3003
sudo -iu radeef /opt/radeef/src/ops/deploy.sh acme                     # الترحيلات + التشغيل
sudo -u radeef node --env-file=/etc/radeef/acme.env /opt/radeef/src/scripts/create-admin.mjs owner@acme.sa --customer-admin
```
يجب أن يشير DNS النطاق إلى السيرفر قبل التشغيل (لشهادة Let's Encrypt)، أو استخدم `--skip-certbot` ثم أعد تشغيله بـ `--nginx-only` لاحقًا. في مسار Docker أضف خدمة للمستأجر في `docker-compose.yml` أولًا.

### 3.6 إيقاف مستأجر أو حذفه
1. نسخة أخيرة: `ops/backup.sh <tenant>` وانقلها خارج السيرفر.
2. `pm2 delete <tenant> && pm2 save` (أو احذف خدمته من compose ثم `docker compose up -d --remove-orphans`).
3. عطّل موقع Nginx: `rm /etc/nginx/sites-enabled/<domain>.conf && nginx -t && systemctl reload nginx`.
4. فقط بعد انتهاء مدة الاحتفاظ المتفق عليها تعاقديًا: `DROP DATABASE` و`DROP ROLE` وحذف `/var/lib/radeef/<tenant>` و`/etc/radeef/<tenant>.env`.

### 3.7 مهام دورية
| المهمة | الوتيرة |
|---|---|
| مراجعة `backup.log` ووصول النسخ للمخزن الخارجي | أسبوعيًا |
| مراجعة نتيجة تمرين الاستعادة الآلي في `JobRun` (3.4) | شهريًا |
| `certbot renew --dry-run` | شهريًا (التجديد نفسه تلقائي عبر مؤقت certbot) |
| `apt upgrade` وإعادة الإقلاع عند الحاجة (`unattended-upgrades` للأمنية) | أسبوعيًا |
| `npm audit --omit=dev` في المستودع وتحديث التبعيات | شهريًا |
| مراجعة المستخدمين النشطين وسجل التدقيق | شهريًا |

### 3.8 تدوير الأسرار
- **كلمة مرور مستخدم:** `node --env-file=/etc/radeef/<t>.env scripts/create-admin.mjs <email>` (يطبع كلمة مرور جديدة، وينهي الجلسات، ويُسقط إقرار الهوية لحساب ليس من رديف). داخل التطبيق لا يضبط المسؤول كلمة مرور غيره: "إعادة ضبط بيانات الدخول" ترسل رابطاً لمرة واحدة لصاحب الحساب (DEC-PO-027).
- **كلمة مرور قاعدة مستأجر:** `ALTER ROLE <t>_app PASSWORD '<new>';` ← حدّث `DATABASE_URL` ← أعد النشر (`deploy.sh --release <current> --skip-migrate <t>`) أو `pm2 reload <t> --update-env` / `docker compose up -d <t>`.
- **SESSION_SECRET:** غيّره ثم أعد التشغيل؛ كل المستخدمين يسجلون الدخول من جديد.
- **DATA_ENCRYPTION_KEY:** لا يُدوَّر بتغيير القيمة فقط (البيانات المشفرة القديمة ستصبح غير مقروءة)؛ يحتاج سكربت إعادة تشفير مخصصًا.

### 3.9 عند توقف الخدمة
1. `curl -i http://127.0.0.1:<port>/api/health` على السيرفر: لا رد ← التطبيق متوقف (`pm2 status` / `docker ps -a`، ثم السجلات). 503 ← قاعدة البيانات (`systemctl status postgresql`، `df -h`).
2. الزوار يرون صفحة الصيانة العامة من Nginx أثناء التوقف (وليست صفحة "الاشتراك غير نشط").
3. إن بدأ العطل بعد نشر: الرجوع (3.2) أولًا ثم التحقيق.

---

## 4. المهام الخلفية، النشر متعدد المستأجرين، وحدود قاعدة البيانات (DEC-004 / DEC-007 / DEC-009)

### 4.1 المهام الخلفية: `scripts/jobs.mjs`
سكربت سطر أوامر داخل الإصدار، **وليس** مسار HTTP (Nginx يمرر كل الطلبات من 127.0.0.1، فلا يمكن تمييز
"الطلب المحلي"). كل تشغيل يكتب صفاً في `JobRun` (`RUNNING` ← `SUCCEEDED`/`FAILED`)، ويرفض التشغيل إن
كان للمهمة نفسها تشغيل `RUNNING` على القاعدة نفسها (ويعلّم ما بقي `RUNNING` أكثر من ساعتين `FAILED`)،
وحوض الاتصالات فيه `connection_limit=2`.

**من أين يأتي الكود (P1-FND-JOBS، DEC-PO-121):** المهام هي كود TypeScript للوحدات نفسه، مسجلة في
`src/jobs/registry.ts`، و`npm run build` (عبر `npm run build:jobs`) يجمعها في ملف واحد `dist/jobs/jobs.cjs`.
`scripts/jobs.mjs` يشغّل هذا الملف فقط، فبعد أي تعديل على مهمة يلزم البناء (deploy.sh وصورة Docker يبنيانه).
`node scripts/jobs.mjs --list` يعرض المهام ونطاقها: مهمة **لكل شركة** تمر على الشركات واحدة واحدة
(`documents-retention`، `apply-employee-changes`، `reconcile`)، والمهام **العابرة للشركات** معلنة في
`CROSS_COMPANY_JOBS` (`src/modules/iam/context.ts`)، و`expiry-digest` يحسب لكل مستلم ما يراه نطاقه فقط.

| المهمة | ما تفعله | الافتراضي الآمن |
|---|---|---|
| `expiry-digest` | يحسب أعداد المستندات المنتهية والتي تقترب من الانتهاء لكل فئة (نفس العتبات ومفاتيح `alert_*` في `src/lib/alerts.ts`)، ويضيف **صفاً واحداً لكل مستخدم مدير في اليوم** إلى `NotificationOutbox` بمفتاح `expiry-digest:<userId>:<YYYY-MM-DD>`. النص **أعداد فقط + رابط تسجيل الدخول**: لا أسماء ولا أرقام هوية. لا يُرسل لمستخدم غير نشط أو مرتبط بموظف منتهية خدمته. لا شيء يُضاف في يوم بلا تنبيهات. | الأدوار من `SystemSetting.expiry_digest_roles` (افتراضي `SUPER_ADMIN,COMPANY_ADMIN`، ولا يُقبل `EMPLOYEE`). الرابط من `APP_URL`. |
| `deactivate-terminated` | بعد مضي `terminated_access_days` يوماً من الإنهاء (دخول كامل) يحوّل الحساب إلى «المستندات فقط» لمدة `terminated_documents_access_days` يوماً (صفحة `/my-documents`)، ثم يعطّله (`isActive=false`، `sessionVersion+1` لإبطال الجلسات، وسطر تدقيق). | `terminated_access_days` غير مضبوط = 0 = فوراً، و`terminated_documents_access_days` غير مضبوط = 30 (0 = تعطيل مباشر؛ نفس `src/lib/access.ts`). |
| `outbox-dispatch` | يرسل صفوف `NotificationOutbox` بالبريد: `PENDING` ← `SENDING` (مع lease) ← `SENT` / `FAILED` / `UNKNOWN`. انتهاء المهلة أو انقطاع الاتصال أثناء الإرسال = `UNKNOWN` ولا يُعاد تلقائياً (قد يكون وصل). `FAILED` (رفض مؤكد) يُعاد حتى `OUTBOX_MAX_ATTEMPTS` (3). وأي رسالة لم تُرسل وعمرها أكثر من `OUTBOX_TTL_HOURS` (افتراضياً 72 ساعة) تصبح `EXPIRED` ولا تُرسل أبداً، فأول تشغيل فعلي لا يرسل رصيداً قديماً (P0-07). التشغيل التجريبي يعرض `wouldExpire`. يعيد التحقق من أن مستلم الملخص ما زال نشطاً قبل الإرسال. | **تشغيل تجريبي (dry run)** لا يغيّر أي صف، إلا إذا `OUTBOX_SEND="true"` **و** `SMTP_HOST/USER/PASS/FROM` مضبوطة. |
| `domain-events` | كل 5 دقائق: يشغّل مستهلكي `DomainEvent` المسجلين (`runConsumers`) على الأحداث المستحقة، مرة واحدة على الأكثر لكل مستهلك وحدث، مع إعادة المحاولة والتأجيل. | لا مستهلك مسجل بعد: يعدّ الأحداث المعلقة فقط (`pendingWithoutConsumer`). |
| `reconcile` | يشغّل الثوابت المقاسة في لقطة قراءة واحدة، ثم يسجل الفروقات (`Discrepancy`) شركة شركة، ثم ما لا شركة له. | `--dry-run` = اللقطة فقط بلا كتابة. فحص لم يعمل يجعل التشغيل `FAILED`. |

```bash
# تجربة يدوية لمستأجر واحد (--dry-run لا يكتب شيئاً في expiry-digest و deactivate-terminated)
cd /opt/radeef/src && sudo -u radeef node --env-file=/etc/radeef/dar.env scripts/jobs.mjs expiry-digest --dry-run
cd /opt/radeef/src && sudo -u radeef node --env-file=/etc/radeef/dar.env scripts/jobs.mjs deactivate-terminated
# كل المستأجرين (مع تأخير عشوائي حتى 10 دقائق)
sudo -u radeef /opt/radeef/src/ops/run-jobs.sh --jitter 600 deactivate-terminated
```
`ops/run-jobs.sh` يمر على كل `/etc/radeef/<tenant>.env` وعلى كل مسار مذكور في `/etc/radeef/jobs-extra.list`
(سطر لكل ملف؛ للنسخ التي أنشأتها لوحة radeef-manage وملفها في `<TENANTS_ROOT>/<name>/.env`)، ويتخطى أي مستأجر
في ملفه `RADEEF_JOBS="off"` (ضعه للمستأجرين الموقوفين)، ويكمل بعد فشل مستأجر ويخرج بـ 1 إن فشل أي منهم.
في وضع PM2 يشغّل المهمة من `/opt/radeef/src` (فيه `node_modules` وعميل Prisma المولَّد، مثل seed النشر)؛
`--mode docker` يستخدم `radeef:live-<tenant>`.

**الجدولة: بين 03:30 و05:00 بتوقيت الرياض مع تأخير عشوائي** (خارج نافذة النسخ الاحتياطي: `ops/backup.sh` 02:15،
ونسخ اللوحة 02:30). systemd (مفضّل):

ملفات الوحدات في المستودع: `ops/systemd/radeef-jobs@.service` ومؤقت لكل مهمة `ops/systemd/radeef-jobs@<job>.timer`
(**المهام الاثنتا عشرة كلها**: `apply-employee-changes` 00:15، `apply-financial-changes` 00:20، `employment-notice-end` 00:20،
`employment-state-opening` 02:40، `reconcile` 03:15، `deactivate-terminated` 03:30، `expiry-digest` 03:55،
`outbox-dispatch` 04:30، `documents-integrity` 04:30، `purge-attendance-biometrics` 04:50، `documents-retention` الجمعة 05:00،
و`domain-events` كل 5 دقائق).
اختبار الوحدة `ops-job-timers.test.ts` (ARCH-018) يفشل في CI إن أُضيفت مهمة إلى `JOB_NAMES` بلا مؤقت.
```bash
sudo /opt/radeef/src/ops/jobs-setup.sh            # ينسخ الوحدات إلى /etc/systemd/system ويفعّل كل المؤقتات
sudo /opt/radeef/src/ops/jobs-setup.sh --check    # يخرج بـ1 إن كان مؤقت غير مفعل (بعد كل نشر)
systemctl list-timers "radeef-jobs@*"; journalctl -u "radeef-jobs@*" --since today
```
(المنطقة الزمنية في `OnCalendar` تحتاج systemd 245 أو أحدث. نسخ اللوحة تحت `/root` لا يقرؤها المستخدم `radeef`:
شغّل لها نسخة خدمة بـ `User=root`.) بديل cron: `ops/jobs-setup.sh --cron > /etc/cron.d/radeef-jobs` يولّد سطراً لكل
مهمة من ملفات المؤقتات نفسها (cron في Debian/Ubuntu يتجاهل `CRON_TZ`، فالأوقات تفترض السيرفر على توقيت الرياض).

**تفعيل الإرسال الفعلي (يحتاج موافقة المالك، DEC-009):** اختيار مزود بريد معاملات مع SPF وDKIM وDMARC، وإدراجه في
`docs/processors.md`، ثم ملء `SMTP_*` في ملف المستأجر و`OUTBOX_SEND="true"`. قبل ذلك تبقى `outbox-dispatch`
تجريبية وتكتفي بالتقرير. المزود المعتمد هو **Amazon SES** (DEC-PO-130، DEC-PO-040)، وخطوات إعداده في الفقرة التالية.

**إعداد Amazon SES (DEC-PO-130):** حساب SES مملوك لرديف، والخطوات بالترتيب:
1. **المنطقة:** `me-south-1` (البحرين) إن كانت SES متاحة فيها لهذا الحساب، وإلا `eu-central-1` (فرانكفورت).
   **تحقق من الإتاحة في وحدة التحكم** (SES ← اختيار المنطقة) قبل البدء؛ هذا الملف لا يجزم بها. كل ما يلي يُنشأ في
   المنطقة نفسها، وتُسجَّل في `docs/processors.md`.
2. **هوية النطاق:** SES ← Identities ← Create identity ← Domain (نطاق الإرسال، مثل `mail.<نطاق رديف>`)، مع
   **Easy DKIM** (RSA 2048). أضف سجلات CNAME الثلاثة التي تعرضها SES في DNS، وانتظر حالة `Verified` للنطاق وDKIM.
3. **SPF:** سجل TXT للنطاق فيه `include:amazonses.com`، مثل `v=spf1 include:amazonses.com ~all` (إن كان للنطاق سجل
   SPF فأضف `include` إليه ولا تنشئ سجلاً ثانياً).
4. **MAIL FROM مخصص:** في صفحة الهوية ← Custom MAIL FROM domain (مثل `bounce.mail.<النطاق>`)، مع سجل MX الذي تعرضه
   SES وسجل TXT `v=spf1 include:amazonses.com ~all` له. بهذا يتوافق SPF مع نطاق المرسل (DMARC alignment).
5. **DMARC:** سجل TXT على `_dmarc.<النطاق>`، يبدأ بـ`v=DMARC1; p=none; rua=mailto:<بريد التقارير>` للمراقبة، ثم يُرفع
   إلى `p=quarantine` بعد أن تظهر التقارير أن DKIM وSPF ناجحان.
6. **الخروج من وضع الاختبار (sandbox):** SES ← Account dashboard ← Request production access (نوع البريد:
   Transactional، مع وصف الرسائل: ملخصات أعداد وروابط دخول وتنبيهات للمالك). قبل الموافقة لا يُرسل إلا لعناوين موثقة.
7. **بيانات SMTP:** SES ← SMTP settings ← Create SMTP credentials (ينشئ مستخدم IAM خاصاً بـSMTP بصلاحية
   `ses:SendRawEmail` فقط). اسم المستخدم وكلمة المرور تظهران مرة واحدة: احفظهما في مخزن الأسرار لا في المستودع.
8. **ملف المستأجر:**
   ```bash
   SMTP_HOST="email-smtp.<region>.amazonaws.com"   # المنطقة المختارة في الخطوة 1
   SMTP_PORT="587"                                  # STARTTLS
   SMTP_USER="<SMTP username من الخطوة 7>"
   SMTP_PASS="<SMTP password من الخطوة 7>"
   SMTP_FROM="Radeef <no-reply@mail.<النطاق>>"       # عنوان على النطاق الموثق
   OWNER_ALERT_EMAIL="<بريد المالك المسجل لدى رديف>"  # قناة DEC-PO-022 (تنبيه القيمة دون الحد النظامي، DEC-PO-126)
   ```
   شغّل `outbox-dispatch` تجريبياً أولاً وراجع العدد، ثم اضبط `OUTBOX_SEND="true"`. بعد أول إرسال راجع في SES
   (Reputation metrics) نسب الارتداد والشكاوى، وفعّل إشعارات الارتداد والشكاوى إن توفر مستهلك لها.

محتوى الرسائل لا يتغير بتغيير المزود: أعداد وروابط دخول فقط، بلا أسماء ولا أرقام هوية ولا معرفات سجلات.

**المتابعة:**
```sql
SELECT job, status, "startedAt", "finishedAt", left(details, 200) FROM "JobRun" ORDER BY "startedAt" DESC LIMIT 20;
SELECT status, count(*) FROM "NotificationOutbox" GROUP BY 1;
SELECT id, recipient, attempts, "lastError", "updatedAt" FROM "NotificationOutbox" WHERE status = 'UNKNOWN';
```
صفوف `UNKNOWN` تُراجع يدوياً في سجل مزود البريد؛ إن تأكد أنها لم تصل:
`UPDATE "NotificationOutbox" SET status = 'PENDING' WHERE id = '<id>';` (يدوياً فقط، واحداً واحداً).

### 4.2 النشر: الإكمال بعد فشل مستأجر ومصفوفة الإصدارات
`ops/deploy.sh` ينشر كل مستأجر في subshell مستقل: فشل مستأجر لا يوقف الباقين، وفي النهاية تُطبع مصفوفة
`TENANT / BEFORE / AFTER / RESULT / STAGE` (وتُضاف إلى `/opt/radeef/deploy-matrix.log`)، ويخرج السكربت بقيمة غير صفرية
إن فشل أو تُخطّي أي مستأجر. `STAGE` تبين أين توقف: `backup`، `migrate`، `canary`، `switch`، `health` (أو
`health (rolled back to …)`)، `done`.
- فشل في مرحلة **migrate** يعني غالباً أن الإصدار نفسه معطوب؛ لذلك بعد `--max-migrate-failures` فشلاً من هذا النوع
  (افتراضي 1) تُعلَّم بقية المستأجرين `SKIPPED` بدل تجربة الترحيل نفسه على قواعدهم. `--max-migrate-failures 0`
  يكمل دائماً (لانحراف خاص بمستأجر بعينه بعد التحقق).
- الموجات: انشر أولاً على مستأجر واحد، ثم `--release <id>` للبقية على دفعات:
  ```bash
  sudo -iu radeef /opt/radeef/src/ops/deploy.sh --ref v1.5.0 dar                 # الموجة 1
  sudo -iu radeef /opt/radeef/src/ops/deploy.sh --release <release-id> rakan acme   # الموجة 2 (نفس البناء)
  ```
- الـcanary يعمل بـ `connection_limit=2`، و`prisma migrate deploy` برابط فيه
  `options=-c lock_timeout=10s -c statement_timeout=15min`. الرابط المعدّل يُكتب في ملف env مؤقت خاص (600) ويُحذف
  بعد الاستخدام؛ لا يظهر في سطر الأوامر.
- `ecosystem.config.js` صار **يتخطى** المستأجر ذا الإعداد الفاسد (اسم أو منفذ غير صالح، ملف env غير مقروء، بلا
  `PORT` أو `DATABASE_URL`) مع تحذير في stderr بدل إيقاف كل المستأجرين. راجع `pm2 logs` بعد كل نشر.

### 4.3 حدود الاتصالات ومهلات Postgres
| من | `connection_limit` |
|---|---|
| عملية التطبيق (PM2/Docker) | 5 (`DATABASE_URL` في ملف المستأجر) |
| canary النشر | 2 |
| `scripts/jobs.mjs` | 2 |
| `scripts/tenant-stats.mjs` | 1 |

الميزانية: `عدد المستأجرين × (5 + 2 + 2)` + النسخ الاحتياطي + الترحيل < `max_connections` (افتراضي Postgres 100).
قبل تجاوزها أضف PgBouncer (DEC-004) بدل رفع `max_connections`.

`ops/new-tenant.sh` واللوحة يضبطان لكل دور جديد:
`statement_timeout = '30s'` و`idle_in_transaction_session_timeout = '60s'`. **للمستأجرين الحاليين** (مرة واحدة،
كمستخدم postgres؛ تسري على الاتصالات الجديدة فقط):
```bash
for r in $(sudo -u postgres psql -tAc "select rolname from pg_roles where rolname like '%\_app'"); do
  sudo -u postgres psql -c "ALTER ROLE \"$r\" SET statement_timeout = '30s'" \
                        -c "ALTER ROLE \"$r\" SET idle_in_transaction_session_timeout = '60s'"
done
```
ثم عدّل `connection_limit=10` إلى `5` في كل `/etc/radeef/<t>.env` وأعد التحميل (`deploy.sh --release <current> --skip-migrate <t>`
أو `pm2 reload <t> --update-env`). `pg_dump` يضبط مهلاته بنفسه (0) فلا يتأثر. أي ترحيل يدوي: أضف
`&options=-c%20lock_timeout%3D10s%20-c%20statement_timeout%3D15min` إلى `DATABASE_URL` لتلك العملية فقط.

### 4.4 النسخ الاحتياطي للوحة radeef-manage
كل تشغيل نسخ احتياطي من اللوحة (`BACKUP_CRON` 02:30، زر "نسخ احتياطي الآن"، `node cli.js backup`) يبدأ بنسخة
متسقة من سجل المستأجرين `database.sqlite` (`VACUUM INTO`) ومن ملف `.env` الخاص باللوحة، بصلاحية 600، في
`PANEL_BACKUP_DIR` (افتراضي `radeef-manage/backups`)، ويرفعهما إلى `/var/backups/radeef/panel/` على السيرفر ليشحنهما
`ops/backup.sh` خارجياً (RCLONE). فشلها يظهر باسم `panel-registry` في قائمة الفاشلة. استعادة السجل: أوقف اللوحة،
انسخ `registry_<ts>.sqlite` إلى `database.sqlite`، ثم شغّلها.

### 4.5 ترخيص اللوحة: الإيقاف بعد تاريخ الانتهاء فقط، وتذكير يومي واحد
تاريخ الانتهاء هو **آخر يوم مدفوع**: الإيقاف في أول فحص بعده (days < 0). تذكير بريدي يومي خلال آخر
`LICENSE_REMINDER_DAYS` (افتراضي 14) يوماً، **مرة واحدة لكل مستأجر في اليوم** (جدول `license_notices` في SQLite،
يُحجز قبل الإرسال، فإعادة تشغيل اللوحة لا تكرر). `node cli.js notices` يعرض آخر الرسائل ونتيجتها. لم يُنفذ بعد
(يحتاج قرار المالك): مهلة "قراءة فقط" بدل الإيقاف، وتأكيد المشغّل في نافذة الرواتب، وشريط داخل التطبيق.

### 4.6 إحصاءات الاستخدام لكل مستأجر (قراءة فقط)
```bash
cd /opt/radeef/src && sudo -u radeef node scripts/tenant-stats.mjs --env-dir /etc/radeef > /tmp/tenant-stats.json
cd /opt/radeef/src && sudo -u radeef node --env-file=/etc/radeef/dar.env scripts/tenant-stats.mjs
```
JSON لكل مستأجر: الشركات، الفروع، الموظفون النشطون والمنتهية خدمتهم، المستخدمون النشطون، العقود القانونية، القضايا،
المركبات، شرائح الاتصالات، المنصات الحكومية، أرشيف التجديدات، ومسيرات آخر 3 أشهر. **أعداد فقط**، داخل معاملة
`READ ONLY` مع `statement_timeout=15s` واتصال واحد. في اللوحة: عمود "موظفون نشطون" (psql للقراءة فقط) والحقول
التجارية الاختيارية (فارغة افتراضياً) لقرارات DEC-007.

### 4.7 حظر `/api/internal/` في Nginx
القالب `ops/nginx/tenant.conf.template` ومولّد اللوحة (`radeef-manage/lib/nginx.js`) يضيفان
`location ^~ /api/internal/ { return 404; }`. للمواقع الحالية: `sudo ops/new-tenant.sh --nginx-only <t> <domain> <port>`
(يعيد توليد الموقع ويختبره بـ `nginx -t`). مواقع اللوحة الحالية لا يُعاد توليدها إلا عند الإنشاء أو الإيقاف أو إعادة
التفعيل بعد إيقاف؛ حتى ذلك أضف الكتلة يدوياً قبل `location /` في `/etc/nginx/sites-available/<domain>.conf` ثم
`nginx -t && systemctl reload nginx`. تحقق:
`curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/internal/x` ← `404`.

### 4.8 فحوص CI الجديدة
- **Migrations on empty Postgres 16:** `prisma migrate deploy` على قاعدة فارغة، ثم
  `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma --exit-code` (أي انحراف = فشل)، ثم
  `node prisma/seed.mjs` مرتين مع مقارنة عدد الصفوف في كل الجداول (يجب ألا يتغير شيء في المرة الثانية)، ثم تشغيل
  تجريبي للمهام و`tenant-stats`.
- **AI/OCR SDKs must be approved sub-processors:** يفشل إن أُضيفت إلى `package.json` حزمة ذكاء اصطناعي أو OCR
  (`openai`، `@anthropic-ai/sdk`، `@google/generative-ai`، `tesseract.js`، `@aws-sdk/client-textract`، …) غير مدرجة في
  جدول "Approved AI / OCR packages" في `docs/processors.md` (فارغ حالياً، DEC-006).
- **المكوّنات الداخلية (DEC-011):** نفس الفحص يفشل إن كانت في `services/face/requirements.txt` حزمة Python غير
  مدرجة في جدول "Approved on-premise components" في `docs/processors.md`.

## 5. الحضور الذاتي من البوابة: الموقع والتحقق من الوجه (DEC-011)

**المفتاح `self_attendance_enabled` مطفأ افتراضياً. لا تفعّله قبل:**
1. موافقة المالك المكتوبة، وتحويل حالة المكوّن في `docs/processors.md` إلى APPROVED.
2. اعتماد نص إشعار الخصوصية الظاهر في البوابة.
3. تشغيل خدمة الوجه.
4. تحديد مواقع الحضور لكل فرع من صفحة الفرع.

### 5.1 خدمة التحقق من الوجه `radeef-face`
- **ما هي:** خدمة Python داخلية على `127.0.0.1:8090`، نسخة واحدة لكل المستأجرين، ولا يعرضها Nginx. لا تخزن شيئاً،
  وكل طلب يحتاج `Authorization: Bearer` بالتوكن.
- **نماذج كشف الالتقاط المباشر:** محوّلة إلى ONNX ومرفوعة في المستودع (`services/face/models/fasnet_*.onnx`، تم التحقق
  من مطابقتها للأصل). لا تحتاج إعادة التحويل إلا عند تغيير النموذج: `services/face/tools/convert_fasnet.py`. التراخيص في
  `services/face/models/MODELS.md`.
- **التثبيت على المضيف (نمط PM2):**
  ```bash
  sudo apt install -y python3-venv
  sudo ops/face-setup.sh --src /opt/radeef/src          # venv + الحزم + النماذج + /etc/radeef/services/face.env + خدمة systemd
  sudo ops/face-setup.sh --configure-tenants            # يضيف FACE_SERVICE_URL/TOKEN لكل /etc/radeef/<tenant>.env
  sudo -iu radeef pm2 startOrReload /opt/radeef/src/ecosystem.config.js --update-env
  curl -s http://127.0.0.1:8090/health                   # "liveness": true مطلوبة
  ```
  التوكن في `/etc/radeef/services/face.env`، وليس في `/etc/radeef/face.env`، لأن كل ملف `*.env` في `/etc/radeef` يُعامل
  مستأجراً في `ecosystem.config.js` و`deploy.sh` و`backup.sh` و`run-jobs.sh`.
  `--configure-tenants` يشمل أيضاً ملفات المستأجرين المذكورة في `/etc/radeef/jobs-extra.list`، ويستبدل سطور
  `FACE_SERVICE_*` الفارغة. القيم تُكتب بلا علامات تنصيص.
- **العزل:** الخدمة تفك صوراً يرسلها الموظفون، لذلك تعمل بمستخدم مؤقت من systemd (`DynamicUser`)، وليس بمستخدم
  المستأجرين `radeef`. ولا ترى `/etc/radeef` ولا الرفوعات ولا النسخ الاحتياطية ولا عمليات المستأجرين، وشبكتها محلية فقط.
  إن رفض systemd قديم أحد خيارات العزل، فالسكربت يعيد الـunit السابق، والسبب في `journalctl -u radeef-face`.
  الصور: الحد 3 ميجابايت و20 مليون بكسل (يُرفض "قنبلة فك الضغط" قبل أن تستهلك الذاكرة)، ولا تُكتب على القرص.
- **نمط Docker:**
  ```bash
  sudo install -d -m 700 /etc/radeef/services
  sudo sh -c 'umask 077; printf "FACE_SERVICE_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/radeef/services/face.env'  # بلا تنصيص
  docker build -t radeef-face services/face
  docker run -d --name radeef-face --restart unless-stopped --read-only --cap-drop ALL \
    --security-opt no-new-privileges --memory 1g --pids-limit 256 --tmpfs /tmp:size=16m \
    --env-file /etc/radeef/services/face.env -p 172.17.0.1:8090:8090 radeef-face
  sudo ufw allow in on docker0 from 172.17.0.0/16 to 172.17.0.1 port 8090 proto tcp   # مثل Postgres على 5432
  sudo ops/face-setup.sh --configure-tenants --mode docker
  ```
  ثم أعد إنشاء حاويات المستأجرين. إن كانت شبكة المستأجرين غير `docker0` (شبكة compose)، اسمح بمداها بدل `172.17.0.0/16`.
- **بعد إصدار غيّر `services/face`:** `sudo ops/face-setup.sh --update --src /opt/radeef/src`. السكربت يجهّز الملفات والحزم
  والنماذج أولاً، ثم يبدّل، ويرجع للملفات والـunit السابقين إن لم تصبح الخدمة سليمة (الحزم مثبتة الإصدارات في
  `services/face/constraints.txt`). `deploy.sh` لا يلمس هذه الخدمة.
- **السجلات:** `journalctl -u radeef-face -f`. لا تُسجَّل الصور ولا القوالب.
- **عند توقف الخدمة:** تُرفض حركات البوابة التي تحتاج الوجه (`FACE_SERVICE_UNAVAILABLE`، fail closed)، ويرفع
  الموظفون طلبات تصحيح. الخطوات: `systemctl status radeef-face`، ثم `curl` على `/health`، ثم التأكد من أن التوكن في
  ملف المستأجر يطابق `/etc/radeef/services/face.env`.
- **تدوير التوكن:**
  1. ولّد قيمة جديدة في `/etc/radeef/services/face.env`، ثم `systemctl restart radeef-face`.
  2. احذف سطري FACE_SERVICE_* من ملفات المستأجرين، ثم شغّل `--configure-tenants`.
  3. أعد تحميل المستأجرين.

### 5.2 الأذونات والترويسات
`Permissions-Policy` صارت `camera=(self), geolocation=(self)` في `next.config.ts` وفي `ops/nginx/tenant.conf.template`.
المواقع الموجودة على الخادم لا تتغير وحدها. لكل مستأجر:
```bash
sudo ops/new-tenant.sh --nginx-only <tenant> <domain> <port>
curl -sI https://<domain>/login | grep -i permissions-policy
```
الكاميرا والموقع يعملان عبر HTTPS فقط.

### 5.3 حذف البيانات الحيوية دورياً
المؤقت `ops/systemd/radeef-jobs@purge-attendance-biometrics.timer` (04:50 + حتى 20 دقيقة) يفعّله `ops/jobs-setup.sh` مع باقي المهام (4.1).
```bash
sudo -iu radeef /opt/radeef/src/ops/run-jobs.sh purge-attendance-biometrics <tenant>   # تجربة يدوية
```
**ماذا تحذف:**
- صور الحركات المرفوضة والمشبوهة الأقدم من `attendance_selfie_retention_days` (افتراضياً 90).
- قالب الوجه وصورته المرجعية لكل موظف انتهت خدمته.

**متى ترفض العمل:**
- إذا لم يكن `UPLOAD_DIR` مضبوطاً في ملف المستأجر.
- إذا كان مجلد `UPLOAD_DIR/.biometric` غير موجود بينما القاعدة تشير إلى ملفات. `run-jobs.sh` في نمط Docker يربط
  مجلد الملفات بالحاوية لهذا الغرض.

`ops/backup.sh` يستثني `.biometric` من أرشيف الملفات. القوالب نفسها مشفرة داخل نسخة القاعدة.

### 5.4 التجربة والمعايرة قبل التعميم
1. **على مستأجر واحد:**
   - حدّد مواقع فرع أو فرعين.
   - فعّل `self_attendance_enabled = 1` من الإعدادات.
   - اطلب من 5–10 موظفين التسجيل من أجهزة iPhone وAndroid مختلفة.
2. **لمدة أسبوع إلى أسبوعين:** راجع تبويب «الحضور من البوابة» في صفحة الحضور:
   - توزيع «التطابق» و«الالتقاط المباشر» للحركات المقبولة.
   - الحركات المرفوضة خطأً.
3. **اضبط العتبات في الإعدادات:**
   - `attendance_face_accept_pct` و`attendance_face_min_pct` (المبدئي 42 و36).
   - `attendance_liveness_*`.
   - `attendance_gps_max_accuracy_m`.
   - نصف قطر المواقع.
4. **جرّب الرفض عمداً:** صورة موظف آخر، وصورة على شاشة جوال، وتسجيل من خارج النطاق. كلها يجب أن تُرفض وتظهر في السجل
   بصورتها.
5. **لا تسويق** بمنع التلاعب تماماً أو بالذكاء الاصطناعي (DEC-002، DEC-005، DEC-006).

## 6. خدمة إصدار المستندات `radeef-render` (ADR-001، docs/document-engine)

خدمة داخلية تحوّل قالب Typst وبيانات جاهزة إلى PDF. نسخة واحدة لكل خادم تخدم كل المستأجرين، على
`127.0.0.1:8091` فقط، ولا تمر عبر Nginx أبداً. عديمة الحالة: كل طلب في مجلد مؤقت يُحذف بعده، ولا تكتب ولا تسجّل أي محتوى.
التصميم والقياسات في `docs/document-engine/POC.md` §H، والكود في `services/render/`.

- **ما يُثبَّت:**
  - ثنائي Typst 0.15.1 الرسمي، مثبّت ببصمة الحزمة وبصمة الثنائي في `services/render/typst.lock`.
  - حزمة الخطوط IBM Plex Sans Arabic، مثبّتة في `services/render/fonts.lock`.
  - `scripts/fetch-assets.sh` يرفض أي ملف لا تطابق بصمته.
  - الخدمة نفسها ترفض التشغيل إذا لم يطابق الثنائي أو الخطوط البصمات، أو وُجد خط إضافي في المجلد.
- **التثبيت (PM2 / المضيف):** يحتاج Node ‏20.9 أو أحدث في مسار نظامي (`/usr/bin/node`، لا `~/.nvm`)، و`xz-utils`.
  ```bash
  sudo ops/render-setup.sh --src /opt/radeef/src          # الأصول الموثّقة + /etc/radeef/services/render.env + خدمة systemd
  sudo ops/render-setup.sh --configure-tenants            # يضيف RENDER_SERVICE_URL/TOKEN لكل /etc/radeef/<tenant>.env
  pm2 startOrReload ecosystem.config.js --update-env
  ```
- **Docker:**
  ```bash
  sudo sh -c 'umask 077; printf "RENDER_SERVICE_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/radeef/services/render.env'
  docker build -t radeef-render services/render
  docker run -d --name radeef-render --restart unless-stopped --read-only --cap-drop ALL \
    --security-opt no-new-privileges --memory 512m --pids-limit 128 --tmpfs /tmp:size=160m,mode=1777 \
    --env-file /etc/radeef/services/render.env -p 172.17.0.1:8091:8091 radeef-render
  sudo ops/render-setup.sh --configure-tenants --mode docker
  ```
- **بعد إصدار غيّر `services/render`:**
  - `sudo ops/render-setup.sh --update --src /opt/radeef/src`.
  - يجهّز الملفات ويتحقق من الأصول أولاً، ثم يبدّل.
  - يرجع للملفات والـunit السابقين إن لم تصبح الخدمة سليمة (جُرّب ذلك فعلياً).
  - `deploy.sh` لا يلمس هذه الخدمة.
- **التحقق بعد التثبيت:** `curl -s 127.0.0.1:8091/health` يعرض `typst.version` و`typst.sha256` و`fontsSha256`. هذه القيم
  تُحفظ على كل مستند صادر (DOC-07)، ويجب أن تطابق `typst.lock` وبصمة الحزمة في اختبارات `services/render/test`.
- **السجلات:** `journalctl -u radeef-render -f`. سطر JSON لكل طلب فيه رمز الخطأ والأحجام والأزمنة فقط، ولا بيانات ولا
  رسائل Typst (قد تقتبس القالب والبيانات، فتُعاد للمستأجر فقط).
- **رموز الأخطاء المهمة:**

  | الرمز | المعنى | ما يفعله المستأجر |
  |---|---|---|
  | `UNSUPPORTED_CHARACTERS` (422) | حرف لا يوجد في الخط، والتفاصيل تسرد النقاط (مثل `U+4E2D`) | تصحيح البيانات. لا يصدر مستند بمربعات فارغة |
  | `TEMPLATE_ERROR` / `RENDER_WARNING` (422) | خطأ أو تحذير من Typst، والتحذير يُعامل كخطأ | خلل في القالب، ويُصلح في الكود |
  | `BUSY` (503، `Retry-After: 2`) | 4 تصييرات جارية و16 في الانتظار | إعادة المحاولة من طابور المهام |
  | `RENDER_TIMEOUT` (504) | تجاوز 15 ثانية، وتُقتل مجموعة العمليات كاملة | إعادة المحاولة. ويُراجع القالب إن تكرر |

- **عند توقف الخدمة:**
  - الإصدار يفشل ويبقى الرقم محجوزاً على المهمة (DOC-02)، ثم تعيد `scripts/jobs.mjs` المحاولة.
  - خطوات الفحص: `systemctl status radeef-render`، ثم `/health`، ثم مطابقة التوكن.
- **تدوير التوكن:** مثل `radeef-face` (§5.1)، مع `render.env` و`RENDER_SERVICE_*`.
- **ترقية Typst أو الخطوط:**
  - تغيير `typst.lock` أو `fonts.lock` يغيّر البايتات الناتجة.
  - يُحدَّث `GOLDEN` في `services/render/test/helpers.mjs` في نفس الـcommit بعد مراجعة بصرية للمخرجات.
  - المستندات الصادرة سابقاً تحتفظ بنسخ ما صدرت به (DOC-07).
- **العزل (مقاس في الاختبار):**
  - `systemd-analyze security radeef-render` = 1.2 (OK).
  - لا شبكة إلا مقبسها المحلي، ولا ترى `/etc/radeef` ولا `/var/lib/radeef` ولا `/home`.
  - `SystemCallFilter` مع `pkey_*`، لأن V8 يحتاجها، و`UV_USE_IO_URING=0`.

### 6.1 تفعيل إصدار المستندات لعميل

1. الخدمة تعمل (§6)، ثم `ops/render-setup.sh --configure-tenants`. هذا يضيف `RENDER_SERVICE_URL` و`RENDER_SERVICE_TOKEN`.
2. `APP_URL` في ملف العميل هو عنوانه العام بـhttps، وهو أصل رابط التحقق المطبوع في QR (`<APP_URL>/v/<token>`). بدونه لا يصدر أي مستند.
3. الترحيل `9b_document_engine` يُطبَّق مع النشر المعتاد (expand-only).
4. المالك من «المستندات الرسمية ← الإعدادات» لكل شركة نظامية:
   - بادئة الترقيم، وهي ثابتة بعد أول إصدار.
   - الشعار والتوقيع والختم (PNG).
   - الموقّع، ويُربط بحسابه إن وُجد.
   - موقّع كل نوع.
   - التفويض المسبق عند الحاجة. يسري بعد قبول الموقّع من صفحة المستندات.
5. **التفعيل تدريجي:** لا تظهر «مستنداتي الرسمية» في بوابة موظفي شركة، ولا تُقبل طلباتها، حتى تكتمل البنود 1 و2 وبادئة الترقيم. حتى ذلك الحين يبقى طلب «شهادة أو خطاب» يدوياً إلى الموارد البشرية كما كان.

**الإصدار وإعادة المحاولة:**
- الإصدار متزامن (نحو 100 إلى 300 ms).
- إذا تعذرت الخدمة يبقى الطلب «قيد الإصدار» ومعه رقمه المحجوز. يُعاد التصيير تلقائياً بتباعد متزايد (30 ثانية ثم دقيقة ثم دقيقتان … حتى ساعة، 8 محاولات) عند فتح قوائم المستندات، وبزر «إعادة المحاولة» في صفحة الموارد البشرية.
- لا توجد مهمة في `scripts/jobs.mjs`، لأن خط الإصدار TypeScript داخل التطبيق.
- الأعطال الدائمة (ملف شعار أو توقيع مفقود، أو حرف غير مدعوم) تُوقف المهمة (`BLOCKED`) برسالة واضحة، ولا تُعاد تلقائياً.
- المستندات الصادرة في `UPLOAD_DIR/.documents`، والأصول في `UPLOAD_DIR/.document-assets`. المجلدان داخل النسخ الاحتياطي الحالي لـ`UPLOAD_DIR`، ولا يصل إليهما `/api/files`.

### 6.2 مهام المستندات الخلفية (`scripts/jobs.mjs`)

| المهمة | ما تفعله | ملاحظات |
|---|---|---|
| `apply-employee-changes` | تطبّق قرارات الترقية أو تعديل الراتب التي حلّ تاريخ سريانها على ملف الموظف مرة واحدة (الراتب الأساسي والمسمى)، وتكتب `SalaryChange` (`isPlanned=false`) وسطر تدقيق | يطبّقها التطبيق أيضاً عند فتح قائمة المستندات وقبل توليد مسيّر الرواتب، فتأخر المؤقت لا يفوّت زيادة على المسيّر |
| `documents-integrity` | تتحقق من سلسلة بصمات `DocumentEvent` كاملة، وتعيد حساب SHA-256 لكل ملف مستند صادر وتقارنه بـ`pdfSha256` | أي خلل يجعل التشغيل `FAILED` مع رقم المستند وسبب الخلل، ويرسل بريداً واحداً يومياً للمديرين (أدوار `expiry_digest_roles`). الحد الأقصى للملفات في التشغيل الواحد `DOCUMENTS_INTEGRITY_MAX` (افتراضي 2000). يحتاج `UPLOAD_DIR` |
| `documents-retention` | بعد `document_retention_years` (افتراضي 10، قرار المالك) من تاريخ انتهاء خدمة الموظف: يحذف ملف الـPDF ويمسح محتوى اللقطات، ويبقى سجل المستند (الرقم والنوع والشركة والتواريخ والبصمة). صفحة التحقق تعرض «انتهت مدة الاحتفاظ» | `--dry-run` يعدّ فقط. الحذف مسموح بـtrigger لمرة واحدة فقط ولا يُتراجع عنه. يؤكد المستشار المدة ضمن DEC-008 قبل تفعيل المؤقت |

الحدث `PURGED` تكتبه المهمة بدالة التطبيق نفسها (`src/lib/documents/events.ts`، المهام في `src/lib/documents/jobs.ts`). `scripts/lib/document-chain.mjs` بقي نسخة JS للقراءة فقط يستعملها تقرير المطابقة، واختبار `documents-chain-parity` يمنع أي اختلاف في التجزئة.

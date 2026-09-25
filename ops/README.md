# ops/ — النشر والتشغيل

الدليل الكامل: [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md).

| الملف | الوظيفة |
|---|---|
| `deploy.sh` | نشر بلا توقف: بناء مرة واحدة ثم لكل مستأجر `pg_dump` ← `prisma migrate deploy` ← canary ← تبديل ← فحص صحة مع رجوع تلقائي. `--mode pm2` (افتراضي) أو `--mode docker`، و`--rollback`، و`--build-only`. يكمل بعد فشل مستأجر، ويطبع مصفوفة المستأجر × الإصدار، ويخرج بقيمة غير صفرية عند أي فشل؛ canary بـ connection_limit=2 والترحيل بـ lock_timeout. |
| `backup.sh` | نسخ يومي `pg_dump -Fc` + أرشيف الملفات لكل مستأجر، احتفاظ 7/4/6، ونسخة خارجية عبر `rclone` عند ضبط `RCLONE_REMOTE`. |
| `restore.sh` | استعادة مستأجر من نسخة (مع نسخة أمان للوضع الحالي أولًا). |
| `new-tenant.sh` | إنشاء مستأجر: دور وقاعدة Postgres مستقلان، `/etc/radeef/<tenant>.env` بأسرار عشوائية، المجلدات، موقع Nginx وشهادة TLS. `--nginx-only` للمستأجرين الحاليين. يضبط connection_limit=5 ومهلات الدور (statement_timeout=30s، idle_in_transaction_session_timeout=60s)، ويكتب SMTP_* (من TENANT_SMTP_* أو فارغة) مع سرد الناقص قبل الإنشاء. |
| `run-jobs.sh` | تشغيل مهمة من `scripts/jobs.mjs` (`expiry-digest`، `deactivate-terminated`، `outbox-dispatch`) لكل المستأجرين مع تأخير عشوائي، لمؤقت systemd أو cron (RUNBOOK 4.1). يتخطى `RADEEF_JOBS="off"` ويكمل بعد فشل مستأجر. |
| `lib/common.sh` | دوال مشتركة (التحقق من اسم المستأجر، قراءة ملف البيئة بلا تنفيذه، تمرير كلمة مرور Postgres عبر `PGPASSWORD` لا سطر الأوامر). |
| `nginx/tenant.conf.template` | قالب موقع Nginx: HTTP→HTTPS، TLS، HSTS وترويسات الأمان، `client_max_body_size 12m`، gzip، صفحة صيانة عامة لـ 502/503/504. ويرجع 404 لـ `/api/internal/`. |
| `nginx/maintenance.html` | صفحة الصيانة العامة (تُنسخ إلى `/var/www/radeef-maintenance/__maintenance.html`). |
| `nginx/dar.radeef-sa.com.conf.legacy` | إعداد Nginx القديم (HTTP فقط) للمرجعية. |
| `legacy/` | سكربتات تشخيص قديمة مُهملة، بلا أسرار. لا تُستخدم. |

قواعد مشتركة لكل السكربتات: `set -euo pipefail`، اسم المستأجر يطابق `^[a-z][a-z0-9-]{1,29}$`، لا أسرار داخل السكربتات (كل شيء من `/etc/radeef/<tenant>.env` بصلاحية 600)، ومسارات افتراضية قابلة للتغيير بمتغيرات البيئة: `RADEEF_ROOT=/opt/radeef`، `ENV_DIR=/etc/radeef`، `DATA_DIR=/var/lib/radeef`، `BACKUP_DIR=/var/backups/radeef`.

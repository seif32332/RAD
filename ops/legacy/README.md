# ops/legacy — سكربتات تشخيص قديمة (مُهملة / DEPRECATED)

هذه الملفات كانت في جذر المستودع، وكُتبت لتشخيص مشكلة صفحة `renewals` على بيئة `dar`
عبر SSH كمستخدم root. **لا تُستخدم للنشر.** النشر الحالي عبر `ops/deploy.sh` أو
`docker-compose.yml` (انظر `README.md` و `docs/RUNBOOK.md`).

## لماذا بقيت؟

للمرجعية التاريخية فقط. كانت تحتوي كلمة مرور root للسيرفر وعنوان IP وكلمة مرور Postgres
وسرّ جلسة ثابت وكلمة مرور مدير افتراضية بشكل نصي. **أُزيلت كل هذه القيم**، ويجب اعتبارها
مسرّبة وتدويرها فورًا (القسم "إجراءات فورية" في `docs/RUNBOOK.md`). إذا كان المستودع قد
رُفع إلى GitHub أو أي مكان آخر، نظّف التاريخ بـ `git filter-repo` بعد التدوير.

## التشغيل (إن اضطررت)

السكربتات تعتمد على الحزمة `ssh2` غير المثبتة في المشروع (عن قصد). كل بيانات الاتصال تُقرأ
من متغيرات البيئة عبر `ssh-config.js`، وأي متغير ناقص يرمي خطأ فورًا:

| المتغير | إلزامي | الوصف |
|---|---|---|
| `SSH_HOST` | نعم | عنوان السيرفر |
| `SSH_USER` | نعم | مستخدم النشر (غير root مستحسن) |
| `SSH_KEY_PATH` | مفضّل | مسار المفتاح الخاص |
| `SSH_KEY_PASSPHRASE` | لا | عبارة مرور المفتاح |
| `SSH_PASSWORD` | لا يُنصح | يُستخدم فقط إن غاب `SSH_KEY_PATH` |
| `SSH_PORT` | لا | الافتراضي 22 |
| `LOCAL_REPO_DIR` | لسكربتات `deploy_*.js` | مسار نسخة المستودع المحلية |
| `DATABASE_URL` | لـ `test.js` | اتصال قاعدة البيانات |

```bash
npm i --no-save ssh2
SSH_HOST=... SSH_USER=deploy SSH_KEY_PATH=~/.ssh/id_ed25519 node ops/legacy/diagnose.js
```

## الملفات

- `check_*.js`, `compare*.js`, `diagnose*.js`, `find_radeef.js`, `verify.js`: قراءة فقط (سجلات PM2، nginx، ملفات).
- `deploy_*.js`, `rebuild.js`: ترفع ملفات وتبني على السيرفر الحي. **لا تستخدمها.**
- `deploy_all.sh.old`: سكربت النشر القديم (rsync لـ `/root/` بين المستأجرين، `prisma db push --accept-data-loss`). ينتهي بـ `exit 1` في أوله عمدًا.
- `test.js`: يطبع جدول `RolePermission`.

هذا المجلد مستثنى من ESLint.

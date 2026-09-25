'use strict';
/**
 * Tenant operations shared by the web panel (server.js) and the CLI (cli.js).
 * Every value that reaches a shell is validated (lib/validate.js) and quoted with shq().
 */
const fs = require('fs');
const path = require('path');
const V = require('./validate');
const { shq, sqlIdent, sqlLiteral } = V;
const { exec, writeRemoteFile, remoteTest } = require('./ssh');
const nginx = require('./nginx');
const { todayKey, addMonthsKey, daysUntilKey, stamp } = require('./dates');
const { TENANT_STATUS } = require('./store');
const { licenseAction, renewFromEndDate, noticeKind, DEFAULT_REMINDER_DAYS } = require('./license');
const { validateCommercial, commercialView } = require('./commercial');
const { TENANT_SMTP_KEYS, missingTenantSmtp } = require('./config');

/** Prisma pool per app process (DEC-004: 4-5 now; the deploy canary uses 2). */
const TENANT_CONNECTION_LIMIT = 5;
/** Per-role session defaults applied to every tenant role we create (DEC-004). */
const ROLE_TIMEOUTS = Object.freeze({ statement_timeout: '30s', idle_in_transaction_session_timeout: '60s' });
/**
 * Migrations: do not queue behind a long lock (lock_timeout) and lift the 30s role
 * statement_timeout for DDL. Passed through the Prisma URL "options" parameter (verified with
 * prisma 5.22: the schema engine applies it).
 */
const MIGRATE_PG_OPTIONS = encodeURIComponent('-c lock_timeout=10s -c statement_timeout=15min');

class OpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'OpError';
    this.status = status;
  }
}

const noopLog = () => {};

/* ------------------------------------------------------------------ serialization */

let chain = Promise.resolve();
let lockDepth = 0;

/** Run mutating operations one at a time (port allocation, nginx reloads, DB drops). */
function serialize(fn) {
  lockDepth++;
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run.finally(() => {
    lockDepth--;
  });
}

function isBusy() {
  return lockDepth > 0;
}

/* ------------------------------------------------------------------ PostgreSQL */

function pgArgs(cfg, db = 'postgres') {
  return `-h ${shq(cfg.pg.host)} -p ${shq(String(cfg.pg.port))} -U ${shq(cfg.pg.user)} -d ${shq(db)}`;
}

function pgSecrets(cfg) {
  return cfg.pg.password ? { PGPASSWORD: cfg.pg.password } : {};
}

/** Run SQL through psql's stdin (never on the command line). Returns trimmed stdout. */
async function psql(conn, cfg, sql, { db = 'postgres', label = 'psql', allowFail = false } = {}) {
  const res = await exec(conn, `psql -X -q -At -v ON_ERROR_STOP=1 ${pgArgs(cfg, db)} -f -`, {
    secrets: pgSecrets(cfg),
    stdin: `${sql}\n`,
    label,
    allowFail,
  });
  return res.stdout;
}

async function dbExists(conn, cfg, dbName) {
  const out = await psql(conn, cfg, `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(V.validatePgName(dbName))};`, {
    label: 'check database',
  });
  return out.trim() === '1';
}

async function roleExists(conn, cfg, roleName) {
  const out = await psql(conn, cfg, `SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(V.validatePgName(roleName))};`, {
    label: 'check role',
  });
  return out.trim() === '1';
}

async function listDatabases(conn, cfg) {
  const out = await psql(conn, cfg, "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1;", {
    label: 'list databases',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => V.PG_NAME_RE.test(s));
}

/** pg_dump -Fc to `file` (written to a temp name, checked non-empty, then renamed). */
async function pgDump(conn, cfg, dbName, file) {
  V.validatePgName(dbName);
  const tmp = `${file}.partial`;
  await exec(
    conn,
    `umask 077 && pg_dump -Fc ${pgArgs(cfg, dbName)} -f ${shq(tmp)} && test -s ${shq(tmp)} && mv -f -- ${shq(tmp)} ${shq(file)}`,
    { secrets: pgSecrets(cfg), label: `pg_dump ${dbName}`, timeoutMs: 2 * 60 * 60 * 1000 },
  );
  return file;
}

async function ensureBackupDir(conn, dir) {
  await exec(conn, `umask 077 && mkdir -p -- ${shq(dir)} && chmod 700 -- ${shq(dir)}`, { label: 'create backup directory' });
}

/* ------------------------------------------------------------------ PM2 / host */

function procPort(proc) {
  const env = proc.pm2_env || {};
  const raw = env.PORT ?? (env.env && env.env.PORT);
  let port = parseInt(raw, 10);
  if (!Number.isInteger(port)) {
    const args = Array.isArray(env.args) ? env.args : [];
    const idx = args.indexOf('PORT');
    if (idx !== -1) port = parseInt(args[idx + 1], 10);
  }
  return Number.isInteger(port) ? port : null;
}

/** Parsed `pm2 jlist` (only the fields we need; pm2 env vars are never returned). */
async function pm2List(conn) {
  const { stdout } = await exec(conn, 'pm2 jlist', { label: 'pm2 jlist' });
  // pm2 may print "[PM2] ..." warnings before the JSON array: try the whole output, then each
  // line that looks like a JSON array, last first.
  let list = null;
  const candidates = [stdout, ...stdout.split('\n').filter((l) => l.trim().startsWith('[{') || l.trim() === '[]').reverse()];
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) {
        list = parsed;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!list) throw new OpError('تعذر قراءة قائمة PM2 من السيرفر', 502);
  return list
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      name: p.name,
      port: procPort(p),
      status: (p.pm2_env && p.pm2_env.status) || 'unknown',
      cwd: (p.pm2_env && p.pm2_env.pm_cwd) || '',
      memory: Math.round(((p.monit && p.monit.memory) || 0) / 1024 / 1024),
      cpu: (p.monit && p.monit.cpu) || 0,
    }));
}

async function listeningPorts(conn) {
  const { stdout } = await exec(conn, "ss -Htln 2>/dev/null | awk '{print $4}'", { allowFail: true, label: 'ss' });
  const ports = new Set();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/:(\d+)$/);
    if (m) ports.add(parseInt(m[1], 10));
  }
  return ports;
}

async function systemStats(conn) {
  const { stdout } = await exec(
    conn,
    "free -m | awk 'NR==2{print $2, $3}'; top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'; df -P / | tail -1 | awk '{print $5}'",
    { label: 'system stats' },
  );
  const [memLine = '', cpuLine = '', diskLine = ''] = stdout.split('\n');
  const [total, used] = memLine.trim().split(/\s+/).map((n) => parseInt(n, 10));
  const ram = total > 0 ? Math.round((used / total) * 100) : 0;
  const cpu = Math.round((parseFloat(cpuLine) || 0) * 10) / 10;
  const disk = parseInt(diskLine.replace('%', ''), 10) || 0;
  return { ram, cpu, disk };
}

/* ------------------------------------------------------------------ listing */

function tenantView(row, proc, guessDomain) {
  const managed = !!row;
  const endDate = row ? row.end_date || null : null;
  return {
    name: proc ? proc.name : row.name,
    port: proc && proc.port ? proc.port : row && row.port ? row.port : 'مجهول',
    status: proc ? proc.status : 'missing',
    cwd: proc ? proc.cwd : (row && row.app_dir) || '',
    domain: row && row.domain ? row.domain : guessDomain,
    memory: proc ? proc.memory : 0,
    cpu: proc ? proc.cpu : 0,
    client_email: row ? row.client_email || '' : '',
    start_date: row ? row.start_date || null : null,
    end_date: endDate,
    duration_months: row ? row.duration_months || null : null,
    days_remaining: endDate ? daysUntilKey(endDate) : null,
    license_status: managed ? row.status || TENANT_STATUS.ACTIVE : 'unmanaged',
    managed,
    auto_suspend: !!(row && row.auto_suspend && endDate),
    commercial: managed ? commercialView(row) : null,
  };
}

async function listTenants(conn, store, cfg) {
  const [procs, rows, nginxOut] = await Promise.all([
    pm2List(conn),
    store.list(),
    exec(conn, 'ls -1 /etc/nginx/sites-enabled/ 2>/dev/null', { allowFail: true, label: 'ls nginx' }).then((r) => r.stdout),
  ]);
  const sites = nginxOut
    .split('\n')
    .map((l) => l.trim().replace(/\.conf$/, ''))
    .filter(Boolean);
  const rowMap = new Map(rows.map((r) => [r.name, r]));
  const seen = new Set();
  const out = [];
  for (const proc of procs) {
    seen.add(proc.name);
    const guess =
      sites.find((s) => s === proc.name || s.startsWith(`${proc.name}.`)) || `${proc.name.toLowerCase()}.${cfg.baseDomain}`;
    out.push(tenantView(rowMap.get(proc.name), proc, guess));
  }
  for (const row of rows) {
    if (!seen.has(row.name)) out.push(tenantView(row, null, row.domain));
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

function appDirFor(row, cfg) {
  return row.app_dir || `${cfg.tenantsRoot}/${row.name}`;
}

function dbNameFor(row) {
  return row.db_name || V.legacyDbNameFor(row.name);
}

async function requireManaged(store, name) {
  const row = await store.get(name);
  if (!row) throw new OpError('النسخة غير مسجلة في لوحة الإدارة', 404);
  return row;
}

function hostSafe(value, label) {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(String(value))) throw new OpError(`${label} غير صالح`, 500);
  return value;
}

/* ------------------------------------------------------------------ create */

/**
 * Provision a new tenant from a clean release directory.
 * params: { name, domain, template, client_email, admin_email, duration_months }
 * Returns { credentials: { url, email, password } } — the password is shown to the operator once.
 */
async function createTenant(conn, store, cfg, params, log = noopLog) {
  const name = V.validateTenantName(params.name);
  const domain = V.validateDomain(params.domain);
  const template = params.template ? V.validateSafePath(params.template, 'template') : cfg.releaseDirs[0];
  if (!cfg.releaseDirs.includes(template)) throw new OpError('القالب غير مسموح به (RELEASE_DIRS)');
  const clientEmail = V.validateEmail(params.client_email);
  const adminEmail = V.validateEmail(params.admin_email || params.client_email);
  const months = V.validateMonths(params.duration_months ?? 1);
  const { dbName, roleName } = V.pgNamesFor(name);
  const appDir = `${cfg.tenantsRoot}/${name}`;
  const dataDir = `${cfg.dataRoot}/${name}`;
  const uploadDir = `${dataDir}/uploads`;

  if (await store.get(name)) throw new OpError('يوجد نسخة مسجلة بنفس الاسم', 409);
  if (await store.getByDomain(domain)) throw new OpError('النطاق مستخدم لنسخة أخرى', 409);

  // ---- 1. pre-flight checks (nothing is modified yet)
  log('فحص السيرفر قبل التثبيت...', 'info', 12);
  const procs = await pm2List(conn);
  if (procs.some((p) => p.name.toLowerCase() === name)) throw new OpError('يوجد عملية PM2 بنفس الاسم على السيرفر', 409);
  if (await remoteTest(conn, `-e ${shq(appDir)}`)) throw new OpError(`المجلد ${appDir} موجود مسبقاً — لن يتم الكتابة فوقه`, 409);
  if (await remoteTest(conn, `-e ${shq(dataDir)}`)) throw new OpError(`مجلد البيانات ${dataDir} موجود مسبقاً`, 409);
  if (await nginx.siteExists(conn, domain)) throw new OpError('يوجد إعداد Nginx لهذا النطاق مسبقاً', 409);
  if (!(await remoteTest(conn, `-f ${shq(`${template}/package.json`)} -a -d ${shq(`${template}/prisma/migrations`)} -a -f ${shq(`${template}/prisma/seed.mjs`)}`))) {
    throw new OpError(`مجلد الإصدار ${template} غير صالح (package.json / prisma/migrations / prisma/seed.mjs)`, 400);
  }
  if (await dbExists(conn, cfg, dbName)) throw new OpError(`قاعدة البيانات ${dbName} موجودة مسبقاً — لن يتم استخدامها`, 409);
  if (await roleExists(conn, cfg, roleName)) throw new OpError(`دور قاعدة البيانات ${roleName} موجود مسبقاً`, 409);
  const smtpMissing = missingTenantSmtp(cfg.tenantSmtp);
  if (smtpMissing.length > 0) {
    // Not blocking: the mail provider is an owner decision (DEC-009). The tenant env still gets
    // every SMTP_* key (empty) so it can be filled in later without guessing the names.
    log(
      `تنبيه: إعدادات البريد للنسخة غير مكتملة (${smtpMissing.join('، ')}) — ستُكتب متغيرات SMTP_* فارغة ولن ترسل النسخة بريداً حتى تُملأ.`,
      'warning',
      14,
    );
  }

  // ---- 2. port
  log('البحث عن منفذ متاح...', 'info', 15);
  const used = await listeningPorts(conn);
  for (const p of procs) if (p.port) used.add(p.port);
  for (const r of await store.list()) if (r.port) used.add(Number(r.port));
  let port = cfg.startPort;
  while (used.has(port)) port++;
  if (port > 65000) throw new OpError('لا يوجد منفذ متاح', 500);
  log(`تم اختيار المنفذ: ${port}`, 'success', 18);

  const today = todayKey();
  await store.insert({
    name,
    domain,
    port,
    client_email: clientEmail,
    start_date: today,
    end_date: addMonthsKey(today, months),
    duration_months: months,
    status: TENANT_STATUS.PROVISIONING,
    app_dir: appDir,
    db_name: dbName,
    db_role: roleName,
    data_dir: dataDir,
    auto_suspend: true,
  });

  try {
    // ---- 3. database + dedicated role
    log(`إنشاء قاعدة البيانات ${dbName} ودور مستقل ${roleName}...`, 'info', 22);
    const dbPassword = V.randomHex(24);
    await psql(
      conn,
      cfg,
      [
        `CREATE ROLE ${sqlIdent(roleName)} LOGIN PASSWORD ${sqlLiteral(dbPassword)};`,
        ...Object.entries(ROLE_TIMEOUTS).map(([k, v]) => `ALTER ROLE ${sqlIdent(roleName)} SET ${k} = ${sqlLiteral(v)};`),
        `CREATE DATABASE ${sqlIdent(dbName)} OWNER ${sqlIdent(roleName)} ENCODING 'UTF8' TEMPLATE template0;`,
        `REVOKE ALL ON DATABASE ${sqlIdent(dbName)} FROM PUBLIC;`,
        `GRANT ALL ON DATABASE ${sqlIdent(dbName)} TO ${sqlIdent(roleName)};`,
      ].join('\n'),
      { label: 'create database' },
    );
    // PostgreSQL 15+ lets the database owner create in `public`; this also covers older versions
    // when PGUSER is a superuser. Not fatal otherwise.
    await psql(conn, cfg, `ALTER SCHEMA public OWNER TO ${sqlIdent(roleName)};`, { db: dbName, label: 'grant schema', allowFail: true });
    log('تم إنشاء قاعدة البيانات.', 'success', 28);

    // ---- 4. clean copy of the release (no .env, uploads, build output or git metadata)
    log(`نسخ الإصدار النظيف من ${template}...`, 'info', 32);
    await exec(conn, `mkdir -p -- ${shq(cfg.tenantsRoot)}`, { label: 'mkdir tenants root' });
    const hasRsync = (await exec(conn, 'command -v rsync', { allowFail: true })).code === 0;
    if (hasRsync) {
      const excludes = ['/.env', '/.env.*', '/uploads/', '/public/uploads/', '/.next/', '/.git/'].map((e) => `--exclude=${shq(e)}`).join(' ');
      await exec(conn, `rsync -a ${excludes} -- ${shq(`${template}/`)} ${shq(`${appDir}/`)}`, { label: 'copy release' });
    } else {
      await exec(
        conn,
        `cp -a -- ${shq(template)} ${shq(appDir)} && rm -rf -- ${shq(`${appDir}/.env`)} ${shq(`${appDir}/.next`)} ${shq(`${appDir}/.git`)} ${shq(`${appDir}/uploads`)} ${shq(`${appDir}/public/uploads`)} && find ${shq(appDir)} -maxdepth 1 -name '.env.*' -type f -delete`,
        { label: 'copy release' },
      );
    }
    await exec(conn, `chmod 750 -- ${shq(appDir)}`, { label: 'chmod app dir' });

    if (!(await remoteTest(conn, `-d ${shq(`${appDir}/node_modules`)}`))) {
      log('تثبيت الحزم (npm ci)...', 'info', 36);
      await exec(conn, `cd ${shq(appDir)} && npm ci --no-audit --no-fund`, { label: 'npm ci' });
    }
    await exec(conn, `cd ${shq(appDir)} && npx prisma generate`, { label: 'prisma generate' });

    // ---- 5. private data directory + .env (SFTP, mode 600)
    log('تكوين متغيرات البيئة (.env) ومجلد الملفات...', 'info', 42);
    await exec(conn, `umask 077 && mkdir -p -- ${shq(uploadDir)} && chmod 700 -- ${shq(dataDir)} ${shq(uploadDir)}`, {
      label: 'create data dir',
    });
    const dbUrl =
      `postgresql://${encodeURIComponent(roleName)}:${encodeURIComponent(dbPassword)}` +
      `@${hostSafe(cfg.pg.tenantHost, 'TENANT_DB_HOST')}:${Number(cfg.pg.port)}/${encodeURIComponent(dbName)}` +
      `?schema=public&connection_limit=${TENANT_CONNECTION_LIMIT}&pool_timeout=20`;
    const smtp = cfg.tenantSmtp || {};
    const envContent = [
      `# Generated by radeef-manage for tenant "${name}" on ${new Date().toISOString()}. Keep private (chmod 600).`,
      'NODE_ENV="production"',
      `PORT=${port}`,
      `DATABASE_URL="${dbUrl}"`,
      `SESSION_SECRET="${V.randomSecret(32)}"`,
      `DATA_ENCRYPTION_KEY="${V.randomSecret(32)}"`,
      `UPLOAD_DIR="${uploadDir}"`,
      `APP_URL="https://${domain}"`,
      `NEXTAUTH_URL="https://${domain}"`,
      '',
      '# Outgoing e-mail. Empty until the owner approves a provider (docs/processors.md).',
      ...TENANT_SMTP_KEYS.map((k) => `${k}="${smtp[k] || ''}"`),
      '',
    ].join('\n');
    await writeRemoteFile(conn, `${appDir}/.env`, envContent, 0o600);

    // ---- 6. schema + seed + build
    const withEnv = `cd ${shq(appDir)} && set -a && . ./.env && set +a`;
    log('تطبيق ترحيلات قاعدة البيانات (prisma migrate deploy)...', 'info', 50);
    // Same database, but with lock_timeout (and without the 30s role statement_timeout).
    await exec(conn, `${withEnv} && DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy`, {
      secrets: { MIGRATE_DATABASE_URL: `${dbUrl}&options=${MIGRATE_PG_OPTIONS}` },
      label: 'prisma migrate deploy',
    });

    log('تهيئة البيانات الأساسية وحساب المدير (prisma/seed.mjs)...', 'info', 56);
    const adminPassword = V.randomAdminPassword();
    await exec(conn, `${withEnv} && node prisma/seed.mjs`, {
      secrets: { ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: adminPassword },
      label: 'seed',
    });

    log('جاري بناء التطبيق (npm run build)... يرجى الانتظار', 'info', 62);
    await exec(conn, `${withEnv} && npm run build`, { label: 'npm run build', timeoutMs: 60 * 60 * 1000 });
    log('تم بناء التطبيق بنجاح.', 'success', 82);

    // ---- 7. PM2
    log('تشغيل النسخة عبر PM2...', 'info', 86);
    await exec(conn, `cd ${shq(appDir)} && PORT=${port} pm2 start npm --name ${shq(name)} -- start && pm2 save`, { label: 'pm2 start' });

    // ---- 8. nginx (+ certificate for domains outside the wildcard)
    log('تكوين Nginx...', 'info', 90);
    await nginx.ensureStatusPages(conn, cfg);
    let tls = await nginx.resolveTls(conn, cfg, domain);
    if (!tls && !nginx.coveredByWildcard(domain, cfg.baseDomain)) {
      await nginx.installSite(conn, domain, nginx.activeConfig({ name, domain, port, tls: null, cfg }), cfg.backupDir);
      if (cfg.certbotEmail) {
        log('إصدار شهادة TLS عبر certbot...', 'info', 93);
        const cert = await exec(
          conn,
          `certbot certonly --webroot -w ${shq(cfg.acmeWebroot)} -d ${shq(domain)} --non-interactive --agree-tos -m ${shq(cfg.certbotEmail)}`,
          { allowFail: true, label: 'certbot' },
        );
        if (cert.code !== 0) log('تعذر إصدار الشهادة — الموقع يعمل عبر HTTP فقط. تحقق من DNS ثم أعد المحاولة.', 'warning', 94);
        tls = await nginx.resolveTls(conn, cfg, domain);
      } else {
        log('CERTBOT_EMAIL غير مضبوط — الموقع يعمل عبر HTTP فقط.', 'warning', 94);
      }
    } else if (!tls) {
      log('شهادة Wildcard غير موجودة (WILDCARD_CERT_DIR) — الموقع يعمل عبر HTTP فقط.', 'warning', 94);
    }
    await nginx.installSite(conn, domain, nginx.activeConfig({ name, domain, port, tls, cfg }), cfg.backupDir);
    log(tls ? 'تم تفعيل HTTPS للنسخة.' : 'تم تفعيل الموقع.', 'success', 96);

    await store.update(name, { status: TENANT_STATUS.ACTIVE });
    log('تم حفظ بيانات الترخيص.', 'success', 99);
    return { credentials: { url: `${tls ? 'https' : 'http'}://${domain}`, email: adminEmail, password: adminPassword } };
  } catch (err) {
    await store.update(name, { status: TENANT_STATUS.FAILED }).catch(() => {});
    throw err;
  }
}

/* ------------------------------------------------------------------ delete */

/**
 * Delete a managed tenant. Requires `confirm === name`. Takes a DB dump and a files archive
 * FIRST; aborts if either fails.
 */
async function deleteTenant(conn, store, cfg, params, log = noopLog) {
  const name = V.validateExistingName(params.name);
  if (typeof params.confirm !== 'string' || params.confirm !== name) {
    throw new OpError('يجب كتابة اسم النسخة بالضبط لتأكيد الحذف', 400);
  }
  const row = await requireManaged(store, name);
  const appDir = V.assertDeletableTenantPath(appDirFor(row, cfg), name);
  const dataDir = row.data_dir ? V.assertDeletableTenantPath(row.data_dir, name) : null;
  const dbName = V.validatePgName(dbNameFor(row));
  const when = stamp();
  const dir = `${cfg.backupDir}/deleted`;
  await ensureBackupDir(conn, cfg.backupDir);
  await ensureBackupDir(conn, dir);

  // 1. backups (mandatory)
  if (await dbExists(conn, cfg, dbName)) {
    log(`أخذ نسخة احتياطية من قاعدة البيانات ${dbName}...`);
    await pgDump(conn, cfg, dbName, `${dir}/${name}_${when}.dump`);
  } else {
    log(`قاعدة البيانات ${dbName} غير موجودة — تخطي.`);
  }
  if (await remoteTest(conn, `-d ${shq(appDir)}`)) {
    log('أرشفة ملفات النسخة (.env والملفات المرفوعة)...');
    await exec(
      conn,
      `umask 077 && tar -czf ${shq(`${dir}/${name}_${when}_app.tar.gz`)} --exclude=./node_modules --exclude=./.next -C ${shq(appDir)} .`,
      { label: 'archive app dir', timeoutMs: 2 * 60 * 60 * 1000 },
    );
  }
  if (dataDir && (await remoteTest(conn, `-d ${shq(dataDir)}`))) {
    await exec(conn, `umask 077 && tar -czf ${shq(`${dir}/${name}_${when}_data.tar.gz`)} -C ${shq(dataDir)} .`, {
      label: 'archive data dir',
      timeoutMs: 2 * 60 * 60 * 1000,
    });
  }

  // 2. stop serving
  log('إيقاف وحذف عملية PM2...');
  await exec(conn, `pm2 delete ${shq(name)}`, { allowFail: true, label: 'pm2 delete' });
  await exec(conn, 'pm2 save', { allowFail: true, label: 'pm2 save' });
  if (row.domain) {
    log('إزالة إعداد Nginx...');
    await nginx.removeSite(conn, V.validateDomain(row.domain), cfg.backupDir);
  }

  // 3. drop data (backups already taken)
  log('حذف قاعدة البيانات...');
  await psql(
    conn,
    cfg,
    [
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(dbName)} AND pid <> pg_backend_pid();`,
      `DROP DATABASE IF EXISTS ${sqlIdent(dbName)};`,
    ].join('\n'),
    { label: 'drop database' },
  );
  if (row.db_role) {
    await psql(conn, cfg, `DROP ROLE IF EXISTS ${sqlIdent(V.validatePgName(row.db_role))};`, { label: 'drop role', allowFail: true });
  }
  log('حذف ملفات النسخة...');
  await exec(conn, `rm -rf -- ${shq(appDir)}`, { label: 'remove app dir' });
  if (dataDir) await exec(conn, `rm -rf -- ${shq(dataDir)}`, { label: 'remove data dir' });

  await store.remove(name);
  return { backupDir: dir };
}

/* ------------------------------------------------------------------ pm2 actions */

async function pm2Action(conn, store, action, rawName) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new OpError('إجراء غير صالح');
  const name = V.validateExistingName(rawName);
  const procs = await pm2List(conn);
  if (!procs.some((p) => p.name === name)) throw new OpError('العملية غير موجودة في PM2', 404);
  const row = await store.get(name);
  if (row && row.status === TENANT_STATUS.SUSPENDED && action !== 'stop') {
    throw new OpError('النسخة موقوفة لانتهاء الترخيص — جدّد الترخيص أولاً', 409);
  }
  await exec(conn, `pm2 ${action} ${shq(name)} && pm2 save`, { label: `pm2 ${action}` });
}

/* ------------------------------------------------------------------ license */

async function suspendTenant(conn, store, cfg, row, log = noopLog) {
  const name = V.validateExistingName(row.name);
  const domain = V.validateDomain(row.domain);
  const dbName = dbNameFor(row);
  const dir = `${cfg.backupDir}/suspended`;
  try {
    await ensureBackupDir(conn, cfg.backupDir);
    await ensureBackupDir(conn, dir);
    if (V.PG_NAME_RE.test(dbName) && (await dbExists(conn, cfg, dbName))) {
      await pgDump(conn, cfg, dbName, `${dir}/${name}_${stamp()}.dump`);
      log(`[LMS] Backup created for ${name}`);
    }
  } catch (err) {
    // Suspension never destroys data, so a failed backup is logged but does not block it.
    log(`[LMS] WARNING: backup before suspending ${name} failed: ${err.message}`);
  }
  await nginx.ensureStatusPages(conn, cfg);
  const tls = await nginx.resolveTls(conn, cfg, domain);
  await nginx.installSite(conn, domain, nginx.suspendedConfig({ name, domain, tls, cfg }), cfg.backupDir);
  await exec(conn, `pm2 stop ${shq(name)}`, { allowFail: true, label: 'pm2 stop' });
  await exec(conn, 'pm2 save', { allowFail: true });
  await store.update(name, { status: TENANT_STATUS.SUSPENDED });
}

async function reactivateTenant(conn, store, cfg, row) {
  const name = V.validateExistingName(row.name);
  const domain = V.validateDomain(row.domain);
  const port = Number(row.port);
  const procs = await pm2List(conn);
  if (!procs.some((p) => p.name === name)) throw new OpError('عملية PM2 للنسخة غير موجودة — لا يمكن إعادة التشغيل', 409);
  await exec(conn, `pm2 start ${shq(name)} && pm2 save`, { label: 'pm2 start' });
  await nginx.ensureStatusPages(conn, cfg);
  const tls = await nginx.resolveTls(conn, cfg, domain);
  await nginx.installSite(conn, domain, nginx.activeConfig({ name, domain, port, tls, cfg }), cfg.backupDir);
}

/** Renew: extends from the current end date, or from today if expired / suspended / no end date. */
async function renewTenant(getConn, store, cfg, params) {
  const name = V.validateExistingName(params.name);
  const months = V.validateMonths(params.duration_months);
  const row = await requireManaged(store, name);
  if (row.status === TENANT_STATUS.PROVISIONING || row.status === TENANT_STATUS.FAILED) {
    throw new OpError('لا يمكن تجديد نسخة لم يكتمل تثبيتها', 409);
  }
  const today = todayKey();
  const remaining = row.end_date ? daysUntilKey(row.end_date) : null;
  let startDate = row.start_date || today;
  let endDate;
  // days_remaining 0 = today is still paid, so a renewal on the last day extends from end_date.
  if (!renewFromEndDate(remaining, row.status === TENANT_STATUS.SUSPENDED)) {
    startDate = today;
    endDate = addMonthsKey(today, months);
  } else {
    endDate = addMonthsKey(row.end_date, months);
  }
  if (row.status === TENANT_STATUS.SUSPENDED) {
    const conn = await getConn();
    try {
      await reactivateTenant(conn, store, cfg, row);
    } finally {
      conn.end();
    }
  }
  await store.update(name, {
    start_date: startDate,
    end_date: endDate,
    duration_months: months,
    status: TENANT_STATUS.ACTIVE,
    auto_suspend: true,
  });
  return { start_date: startDate, end_date: endDate };
}

/** Explicitly set (or clear) the end date. Clearing disables automatic suspension. */
async function setLicense(store, params) {
  const name = V.validateExistingName(params.name);
  const row = await requireManaged(store, name);
  const endDate = V.validateOptionalDateKey(params.end_date);
  const fields = { end_date: endDate, auto_suspend: !!endDate };
  if (params.client_email) fields.client_email = V.validateEmail(params.client_email);
  await store.update(row.name, fields);
  return { end_date: endDate, auto_suspend: !!endDate };
}

/** Register an existing (unmanaged) PM2 process. No server change is made. */
async function adoptTenant(conn, store, params) {
  const name = V.validateExistingName(params.name);
  const domain = V.validateDomain(params.domain);
  const clientEmail = params.client_email ? V.validateEmail(params.client_email) : null;
  const endDate = V.validateOptionalDateKey(params.end_date);
  if (await store.get(name)) throw new OpError('النسخة مسجلة مسبقاً', 409);
  if (await store.getByDomain(domain)) throw new OpError('النطاق مستخدم لنسخة أخرى', 409);
  const proc = (await pm2List(conn)).find((p) => p.name === name);
  if (!proc) throw new OpError('العملية غير موجودة في PM2', 404);
  let appDir = null;
  try {
    appDir = proc.cwd ? V.validateSafePath(proc.cwd, 'cwd') : null;
  } catch {
    appDir = null;
  }
  const legacyDb = V.legacyDbNameFor(name);
  await store.insert({
    name,
    domain,
    port: proc.port,
    client_email: clientEmail,
    start_date: todayKey(),
    end_date: endDate,
    duration_months: null,
    status: TENANT_STATUS.ACTIVE,
    app_dir: appDir,
    db_name: V.PG_NAME_RE.test(legacyDb) ? legacyDb : null,
    db_role: null,
    data_dir: null,
    auto_suspend: !!endDate,
  });
  return { name, domain, end_date: endDate };
}

/**
 * Send a license e-mail at most once per tenant per Riyadh calendar day and kind. The slot is
 * claimed in SQLite BEFORE sending, so a crash or restart after the claim never re-sends; the
 * outcome (sent / skipped:<reason> / failed:<error>) is recorded for the operator.
 */
async function notifyOnce(store, notify, row, kind, days, day) {
  if (!(await store.claimNotice(row.name, day, kind, days))) return 'already_sent_today';
  let outcome;
  try {
    const res = await notify(row, kind, { days });
    outcome = res && res.sent ? 'sent' : `skipped:${(res && res.reason) || 'unknown'}`;
  } catch (err) {
    outcome = `failed:${err && err.message}`;
  }
  await store.setNoticeOutcome(row.name, day, kind, outcome).catch(() => {});
  return outcome;
}

/**
 * Daily license check (DEC-009). Suspends ONLY tenants with status=active, auto_suspend=1 and an
 * end date that has PASSED (days < 0): the end date itself is the last paid day and stays up.
 * Reminder e-mails go out while 0 <= days <= LICENSE_REMINDER_DAYS (default 14), once per day.
 * Unmanaged PM2 processes are never touched.
 */
async function checkLicenses(getConn, store, cfg, { notify, log = console.log, now = new Date() } = {}) {
  const rows = (await store.list()).filter((r) => r.status === TENANT_STATUS.ACTIVE && r.auto_suspend && r.end_date);
  const reminderDays = cfg && Number.isFinite(cfg.licenseReminderDays) ? cfg.licenseReminderDays : DEFAULT_REMINDER_DAYS;
  const day = todayKey(now);
  let conn = null;
  const results = [];
  try {
    for (const row of rows) {
      const days = daysUntilKey(row.end_date, now);
      const action = licenseAction(days, reminderDays);
      if (action === 'suspend') {
        log(`[LMS] ${row.name} expired on ${row.end_date} — suspending`);
        try {
          if (!conn) conn = await getConn();
          await suspendTenant(conn, store, cfg, row, log);
          const notice = notify ? await notifyOnce(store, notify, row, noticeKind(action), days, day) : 'no_notifier';
          results.push({ name: row.name, action: 'suspended', days, notice });
        } catch (err) {
          log(`[LMS] failed to suspend ${row.name}: ${err.message}`);
          results.push({ name: row.name, action: 'error', days });
        }
      } else if (action === 'remind' && notify) {
        const notice = await notifyOnce(store, notify, row, noticeKind(action), days, day);
        if (notice !== 'already_sent_today') log(`[LMS] ${row.name}: reminder (${days} day(s) left) -> ${notice}`);
        results.push({ name: row.name, action: 'reminder', days, notice });
      }
    }
  } finally {
    if (conn) conn.end();
  }
  return results;
}

/* ------------------------------------------------------------------ commercial (DEC-007) */

/** Replace the optional commercial fields of a managed tenant (all six; empty = NULL). */
async function setCommercial(store, params) {
  const name = V.validateExistingName(params && params.name);
  const row = await requireManaged(store, name);
  const fields = validateCommercial(params);
  await store.update(row.name, fields);
  return fields;
}

/* ------------------------------------------------------------------ active employees (DEC-007) */

/**
 * Read-only active-employee count per registered tenant database:
 *   SELECT count(*) FROM "Employee" WHERE "isTerminated" = false
 * The session is forced read-only with a short statement_timeout. Returns
 * { [name]: { active: number|null, error?: string } }.
 */
async function employeeCounts(conn, store, cfg) {
  const out = {};
  for (const row of await store.list()) {
    if (row.status === TENANT_STATUS.PROVISIONING || row.status === TENANT_STATUS.FAILED) continue;
    const db = dbNameFor(row);
    if (!V.PG_NAME_RE.test(db)) {
      out[row.name] = { active: null, error: 'invalid database name' };
      continue;
    }
    try {
      const stdout = await psql(
        conn,
        cfg,
        [
          'SET default_transaction_read_only = on;',
          "SET statement_timeout = '10s';",
          'SELECT count(*) FROM "Employee" WHERE "isTerminated" = false;',
        ].join('\n'),
        { db, label: `count employees ${db}` },
      );
      const last = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .pop();
      out[row.name] = last === undefined ? { active: null, error: 'no result' } : { active: parseInt(last, 10) };
    } catch (err) {
      out[row.name] = { active: null, error: String((err && err.message) || err).slice(0, 200) };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ panel self-backup (DEC-004) */

function pruneLocal(dir, days, log) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (!/^(registry_.*\.sqlite|panel_.*\.env)$/.test(f)) continue;
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch (err) {
      log(`[backup] could not prune ${p}: ${err.message}`);
    }
  }
}

/**
 * Back up the panel's own state: the SQLite registry (online copy via VACUUM INTO) and the
 * panel .env (SSH/PG credentials; without it the registry cannot be operated). Copies are kept
 * locally in PANEL_BACKUP_DIR (chmod 600) and uploaded to BACKUP_DIR/panel on the server, which
 * ops/backup.sh ships off-site with the tenant dumps.
 */
async function backupPanel(conn, store, cfg, log = noopLog) {
  const dir = cfg.panelBackupDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const when = stamp();
  const files = [];
  const registry = path.join(dir, `registry_${when}.sqlite`);
  await store.backupTo(registry);
  fs.chmodSync(registry, 0o600);
  files.push(registry);
  if (cfg.panelEnvFile && fs.existsSync(cfg.panelEnvFile)) {
    const envCopy = path.join(dir, `panel_${when}.env`);
    fs.copyFileSync(cfg.panelEnvFile, envCopy);
    fs.chmodSync(envCopy, 0o600);
    files.push(envCopy);
  } else {
    log('[backup] panel .env not found — registry only');
  }
  pruneLocal(dir, Math.max(1, Number(cfg.backupRetentionDays) || 14), log);

  const remoteDir = `${cfg.backupDir}/panel`;
  const uploaded = [];
  if (conn) {
    await ensureBackupDir(conn, cfg.backupDir);
    await ensureBackupDir(conn, remoteDir);
    for (const f of files) {
      const target = `${remoteDir}/${path.basename(f)}`;
      await writeRemoteFile(conn, target, fs.readFileSync(f), 0o600);
      uploaded.push(target);
    }
    const days = Math.max(1, Number(cfg.backupRetentionDays) || 14);
    await exec(conn, `find ${shq(remoteDir)} -maxdepth 1 -type f \\( -name 'registry_*.sqlite' -o -name 'panel_*.env' \\) -mtime +${days} -delete`, {
      allowFail: true,
      label: 'prune panel backups',
    });
  }
  log(`[backup] panel registry + env -> ${dir}${uploaded.length ? ` and ${remoteDir}` : ''}`);
  return { local: files, remote: uploaded };
}

/* ------------------------------------------------------------------ backups */

/** pg_dump -Fc of every tenant database (registry + all non-template DBs); prune old dumps. */
async function backupAll(conn, store, cfg, log = noopLog) {
  const dir = `${cfg.backupDir}/daily`;
  await ensureBackupDir(conn, cfg.backupDir);
  await ensureBackupDir(conn, dir);
  // Every non-template database on the server: covers registered, adopted and unmanaged tenants.
  const names = new Set(await listDatabases(conn, cfg));
  for (const row of await store.list()) {
    const db = dbNameFor(row);
    if (V.PG_NAME_RE.test(db) && !names.has(db)) log(`[backup] registered database ${db} (${row.name}) not found on server`);
  }
  const when = stamp();
  const ok = [];
  const failed = [];
  // The panel's own registry + .env first (DEC-004): losing them loses the tenant registry.
  let panel = null;
  try {
    panel = await backupPanel(conn, store, cfg, log);
    ok.push('panel-registry');
  } catch (err) {
    failed.push('panel-registry');
    log(`[backup] panel registry FAILED: ${err.message}`);
  }
  for (const db of [...names].sort()) {
    try {
      await pgDump(conn, cfg, db, `${dir}/${db}_${when}.dump`);
      ok.push(db);
      log(`[backup] ${db} ok`);
    } catch (err) {
      failed.push(db);
      log(`[backup] ${db} FAILED: ${err.message}`);
    }
  }
  const days = Math.max(1, Number(cfg.backupRetentionDays) || 14);
  await exec(conn, `find ${shq(dir)} -maxdepth 1 -type f \\( -name '*.dump' -o -name '*.partial' \\) -mtime +${days} -delete`, {
    allowFail: true,
    label: 'prune backups',
  });
  return { ok, failed, dir, panel };
}

module.exports = {
  TENANT_CONNECTION_LIMIT,
  ROLE_TIMEOUTS,
  OpError,
  serialize,
  isBusy,
  pm2List,
  systemStats,
  listTenants,
  createTenant,
  deleteTenant,
  pm2Action,
  renewTenant,
  setLicense,
  adoptTenant,
  suspendTenant,
  checkLicenses,
  setCommercial,
  employeeCounts,
  backupPanel,
  backupAll,
};

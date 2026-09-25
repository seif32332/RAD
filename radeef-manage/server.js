'use strict';
/**
 * Radeef tenant manager — web control panel.
 *
 * SECURITY MODEL
 *  - Listens on 127.0.0.1 by default (HOST to override). Put it behind nginx with TLS and an
 *    IP allow-list, or reach it through an SSH tunnel. Never expose the port publicly.
 *  - Single admin account from ADMIN_USERNAME / ADMIN_PASSWORD (>= 12 chars). The process refuses
 *    to start without them.
 *  - Random server-side session tokens in an httpOnly, SameSite=Strict cookie. No token in
 *    localStorage or in URLs.
 *  - Every value sent to the server over SSH is validated and shell-quoted (lib/validate.js).
 */
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const { loadConfig, loadSshConfig, env, ConfigError, missingTenantSmtp } = require('./lib/config');
const V = require('./lib/validate');
const ssh = require('./lib/ssh');
const ops = require('./lib/ops');
const { openStore } = require('./lib/store');
const { sendAlertEmail } = require('./lib/mailer');

/* ------------------------------------------------------------------ startup (fail closed) */

let cfg;
let sshOptions;
const ADMIN_USER = env('ADMIN_USERNAME');
const ADMIN_PASS = env('ADMIN_PASSWORD');
try {
  if (!ADMIN_USER || !ADMIN_PASS) throw new ConfigError('ADMIN_USERNAME and ADMIN_PASSWORD must be set');
  if (ADMIN_PASS.length < 12) throw new ConfigError('ADMIN_PASSWORD must be at least 12 characters');
  if (ADMIN_PASS.toLowerCase() === ADMIN_USER.toLowerCase() || /^(admin|password|123456)/i.test(ADMIN_PASS)) {
    throw new ConfigError('ADMIN_PASSWORD is too weak');
  }
  cfg = loadConfig();
  sshOptions = loadSshConfig();
} catch (err) {
  console.error(`[radeef-manage] Refusing to start: ${err.message}`);
  process.exit(1);
}

const store = openStore();
const getConn = () => ssh.connect(sshOptions);

const SESSION_COOKIE = 'rm_sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const COOKIE_SECURE = env('COOKIE_SECURE', 'true') !== 'false';

/* ------------------------------------------------------------------ app + headers */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env('TRUST_PROXY', 'loopback'));

const CSP = [
  "default-src 'self'",
  // Alpine.js and the Tailwind play CDN need 'unsafe-eval' / 'unsafe-inline'.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

/* ------------------------------------------------------------------ sessions */

const sessions = new Map(); // token -> { username, createdAt, lastSeen }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    COOKIE_SECURE ? 'Secure' : '',
    `Max-Age=${maxAgeSec}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.createdAt > SESSION_TTL_MS || now - s.lastSeen > SESSION_IDLE_MS) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = now;
  return { token, ...s };
}

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS || now - s.lastSeen > SESSION_IDLE_MS) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();

function authenticate(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'غير مصرح — سجّل الدخول' });
  req.session = session;
  next();
}

/** CSRF defence in depth (the cookie is already SameSite=Strict). */
function sameOriginWrite(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!req.is('application/json')) return res.status(415).json({ success: false, error: 'Content-Type must be application/json' });
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (host !== req.get('host')) return res.status(403).json({ success: false, error: 'Cross-origin request rejected' });
  }
  next();
}
app.use('/api', sameOriginWrite);

/* ------------------------------------------------------------------ login rate limit */

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_GLOBAL = 50;
const loginFailures = new Map(); // key -> { count, first }

function limited(key, max) {
  const e = loginFailures.get(key);
  if (!e) return false;
  if (Date.now() - e.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return e.count >= max;
}

function recordFailure(key) {
  const e = loginFailures.get(key);
  if (!e || Date.now() - e.first > LOGIN_WINDOW_MS) loginFailures.set(key, { count: 1, first: Date.now() });
  else e.count++;
}

/* ------------------------------------------------------------------ errors */

function sendError(res, err, ctx) {
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error(`[radeef-manage] ${ctx}:`, err && err.message, err && err.stderrTail ? `\n${err.stderrTail}` : '');
  }
  let message = 'حدث خطأ غير متوقع — راجع سجل الخادم';
  if (err instanceof V.ValidationError || err instanceof ops.OpError) message = err.message;
  else if (err instanceof ssh.RemoteCommandError) message = `فشل تنفيذ الأمر على السيرفر: ${err.message}`;
  else if (err && /All configured authentication methods failed|ECONNREFUSED|ETIMEDOUT|Timed out/i.test(err.message || '')) {
    message = 'تعذر الاتصال بالسيرفر عبر SSH';
  }
  res.status(status).json({ success: false, error: message });
}

async function withSsh(fn) {
  const conn = await getConn();
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

/* ------------------------------------------------------------------ auth routes */

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (limited(`ip:${ip}`, LOGIN_MAX_PER_IP) || limited('global', LOGIN_MAX_GLOBAL)) {
    return res.status(429).json({ success: false, error: 'محاولات كثيرة — حاول لاحقاً' });
  }
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const okUser = V.safeEqual(username, ADMIN_USER);
  const okPass = V.safeEqual(password, ADMIN_PASS);
  if (!(okUser && okPass)) {
    recordFailure(`ip:${ip}`);
    recordFailure('global');
    console.warn(`[auth] failed login from ${ip}`);
    return res.status(401).json({ success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  loginFailures.delete(`ip:${ip}`);
  // Rotate: drop any session presented with this request.
  const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (old) sessions.delete(old);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: ADMIN_USER, createdAt: Date.now(), lastSeen: Date.now() });
  res.setHeader('Set-Cookie', cookieString(token, Math.floor(SESSION_TTL_MS / 1000)));
  console.log(`[auth] login from ${ip}`);
  res.json({ success: true, username: ADMIN_USER });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', cookieString('', 0));
  res.json({ success: true });
});

app.get('/api/session', authenticate, (req, res) => {
  res.json({ success: true, username: req.session.username });
});

app.get('/api/config', authenticate, (req, res) => {
  res.json({
    success: true,
    templates: cfg.releaseDirs,
    base_domain: cfg.baseDomain,
    default_client_email: cfg.defaultClientEmail,
    license_reminder_days: cfg.licenseReminderDays,
    // Pre-provisioning check (DEC-009): TENANT_SMTP_* values that are still empty.
    tenant_smtp_missing: missingTenantSmtp(cfg.tenantSmtp),
  });
});

/* ------------------------------------------------------------------ read routes */

app.get('/api/system/stats', authenticate, async (req, res) => {
  try {
    const stats = await withSsh((conn) => ops.systemStats(conn));
    res.json({ success: true, ...stats });
  } catch (err) {
    sendError(res, err, 'stats');
  }
});

app.get('/api/tenants', authenticate, async (req, res) => {
  try {
    const tenants = await withSsh((conn) => ops.listTenants(conn, store, cfg));
    res.json({ success: true, tenants });
  } catch (err) {
    sendError(res, err, 'list tenants');
  }
});

// Read-only active-employee counts (DEC-007). One psql per tenant DB over SSH, so cached.
const EMPLOYEE_COUNT_TTL_MS = 10 * 60 * 1000;
let employeeCountCache = null; // { at, counts }

app.get('/api/tenants/employees', authenticate, async (req, res) => {
  try {
    const fresh = employeeCountCache && Date.now() - employeeCountCache.at < EMPLOYEE_COUNT_TTL_MS;
    if (!fresh || req.query.refresh === '1') {
      const counts = await withSsh((conn) => ops.employeeCounts(conn, store, cfg));
      employeeCountCache = { at: Date.now(), counts };
    }
    res.json({ success: true, counts: employeeCountCache.counts, checked_at: new Date(employeeCountCache.at).toISOString() });
  } catch (err) {
    sendError(res, err, 'employee counts');
  }
});

app.get('/api/license-notices', authenticate, async (req, res) => {
  try {
    res.json({ success: true, notices: await store.lastNotices(100) });
  } catch (err) {
    sendError(res, err, 'license notices');
  }
});

/* ------------------------------------------------------------------ actions */

app.post('/api/tenants/action', authenticate, async (req, res) => {
  const { action, name, confirm } = req.body || {};
  try {
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) throw new ops.OpError('إجراء غير صالح');
    V.validateExistingName(name);
    if (action === 'delete') {
      if (confirm !== name) throw new ops.OpError('يجب كتابة اسم النسخة بالضبط لتأكيد الحذف');
      const result = await ops.serialize(() =>
        withSsh((conn) => ops.deleteTenant(conn, store, cfg, { name, confirm }, (m) => console.log(`[delete ${name}] ${m}`))),
      );
      console.log(`[audit] ${req.session.username} deleted tenant ${name}; backups in ${result.backupDir}`);
      return res.json({ success: true, backup_dir: result.backupDir });
    }
    await withSsh((conn) => ops.pm2Action(conn, store, action, name));
    console.log(`[audit] ${req.session.username} ${action} ${name}`);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, `action ${action}`);
  }
});

app.post('/api/tenants/renew', authenticate, async (req, res) => {
  try {
    const result = await ops.serialize(() => ops.renewTenant(getConn, store, cfg, req.body || {}));
    console.log(`[audit] ${req.session.username} renewed ${req.body.name} until ${result.end_date}`);
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err, 'renew');
  }
});

app.post('/api/tenants/license', authenticate, async (req, res) => {
  try {
    const result = await ops.serialize(() => ops.setLicense(store, req.body || {}));
    console.log(`[audit] ${req.session.username} set license ${req.body.name} end_date=${result.end_date}`);
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err, 'set license');
  }
});

app.post('/api/tenants/commercial', authenticate, async (req, res) => {
  try {
    const result = await ops.serialize(() => ops.setCommercial(store, req.body || {}));
    console.log(`[audit] ${req.session.username} set commercial fields for ${req.body.name}`);
    res.json({ success: true, commercial: result });
  } catch (err) {
    sendError(res, err, 'set commercial');
  }
});

app.post('/api/tenants/adopt', authenticate, async (req, res) => {
  try {
    const result = await ops.serialize(() => withSsh((conn) => ops.adoptTenant(conn, store, req.body || {})));
    console.log(`[audit] ${req.session.username} adopted ${result.name}`);
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err, 'adopt');
  }
});

app.post('/api/tenants/check-licenses', authenticate, async (req, res) => {
  try {
    const results = await ops.serialize(() => ops.checkLicenses(getConn, store, cfg, { notify: sendAlertEmail }));
    res.json({ success: true, message: 'License checks executed successfully', results });
  } catch (err) {
    sendError(res, err, 'check licenses');
  }
});

app.post('/api/backups/run', authenticate, async (req, res) => {
  try {
    const result = await ops.serialize(() => withSsh((conn) => ops.backupAll(conn, store, cfg, console.log)));
    res.json({ success: result.failed.length === 0, ...result });
  } catch (err) {
    sendError(res, err, 'backup');
  }
});

/* ------------------------------------------------------------------ create (job + SSE) */

const jobs = new Map(); // id -> job
const JOB_RETENTION_MS = 30 * 60 * 1000;

function newJob(name) {
  const job = { id: crypto.randomBytes(16).toString('hex'), name, events: [], listeners: new Set(), done: false, finishedAt: 0 };
  jobs.set(job.id, job);
  return job;
}

function writeEvent(res, ev) {
  res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

function pushEvent(job, data) {
  const ev = { seq: job.events.length + 1, data };
  job.events.push(ev);
  for (const res of job.listeners) writeEvent(res, ev);
  // Initial credentials are shown once: drop them as soon as a listener received them.
  if (data.credentials && job.listeners.size > 0) ev.data = { ...data, credentials: undefined };
  if (data.type === 'done' || data.type === 'error') {
    job.done = true;
    job.finishedAt = Date.now();
    for (const res of job.listeners) res.end();
    job.listeners.clear();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.done && now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(id);
}, 5 * 60 * 1000).unref();

app.post('/api/tenants/create', authenticate, async (req, res) => {
  const body = req.body || {};
  let params;
  try {
    params = {
      name: V.validateTenantName(body.name),
      domain: V.validateDomain(body.domain),
      template: body.template ? V.validateSafePath(body.template, 'template') : cfg.releaseDirs[0],
      client_email: V.validateEmail(body.client_email || cfg.defaultClientEmail),
      admin_email: V.validateEmail(body.admin_email || body.client_email || cfg.defaultClientEmail),
      duration_months: V.validateMonths(body.duration_months ?? 1),
    };
    if (!cfg.releaseDirs.includes(params.template)) throw new ops.OpError('القالب غير مسموح به');
    if (ops.isBusy()) throw new ops.OpError('توجد عملية أخرى قيد التنفيذ — انتظر حتى تنتهي', 409);
    if (await store.get(params.name)) throw new ops.OpError('يوجد نسخة مسجلة بنفس الاسم', 409);
    if (await store.getByDomain(params.domain)) throw new ops.OpError('النطاق مستخدم لنسخة أخرى', 409);
  } catch (err) {
    return sendError(res, err, 'create (validate)');
  }

  const job = newJob(params.name);
  console.log(`[audit] ${req.session.username} started creation of ${params.name} (${params.domain})`);
  const log = (msg, type = 'info', progress) => pushEvent(job, { type, msg, progress });
  log('جاري الاتصال بالسيرفر عبر SSH...', 'info', 5);

  ops
    .serialize(() =>
      withSsh(async (conn) => {
        log('تم الاتصال بنجاح. بدء التثبيت...', 'success', 10);
        return ops.createTenant(conn, store, cfg, params, log);
      }),
    )
    .then((result) => {
      pushEvent(job, { type: 'done', msg: 'اكتمل الإنشاء بنجاح!', progress: 100, credentials: result.credentials });
    })
    .catch((err) => {
      console.error(`[create ${params.name}]`, err.message, err.stderrTail ? `\n${err.stderrTail}` : '');
      const detail = err instanceof V.ValidationError || err instanceof ops.OpError ? err.message : `فشل: ${err.message}`;
      const tail = err.stderrTail ? `\n${err.stderrTail.slice(-400)}` : '';
      pushEvent(job, { type: 'error', msg: `${detail}${tail}`, progress: 0 });
    });

  res.json({ success: true, jobId: job.id });
});

app.get('/api/tenants/create-stream', authenticate, (req, res) => {
  const id = typeof req.query.job === 'string' ? req.query.job : '';
  const job = /^[a-f0-9]{32}$/.test(id) ? jobs.get(id) : null;
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const lastId = parseInt(req.get('Last-Event-ID') || '0', 10) || 0;
  for (const ev of job.events) {
    if (ev.seq <= lastId) continue;
    writeEvent(res, ev);
    if (ev.data.credentials) ev.data = { ...ev.data, credentials: undefined };
  }
  if (job.done) return res.end();

  job.listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    job.listeners.delete(res);
  });
});

/* ------------------------------------------------------------------ API 404 + errors */

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Payload too large' });
  sendError(res, err, 'unhandled');
});

/* ------------------------------------------------------------------ schedules */

const TZ = 'Asia/Riyadh';

function runLicenseCheck() {
  ops
    .serialize(() => ops.checkLicenses(getConn, store, cfg, { notify: sendAlertEmail }))
    .then((r) => console.log(`[LMS] license check done (${r.length} action(s))`))
    .catch((err) => console.error('[LMS] license check failed:', err.message));
}

function runBackups() {
  ops
    .serialize(() => withSsh((conn) => ops.backupAll(conn, store, cfg, console.log)))
    .then((r) => {
      console.log(`[backup] done: ${r.ok.length} ok, ${r.failed.length} failed`);
      if (r.failed.length) console.error(`[backup] FAILED databases: ${r.failed.join(', ')}`);
    })
    .catch((err) => console.error('[backup] run failed:', err.message));
}

cron.schedule(env('LICENSE_CRON', '0 0 * * *'), runLicenseCheck, { timezone: TZ });
if (env('BACKUP_CRON', '30 2 * * *') !== 'off') cron.schedule(env('BACKUP_CRON', '30 2 * * *'), runBackups, { timezone: TZ });
if (env('LICENSE_CHECK_ON_START', 'true') === 'true') setTimeout(runLicenseCheck, 5000).unref();

/* ------------------------------------------------------------------ listen */

const HOST = env('HOST', '127.0.0.1');
const PORT = parseInt(env('PORT', '3099'), 10);
store.ready
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`[radeef-manage] listening on http://${HOST}:${PORT}`);
      if (HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost') {
        console.warn('[radeef-manage] WARNING: not bound to loopback. Restrict access with a firewall / IP allow-list.');
      }
      if (!COOKIE_SECURE) console.warn('[radeef-manage] WARNING: COOKIE_SECURE=false — use only over an SSH tunnel to localhost.');
    });
  })
  .catch((err) => {
    console.error('[radeef-manage] cannot open the SQLite registry:', err.message);
    process.exit(1);
  });

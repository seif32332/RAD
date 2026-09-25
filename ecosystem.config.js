/**
 * PM2 process file - alternative to docker-compose.yml for the existing VPS.
 *
 * One app per tenant. Each app runs the Next standalone server of the release its
 * `current` symlink points to:
 *
 *   /opt/radeef/<tenant>/current -> /opt/radeef/releases/<release-id>
 *   /opt/radeef/releases/<release-id>/.next/standalone/server.js
 *
 * Releases are built and switched by ops/deploy.sh (never build on top of a running app).
 * Secrets are read from /etc/radeef/<tenant>.env (owned by the service user, chmod 600);
 * nothing secret lives in this file.
 *
 * Run PM2 as the unprivileged `radeef` user, NEVER as root:
 *   sudo -iu radeef pm2 start /opt/radeef/ecosystem.config.js
 *   sudo -iu radeef pm2 save && sudo env PATH=$PATH pm2 startup systemd -u radeef --hp /home/radeef
 *
 * Log rotation (once per server, as the radeef user):
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 14 && pm2 set pm2-logrotate:compress true
 *
 * Tenants: every /etc/radeef/<tenant>.env whose name matches ^[a-z][a-z0-9-]{1,29}$, or an
 * explicit list RADEEF_TENANTS="radeef,rakan,dar". The port comes from PORT in the tenant env
 * file (an optional "name:port" entry is only a fallback when PORT is missing).
 * Exec mode is `cluster` with one instance so `pm2 reload <tenant>` starts the new process
 * before stopping the old one (zero-downtime switch).
 *
 * A broken entry (invalid name/port, unreadable env file, PORT missing) is SKIPPED with a warning
 * on stderr instead of throwing: one bad tenant must not stop PM2 from (re)loading all the others
 * (DEC-004). Check `pm2 logs` / the warning after every deploy.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RADEEF_ROOT = process.env.RADEEF_ROOT || '/opt/radeef';
const ENV_DIR = process.env.ENV_DIR || '/etc/radeef';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/radeef';
const LOG_DIR = process.env.RADEEF_LOG_DIR || '/var/log/radeef';
const TENANT_RE = /^[a-z][a-z0-9-]{1,29}$/;

const DEFAULT_TENANTS = 'radeef:3000,rakan:3001,dar:3002';
const PORT_RE = /^\d{2,5}$/;

/** Minimal dotenv parser (KEY=value, KEY="value", KEY='value'; # comments). */
function readEnvFile(file) {
  const env = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    env[match[1]] = value;
  }
  return env;
}

/** Warn about a skipped tenant (stderr, so PM2 shows it) and return null. */
function skip(message) {
  console.warn(`[ecosystem.config.js] WARNING: skipping ${message}`);
  return null;
}

function parseTenants(spec) {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, port] = entry.split(':');
      if (!TENANT_RE.test(name || '')) return skip(`invalid tenant name in RADEEF_TENANTS: ${entry}`);
      if (port !== undefined && !PORT_RE.test(port)) return skip(`invalid port in RADEEF_TENANTS: ${entry}`);
      return { name, fallbackPort: port };
    })
    .filter(Boolean);
}

/** Tenants = env files in ENV_DIR (falls back to the three historical tenants). */
function discoverTenants() {
  try {
    const names = fs
      .readdirSync(ENV_DIR)
      .filter((f) => f.endsWith('.env'))
      .map((f) => f.slice(0, -'.env'.length))
      .filter((name) => TENANT_RE.test(name))
      .sort();
    if (names.length > 0) return names.join(',');
  } catch {
    // ENV_DIR missing or unreadable: use the defaults and let readEnvFile report the problem.
  }
  return DEFAULT_TENANTS;
}

function buildApp({ name, fallbackPort }) {
  const envFile = path.posix.join(ENV_DIR, `${name}.env`);
  let fileEnv;
  try {
    fileEnv = readEnvFile(envFile);
  } catch (err) {
    return skip(`tenant "${name}": cannot read ${envFile} (${err.message})`);
  }
  const port = fileEnv.PORT || fallbackPort;
  if (!port || !PORT_RE.test(port)) return skip(`tenant "${name}": PORT is missing or invalid in ${envFile}`);
  if (!fileEnv.DATABASE_URL) return skip(`tenant "${name}": DATABASE_URL is missing in ${envFile}`);
  const cwd = path.posix.join(RADEEF_ROOT, name, 'current');
  return {
    name,
    cwd,
    script: '.next/standalone/server.js',
    exec_mode: 'cluster',
    instances: 1,
    autorestart: true,
    max_memory_restart: '700M',
    // Graceful shutdown: give in-flight requests time to finish before SIGKILL.
    kill_timeout: 10000,
    // In cluster mode PM2 waits for the new worker to listen before killing the old one.
    listen_timeout: 30000,
    max_restarts: 10,
    min_uptime: '30s',
    exp_backoff_restart_delay: 200,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    out_file: path.posix.join(LOG_DIR, `${name}.out.log`),
    error_file: path.posix.join(LOG_DIR, `${name}.err.log`),
    env: {
      ...fileEnv,
      NODE_ENV: 'production',
      PORT: String(port),
      // Only Nginx on the same host talks to the app.
      HOSTNAME: '127.0.0.1',
      UPLOAD_DIR: fileEnv.UPLOAD_DIR || path.posix.join(DATA_DIR, name, 'uploads'),
    },
  };
}

const apps = [];
const seenPorts = new Map();
for (const tenant of parseTenants(process.env.RADEEF_TENANTS || discoverTenants())) {
  const app = buildApp(tenant);
  if (!app) continue;
  const other = seenPorts.get(app.env.PORT);
  // Warn only: which of the two is the right owner of the port is not knowable here.
  if (other) console.warn(`[ecosystem.config.js] WARNING: tenants "${other}" and "${app.name}" both use PORT ${app.env.PORT}`);
  seenPorts.set(app.env.PORT, app.name);
  apps.push(app);
}

module.exports = { apps };

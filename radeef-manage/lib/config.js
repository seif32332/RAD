'use strict';
/**
 * Configuration shared by server.js and cli.js. Everything comes from the environment
 * (radeef-manage/.env is loaded if present). Nothing secret has a default.
 */
const fs = require('fs');
const path = require('path');
const { validateSafePath, validateDomain, validateEmail, assertSingleLineSecret } = require('./validate');

const PANEL_ENV_FILE = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: PANEL_ENV_FILE });

class ConfigError extends Error {}

/** SMTP variables every tenant env file carries (values may be empty). */
const TENANT_SMTP_KEYS = Object.freeze(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
/** Needed for a tenant to actually send mail (SMTP_SECURE and SMTP_PORT have usable defaults). */
const TENANT_SMTP_REQUIRED = Object.freeze(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);

/** Pre-provisioning check: which required TENANT_SMTP_* values are empty. */
function missingTenantSmtp(tenantSmtp) {
  return TENANT_SMTP_REQUIRED.filter((k) => !tenantSmtp || !tenantSmtp[k]).map((k) => `TENANT_${k}`);
}

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name, fallback) {
  const raw = env(name, '');
  if (raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} must be an integer`);
  return n;
}

function pathEnv(name, fallback) {
  const raw = env(name, fallback);
  try {
    return validateSafePath(raw, name);
  } catch {
    throw new ConfigError(`${name} must be an absolute path made of [A-Za-z0-9._/-]`);
  }
}

function listEnv(name, fallback) {
  return env(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig() {
  const baseDomain = validateDomain(env('BASE_DOMAIN', 'radeef-sa.com'));
  const releaseDirs = listEnv('RELEASE_DIRS', '/opt/radeef/release').map((p) => {
    try {
      return validateSafePath(p, 'RELEASE_DIRS entry');
    } catch {
      throw new ConfigError('RELEASE_DIRS must be a comma-separated list of absolute paths');
    }
  });
  if (releaseDirs.length === 0) throw new ConfigError('RELEASE_DIRS must list at least one release directory');

  const pgPassword = env('PGPASSWORD', '');
  if (pgPassword) {
    try {
      assertSingleLineSecret(pgPassword, 'PGPASSWORD');
    } catch {
      throw new ConfigError('PGPASSWORD must not contain newlines, quotes, $, ` or \\');
    }
  }

  // SMTP_* written into every NEW tenant env file (DEC-009). Empty until the owner approves a
  // transactional mail provider (SPF/DKIM/DMARC) and lists it in docs/processors.md.
  const tenantSmtp = {};
  for (const key of TENANT_SMTP_KEYS) {
    const value = env(`TENANT_${key}`, key === 'SMTP_PORT' ? '587' : '');
    try {
      if (value) assertSingleLineSecret(value, `TENANT_${key}`);
    } catch {
      throw new ConfigError(`TENANT_${key} must not contain newlines, quotes, $, \` or \\`);
    }
    tenantSmtp[key] = value;
  }

  return {
    baseDomain,
    releaseDirs,
    tenantSmtp,
    licenseReminderDays: Math.min(60, Math.max(0, intEnv('LICENSE_REMINDER_DAYS', 14))),
    // Local copies of the panel's own .env + SQLite registry (also uploaded to BACKUP_DIR/panel).
    panelBackupDir: path.resolve(env('PANEL_BACKUP_DIR', path.join(__dirname, '..', 'backups'))),
    panelEnvFile: PANEL_ENV_FILE,
    tenantsRoot: pathEnv('TENANTS_ROOT', '/root'),
    dataRoot: pathEnv('DATA_ROOT', '/var/lib/radeef'),
    backupDir: pathEnv('BACKUP_DIR', '/var/backups/radeef'),
    backupRetentionDays: Math.max(1, intEnv('BACKUP_RETENTION_DAYS', 14)),
    statusPagesDir: pathEnv('STATUS_PAGES_DIR', '/var/www/radeef-status'),
    acmeWebroot: pathEnv('ACME_WEBROOT', '/var/www/letsencrypt'),
    wildcardCertDir: pathEnv('WILDCARD_CERT_DIR', '/etc/letsencrypt/live/radeef-sa.com-0001'),
    certbotEmail: env('CERTBOT_EMAIL', '') ? validateEmail(env('CERTBOT_EMAIL')) : '',
    startPort: intEnv('START_PORT', 3005),
    defaultClientEmail: env('DEFAULT_CLIENT_EMAIL', '') ? validateEmail(env('DEFAULT_CLIENT_EMAIL')) : '',
    pg: {
      host: env('PGHOST', 'localhost'),
      port: intEnv('PGPORT', 5432),
      user: env('PGUSER', 'postgres'),
      password: pgPassword,
      tenantHost: env('TENANT_DB_HOST', env('PGHOST', 'localhost')),
    },
  };
}

/**
 * SSH connection options for ssh2. Key auth preferred; password only as a fallback.
 * Host key pinning via SSH_HOST_FINGERPRINT (the "SHA256:..." value from ssh-keygen -lf).
 */
function loadSshConfig() {
  const host = env('SSH_HOST');
  const username = env('SSH_USER');
  if (!host || !username) throw new ConfigError('SSH_HOST and SSH_USER must be set');

  const opts = {
    host,
    port: intEnv('SSH_PORT', 22),
    username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
  };

  const keyPath = env('SSH_KEY_PATH');
  const password = env('SSH_PASSWORD', env('SSH_PASS'));
  if (keyPath) {
    try {
      opts.privateKey = fs.readFileSync(keyPath);
    } catch {
      throw new ConfigError(`Cannot read SSH_KEY_PATH (${keyPath})`);
    }
    if (env('SSH_KEY_PASSPHRASE')) opts.passphrase = env('SSH_KEY_PASSPHRASE');
  } else if (password) {
    opts.password = password;
  } else {
    throw new ConfigError('Set SSH_KEY_PATH (recommended) or SSH_PASSWORD');
  }

  const fingerprint = env('SSH_HOST_FINGERPRINT').replace(/^SHA256:/, '').replace(/=+$/, '');
  if (fingerprint) {
    opts.hostVerifier = (key) => {
      const actual = require('crypto').createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
      return actual === fingerprint;
    };
  } else if (env('SSH_ALLOW_UNVERIFIED_HOST') === 'true') {
    console.warn('[config] WARNING: SSH host key is NOT verified (SSH_ALLOW_UNVERIFIED_HOST=true). Set SSH_HOST_FINGERPRINT.');
  } else {
    throw new ConfigError(
      'SSH_HOST_FINGERPRINT is required (run on the server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). ' +
        'Set SSH_ALLOW_UNVERIFIED_HOST=true only for a first test.',
    );
  }
  return opts;
}

module.exports = {
  ConfigError,
  env,
  intEnv,
  loadConfig,
  loadSshConfig,
  TENANT_SMTP_KEYS,
  TENANT_SMTP_REQUIRED,
  missingTenantSmtp,
  PANEL_ENV_FILE,
};

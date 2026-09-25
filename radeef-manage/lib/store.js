'use strict';
/**
 * SQLite tenant registry (radeef-manage/database.sqlite, or DB_PATH).
 *
 * Only tenants in this table are "managed". A tenant is auto-suspended ONLY when
 * auto_suspend = 1 AND end_date is set; auto_suspend is set exclusively by an explicit admin
 * action (create, renew, set-license). Rows that existed before this version (including rows
 * the old panel auto-imported with end_date = today + 1 month) are migrated with auto_suspend = 0,
 * so upgrading never suspends a running customer.
 */
const path = require('path');
const sqlite3 = require('sqlite3');

const TENANT_STATUS = Object.freeze({
  PROVISIONING: 'provisioning',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  FAILED: 'failed',
});

const COLUMNS = [
  ['app_dir', 'TEXT'],
  ['db_name', 'TEXT'],
  ['db_role', 'TEXT'],
  ['data_dir', 'TEXT'],
  ['auto_suspend', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_at', 'TEXT'],
  ['updated_at', 'TEXT'],
  // DEC-007: optional commercial fields, NULL (empty) by default; see lib/commercial.js.
  ['price', 'REAL'],
  ['currency', 'TEXT'],
  ['billing_cycle', 'TEXT'],
  ['paid_until', 'TEXT'],
  ['vat_rate', 'REAL'],
  ['price_includes_vat', 'INTEGER'],
];

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'database.sqlite');

function openStore(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  const db = new sqlite3.Database(dbPath);

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });

  const ready = (async () => {
    await run(`
      CREATE TABLE IF NOT EXISTS tenants (
        name TEXT PRIMARY KEY,
        domain TEXT,
        port INTEGER,
        client_email TEXT,
        start_date TEXT,
        end_date TEXT,
        duration_months INTEGER,
        status TEXT
      )
    `);
    const existing = new Set((await all('PRAGMA table_info(tenants)')).map((c) => c.name));
    for (const [col, type] of COLUMNS) {
      if (!existing.has(col)) await run(`ALTER TABLE tenants ADD COLUMN ${col} ${type}`);
    }
    await run('CREATE UNIQUE INDEX IF NOT EXISTS tenants_domain_unique ON tenants(domain)').catch((err) => {
      console.warn('[store] could not create unique domain index (duplicate domains in legacy rows?):', err.message);
    });
    // DEC-009: one row per (tenant, Riyadh calendar day, kind) — a license e-mail is sent at most
    // once per tenant per day, even when the panel restarts (LICENSE_CHECK_ON_START) or the
    // operator presses "check licenses" again.
    await run(`
      CREATE TABLE IF NOT EXISTS license_notices (
        name TEXT NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        days_remaining INTEGER,
        outcome TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (name, day, kind)
      )
    `);
  })();

  const now = () => new Date().toISOString();

  return {
    ready,
    path: dbPath,
    close: () => new Promise((resolve) => db.close(() => resolve())),
    async list() {
      await ready;
      return all('SELECT * FROM tenants ORDER BY name');
    },
    async get(name) {
      await ready;
      return get('SELECT * FROM tenants WHERE name = ?', [name]);
    },
    async getByDomain(domain) {
      await ready;
      return get('SELECT * FROM tenants WHERE domain = ?', [domain]);
    },
    async insert(t) {
      await ready;
      await run(
        `INSERT INTO tenants (name, domain, port, client_email, start_date, end_date, duration_months, status,
           app_dir, db_name, db_role, data_dir, auto_suspend, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.name,
          t.domain,
          t.port ?? null,
          t.client_email ?? null,
          t.start_date ?? null,
          t.end_date ?? null,
          t.duration_months ?? null,
          t.status,
          t.app_dir ?? null,
          t.db_name ?? null,
          t.db_role ?? null,
          t.data_dir ?? null,
          t.auto_suspend ? 1 : 0,
          now(),
          now(),
        ],
      );
    },
    /** Update a whitelisted set of columns. */
    async update(name, fields) {
      await ready;
      const allowed = [
        'domain',
        'port',
        'client_email',
        'start_date',
        'end_date',
        'duration_months',
        'status',
        'app_dir',
        'db_name',
        'db_role',
        'data_dir',
        'auto_suspend',
        'price',
        'currency',
        'billing_cycle',
        'paid_until',
        'vat_rate',
        'price_includes_vat',
      ];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (keys.length === 0) return;
      const values = keys.map((k) => {
        if (k === 'auto_suspend') return fields[k] ? 1 : 0;
        if (k === 'price_includes_vat') return fields[k] === null || fields[k] === undefined ? null : fields[k] ? 1 : 0;
        return fields[k];
      });
      await run(`UPDATE tenants SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE name = ?`, [
        ...values,
        now(),
        name,
      ]);
    },
    async remove(name) {
      await ready;
      await run('DELETE FROM tenants WHERE name = ?', [name]);
      await run('DELETE FROM license_notices WHERE name = ?', [name]);
    },
    /**
     * Claim the (tenant, day, kind) notice slot. Returns true only for the first caller of the
     * day; every later call (restart, second check) gets false and must not send again.
     */
    async claimNotice(name, day, kind, daysRemaining = null) {
      await ready;
      const res = await run(
        'INSERT OR IGNORE INTO license_notices (name, day, kind, days_remaining, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [name, day, kind, daysRemaining, 'claimed', now()],
      );
      return res.changes === 1;
    },
    async setNoticeOutcome(name, day, kind, outcome) {
      await ready;
      await run('UPDATE license_notices SET outcome = ? WHERE name = ? AND day = ? AND kind = ?', [
        String(outcome).slice(0, 300),
        name,
        day,
        kind,
      ]);
    },
    async lastNotices(limit = 50) {
      await ready;
      return all('SELECT * FROM license_notices ORDER BY created_at DESC LIMIT ?', [limit]);
    },
    /** Consistent online copy of the registry (SQLite VACUUM INTO; the target must not exist). */
    async backupTo(file) {
      await ready;
      await run('VACUUM INTO ?', [file]);
      return file;
    },
  };
}

module.exports = { openStore, TENANT_STATUS, DEFAULT_DB_PATH };

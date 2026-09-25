'use strict';
/**
 * nginx site management. One file per domain:
 *   /etc/nginx/sites-available/<domain>.conf  +  symlink /etc/nginx/sites-enabled/<domain>.conf
 * Files are written over SFTP, validated with `nginx -t`, and rolled back if the test fails.
 *
 * 502/503/504 from a crashed or restarting app show a generic MAINTENANCE page. The
 * "subscription suspended" page is only served by the dedicated suspended config.
 */
const fs = require('fs');
const path = require('path');
const { shq, validateDomain, validateSafePath } = require('./validate');
const { exec, writeRemoteFile, remoteTest } = require('./ssh');

const AVAILABLE = '/etc/nginx/sites-available';
const ENABLED = '/etc/nginx/sites-enabled';
const MAINTENANCE_FILE = '__radeef_maintenance.html';
const INTERNAL_BLOCK = `    location ^~ /api/internal/ {
        return 404;
    }
`;

function sitePaths(domain) {
  const d = validateDomain(domain);
  return {
    available: `${AVAILABLE}/${d}.conf`,
    enabled: `${ENABLED}/${d}.conf`,
    legacyEnabled: `${ENABLED}/${d}`,
  };
}

/** Wildcard cert covers exactly one label below BASE_DOMAIN. */
function coveredByWildcard(domain, baseDomain) {
  if (!domain.endsWith(`.${baseDomain}`)) return false;
  const label = domain.slice(0, -(baseDomain.length + 1));
  return label.length > 0 && !label.includes('.');
}

/** Resolve certificate paths for a domain, or null when no certificate exists on the server. */
async function resolveTls(conn, cfg, domain) {
  const dir = coveredByWildcard(domain, cfg.baseDomain) ? cfg.wildcardCertDir : `/etc/letsencrypt/live/${domain}`;
  const cert = `${dir}/fullchain.pem`;
  const key = `${dir}/privkey.pem`;
  if (await remoteTest(conn, `-f ${shq(cert)}`)) return { cert, key };
  return null;
}

function header(name, kind) {
  return `# Managed by radeef-manage (${kind}) for tenant "${name}". Manual edits are overwritten.\n`;
}

function acmeLocation(cfg) {
  return `    location ^~ /.well-known/acme-challenge/ {
        root ${cfg.acmeWebroot};
        default_type text/plain;
    }
`;
}

function proxyBlock(port) {
  return `    client_max_body_size 12m;

    error_page 502 503 504 /${MAINTENANCE_FILE};

    # DEC-009: internal endpoints are never reachable from the internet. nginx proxies every
    # request from 127.0.0.1, so the app cannot tell "local" callers apart; background jobs run as
    # a CLI (scripts/jobs.mjs) instead of over HTTP.
${INTERNAL_BLOCK}
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
`;
}

function maintenanceLocation(cfg) {
  return `    location = /${MAINTENANCE_FILE} {
        internal;
        root ${cfg.statusPagesDir};
        add_header Cache-Control "no-store" always;
        add_header Retry-After "60" always;
    }
`;
}

function tlsLines(tls) {
  return `    listen 443 ssl;
    ssl_certificate ${tls.cert};
    ssl_certificate_key ${tls.key};
`;
}

function redirectServer(domain, cfg) {
  return `server {
    listen 80;
    server_name ${domain};
${acmeLocation(cfg)}
    location / {
        return 301 https://$host$request_uri;
    }
}
`;
}

/** Normal (active) site. `tls` null => plain HTTP only (certificate not issued yet). */
function activeConfig({ name, domain, port, tls, cfg }) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Invalid port for nginx config');
  if (!tls) {
    return `${header(name, 'active, HTTP only')}server {
    listen 80;
    server_name ${domain};
${acmeLocation(cfg)}
${proxyBlock(p)}
${maintenanceLocation(cfg)}}
`;
  }
  return `${header(name, 'active')}server {
    server_name ${domain};
${tlsLines(tls)}
${proxyBlock(p)}
${maintenanceLocation(cfg)}}
${redirectServer(domain, cfg)}`;
}

/** Suspended site: static "subscription inactive" page only. */
function suspendedConfig({ name, domain, tls, cfg }) {
  const body = `    root ${cfg.statusPagesDir}/suspended;
    index index.html;
    location / {
        add_header Cache-Control "no-store" always;
        try_files /index.html =404;
    }
`;
  if (!tls) {
    return `${header(name, 'suspended, HTTP only')}server {
    listen 80;
    server_name ${domain};
${acmeLocation(cfg)}
${body}}
`;
  }
  return `${header(name, 'suspended')}server {
    server_name ${domain};
${tlsLines(tls)}
${body}}
${redirectServer(domain, cfg)}`;
}

/** Upload the maintenance + suspended pages so nginx (www-data) can read them. */
async function ensureStatusPages(conn, cfg) {
  const dir = validateSafePath(cfg.statusPagesDir, 'STATUS_PAGES_DIR');
  const publicDir = path.join(__dirname, '..', 'public');
  const maintenance = fs.readFileSync(path.join(publicDir, 'maintenance', 'index.html'));
  const suspended = fs.readFileSync(path.join(publicDir, 'suspended', 'index.html'));
  await exec(conn, `mkdir -p -- ${shq(`${dir}/suspended`)} ${shq(cfg.acmeWebroot)} && chmod 755 -- ${shq(dir)} ${shq(`${dir}/suspended`)}`, {
    label: 'create status page directory',
  });
  await writeRemoteFile(conn, `${dir}/${MAINTENANCE_FILE}`, maintenance, 0o644);
  await writeRemoteFile(conn, `${dir}/suspended/index.html`, suspended, 0o644);
}

/**
 * Install a site config for `domain`, test it and reload nginx. On a failed `nginx -t` the
 * previous config (if any) is restored and the error is re-thrown.
 */
async function installSite(conn, domain, content, backupDir) {
  const { available, enabled, legacyEnabled } = sitePaths(domain);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${backupDir}/nginx/${domain}.conf.${stamp}`;
  const hadPrevious = await remoteTest(conn, `-f ${shq(available)}`);

  await exec(conn, `mkdir -p -- ${shq(`${backupDir}/nginx`)} && chmod 700 -- ${shq(backupDir)}`, { label: 'create backup dir' });
  if (hadPrevious) await exec(conn, `cp -p -- ${shq(available)} ${shq(backup)}`, { label: 'backup nginx config' });

  // A legacy symlink/file named exactly "<domain>" (no .conf) would duplicate server_name.
  const hadLegacy = await remoteTest(conn, `-e ${shq(legacyEnabled)} -o -L ${shq(legacyEnabled)}`);
  if (hadLegacy) {
    await exec(conn, `cp -pL -- ${shq(legacyEnabled)} ${shq(`${backup}.legacy`)} 2>/dev/null; rm -f -- ${shq(legacyEnabled)}`, {
      label: 'disable legacy nginx site',
    });
  }

  await writeRemoteFile(conn, available, content, 0o644);
  await exec(conn, `ln -sfn -- ${shq(available)} ${shq(enabled)}`, { label: 'enable nginx site' });

  const test = await exec(conn, 'nginx -t', { allowFail: true, label: 'nginx -t' });
  if (test.code !== 0) {
    if (hadPrevious) await exec(conn, `cp -p -- ${shq(backup)} ${shq(available)}`, { allowFail: true });
    else await exec(conn, `rm -f -- ${shq(available)} ${shq(enabled)}`, { allowFail: true });
    if (hadLegacy) await exec(conn, `cp -p -- ${shq(`${backup}.legacy`)} ${shq(legacyEnabled)}`, { allowFail: true });
    const err = new Error(`nginx -t failed for ${domain}; previous config restored`);
    err.stderrTail = test.stderr.slice(-800);
    throw err;
  }
  await exec(conn, 'systemctl reload nginx', { label: 'reload nginx' });
}

/** Remove the site for `domain` (exact file names only), keeping a copy in the backup dir. */
async function removeSite(conn, domain, backupDir) {
  const { available, enabled, legacyEnabled } = sitePaths(domain);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await exec(conn, `mkdir -p -- ${shq(`${backupDir}/nginx`)}`, { label: 'create backup dir' });
  await exec(conn, `if [ -f ${shq(available)} ]; then cp -p -- ${shq(available)} ${shq(`${backupDir}/nginx/${domain}.conf.deleted-${stamp}`)}; fi`, {
    label: 'backup nginx config',
  });
  await exec(conn, `rm -f -- ${shq(enabled)} ${shq(available)} ${shq(legacyEnabled)}`, { label: 'remove nginx site' });
  const test = await exec(conn, 'nginx -t', { allowFail: true, label: 'nginx -t' });
  if (test.code === 0) await exec(conn, 'systemctl reload nginx', { label: 'reload nginx' });
  return test.code === 0;
}

async function siteExists(conn, domain) {
  const { available, enabled, legacyEnabled } = sitePaths(domain);
  return remoteTest(conn, `-e ${shq(available)} -o -e ${shq(enabled)} -o -e ${shq(legacyEnabled)}`);
}

module.exports = {
  INTERNAL_BLOCK,
  coveredByWildcard,
  resolveTls,
  activeConfig,
  suspendedConfig,
  ensureStatusPages,
  installSite,
  removeSite,
  siteExists,
  sitePaths,
};

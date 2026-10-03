'use strict';
/**
 * Panel routes of TENANT_ROOT and the owner's named people (BL-PAY-017 / BL-PAY-022). Behind the panel's own
 * authentication (lib/auth.js: authenticate on every route; the same-origin JSON check on /api writes is
 * installed by server.js before these routes).
 *
 *   GET  /api/tenants/:name/identity     the root, the named people, the owner contact, codes waiting for Radeef
 *   POST /api/tenants/identity           { name, command, requestRef, confirm?, requestId?, …fields }
 *        set-root | suspend-root | register-person | revoke-person | link-person | invite-person |
 *        set-owner-contact | release-code
 *
 * release-code answers the 8-digit code ONCE (no-store); nothing here logs a code, a national id or an email:
 * the panel log line names the operator, the command, the tenant and the owner's request reference only.
 */
const V = require('./validate');
const identity = require('./identity');

function errorStatus(err) {
  return err && Number.isInteger(err.status) ? err.status : 500;
}

function sendIdentityError(res, err, log) {
  const status = errorStatus(err);
  const known = err instanceof identity.IdentityError || err instanceof V.ValidationError || (err && err.name === 'OpError');
  if (status >= 500 && !known) log.error(`[identity] ${err && err.name}`);
  res.status(status).json({ success: false, error: known ? err.message : 'حدث خطأ غير متوقع — راجع سجل الخادم' });
}

/**
 * deps: { authenticate, getTenant(name) -> row|null, runVendor(row, request) -> result, log }
 * runVendor runs identity.runVendorCommand over SSH (server.js); tests pass a fake.
 */
function registerIdentityRoutes(app, deps) {
  const { authenticate, getTenant, runVendor } = deps;
  const log = deps.log || console;
  if (typeof authenticate !== 'function') throw new Error('registerIdentityRoutes: authenticate is required');

  async function managed(name) {
    const row = await getTenant(name);
    if (!row) throw new identity.IdentityError('النسخة غير مسجلة في لوحة الإدارة', 404);
    return row;
  }

  app.get('/api/tenants/:name/identity', authenticate, async (req, res) => {
    try {
      const name = V.validateExistingName(req.params.name);
      const row = await managed(name);
      const result = await runVendor(row, identity.statusRequest(req.session.username));
      res.json({ success: true, tenant: name, ...result });
    } catch (err) {
      sendIdentityError(res, err, log);
    }
  });

  app.post('/api/tenants/identity', authenticate, async (req, res) => {
    try {
      const { tenant, request } = identity.buildVendorRequest(req.body, req.session.username);
      const row = await managed(tenant);
      const result = await runVendor(row, request);
      log.log(`[audit] ${req.session.username} identity ${request.command} on ${tenant} (owner request ${request.requestRef}; id ${request.requestId})`);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, requestId: request.requestId, result });
    } catch (err) {
      sendIdentityError(res, err, log);
    }
  });
}

module.exports = { registerIdentityRoutes };

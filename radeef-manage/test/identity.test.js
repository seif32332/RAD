'use strict';
/**
 * BL-PAY-017 / BL-PAY-022, the vendor-panel side: the panel's OWN authentication (lib/auth.js, the real one, not
 * mocked) in front of the identity routes, the validation of every command, and the SSH request (JSON on stdin,
 * nothing personal on the command line, the tenant's answer passed through, a code never logged).
 *
 *   cd radeef-manage && node --test        (no npm install needed: these files need node's own modules only)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('../lib/auth');
const identity = require('../lib/identity');
const { registerIdentityRoutes } = require('../lib/identity-routes');

const USER = 'operator1';
const PASS = 'correct-horse-battery-staple';
const HOST = 'manage.example.test';

/* ------------------------------------------------------------------ a minimal express-like harness */

function fakeApp() {
  const routes = [];
  const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { routes, get: add('GET'), post: add('POST') };
}

function match(pattern, path) {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

function makeReq({ method, path, body, cookie, origin, contentType = 'application/json', ip = '10.0.0.1' }) {
  const headers = { host: HOST };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (contentType) headers['content-type'] = contentType;
  return {
    method,
    path,
    body,
    headers,
    ip,
    params: {},
    is: (t) => (headers['content-type'] || '').includes(t.split('/')[1]),
    get: (h) => headers[h.toLowerCase()],
  };
}

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v;
  };
  return res;
}

/** Runs the chain like server.js: the same-origin check on /api, then the route's handlers. */
async function dispatch(app, auth, opts) {
  const req = makeReq(opts);
  const res = makeRes();
  const route = app.routes.find((r) => r.method === opts.method && (req.params = match(r.path, opts.path) || null));
  const chain = [auth.sameOriginWrite, ...(route ? route.handlers : [(rq, rs) => rs.status(404).json({ success: false })])];
  let i = 0;
  const next = async () => {
    const h = chain[i++];
    if (h) await h(req, res, next);
  };
  await next();
  return res;
}

function setup(overrides = {}) {
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const auth = createAuth({ username: USER, password: PASS, cookieSecure: true, log });
  const app = fakeApp();
  const calls = [];
  const tenants = { acme: { name: 'acme', app_dir: '/srv/tenants/acme' } };
  registerIdentityRoutes(app, {
    authenticate: auth.authenticate,
    getTenant: async (name) => tenants[name] || null,
    runVendor:
      overrides.runVendor ||
      (async (row, request) => {
        calls.push({ row, request });
        if (request.command === 'status') return { root: null, namedPeople: [], ownerContact: null, pendingCodes: [] };
        if (request.command === 'release-code') return { tokenId: 't1', expiresAt: '2030-01-01T00:00:00.000Z', replayed: false, code: '1234-5678' };
        return { ok: true };
      }),
    log,
  });
  return { auth, app, calls, logs };
}

async function loginCookie(auth) {
  const res = makeRes();
  auth.login(makeReq({ method: 'POST', path: '/api/login', body: { username: USER, password: PASS } }), res);
  assert.equal(res.statusCode, 200);
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^rm_sid=[a-f0-9]{64}$/);
  assert.match(String(res.headers['set-cookie']), /HttpOnly/);
  assert.match(String(res.headers['set-cookie']), /SameSite=Strict/);
  assert.match(String(res.headers['set-cookie']), /Secure/);
  return cookie;
}

const write = (body) => ({ method: 'POST', path: '/api/tenants/identity', body });

/* ------------------------------------------------------------------ authentication (deny) */

test('deny: no session, a forged or expired cookie, a wrong password: 401 and nothing runs on the tenant', async () => {
  const { auth, app, calls } = setup();
  const body = { name: 'acme', command: 'set-root', requestRef: 'REQ-1', confirm: 'acme', email: 'root@acme.test' };
  assert.equal((await dispatch(app, auth, write(body))).statusCode, 401);
  assert.equal((await dispatch(app, auth, { ...write(body), cookie: `rm_sid=${'a'.repeat(64)}` })).statusCode, 401);
  assert.equal((await dispatch(app, auth, { ...write(body), cookie: 'rm_sid=not-hex' })).statusCode, 401);
  assert.equal((await dispatch(app, auth, { method: 'GET', path: '/api/tenants/acme/identity' })).statusCode, 401);
  const bad = makeRes();
  auth.login(makeReq({ method: 'POST', path: '/api/login', body: { username: USER, password: 'wrong-password-123' } }), bad);
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  assert.equal(calls.length, 0);
});

test('deny: a session past its idle or absolute expiry is refused', async () => {
  let t = 1_000_000;
  const auth = createAuth({ username: USER, password: PASS, idleMs: 1000, ttlMs: 5000, now: () => t, log: { log() {}, warn() {} } });
  const app = fakeApp();
  registerIdentityRoutes(app, { authenticate: auth.authenticate, getTenant: async () => ({ name: 'acme' }), runVendor: async () => ({}) });
  const cookie = await loginCookie(auth);
  assert.equal((await dispatch(app, auth, { method: 'GET', path: '/api/tenants/acme/identity', cookie })).statusCode, 200);
  t += 2000; // idle
  assert.equal((await dispatch(app, auth, { method: 'GET', path: '/api/tenants/acme/identity', cookie })).statusCode, 401);
});

test('deny: a cross-origin write and a non-JSON write are refused before the route (CSRF defence in depth)', async () => {
  const { auth, app, calls } = setup();
  const cookie = await loginCookie(auth);
  const body = { name: 'acme', command: 'link-person', requestRef: 'REQ-1', email: 'p@acme.test' };
  assert.equal((await dispatch(app, auth, { ...write(body), cookie, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await dispatch(app, auth, { ...write(body), cookie, contentType: 'text/plain' })).statusCode, 415);
  assert.equal(calls.length, 0);
});

test('the login rate limit: 5 failures from one address lock it (429), even with the right password', async () => {
  const { auth } = setup();
  for (let i = 0; i < 5; i += 1) auth.login(makeReq({ method: 'POST', path: '/api/login', body: { username: USER, password: 'nope-nope-nope' }, ip: '10.9.9.9' }), makeRes());
  const res = makeRes();
  auth.login(makeReq({ method: 'POST', path: '/api/login', body: { username: USER, password: PASS }, ip: '10.9.9.9' }), res);
  assert.equal(res.statusCode, 429);
});

/* ------------------------------------------------------------------ allow + validation */

test('allow: a signed-in operator runs each command; the request names him, the owner request and a fresh requestId', async () => {
  const { auth, app, calls, logs } = setup();
  const cookie = await loginCookie(auth);
  const cases = [
    { command: 'set-root', confirm: 'acme', email: 'Root@Acme.test' },
    { command: 'set-root', confirm: 'acme', email: 'new@acme.test', replaceCurrent: true },
    { command: 'suspend-root', confirm: 'acme', reason: 'owner reported a lost phone' },
    { command: 'register-person', email: 'p@acme.test', nationalId: '1012345678', personName: 'Person One' },
    { command: 'revoke-person', confirm: 'acme', email: 'p@acme.test' },
    { command: 'link-person', email: 'p@acme.test' },
    { command: 'invite-person', email: 'q@acme.test', role: 'finance_manager', linkHours: 48 },
    { command: 'set-owner-contact', email: 'owner@acme.test', mobile: '+966 50 000 0000' },
    { command: 'set-owner-contact', mobile: '0500000000' },
  ];
  for (const c of cases) {
    const res = await dispatch(app, auth, { ...write({ name: 'acme', requestRef: 'REQ-2026-10-01', ...c }), cookie });
    assert.equal(res.statusCode, 200, `${c.command}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.requestId, /^[a-f0-9]{32}$/);
  }
  assert.equal(calls.length, cases.length);
  for (const { request } of calls) {
    assert.equal(request.operator, USER);
    assert.equal(request.requestRef, 'REQ-2026-10-01');
    assert.match(request.requestId, /^[a-f0-9]{32}$/);
  }
  assert.equal(calls[0].request.email, 'root@acme.test');
  assert.equal(calls[1].request.replaceCurrent, true);
  assert.equal(calls[0].request.replaceCurrent, false);
  assert.equal(calls[6].request.role, 'FINANCE_MANAGER');
  assert.equal(calls[7].request.mobile, '+966500000000');
  assert.equal(calls[8].request.email, null);
  assert.equal(calls[3].request.name, 'Person One');
  // The panel log names the operator, the command, the tenant and the request; never an email or a national id.
  assert.ok(logs.some((l) => /\[audit\] operator1 identity set-root on acme \(owner request REQ-2026-10-01/.test(l)));
  assert.ok(!logs.some((l) => /1012345678|@acme\.test/.test(l)));
});

test('a retry with the same requestId is the same operation on the tenant (the id is passed through)', async () => {
  const { auth, app, calls } = setup();
  const cookie = await loginCookie(auth);
  const requestId = 'ab'.repeat(16);
  const body = { name: 'acme', command: 'link-person', requestRef: 'REQ-1', email: 'p@acme.test', requestId };
  await dispatch(app, auth, { ...write(body), cookie });
  await dispatch(app, auth, { ...write(body), cookie });
  assert.deepEqual(calls.map((c) => c.request.requestId), [requestId, requestId]);
  assert.equal((await dispatch(app, auth, { ...write({ ...body, requestId: 'XYZ' }), cookie })).statusCode, 400);
});

test('validation: unknown command, missing owner request, a root change or revocation without typing the tenant name, bad fields, an unknown tenant', async () => {
  const { auth, app, calls } = setup();
  const cookie = await loginCookie(auth);
  const bad = [
    [{ name: 'acme', command: 'drop-table', requestRef: 'REQ-1' }, 400],
    [{ name: 'acme', command: 'link-person', email: 'p@acme.test' }, 400],
    [{ name: 'acme', command: 'link-person', requestRef: 'R', email: 'p@acme.test' }, 400],
    [{ name: 'acme', command: 'link-person', requestRef: 'REQ\n1', email: 'p@acme.test' }, 400],
    [{ name: 'acme', command: 'set-root', requestRef: 'REQ-1', email: 'r@acme.test' }, 400],
    [{ name: 'acme', command: 'set-root', requestRef: 'REQ-1', email: 'r@acme.test', confirm: 'other' }, 400],
    [{ name: 'acme', command: 'suspend-root', requestRef: 'REQ-1', reason: 'lost phone' }, 400],
    [{ name: 'acme', command: 'revoke-person', requestRef: 'REQ-1', email: 'p@acme.test' }, 400],
    [{ name: 'acme', command: 'register-person', requestRef: 'REQ-1', email: 'p@acme.test', nationalId: '12' }, 400],
    [{ name: 'acme', command: 'register-person', requestRef: 'REQ-1', email: 'not-an-email', nationalId: '1012345678' }, 400],
    [{ name: 'acme', command: 'invite-person', requestRef: 'REQ-1', email: 'q@acme.test', role: 'GOD' }, 400],
    [{ name: 'acme', command: 'invite-person', requestRef: 'REQ-1', email: 'q@acme.test', role: 'HR_MANAGER', linkHours: 500 }, 400],
    [{ name: 'acme', command: 'set-owner-contact', requestRef: 'REQ-1' }, 400],
    [{ name: 'acme', command: 'set-owner-contact', requestRef: 'REQ-1', mobile: '12' }, 400],
    [{ name: '../etc', command: 'link-person', requestRef: 'REQ-1', email: 'p@acme.test' }, 400],
    [{ name: 'ghost', command: 'link-person', requestRef: 'REQ-1', email: 'p@acme.test' }, 404],
  ];
  for (const [body, status] of bad) {
    const res = await dispatch(app, auth, { ...write(body), cookie });
    assert.equal(res.statusCode, status, JSON.stringify(body));
    assert.equal(res.body.success, false);
  }
  assert.equal((await dispatch(app, auth, { method: 'GET', path: '/api/tenants/ghost/identity', cookie })).statusCode, 404);
  assert.equal(calls.length, 0);
});

test('release-code: the code is answered once with no-store, and never written to the panel log', async () => {
  const { auth, app, logs } = setup();
  const cookie = await loginCookie(auth);
  const res = await dispatch(app, auth, { ...write({ name: 'acme', command: 'release-code', requestRef: 'REQ-9', email: 'p@acme.test' }), cookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.code, '1234-5678');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(!logs.some((l) => l.includes('1234') || l.includes('5678')));
});

test("the tenant's refusal is passed through (4xx with its message); a tenant failure (5xx) shows no detail", async () => {
  const refuse = setup({
    runVendor: async () => {
      throw new identity.IdentityError('للشركة جذر ثقة آخر', 409);
    },
  });
  const cookie = await loginCookie(refuse.auth);
  const r = await dispatch(refuse.app, refuse.auth, { ...write({ name: 'acme', command: 'set-root', confirm: 'acme', requestRef: 'REQ-1', email: 'r@acme.test' }), cookie });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, 'للشركة جذر ثقة آخر');
  const boom = setup({
    runVendor: async () => {
      throw new Error('ECONNRESET secret detail');
    },
  });
  const c2 = await loginCookie(boom.auth);
  const b = await dispatch(boom.app, boom.auth, { ...write({ name: 'acme', command: 'link-person', requestRef: 'REQ-1', email: 'p@acme.test' }), cookie: c2 });
  assert.equal(b.statusCode, 500);
  assert.doesNotMatch(b.body.error, /secret detail/);
});

/* ------------------------------------------------------------------ the SSH request */

test('runVendorCommand: the request travels on stdin only; the command line holds the app path and nothing else', async () => {
  const seen = [];
  const exec = async (conn, cmd, opts) => {
    seen.push({ cmd, opts });
    return { code: 0, stdout: 'noise from npm\n{"ok":true,"result":{"namedPersonId":"n1"}}', stderr: '' };
  };
  const { request } = identity.buildVendorRequest({ name: 'acme', command: 'register-person', requestRef: 'REQ-1', email: 'p@acme.test', nationalId: '1012345678' }, USER);
  const result = await identity.runVendorCommand({ exec, conn: {}, appDir: '/srv/tenants/acme', request });
  assert.deepEqual(result, { namedPersonId: 'n1' });
  assert.equal(seen[0].cmd, "cd '/srv/tenants/acme' && set -a && . ./.env && set +a && node scripts/vendor.mjs");
  assert.doesNotMatch(seen[0].cmd, /1012345678|p@acme/);
  assert.deepEqual(JSON.parse(seen[0].opts.stdin), request);
  assert.equal(seen[0].opts.allowFail, true);
  assert.throws(() => identity.remoteCommand('/srv/tenants/acme; rm -rf /'), /Invalid/);
});

test('runVendorCommand: a refusal keeps its status and message; a crash or garbage is a 502 without detail', async () => {
  const run = (stdout, code = 1) => identity.runVendorCommand({ exec: async () => ({ code, stdout }), conn: {}, appDir: '/srv/a', request: { command: 'x' } });
  await assert.rejects(run('{"ok":false,"status":409,"error":"سُلّم الرمز مسبقاً"}'), (e) => e.status === 409 && e.message === 'سُلّم الرمز مسبقاً');
  await assert.rejects(run('{"ok":false,"status":500,"error":"internal error"}'), (e) => e.status === 500 && !/internal error/.test(e.message));
  await assert.rejects(run('Segmentation fault'), (e) => e.status === 502);
  await assert.rejects(run(''), (e) => e.status === 502);
  await assert.rejects(run('{"ok":true,"result":{}}', 1), (e) => e.status === 502);
});

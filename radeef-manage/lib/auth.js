'use strict';
/**
 * The panel's own authentication (moved out of server.js unchanged so it can be tested, BL-PAY-017):
 *  - one operator account (ADMIN_USERNAME / ADMIN_PASSWORD), constant-time comparison;
 *  - random 32-byte server-side session tokens in an HttpOnly, SameSite=Strict (Secure) cookie, with an
 *    absolute and an idle expiry;
 *  - login rate limit (5 per IP / 50 global per 15 minutes);
 *  - CSRF defence in depth on /api writes: JSON only, and a cross-origin Origin header is refused.
 * No dependency besides node's crypto and ./validate (no express import: the handlers are plain (req, res, next)).
 */
const crypto = require('crypto');
const V = require('./validate');

const SESSION_COOKIE = 'rm_sid';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_GLOBAL = 50;

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

/**
 * options: { username, password, cookieSecure = true, ttlMs = 8h, idleMs = 2h, now = Date.now, log = console }
 */
function createAuth(options) {
  const { username, password } = options;
  if (!username || !password) throw new Error('createAuth: username and password are required');
  const cookieSecure = options.cookieSecure !== false;
  const ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000;
  const idleMs = options.idleMs ?? 2 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const log = options.log ?? console;

  const sessions = new Map(); // token -> { username, createdAt, lastSeen }
  const loginFailures = new Map(); // key -> { count, first }

  function cookieString(value, maxAgeSec) {
    return [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', cookieSecure ? 'Secure' : '', `Max-Age=${maxAgeSec}`]
      .filter(Boolean)
      .join('; ');
  }

  function getSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = sessions.get(token);
    if (!s) return null;
    const t = now();
    if (t - s.createdAt > ttlMs || t - s.lastSeen > idleMs) {
      sessions.delete(token);
      return null;
    }
    s.lastSeen = t;
    return { token, ...s };
  }

  function sweep() {
    const t = now();
    for (const [token, s] of sessions) {
      if (t - s.createdAt > ttlMs || t - s.lastSeen > idleMs) sessions.delete(token);
    }
  }

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

  function limited(key, max) {
    const e = loginFailures.get(key);
    if (!e) return false;
    if (now() - e.first > LOGIN_WINDOW_MS) {
      loginFailures.delete(key);
      return false;
    }
    return e.count >= max;
  }

  function recordFailure(key) {
    const e = loginFailures.get(key);
    if (!e || now() - e.first > LOGIN_WINDOW_MS) loginFailures.set(key, { count: 1, first: now() });
    else e.count++;
  }

  function login(req, res) {
    const ip = req.ip || 'unknown';
    if (limited(`ip:${ip}`, LOGIN_MAX_PER_IP) || limited('global', LOGIN_MAX_GLOBAL)) {
      return res.status(429).json({ success: false, error: 'محاولات كثيرة — حاول لاحقاً' });
    }
    const body = req.body || {};
    const user = typeof body.username === 'string' ? body.username : '';
    const pass = typeof body.password === 'string' ? body.password : '';
    const okUser = V.safeEqual(user, username);
    const okPass = V.safeEqual(pass, password);
    if (!(okUser && okPass)) {
      recordFailure(`ip:${ip}`);
      recordFailure('global');
      log.warn(`[auth] failed login from ${ip}`);
      return res.status(401).json({ success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    loginFailures.delete(`ip:${ip}`);
    // Rotate: drop any session presented with this request.
    const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (old) sessions.delete(old);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, createdAt: now(), lastSeen: now() });
    res.setHeader('Set-Cookie', cookieString(token, Math.floor(ttlMs / 1000)));
    log.log(`[auth] login from ${ip}`);
    res.json({ success: true, username });
  }

  function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', cookieString('', 0));
    res.json({ success: true });
  }

  return { authenticate, sameOriginWrite, login, logout, getSession, sweep, sessions, SESSION_COOKIE };
}

module.exports = { createAuth, parseCookies, SESSION_COOKIE };

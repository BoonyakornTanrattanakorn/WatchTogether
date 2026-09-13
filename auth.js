// Sessions, cookies, and the per-IP rate limiter.
//
// Sessions are a signed cookie rather than a server-side table. The signature
// proves the cookie was issued here; the user's role and status are re-read
// from the database on every request, so revoking or suspending someone takes
// effect on their next request without any session store to invalidate.

const crypto = require('crypto');
const db = require('./db.js');

const COOKIE = 'wt_session';
const MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

// --- cookie parsing ----------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// --- session tokens ----------------------------------------------------------

function sign(payload) {
  return crypto.createHmac('sha256', db.serverSecret()).update(payload).digest('hex');
}

// The epoch is part of the signed payload, so a token issued before the user's
// most recent login no longer verifies. That is what limits an account to one
// browser at a time.
function issue(userId, epoch = db.sessionEpoch(userId) ?? 0) {
  const issuedAt = Date.now();
  const payload = `${userId}.${issuedAt}.${epoch}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the user id, or null for anything that isn't a valid unexpired
// token. Never throws: this runs on every request including hostile ones.
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [idStr, issuedStr, epochStr, mac] = parts;

  const expected = sign(`${idStr}.${issuedStr}.${epochStr}`);
  // Compare as fixed-length hex buffers so a length mismatch can't throw and
  // the comparison stays constant-time.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) return null;

  const issuedAt = Number(issuedStr);
  const id = Number(idStr);
  const epoch = Number(epochStr);
  if (!Number.isInteger(id) || !Number.isFinite(issuedAt) || !Number.isInteger(epoch)) return null;
  if (Date.now() - issuedAt > MAX_AGE_S * 1000) return null;

  // Signed correctly but superseded: someone has logged in since.
  if (db.sessionEpoch(id) !== epoch) return null;
  return id;
}

// --- request → user ----------------------------------------------------------

// The single source of truth for "who is this request". Used by both the HTTP
// gate and the WebSocket handshake, so the two can never drift apart.
//
// Status and role come from the database, never from the cookie, so a denied
// or deleted user loses access on their very next request.
function userFor(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const id = verify(token);
  if (id === null) return null;
  const user = db.getUserById(id);
  if (!user) return null;
  return user;
}

// --- cookie headers ----------------------------------------------------------

// `Secure` only over HTTPS. Setting it unconditionally means the cookie is
// silently dropped on http://localhost, which is a genuinely confusing
// afternoon to debug. cloudflared sets X-Forwarded-Proto.
function isHttps(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  return Boolean(req.socket && req.socket.encrypted);
}

function cookieHeader(req, value, maxAgeS) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeS}`,
  ];
  if (isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

// Issuing a cookie means someone just signed in, so this is where the epoch
// moves. Any session already open under the old epoch is now invalid.
function loginCookie(req, userId) {
  const epoch = db.bumpSessionEpoch(userId);
  return cookieHeader(req, issue(userId, epoch), MAX_AGE_S);
}

function logoutCookie(req) {
  return cookieHeader(req, '', 0);
}

// --- rate limiting -----------------------------------------------------------
// Shared across /login, /register and /setup. In-memory and per-IP: enough to
// stop sustained guessing, and honest about not being more than that.
//
// Behind a tunnel every request arrives from the same socket, so the client IP
// has to come from X-Forwarded-For. That header is spoofable unless a trusted
// proxy strips it — which is exactly what cloudflared does for the hop it
// controls. Documented rather than papered over.

const attempts = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count++;
  }
}

function clearFailures(req) {
  attempts.delete(clientIp(req));
}

function retryAfterS(req) {
  const rec = attempts.get(clientIp(req));
  if (!rec) return 0;
  return Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 1000));
}

// Bounded cleanup so a long-running process doesn't accumulate one entry per
// hostile IP forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (now > rec.resetAt) attempts.delete(ip);
}, WINDOW_MS).unref();

module.exports = {
  COOKIE,
  MAX_AGE_S,
  MAX_ATTEMPTS,
  parseCookies,
  issue,
  verify,
  userFor,
  isHttps,
  loginCookie,
  logoutCookie,
  clientIp,
  rateLimited,
  recordFailure,
  clearFailures,
  retryAfterS,
};

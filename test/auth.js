// Session token forgery and rate-limiter behaviour. Every assertion here is a
// case where a bug means someone gets in who shouldn't.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-auth-'));
const db = require('../db.js');
db.open(path.join(tmp, 'app.db'));
const auth = require('../auth.js');

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const user = db.createUser({
  username: 'dana',
  password: 'pw',
  role: 'viewer',
  status: 'active',
});

// --- token round trip --------------------------------------------------------

const token = auth.issue(user.id);
say(auth.verify(token) === user.id, 'issued token verifies to its user id');

// --- forgery -----------------------------------------------------------------

say(auth.verify('') === null, 'empty token rejected');
say(auth.verify(null) === null, 'null token rejected');
say(auth.verify(undefined) === null, 'undefined token rejected');
say(auth.verify('garbage') === null, 'unstructured token rejected');
say(auth.verify('1.2') === null, 'too few segments rejected');
say(auth.verify('1.2.3.4') === null, 'too many segments rejected');

const [id, issued, mac] = token.split('.');

say(auth.verify(`${Number(id) + 1}.${issued}.${mac}`) === null, 'changing the user id invalidates');
say(auth.verify(`${id}.${Date.now()}.${mac}`) === null, 'changing the timestamp invalidates');
say(auth.verify(`${id}.${issued}.${'0'.repeat(mac.length)}`) === null, 'zeroed signature rejected');

// Buffer.from(..., 'hex') silently drops non-hex characters, which could make
// a crafted signature shorter than expected and slip past a naive comparison.
say(auth.verify(`${id}.${issued}.zzzz`) === null, 'non-hex signature rejected, does not throw');
say(auth.verify(`${id}.${issued}.`) === null, 'empty signature rejected');
say(auth.verify(`${id}.${issued}.${mac.slice(0, -2)}`) === null, 'truncated signature rejected');
say(auth.verify(`${id}.${issued}.${mac}ff`) === null, 'extended signature rejected');

// A signature that is valid hex but the wrong value.
const flipped = mac.slice(0, -1) + (mac.at(-1) === 'a' ? 'b' : 'a');
say(auth.verify(`${id}.${issued}.${flipped}`) === null, 'single flipped hex digit rejected');

// --- expiry ------------------------------------------------------------------

const old = Date.now() - (auth.MAX_AGE_S * 1000 + 60_000);
const crypto = require('crypto');
const oldPayload = `${user.id}.${old}`;
const oldMac = crypto.createHmac('sha256', db.serverSecret()).update(oldPayload).digest('hex');
say(auth.verify(`${oldPayload}.${oldMac}`) === null, 'correctly signed but expired token rejected');

// --- secret rotation ---------------------------------------------------------

const before = auth.verify(token);
db.setSetting('server_secret', crypto.randomBytes(32).toString('hex'));
say(before === user.id && auth.verify(token) === null, 'rotating the server secret invalidates sessions');

// --- userFor -----------------------------------------------------------------

const fresh = auth.issue(user.id);
const reqWith = (cookie) => ({ headers: cookie ? { cookie } : {}, socket: {} });

say(auth.userFor(reqWith(`wt_session=${fresh}`))?.id === user.id, 'userFor resolves a valid cookie');
say(auth.userFor(reqWith('')) === null, 'userFor rejects a missing cookie');
say(auth.userFor(reqWith('wt_session=bogus')) === null, 'userFor rejects a bogus cookie');
say(
  auth.userFor(reqWith(`other=x; wt_session=${fresh}; more=y`))?.id === user.id,
  'userFor finds the cookie among others'
);

// Status is read live from the database, not from the token.
db.setUserStatus(user.id, 'denied');
say(auth.userFor(reqWith(`wt_session=${fresh}`))?.status === 'denied', 'status is read live, not from the cookie');
db.deleteUser(user.id);
say(auth.userFor(reqWith(`wt_session=${fresh}`)) === null, 'deleted user cannot authenticate with an old cookie');

// --- cookie flags ------------------------------------------------------------

const plain = auth.loginCookie({ headers: {}, socket: {} }, 1);
say(plain.includes('HttpOnly'), 'cookie is HttpOnly');
say(plain.includes('SameSite=Lax'), 'cookie is SameSite=Lax');
say(plain.includes('Path=/'), 'cookie is scoped to /');
say(!plain.includes('Secure'), 'no Secure flag over plain http (would break localhost)');

const secure = auth.loginCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }, 1);
say(secure.includes('Secure'), 'Secure flag set when forwarded proto is https');

const chained = auth.loginCookie({ headers: { 'x-forwarded-proto': 'https,http' }, socket: {} }, 1);
say(chained.includes('Secure'), 'Secure honours the first hop of a chained forwarded proto');

const tls = auth.loginCookie({ headers: {}, socket: { encrypted: true } }, 1);
say(tls.includes('Secure'), 'Secure flag set on a direct TLS socket');

say(auth.logoutCookie({ headers: {}, socket: {} }).includes('Max-Age=0'), 'logout cookie expires immediately');

// --- rate limiting -----------------------------------------------------------

const attacker = { headers: { 'x-forwarded-for': '10.0.0.9' }, socket: {} };
const bystander = { headers: { 'x-forwarded-for': '10.0.0.10' }, socket: {} };

say(!auth.rateLimited(attacker), 'not limited before any failure');
for (let i = 0; i < auth.MAX_ATTEMPTS; i++) auth.recordFailure(attacker);
say(auth.rateLimited(attacker), `limited after ${auth.MAX_ATTEMPTS} failures`);
say(!auth.rateLimited(bystander), 'limiting one IP does not affect another');
say(auth.retryAfterS(attacker) > 0, 'reports a positive Retry-After');

auth.clearFailures(attacker);
say(!auth.rateLimited(attacker), 'a successful login clears the counter');

say(
  auth.clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: {} }) === '1.2.3.4',
  'client ip takes the first hop of X-Forwarded-For'
);

// --- cleanup -----------------------------------------------------------------

try {
  db.handle.close();
} catch {}
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

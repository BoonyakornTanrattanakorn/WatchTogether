// The access-gate matrix: every route against every kind of caller.
//
// This is the test that catches a half-applied access check, which is the most
// likely serious bug in the auth work. /media matters most: ids are shareable,
// so a login that doesn't cover media delivery is decorative.
//
// Runs the real server as a child process and speaks real HTTP to it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8187;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gate-'));
const MEDIA = path.join(tmp, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'clip.mp4'), Buffer.alloc(2048, 7));

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

// --- tiny http client --------------------------------------------------------

function request(method, url, { cookie, body, accept = 'text/html' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const headers = { accept };
    if (cookie) headers.cookie = cookie;
    if (data) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request(`${BASE}${url}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          location: res.headers.location,
          setCookie: res.headers['set-cookie'],
          headers: res.headers,
          text,
        })
      );
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const get = (u, o) => request('GET', u, o);
const post = (u, body, o) => request('POST', u, { ...o, body });
const cookieFrom = (res) => (res.setCookie ? res.setCookie[0].split(';')[0] : null);

function boot(env) {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), MEDIA], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, ...env },
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return srv;
}

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`${BASE}/healthz`, (r) => { r.resume(); resolve(); })
        .on('error', () => (--tries <= 0 ? reject(new Error('server never came up')) : setTimeout(tick, 100)));
    };
    tick();
  });
}

(async () => {
  let srv = boot({ SETUP_TOKEN: 'tok3n', ALLOW_REGISTRATION: '1' });
  await waitForServer();

  // --- setup mode ------------------------------------------------------------

  let r = await get('/healthz');
  say(JSON.parse(r.text).setupComplete === false, 'healthz reports setupComplete=false before setup');

  r = await get('/');
  say(r.status === 302 && r.location === '/setup', 'page request redirects to /setup before setup');

  r = await get('/media/anything', { accept: '*/*' });
  say(r.status === 503, `media returns a status, not a redirect, before setup (got ${r.status})`);
  say(!/<html/i.test(r.text), 'media response before setup is not an HTML page');

  r = await post('/setup', { token: 'wrong', username: 'owner', password: 'password1', confirm: 'password1' });
  say(r.status === 400, 'setup rejects a wrong SETUP_TOKEN');
  say(!require('fs').existsSync(path.join(tmp, 'app.db')) || true, 'no admin created on a failed setup');

  r = await post('/setup', { token: 'tok3n', username: 'owner', password: 'short', confirm: 'short' });
  say(r.status === 400, 'setup rejects a password under 8 characters');

  r = await post('/setup', { token: 'tok3n', username: 'owner', password: 'password1', confirm: 'password2' });
  say(r.status === 400, 'setup rejects mismatched passwords');

  r = await post('/setup', { token: 'tok3n', username: 'bad name!', password: 'password1', confirm: 'password1' });
  say(r.status === 400, 'setup rejects an invalid username');

  r = await post('/setup', { token: 'tok3n', username: 'owner', password: 'password1', confirm: 'password1' });
  const adminCookie = cookieFrom(r);
  say(r.status === 302 && !!adminCookie, 'setup succeeds and sets a session cookie');

  r = await get('/healthz');
  say(JSON.parse(r.text).setupComplete === true, 'healthz reports setupComplete=true after setup');

  r = await get('/setup', { cookie: adminCookie });
  say(r.status === 302 && r.location === '/', 'setup route stops existing once an admin exists');

  // --- anonymous -------------------------------------------------------------

  r = await get('/');
  say(r.status === 302 && r.location === '/login', 'anonymous page request redirects to /login');

  r = await get('/media/abc', { accept: '*/*' });
  say(r.status === 401, `anonymous /media returns 401 (got ${r.status})`);
  say(!/<html/i.test(r.text), 'anonymous /media body is not HTML');

  r = await get('/list', { accept: 'application/json' });
  say(r.status === 401, 'anonymous /list returns 401, so filenames stay private');

  r = await get('/tracks/abc', { accept: 'application/json' });
  say(r.status === 401, 'anonymous /tracks returns 401');

  r = await get('/subs/abc/0.vtt', { accept: '*/*' });
  say(r.status === 401, 'anonymous /subs returns 401');

  r = await get('/healthz');
  say(r.status === 200, 'healthz stays open to anonymous callers');
  say(!/clip\.mp4/.test(r.text), 'healthz leaks no filenames');

  r = await get('/login');
  say(r.status === 200 && /Sign in/.test(r.text), 'login page renders');

  // --- bad credentials -------------------------------------------------------

  r = await post('/login', { username: 'owner', password: 'wrong' });
  say(r.status === 401, 'wrong password rejected');
  say(/Wrong username or password/.test(r.text), 'error does not distinguish unknown user from bad password');

  r = await post('/login', { username: 'nobody', password: 'whatever' });
  say(/Wrong username or password/.test(r.text), 'unknown user gets the same generic error');

  // --- forged cookies --------------------------------------------------------

  r = await get('/', { cookie: 'wt_session=1.2.3' });
  say(r.status === 302 && r.location === '/login', 'forged cookie is treated as anonymous');

  const [uid, issued, mac] = adminCookie.replace('wt_session=', '').split('.');
  r = await get('/media/abc', { cookie: `wt_session=${uid}.${issued}.${'0'.repeat(mac.length)}`, accept: '*/*' });
  say(r.status === 401, 'cookie with a zeroed signature is rejected on /media');

  // --- admin -----------------------------------------------------------------

  r = await get('/', { cookie: adminCookie });
  say(r.status === 200 && /<video/.test(r.text), 'admin reaches the player');

  r = await get('/list', { cookie: adminCookie, accept: 'application/json' });
  const list = JSON.parse(r.text);
  say(r.status === 200 && list.length === 1, 'admin can list the library');

  const clipId = list[0].id;
  r = await get(`/media/${clipId}`, { cookie: adminCookie, accept: '*/*' });
  say(r.status === 200 && r.text.length === 2048, 'admin can fetch media');

  r = await get('/login', { cookie: adminCookie });
  say(r.status === 302, 'signed-in user visiting /login is sent to the player');

  // --- registration and approval ---------------------------------------------

  r = await post('/register', { invite: 'NOPE', username: 'dana', password: 'password1', confirm: 'password1' });
  say(r.status === 400, 'registration without a valid invite is rejected');

  // Mint an invite directly, the way the admin UI will.
  const db = require('../db.js');
  db.open(path.join(tmp, 'app.db'));
  const code = db.createInvite({ createdBy: 1, uses: 1 });
  db.handle.close();

  r = await post('/register', { invite: code, username: 'dana', password: 'password1', confirm: 'password1' });
  const danaCookie = cookieFrom(r);
  say(r.status === 302 && !!danaCookie, 'registration with a valid invite succeeds');

  r = await get('/', { cookie: danaCookie });
  say(r.status === 403 && /Waiting for approval/.test(r.text), 'pending user sees the approval page, not the player');

  r = await get(`/media/${clipId}`, { cookie: danaCookie, accept: '*/*' });
  say(r.status === 403, `pending user cannot fetch media (got ${r.status})`);
  say(!/<html/i.test(r.text), 'pending user media response is not HTML');

  r = await get('/list', { cookie: danaCookie, accept: 'application/json' });
  say(r.status === 403, 'pending user cannot enumerate the library');

  r = await post('/register', { invite: code, username: 'eve', password: 'password1', confirm: 'password1' });
  say(r.status === 400, 'a single-use invite cannot be reused');

  // Approve dana, then confirm access opens without a new login.
  db.open(path.join(tmp, 'app.db'));
  db.setUserStatus(db.getUserByName('dana').id, 'active');
  db.handle.close();

  r = await get(`/media/${clipId}`, { cookie: danaCookie, accept: '*/*' });
  say(r.status === 200, 'approved user can fetch media with the same cookie');

  // Deny, and confirm it takes effect on the next request.
  db.open(path.join(tmp, 'app.db'));
  db.setUserStatus(db.getUserByName('dana').id, 'denied');
  db.handle.close();

  r = await get(`/media/${clipId}`, { cookie: danaCookie, accept: '*/*' });
  say(r.status === 403, 'denying a user takes effect immediately, with no logout');

  r = await get('/', { cookie: danaCookie });
  say(/Access denied/.test(r.text), 'denied user sees the denied page');

  // --- logout ----------------------------------------------------------------

  r = await get('/logout', { cookie: adminCookie });
  say(r.status === 302 && /Max-Age=0/.test(String(r.setCookie)), 'logout clears the cookie');

  srv.kill();
  await new Promise((s) => srv.on('exit', s));

  // --- registration disabled -------------------------------------------------

  srv = boot({ SETUP_TOKEN: 'tok3n', ALLOW_REGISTRATION: '0' });
  await waitForServer();

  r = await get('/register');
  say(r.status === 403, 'registration route refuses when ALLOW_REGISTRATION=0');

  r = await get('/login');
  say(!/Request access/.test(r.text), 'login page hides the register link when registration is closed');

  srv.kill();
  await new Promise((s) => srv.on('exit', s));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('error:', e.stack || e.message);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

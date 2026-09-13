// Account management over the WebSocket: invites, approval, revocation.
//
// The important half of this file is the negative cases. Every admin command
// re-checks `ws.isHost` on the server, because the client-side UI is only a
// convenience — a viewer who unhides the button, or writes the frames by hand,
// must get nowhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8196;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-admin-'));
const MEDIA = path.join(tmp, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'clip.mp4'), Buffer.alloc(1024, 5));

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, url, { cookie, body, accept = 'text/html' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const headers = { accept };
    if (data) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.cookie = cookie;
    const req = http.request(`${BASE}${url}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () =>
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'], text })
      );
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const post = (url, body, cookie) => request('POST', url, { body, cookie });
const get = (url, cookie, accept) => request('GET', url, { cookie, accept });

// A socket that keeps every message it receives, so assertions can look back
// at what the server pushed rather than racing it.
function open(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?room=main`, { headers: { cookie } });
    const msgs = [];
    let closed = false;
    ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
    ws.on('close', () => { closed = true; });
    ws.on('open', () => setTimeout(() => resolve({
      ws,
      msgs,
      get closed() { return closed; },
      send: (o) => ws.send(JSON.stringify(o)),
      last: (type) => [...msgs].reverse().find((m) => m.type === type),
    }), 300));
    ws.on('error', () => resolve(null));
  });
}

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`${BASE}/healthz`, (r) => { r.resume(); resolve(); })
        .on('error', () => (--tries <= 0 ? reject(new Error('no server')) : setTimeout(tick, 100)));
    };
    tick();
  });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), MEDIA], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, SETUP_TOKEN: 'tok', ALLOW_REGISTRATION: '1' },
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();

  const setupRes = await post('/setup', {
    token: 'tok',
    username: 'owner',
    password: 'password1',
    confirm: 'password1',
  });
  const adminCookie = setupRes.setCookie[0].split(';')[0];

  const admin = await open(adminCookie);

  // The panel is useless if the admin has to ask for its contents.
  say(!!admin.last('admin'), 'admin receives account state on connect');
  say(admin.last('admin').invites.length === 0, 'a fresh deployment has no invite codes');
  say(admin.last('admin').users.length === 1, 'only the admin account exists at first');

  // Registration is impossible until an invite exists — the bug this replaced.
  let r = await post('/register', {
    username: 'nobody',
    password: 'password1',
    confirm: 'password1',
    invite: 'MADEUPCODE',
  });
  say(r.status === 400, 'registration is refused without a real invite code');

  // --- creating an invite ----------------------------------------------------

  admin.send({ type: 'admin:invite', uses: 3, days: 0 });
  await wait(300);
  const code = admin.last('admin').invites[0]?.code;
  say(typeof code === 'string' && code.length === 10, `admin:invite returns a code (${code})`);
  say(admin.last('admin').invites[0].usesRemaining === 3, 'invite carries the requested use count');

  // Absurd values must not produce a code nobody can spend.
  admin.send({ type: 'admin:invite', uses: 9999, days: -5 });
  await wait(300);
  const clamped = admin.last('admin').invites.find((i) => i.usesRemaining > 3);
  say(clamped && clamped.usesRemaining === 50, 'an oversized use count is clamped to 50');
  admin.send({ type: 'admin:revoke', code: clamped.code });
  await wait(200);

  // --- the invite link -------------------------------------------------------
  // The panel hands out /register?invite=CODE rather than a bare code, so the
  // form has to accept it from the query string and survive a failed submit.

  r = await get(`/register?invite=${code}`);
  say(
    new RegExp(`name="invite"[^>]*value="${code}"`).test(r.text),
    'an invite link prefills the code'
  );
  say(/name="username"[^>]*autofocus/.test(r.text), 'the link moves focus to the username');

  r = await post('/register', {
    username: 'x',
    password: 'short',
    confirm: 'short',
    invite: code,
  });
  say(
    new RegExp(`name="invite"[^>]*value="${code}"`).test(r.text),
    'a failed submit keeps the code in the box'
  );

  r = await get('/register?invite=' + encodeURIComponent('"><script>alert(1)</script>'));
  say(!r.text.includes('<script>alert(1)'), 'a crafted invite parameter is escaped');

  // --- registering and approving ---------------------------------------------

  r = await post('/register', {
    username: 'viewer1',
    password: 'password1',
    confirm: 'password1',
    invite: code,
  });
  say(r.status === 302, 'a viewer can register with a UI-created code');
  const viewerCookie = r.setCookie[0].split(';')[0];

  await wait(300);
  const pending = admin.last('admin').users.find((u) => u.username === 'viewer1');
  say(pending && pending.status === 'pending', 'the new registration is pushed to admins live');

  r = await get('/list', viewerCookie, 'application/json');
  say(r.status === 403, 'a pending viewer cannot read the library');

  admin.send({ type: 'admin:status', id: pending.id, status: 'active' });
  await wait(300);
  r = await get('/list', viewerCookie, 'application/json');
  say(r.status === 200, 'approving from the panel grants access immediately');

  // --- a viewer must not be able to drive any of this ------------------------

  const viewer = await open(viewerCookie);
  viewer.send({ type: 'admin:state' });
  viewer.send({ type: 'admin:invite', uses: 10 });
  viewer.send({ type: 'admin:status', id: pending.id, status: 'active' });
  await wait(400);
  say(!viewer.last('admin'), 'a viewer is never sent account state');
  say(admin.last('admin').invites.length === 1, 'a viewer cannot create an invite');

  // Wait for one stats tick to reach the viewer, then check what it carries.
  await wait(2200);
  const viewerStats = viewer.last('stats');
  say(!!viewerStats, 'a viewer receives room stats');
  say(!!viewerStats && viewerStats.server === undefined, 'a viewer never receives server vitals');
  say(
    !!viewerStats && Array.isArray(viewerStats.clients),
    'a viewer still sees who else is connected'
  );

  // Self-reported numbers are shown to other people, so they are clamped.
  viewer.send({ type: 'stat', rtt: 1e9, drift: 5, muted: false });
  await wait(2400);
  const clamped2 = admin.last('stats').clients.find((c) => c.name === 'viewer1');
  say(clamped2 && clamped2.rtt === 99999, 'an absurd self-reported latency is clamped');

  // --- revoking access closes the live socket --------------------------------

  admin.send({ type: 'admin:status', id: pending.id, status: 'denied' });
  await wait(500);
  say(viewer.closed, 'a revoked viewer is disconnected without waiting for a reload');
  r = await get('/list', viewerCookie, 'application/json');
  say(r.status === 403, 'a revoked viewer cannot read the library');

  // --- the stats sidebar -----------------------------------------------------
  // The machine's vitals are for whoever runs it. Viewers see the room.

  const adminStats = admin.last('stats');
  say(!!adminStats, 'stats are pushed to the room without being asked for');
  say(!!adminStats && !!adminStats.server, 'an admin receives the server vitals');
  say(
    !!adminStats &&
      typeof adminStats.server.cpu === 'number' &&
      typeof adminStats.server.mbpsOut === 'number',
    'the vitals carry cpu and throughput numbers'
  );
  say(
    !!adminStats && adminStats.clients.some((c) => c.name === 'owner' && c.host),
    'the client list names the host'
  );

  // --- one account, one browser ----------------------------------------------
  // Sessions are stateless cookies, so this is enforced by an epoch in the
  // signed payload rather than by deleting a row.

  const second = await post('/login', { username: 'owner', password: 'password1' });
  const secondCookie = second.setCookie[0].split(';')[0];
  r = await get('/list', secondCookie, 'application/json');
  say(r.status === 200, 'the newest login works');
  r = await get('/list', adminCookie, 'application/json');
  say(r.status === 401, 'logging in again invalidates the earlier session');

  // Everything below needs a working admin socket again.
  try { admin.ws.close(); } catch {}
  const admin2 = await open(secondCookie);

  // --- the log is readable from the UI, by admins only -----------------------

  admin2.send({ type: 'admin:log' });
  await wait(300);
  const logMsg = admin2.last('log');
  say(!!logMsg && Array.isArray(logMsg.lines), 'admin:log returns the buffered lines');
  say(
    !!logMsg && logMsg.lines.some((l) => /joined/.test(l.line)),
    'the log carries the join lines'
  );

  // The viewer from earlier was revoked, so make a fresh one to prove the log
  // is refused on role rather than on status.
  admin2.send({ type: 'admin:invite', uses: 1, days: 0 });
  await wait(300);
  const spyCode = admin2.last('admin').invites.find((i) => i.code !== code)?.code;
  r = await post('/register', {
    username: 'viewer3',
    password: 'password1',
    confirm: 'password1',
    invite: spyCode,
  });
  const spyCookie = r.setCookie[0].split(';')[0];
  await wait(200);
  const spyUser = admin2.last('admin').users.find((u) => u.username === 'viewer3');
  admin2.send({ type: 'admin:status', id: spyUser.id, status: 'active' });
  await wait(300);

  const spy = await open(spyCookie);
  spy.send({ type: 'admin:log' });
  await wait(300);
  say(!spy.last('log'), 'an active viewer still cannot read the log');
  try { spy.ws.close(); } catch {}

  // --- the last admin cannot lock everyone out -------------------------------

  const me = admin2.last('admin').users.find((u) => u.role === 'admin');
  admin2.send({ type: 'admin:delete', id: me.id });
  await wait(300);
  say(!!admin2.last('admin:error'), 'deleting the only admin is refused');
  admin2.send({ type: 'admin:status', id: me.id, status: 'denied' });
  await wait(300);
  say(
    admin2.last('admin').users.find((u) => u.id === me.id).status === 'active',
    'the only admin cannot revoke themselves'
  );

  // --- revoking an invite ----------------------------------------------------

  admin2.send({ type: 'admin:revoke', code });
  await wait(300);
  say(admin2.last('admin').invites.length === 0, 'a revoked code disappears from the list');
  r = await post('/register', {
    username: 'viewer2',
    password: 'password1',
    confirm: 'password1',
    invite: code,
  });
  say(r.status === 400, 'a revoked code no longer registers anyone');

  // --- deleting a user -------------------------------------------------------

  admin2.send({ type: 'admin:delete', id: pending.id });
  await wait(300);
  say(
    !admin2.last('admin').users.some((u) => u.username === 'viewer1'),
    'a deleted user is gone from the list'
  );

  try { admin2.ws.close(); } catch {}
  srv.kill();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();

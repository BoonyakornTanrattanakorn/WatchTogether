// The WebSocket handshake must enforce the same rules as the HTTP gate, and
// identity must come from the session rather than the query string.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8194;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ws-'));
const MEDIA = path.join(tmp, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'clip.mp4'), Buffer.alloc(1024, 3));

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

function post(url, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(data),
      accept: 'text/html',
    };
    if (cookie) headers.cookie = cookie;
    const req = http.request(`${BASE}${url}`, { method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'], text }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Try to open a socket. Resolves with what happened rather than throwing, so
// the refusal cases read as assertions.
function tryConnect(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?room=main`, {
      headers: cookie ? { cookie } : {},
    });
    const done = (result) => {
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.on('unexpected-response', (_req, res) => done({ ok: false, status: res.statusCode }));
    ws.on('error', (e) => done({ ok: false, error: e.message }));
    ws.on('message', (raw) => done({ ok: true, first: JSON.parse(raw) }));
    setTimeout(() => done({ ok: false, error: 'timeout' }), 3000);
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

  // Before setup, every socket is refused regardless of who is asking.
  let r = await tryConnect(null);
  say(!r.ok && r.status === 403, `websocket refused before setup (${r.status || r.error})`);

  // Set up the admin.
  const setupRes = await post('/setup', {
    token: 'tok',
    username: 'owner',
    password: 'password1',
    confirm: 'password1',
  });
  const adminCookie = setupRes.setCookie[0].split(';')[0];

  // Now that setup is done, an anonymous socket is an auth failure proper.
  r = await tryConnect(null);
  say(!r.ok && r.status === 401, `anonymous websocket refused with 401 (${r.status || r.error})`);

  r = await tryConnect('wt_session=1.2.deadbeef');
  say(!r.ok && r.status === 401, 'forged cookie websocket refused with 401');

  r = await tryConnect(adminCookie);
  say(r.ok, 'admin websocket connects');
  say(r.first && r.first.you && r.first.you.host === true, 'admin is told they control playback');

  // A pending user must not be admitted to the room at all.
  const db = require('../db.js');
  db.open(path.join(tmp, 'app.db'));
  const code = db.createInvite({ createdBy: 1, uses: 1 });
  db.handle.close();

  const reg = await post('/register', {
    invite: code,
    username: 'dana',
    password: 'password1',
    confirm: 'password1',
  });
  const danaCookie = reg.setCookie[0].split(';')[0];

  r = await tryConnect(danaCookie);
  say(!r.ok, `pending user websocket refused (${r.status || r.error})`);
  say(r.status === 403, 'pending user refused with 403');

  db.open(path.join(tmp, 'app.db'));
  db.setUserStatus(db.getUserByName('dana').id, 'active');
  db.handle.close();

  r = await tryConnect(danaCookie);
  say(r.ok, 'approved user websocket connects');
  say(r.first && r.first.you && r.first.you.host === false, 'viewer is told they do not control playback');

  // Identity comes from the session: a spoofed ?name= must be ignored.
  const spoof = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?room=main&name=owner&key=anything`, {
      headers: { cookie: danaCookie },
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      try { ws.close(); } catch {}
      resolve(m);
    });
    ws.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
  say(spoof && spoof.you.host === false, 'a spoofed ?key= does not grant control');

  db.open(path.join(tmp, 'app.db'));
  db.setUserStatus(db.getUserByName('dana').id, 'denied');
  db.handle.close();

  r = await tryConnect(danaCookie);
  say(!r.ok, 'denied user websocket refused on the next connect');

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

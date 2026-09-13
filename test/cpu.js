// Encoder lifetime: how many ffmpeg processes exist, and whether they stop.
//
// This began as the suite for a specific complaint — three encoders at once,
// and CPU still burning with nothing playing — from the days when a request
// for an unplayable file started an encoder. Encoding is explicit now, so the
// cases have changed, but the reason for counting processes has not: every
// other suite checks what a route returns rather than what is left running
// afterwards, and an encoder that never stops passes all of them.
//
// What must hold now: nothing encodes unless an admin asked for it, only one
// encoder runs however much is queued, cancelling actually kills the process,
// and a killed encode does not leave a part-written file that would later play
// as a truncated film.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const PORT = 8199;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cpu-'));
const MEDIA = path.join(tmp, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

// Long enough that an encode cannot finish while we are watching it: the whole
// point is to observe processes mid-flight.
let have = false;
const started = Date.now();
try {
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=600',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p10le',
    path.join(MEDIA, 'big.mkv'), '-y',
  ], { stdio: 'ignore', timeout: 120000 });
  have = fs.existsSync(path.join(MEDIA, 'big.mkv'));
} catch {}
if (!have) {
  console.log('note: no ffmpeg/libx265, skipping the encoder-lifetime checks');
  process.exit(0);
}
// A second file to queue behind the first, so "one at a time" has something to
// be true about. A copy rather than a second encode: the id is a hash of the
// path, so the same bytes under a different name are two library entries — and
// encoding ten more minutes of 1080p to prove it would double the test's
// runtime for nothing.
fs.copyFileSync(path.join(MEDIA, 'big.mkv'), path.join(MEDIA, 'big2.mkv'));

// Some sandboxes stub ffmpeg: it exits 0 immediately without encoding. Every
// assertion below counts running encoders, so against a stub they would all
// pass while proving nothing. Refuse to report a pass we did not earn.
const elapsed = Date.now() - started;
const size = fs.statSync(path.join(MEDIA, 'big.mkv')).size;
if (elapsed < 1000 || size < 10000) {
  console.log(
    `note: ffmpeg encoded 90s of video in ${elapsed}ms to ${size} bytes — it is ` +
      'not really encoding here, so the encoder-lifetime checks cannot run.'
  );
  console.log('SKIPPED (unverified)');
  process.exit(0);
}

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Count ffmpeg children of the server. Counting every ffmpeg on the machine
// would pick up unrelated ones, so this asks for children of our pid.
function encoders(serverPid) {
  try {
    if (process.platform === 'win32') {
      // @(...) so a single match still has a .Count; without it PowerShell
      // returns the object itself and this reads as 0.
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.ParentProcessId -eq ${serverPid} }).Count`],
        { encoding: 'utf8' });
      return Number(out.trim()) || 0;
    }
    const out = execFileSync('pgrep', ['-P', String(serverPid), 'ffmpeg'], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

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
      res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'], text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${BASE}/healthz`, (r) => { r.resume(); resolve(); })
        .on('error', () => (--tries <= 0 ? reject(new Error('no server')) : setTimeout(tick, 100)));
    };
    tick();
  });
}


(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), MEDIA], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, SETUP_TOKEN: 'tok' },
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();

  const setupRes = await request('POST', '/setup', {
    body: { token: 'tok', username: 'owner', password: 'password1', confirm: 'password1' },
  });
  const cookie = setupRes.setCookie[0].split(';')[0];

  const files = JSON.parse(
    (await request('GET', '/list', { cookie, accept: 'application/json' })).text
  );
  const big = files.find((f) => f.name === 'big.mkv');
  const big2 = files.find((f) => f.name === 'big2.mkv');

  const ws = new WebSocket(`ws://localhost:${PORT}/?room=main`, { headers: { cookie } });
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
  const last = (type) => [...msgs].reverse().find((m) => m.type === type);
  await new Promise((r) => ws.on('open', () => setTimeout(r, 300)));

  // --- playing an unconvertable file encodes nothing --------------------------
  // This is the change the whole redesign turns on. Loading and requesting an
  // HEVC file used to start an encoder; now it must start nothing at all.

  ws.send(JSON.stringify({ type: 'load', src: big.id }));
  await wait(500);
  const hit = await request('GET', `/transcode/${big.id}`, { cookie });
  await wait(1500);
  const afterRequest = encoders(srv.pid);
  say(hit.status === 409, `an unconverted file is refused rather than encoded (${hit.status})`);
  say(afterRequest === 0, `playing an unconverted file starts no encoder (${afterRequest})`);

  // --- one encoder, however much is queued ------------------------------------
  // Two encoders on a machine that is also serving video is how playback starts
  // stuttering for everyone, so the queue runs strictly one at a time.

  ws.send(JSON.stringify({ type: 'encode:queue', id: big.id }));
  await wait(300);
  ws.send(JSON.stringify({ type: 'encode:queue', id: big2.id }));
  await wait(3000);
  const running = encoders(srv.pid);
  say(running === 1, `two queued files run one encoder, not two (${running})`);

  const state = last('encode');
  const statuses = (state?.items || []).map((i) => i.status).sort().join(',');
  say(statuses === 'encoding,queued', `the second file waits its turn (${statuses})`);

  // Progress is what makes the panel worth looking at rather than a spinner.
  await wait(4000);
  const enc = (last('encode')?.items || []).find((i) => i.status === 'encoding');
  say(!!enc && enc.percent > 0, `the running encode reports progress (${enc && enc.percent?.toFixed(1)}%)`);

  // --- cancelling actually kills it -------------------------------------------
  // The queue row going away while ffmpeg carries on is exactly the failure
  // this suite exists to catch.

  ws.send(JSON.stringify({ type: 'encode:cancel', id: big.id }));
  await wait(2500);
  const afterCancel = encoders(srv.pid);
  // The second file takes over, so one encoder is the right answer — but it
  // must be a different one, not the cancelled job still running.
  say(afterCancel <= 1, `cancelling does not leave both running (${afterCancel})`);
  const rows = (last('encode')?.items || []).map((i) => i.id);
  say(!rows.includes(big.id), 'a cancelled file is off the queue');

  ws.send(JSON.stringify({ type: 'encode:cancel', id: big2.id }));
  await wait(2500);
  const afterAll = encoders(srv.pid);
  say(afterAll === 0, `cancelling the last queued file stops encoding (${afterAll})`);

  // --- a killed encode leaves nothing that looks finished ---------------------
  // A part-written file served as if it were whole plays as a truncated film,
  // which is a worse failure than not having it at all.

  const dir = path.join(tmp, 'transcoded');
  const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  say(
    !left.some((f) => f.endsWith('.part')),
    `a cancelled encode cleans up its partial file (${left.join(', ') || 'nothing left'})`
  );
  say(
    !left.some((f) => f.endsWith('.done')),
    'a cancelled encode is never marked finished'
  );

  // --- an empty room does not stop work the host asked for --------------------
  // The opposite of the old rule. A background encode used to be cancelled when
  // the room emptied, because it only existed to serve someone who was waiting.
  // A queued encode is work requested ahead of time, and an empty room is when
  // it should be getting on with it.

  ws.send(JSON.stringify({ type: 'encode:queue', id: big.id }));
  await wait(3000);
  const beforeClose = encoders(srv.pid);
  ws.close();
  await wait(3000);
  const afterClose = encoders(srv.pid);
  say(beforeClose === 1, `the queued encode is running (${beforeClose})`);
  say(afterClose === 1, `an empty room does not cancel a queued encode (${afterClose})`);

  srv.kill();
  await wait(500);
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();

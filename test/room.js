// Room behaviour that is not about access: what happens when someone arrives,
// leaves, or drops, and whether a track choice survives to the next viewing.
//
// The distinction that matters here is deliberate-leave versus dropped: one
// should stop the film for everyone, the other should not.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8198;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-room-'));
const MEDIA = path.join(tmp, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
// Two files, so a per-file preference can be told apart from a global one.
fs.writeFileSync(path.join(MEDIA, 'one.mp4'), Buffer.alloc(2048, 1));
fs.writeFileSync(path.join(MEDIA, 'two.mp4'), Buffer.alloc(2048, 2));

// A genuinely unplayable file, for the codec detection. ffmpeg is optional
// everywhere else in this project, so its absence skips these rather than
// failing the suite.
let hevcFile = false;
try {
  require('child_process').execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=2',
     '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p10le',
     path.join(MEDIA, 'hevc.mkv'), '-y'],
    { stdio: 'ignore', timeout: 30000 }
  );
  hevcFile = fs.existsSync(path.join(MEDIA, 'hevc.mkv'));
} catch {
  console.log('note: no ffmpeg/libx265, skipping the codec-detection checks');
}

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

function open(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?room=main`, { headers: { cookie } });
    const msgs = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
    ws.on('open', () => setTimeout(() => resolve({
      ws,
      msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      last: (type) => [...msgs].reverse().find((m) => m.type === type),
      all: (type) => msgs.filter((m) => m.type === type),
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

  // A viewer to arrive and leave.
  admin.send({ type: 'admin:invite', uses: 5, days: 0 });
  await wait(300);
  const code = admin.last('admin').invites[0].code;
  let r = await post('/register', {
    username: 'guest',
    password: 'password1',
    confirm: 'password1',
    invite: code,
  });
  const guestCookie = r.setCookie[0].split(';')[0];
  const guest = admin.last('admin').users.find((u) => u.username === 'guest');
  admin.send({ type: 'admin:status', id: guest.id, status: 'active' });
  await wait(300);

  // --- arriving and leaving are announced ------------------------------------

  const g1 = await open(guestCookie);
  await wait(400);
  say(
    admin.all('notice').some((n) => n.kind === 'join' && /guest/.test(n.text)),
    'a join is announced to the room'
  );

  const files = JSON.parse((await get('/list', adminCookie, 'application/json')).text);
  const one = files.find((f) => f.name === 'one.mp4');
  const two = files.find((f) => f.name === 'two.mp4');

  admin.send({ type: 'load', src: one.id });
  await wait(300);
  admin.send({ type: 'control', paused: false, time: 5 });
  // A resume is scheduled rather than applied immediately (see mistakes.md
  // #9 / architecture.md's Sync section) — the room reports paused:true with
  // a playAt for PLAY_LEAD_MS before it actually starts, so a check right
  // after sending 'control' has to look for the schedule, not the play.
  await wait(150);
  say(
    admin.last('state').paused === true && Number.isFinite(admin.last('state').playAt),
    'a resume is scheduled rather than applied immediately'
  );
  await wait(700);
  say(admin.last('state').paused === false, 'the room is playing once the schedule fires');

  // --- a dropped connection stops the film -----------------------------------

  g1.ws.terminate(); // no close frame: exactly how a lost connection looks
  await wait(800);
  say(admin.last('state').paused === true, 'the room pauses when a viewer drops');
  const drop = admin.all('notice').find((n) => n.kind === 'drop');
  say(!!drop, 'the pause is explained by a notice');
  say(
    !!drop && /guest/.test(drop.text) && /connection/i.test(drop.text),
    'the notice names who dropped and why'
  );

  // --- a deliberate leave does not --------------------------------------------

  const g2 = await open(guestCookie);
  await wait(300);
  admin.send({ type: 'control', paused: false, time: 6 });
  await wait(850); // past PLAY_LEAD_MS, so the schedule has fired
  g2.send({ type: 'bye' });
  await wait(150);
  g2.ws.close();
  await wait(800);
  say(admin.last('state').paused === false, 'closing a tab on purpose does not pause the room');
  say(
    admin.all('notice').some((n) => n.kind === 'leave'),
    'a plain leave notice is sent instead'
  );

  // --- the sidebar is the host's ---------------------------------------------
  // The layout itself is CSS, so what is checked here is the rule that drives
  // it: the server must tell each side which they are.

  // `you` rides on the first state message only, so look at that one rather
  // than the newest.
  const hostState = admin.all('state').find((m) => m.you);
  say(!!hostState && hostState.you.host === true, 'an admin is told they are the host');
  const g3 = await open(guestCookie);
  await wait(300);
  const guestState = g3.all('state').find((m) => m.you);
  say(
    !!guestState && guestState.you.host === false,
    'a viewer is told they are not, which is what hides the sidebar'
  );
  try { g3.ws.close(); } catch {}
  await wait(400);

  // --- unplayable files are named, not just failed ---------------------------
  // The browser reports a missing codec as MEDIA_ERR_NETWORK, which sends
  // everyone looking at the tunnel. The server reads the codecs instead.

  const probe = JSON.parse((await get(`/tracks/${one.id}`, adminCookie, 'application/json')).text);
  say('play' in probe, 'the probe reports whether a file is playable');

  // A real HEVC file, if ffmpeg can make one. Skipped rather than failed where
  // it cannot: the detection is worth testing, the encoder is not a dependency.
  if (hevcFile) {
    const list2 = JSON.parse((await get('/list', adminCookie, 'application/json')).text);
    const hv = list2.find((f) => f.name === 'hevc.mkv');
    if (hv) {
      const hp = JSON.parse((await get(`/tracks/${hv.id}`, adminCookie, 'application/json')).text);
      say(hp.play && hp.play.ok === false, 'an HEVC file is reported unplayable');
      say(
        hp.play && /HEVC/i.test(hp.play.reasons[0]?.text || ''),
        'the reason names HEVC rather than saying "network error"'
      );
      say(hp.video && hp.video.codec === 'hevc', 'the probe reports the video codec');
      say(hp.duration > 1, `the probe reports the source duration (${hp.duration}s)`);

      // --- the encode queue --------------------------------------------------
      // Encoding is no longer something playback sets off: nothing is
      // converted until an admin asks for it. So an unconverted file is a
      // refusal with a distinguishable status, not a live ffmpeg pipe.

      const before = await new Promise((resolve) => {
        http.get(
          `${BASE}/transcode/${hv.id}`,
          { headers: { cookie: adminCookie } },
          (res) => { res.resume(); resolve(res.statusCode); }
        ).on('error', () => resolve(0));
      });
      say(before === 409, `an unconverted file is refused, not encoded on demand (${before})`);

      // A viewer must not be able to start work on the server.
      const g4 = await open(guestCookie);
      g4.send({ type: 'encode:queue', id: hv.id });
      await wait(400);
      say(!g4.last('encode'), 'a viewer is never sent the encode queue');
      try { g4.ws.close(); } catch {}

      admin.send({ type: 'encode:state' });
      await wait(300);
      say(!!admin.last('encode'), 'an admin can read the encode queue');

      admin.send({ type: 'encode:queue', id: hv.id });
      await wait(600);
      const queued = admin.last('encode');
      const row = queued && queued.items.find((i) => i.id === hv.id);
      say(!!row, 'queueing a file puts it on the list');
      // A two-second test clip can be through the encoder before this check
      // runs, so 'done' is as valid an answer as 'queued' here. What is being
      // tested is that the file reached the queue in a state it recognises —
      // not how fast the machine is.
      say(
        row && ['queued', 'encoding', 'done'].includes(row.status),
        `the queued file has a known status (${row && row.status})`
      );

      // Asking twice is a double-click, not a request for two encodes.
      admin.send({ type: 'encode:queue', id: hv.id });
      await wait(400);
      const again = admin.last('encode');
      say(
        again.items.filter((i) => i.id === hv.id).length === 1,
        'queueing the same file twice does not queue it twice'
      );

      // The encode runs to completion and the result is an ordinary file.
      let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        await wait(1000);
        admin.send({ type: 'encode:state' });
        await wait(200);
        const st = admin.last('encode');
        const r = st && st.items.find((x) => x.id === hv.id);
        if (r && r.status === 'failed') {
          say(false, `the encode failed: ${r.error}`);
          break;
        }
        done = !!(r && r.status === 'done');
      }
      say(done, 'the queued file finishes encoding');

      if (done) {
        const after = await new Promise((resolve) => {
          http.get(
            `${BASE}/transcode/${hv.id}`,
            { headers: { cookie: adminCookie } },
            (res) => {
              let n = 0;
              res.on('data', (d) => { n += d.length; });
              res.on('end', () => resolve({ status: res.statusCode, n, type: res.headers['content-type'] }));
              res.on('error', () => resolve({ status: 0, n }));
            }
          ).on('error', () => resolve({ status: 0, n: 0 }));
        });
        say(after.status === 200 && after.n > 1000, `the converted file is served (${after.n} bytes)`);
        say(after.type === 'video/mp4', 'the converted file is served as video/mp4');

        // The whole point of encoding ahead of time: a real file, so the
        // browser can seek in it by byte range.
        const ranged = await new Promise((resolve) => {
          http.get(
            `${BASE}/transcode/${hv.id}`,
            { headers: { cookie: adminCookie, range: 'bytes=0-499' } },
            (res) => { res.resume(); resolve(res.statusCode); }
          ).on('error', () => resolve(0));
        });
        say(ranged === 206, 'the converted file answers byte ranges, so seeking is real');

        const t3 = JSON.parse((await get(`/tracks/${hv.id}`, adminCookie, 'application/json')).text);
        say(t3.cached === true, 'the probe reports the file as converted');

        // Clearing the list is about the list, not the file on disk.
        admin.send({ type: 'encode:clear' });
        await wait(400);
        const cleared = admin.last('encode');
        say(
          !cleared.items.some((i) => i.id === hv.id),
          'clearing finished rows removes them from the queue'
        );
        const still = await new Promise((resolve) => {
          http.get(
            `${BASE}/transcode/${hv.id}`,
            { headers: { cookie: adminCookie } },
            (res) => { res.resume(); resolve(res.statusCode); }
          ).on('error', () => resolve(0));
        });
        say(still === 200, 'clearing the list does not delete the converted file');

        // --- orphans ---------------------------------------------------------
        // A converted file whose source has gone — deleted, moved, or
        // MEDIA_DIRS reordered, which changes every id. Nothing will ever ask
        // for it again and it counts against the disk budget, so the panel
        // has to be able to see and remove it.

        admin.send({ type: 'encode:state' });
        await wait(400);
        say(
          (admin.last('encode').orphans || []).length === 0,
          'a converted file still in the library is not an orphan'
        );

        // Make one, by giving a real encode an id the library does not know.
        const cacheDir = path.join(tmp, 'transcoded');
        fs.copyFileSync(path.join(cacheDir, `${hv.id}.mp4`), path.join(cacheDir, 'deadbeef99.mp4'));
        fs.writeFileSync(path.join(cacheDir, 'deadbeef99.mp4.done'), '');
        admin.send({ type: 'encode:state' });
        await wait(500);
        const orphans = admin.last('encode').orphans || [];
        say(
          orphans.length === 1 && orphans[0].id === 'deadbeef99',
          `a conversion with no library entry is reported as an orphan (${orphans.length})`
        );
        say(orphans[0] && orphans[0].size > 0, 'the orphan reports its size');

        // Deleting one that is still in the library must be refused, or this
        // becomes a way to delete the film everyone is about to watch.
        admin.send({ type: 'encode:forget', id: hv.id });
        await wait(400);
        say(!!admin.last('encode:error'), 'deleting a conversion still in the library is refused');
        say(
          fs.existsSync(path.join(cacheDir, `${hv.id}.mp4`)),
          'the refused delete left the file alone'
        );

        admin.send({ type: 'encode:forget', id: 'deadbeef99' });
        await wait(600);
        say(
          (admin.last('encode').orphans || []).length === 0,
          'deleting an orphan removes it from the list'
        );
        say(
          !fs.existsSync(path.join(cacheDir, 'deadbeef99.mp4')) &&
            !fs.existsSync(path.join(cacheDir, 'deadbeef99.mp4.done')),
          'deleting an orphan removes the file and its marker'
        );

        // A viewer must not be able to delete anything.
        const g5 = await open(guestCookie);
        fs.copyFileSync(path.join(cacheDir, `${hv.id}.mp4`), path.join(cacheDir, 'deadbeef98.mp4'));
        fs.writeFileSync(path.join(cacheDir, 'deadbeef98.mp4.done'), '');
        g5.send({ type: 'encode:forget', id: 'deadbeef98' });
        await wait(600);
        say(
          fs.existsSync(path.join(cacheDir, 'deadbeef98.mp4')),
          'a viewer cannot delete a conversion'
        );
        try { g5.ws.close(); } catch {}
      }
    }
  }

  // --- track choices are remembered per file ----------------------------------

  admin.send({ type: 'tracks', audio: 1, sub: 2 });
  await wait(300);
  say(admin.last('state').sub === 2, 'a subtitle choice applies to the room');

  admin.send({ type: 'load', src: two.id });
  await wait(300);
  say(
    admin.last('state').sub === -1 && admin.last('state').audio === 0,
    'a different file starts from its own defaults'
  );

  admin.send({ type: 'load', src: one.id });
  await wait(300);
  say(
    admin.last('state').sub === 2 && admin.last('state').audio === 1,
    'returning to a file restores the remembered choice'
  );

  // It has to survive a restart, or "persistent" means nothing.
  srv.kill();
  await wait(600);
  const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), MEDIA], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, SETUP_TOKEN: 'tok', ALLOW_REGISTRATION: '1' },
  });
  srv2.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();

  const again = await open(adminCookie);
  again.send({ type: 'load', src: one.id });
  await wait(400);
  say(
    again.last('state').sub === 2 && again.last('state').audio === 1,
    'the remembered choice survives a server restart'
  );

  try { again.ws.close(); } catch {}
  srv2.kill();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();

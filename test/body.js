// Regression test for the readBody() UTF-8 chunk-boundary bug.
//
// `body += chunk` used to coerce each Buffer chunk to UTF-8 independently, so
// a multi-byte character split across a TCP read was decoded as two invalid
// halves on either side of the split. Over a normal LAN a chunk is usually
// the whole small POST body in one read, so this passed unnoticed for years;
// a VPN changes MTU and timing enough that the split lands mid-character
// often enough to make logins fail intermittently, which read as "I can't
// log in over the VPN" rather than as an encoding bug. It corrupted
// usernames and invite codes the same way.
//
// http.request() (used by the other tests) will not reproduce this: Node's
// own client either sends small bodies in one write or the kernel coalesces
// them before the server ever sees two 'data' events. So this file talks to
// the server with a raw net.Socket and forces the split by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8199;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-body-'));
const MEDIA = path.join(tmp, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`http://localhost:${PORT}/healthz`, (r) => { r.resume(); resolve(); })
        .on('error', () => (--tries <= 0 ? reject(new Error('no server')) : setTimeout(tick, 100)));
    };
    tick();
  });
}

// --- a POST whose body is written in two separate socket writes ------------
//
// `splitAt` is a byte offset into the encoded body. Writing it in two pieces
// with a real delay between them is the only way to force the server's
// 'data' handler to fire twice for one request — everything built on
// http.request sends bodies this small in a single write.
function splitPost(url, body, { splitAt, delayMs = 50, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const at = splitAt == null ? bodyBuf.length : Math.max(0, Math.min(bodyBuf.length, splitAt));

    const headerLines = [
      `POST ${url} HTTP/1.1`,
      'Host: localhost',
      'Content-Type: application/x-www-form-urlencoded',
      `Content-Length: ${bodyBuf.length}`,
      'Connection: close',
    ];
    if (cookie) headerLines.push(`Cookie: ${cookie}`);
    headerLines.push('', '');
    const head = Buffer.from(headerLines.join('\r\n'), 'utf8');

    const sock = net.connect(PORT, '127.0.0.1', () => {
      // Nagle would happily merge two small writes back into one TCP segment,
      // which would defeat the whole point of splitting the body.
      sock.setNoDelay(true);
      sock.write(Buffer.concat([head, bodyBuf.subarray(0, at)]), () => {
        setTimeout(() => {
          sock.write(bodyBuf.subarray(at), () => {});
        }, delayMs);
      });
    });

    let raw = Buffer.alloc(0);
    sock.on('data', (d) => { raw = Buffer.concat([raw, d]); });
    sock.on('error', reject);
    sock.on('close', () => {
      const text = raw.toString('utf8');
      const [statusLine, ...rest] = text.split('\r\n');
      const status = Number((/HTTP\/1\.[01] (\d+)/.exec(statusLine) || [])[1]) || 0;
      const headerBlock = text.slice(0, text.indexOf('\r\n\r\n'));
      const setCookie = headerBlock
        .split('\r\n')
        .find((l) => /^set-cookie:/i.test(l));
      resolve({
        status,
        setCookie: setCookie ? setCookie.slice(setCookie.indexOf(':') + 1).trim() : null,
        text,
      });
    });
  });
}

// A strict browser <form> submit percent-encodes every non-ASCII byte, which
// makes the wire body pure ASCII — and a body with no multi-byte bytes in it
// can never be split mid-character, so that path can never hit this bug.
// URLSearchParams (used on both ends of a real browser round trip, and by
// readBody() here) is lenient about raw non-ASCII bytes in a form body, and
// plenty of real callers exploit that leniency: hand-rolled fetch() bodies,
// curl scripts, mobile clients — anything that interpolates a value into
// `k=v&k=v` without routing it through encodeURIComponent first. That is the
// actual population this bug hurt, so the test has to send bodies the same
// way: raw UTF-8 for the value, with only the wire-structural characters
// (&, =, %, and stray whitespace) escaped so the body still parses as the
// single field intended.
const escapeStructural = (v) =>
  String(v).replace(/[%&=\r\n]/g, (c) => encodeURIComponent(c));
const form = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${escapeStructural(k)}=${escapeStructural(v)}`)
    .join('&');

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), MEDIA], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, SETUP_TOKEN: 'tok', ALLOW_REGISTRATION: '1' },
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();

  // A password with 2-byte, 3-byte and 4-byte UTF-8 characters, so a split
  // anywhere in the string exercises every width a boundary can fall inside.
  const PASSWORD = 'pässwörd-日本語-🎬-123';

  // --- setup, with the body split partway through -----------------------------

  const setupBody = form({ token: 'tok', username: 'owner', password: PASSWORD, confirm: PASSWORD });
  const setupSplit = Math.floor(Buffer.byteLength(setupBody, 'utf8') / 2);
  const setupRes = await splitPost('/setup', setupBody, { splitAt: setupSplit });
  say(setupRes.status === 302 && !!setupRes.setCookie, 'setup succeeds with the body split mid-request');

  // --- the core assertion: every possible split point still logs in ----------
  // If any single byte offset decodes the password wrong, that offset is
  // exactly where a VPN-sized MTU would put the boundary for someone unlucky
  // enough to have a multi-byte character there.

  const loginBody = form({ username: 'owner', password: PASSWORD });
  const total = Buffer.byteLength(loginBody, 'utf8');
  let ok = 0;
  const failures = [];
  for (let at = 1; at < total; at++) {
    const r = await splitPost('/login', loginBody, { splitAt: at });
    if (r.status === 302) {
      ok++;
    } else {
      failures.push({ at, status: r.status });
    }
  }
  say(
    ok === total - 1,
    `login succeeds at every split point (${ok}/${total - 1})` +
      (failures.length
        ? ` — first failures: ${failures.slice(0, 5).map((f) => `${f.at}:${f.status}`).join(', ')}`
        : '')
  );

  // --- the byte cap still rejects an oversized body ---------------------------
  // readBody() resolves null once the running byte count passes the limit, and
  // /login treats a missing username/password as a plain wrong-credentials
  // 401 — there is no separate "body too large" status. That is the real,
  // observed behaviour, not an assumption: worth pinning down explicitly so a
  // future change to either the cap or the error path is noticed here.
  const oversized = `username=owner&password=${'x'.repeat(9 * 1024)}`;
  const bigRes = await splitPost('/login', oversized, { splitAt: 4000 });
  say(bigRes.status === 401, `a body over the byte cap is rejected, not accepted (got ${bigRes.status})`);

  // --- a non-ASCII username is rejected consistently, not sometimes ----------
  // Usernames are validated against /^[\w.-]{2,24}$/, which non-ASCII letters
  // fail regardless of the UTF-8 bug. What the bug could have done is make
  // that rejection depend on where the chunk boundary landed — accepted at
  // some split points, rejected at others, because the corrupted bytes
  // sometimes happened to still match the regex. So the property to check
  // isn't "is it rejected" (it always should be) but "is it rejected THE SAME
  // WAY every time".
  const badUser = 'üser日本';
  const registerBody = form({
    invite: 'no-such-code',
    username: badUser,
    password: 'password1',
    confirm: 'password1',
  });
  // Each rejected attempt also counts against the login rate limiter (it
  // shares recordFailure with /login and /setup), so this stays under
  // MAX_ATTEMPTS rather than tripping into 429 territory, which would be a
  // rate-limit artifact, not a signal about the UTF-8 fix.
  const rTotal = Buffer.byteLength(registerBody, 'utf8');
  const stride = Math.max(1, Math.ceil((rTotal - 1) / 3));
  let badUserStatuses = new Set();
  for (let at = 1; at < rTotal; at += stride) {
    const r = await splitPost('/register', registerBody, { splitAt: at });
    badUserStatuses.add(r.status);
  }
  say(
    badUserStatuses.size === 1 && badUserStatuses.has(400),
    `a non-ASCII username is rejected the same way at every split point (statuses seen: ${[...badUserStatuses]})`
  );

  srv.kill();
  await new Promise((s) => srv.on('exit', s));
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('error:', e.stack || e.message);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

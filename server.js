// Watch-together server: static files + WebSocket sync.
//
//   npm install ws
//   node server.js ~/Videos /mnt/nas/tv "D:/films/Heat (1995).mkv"
//   node server.js -r ~/Videos          # also scan subfolders
//
// Pass any mix of files and directories. Only the top level of each directory
// is scanned unless you pass -r. With no arguments it scans the current
// directory.
// Then point your Cloudflare tunnel ingress at http://localhost:8090

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db.js');
const auth = require('./auth.js');
const pages = require('./pages.js');

// --- .env --------------------------------------------------------------------
// Read alongside server.js. Real environment variables win, so a systemd unit
// or a one-off `HOST_KEY=... node server.js` still overrides the file. Kept to
// a few lines on purpose: the point of this project is that it runs with no
// dependencies beyond ws.
function loadEnv() {
  let text;
  try {
    text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return; // no .env is the normal case
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so paths with spaces can be quoted.
    if (val.length > 1 && (val[0] === '"' || val[0] === "'") && val.at(-1) === val[0]) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = process.env.PORT || 8090;
const MAX_DEPTH = 6; // only applies with -r

// Where users, invites and settings live. A bind mount in the container; a
// local folder in development.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Guards first-run setup, so whoever finds the hostname first cannot claim the
// admin account. When it is unset on a first run we mint one below and print it
// at startup, so an unconfigured server is never open to whoever reaches /setup
// first. Once an admin exists the token is moot and stays empty.
let SETUP_TOKEN = process.env.SETUP_TOKEN || '';
let SETUP_TOKEN_GENERATED = false;

// Registration can be closed entirely for a fixed group. Even when open, it
// needs an invite code and an admin's approval.
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== '0';

// --- logging -----------------------------------------------------------------
// VERBOSE=1 (or --verbose) logs every request and every room event. Range
// requests are the noisy part and also the interesting part when playback
// misbehaves, so they are only shown at this level.
const VERBOSE = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

function ts() {
  return new Date().toISOString().slice(11, 23);
}

// A ring buffer of recent lines, so the admin can read the log from the web UI
// without shell access. Deliberately small and in-memory: this is for "what
// just happened", not an audit trail.
const LOG_KEEP = 400;
const logBuffer = [];
let logSeq = 0;

// Set once the websocket layer exists; until then lines are only buffered.
let onLogLine = null;

function remember(line) {
  const entry = { n: ++logSeq, t: Date.now(), line };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_KEEP) logBuffer.shift();
  if (onLogLine) onLogLine(entry);
}

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  remember(line);
  console.log(ts(), ...a);
}

function vlog(...a) {
  if (VERBOSE) console.log(ts(), ...a);
}

const VIDEO = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.m3u8': 'application/vnd.apple.mpegurl',
};

// Expand ~ and resolve against cwd, so quoted shell paths behave.
function resolveRoot(p) {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

const args = process.argv.slice(2);
// `-r` on the command line, or RECURSIVE=1 in .env for anyone starting the
// server through `npm start`, where passing flags is awkward.
const recursive =
  args.some((a) => a === '-r' || a === '--recursive') || process.env.RECURSIVE === '1';
const NOT_A_PATH = new Set(['-r', '--recursive', '--verbose', '--print-index']);

// --- database ----------------------------------------------------------------
// Opened before anything else so the reset path below can use it.
db.open(path.join(DATA_DIR, 'app.db'));

// No token configured and no admin yet: mint one for this run rather than
// leaving /setup open to whoever reaches it first. It is printed at startup.
if (!SETUP_TOKEN && !db.setupComplete()) {
  SETUP_TOKEN = crypto.randomBytes(8).toString('hex');
  SETUP_TOKEN_GENERATED = true;
}

// `node server.js --reset-admin <username>` is the way back in after a
// forgotten password. It replaces HOST_KEY/?key=, which put a credential in
// every browser history that ever opened the link. This needs shell access to
// the container, which is a strictly better bar than knowing a URL.
const resetIdx = args.indexOf('--reset-admin');
if (resetIdx !== -1) {
  const username = args[resetIdx + 1];
  if (!username || username.startsWith('-')) {
    console.error('usage: node server.js --reset-admin <username>');
    process.exit(1);
  }
  const rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question(`New password for ${username}: `, (password) => {
    rl.close();
    if (!password || password.length < 8) {
      console.error('password must be at least 8 characters');
      process.exit(1);
    }
    const existing = db.getUserByName(username);
    if (existing) {
      db.setUserPassword(existing.id, password);
      db.setUserStatus(existing.id, 'active');
      if (existing.role !== 'admin') {
        db.handle.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      }
      console.log(`reset password for ${username} and ensured admin role`);
    } else {
      db.createUser({ username, password, role: 'admin', status: 'active' });
      console.log(`created admin ${username}`);
    }
    process.exit(0);
  });
  return;
}

// Note the resetIdx guard only applies when the flag is actually present:
// with resetIdx === -1, `i !== resetIdx + 1` would silently drop argv[0].
const paths = args.filter(
  (a, i) => !NOT_A_PATH.has(a) && (resetIdx === -1 || (i !== resetIdx && i !== resetIdx + 1))
);

// Split a path list on both ';' and ':' regardless of platform. Using
// path.delimiter means a value authored on Windows (';') becomes one nonsense
// path inside a Linux container, which indexes zero files and says nothing
// about why.
//
// ':' is also the drive separator, so "F:/media" must not split at "F". Only
// treat ':' as a separator when it isn't a drive letter — i.e. when it is not
// a single alphabetic character preceded by a separator or the start.
function splitPathList(value) {
  const out = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    // A ':' directly after a single letter that starts this segment is a drive
    // letter ("F:/media"), not a separator.
    const isDrive = c === ':' && cur.length === 1 && /[A-Za-z]/.test(cur);
    if ((c === ';' || c === ':') && !isDrive) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const roots = (paths.length
  ? paths
  : splitPathList(process.env.MEDIA_DIRS || process.cwd())
).map(resolveRoot);

for (const r of roots) {
  if (!fs.existsSync(r)) {
    console.error(`no such path: ${r}`);
    process.exit(1);
  }
}

// --- library index -----------------------------------------------------------
// Files are addressed by an opaque id, never by a path from the client. That
// means there is no traversal to defend against: an id either resolves to
// something we indexed or it doesn't exist.

let library = new Map(); // id -> { file, label }
let indexedAt = 0;

// Ids are derived from the path *relative to its root*, not the absolute path,
// so /media/<id> survives moving the library or re-pointing MEDIA_DIRS at the
// same tree under a different mount point. Hashing the absolute path meant a
// host-path change silently 404'd every bookmarked and in-flight URL.
//
// Two roots can hold the same relative name, so the root index is mixed in as
// a tiebreak. The consequence to know: reordering MEDIA_DIRS still changes
// ids. That is rarer than moving the library, which is what this fixes.
//
// Separators are normalised so the same tree indexed on Windows and Linux
// produces the same ids.
function idFor(rootIndex, relPath) {
  const key = `${rootIndex}\0${relPath.split(path.sep).join('/')}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function walk(dir, base, depth, out, rootIndex) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip rather than crash the scan
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) walk(full, base, depth + 1, out, rootIndex);
    } else if (VIDEO[path.extname(e.name).toLowerCase()]) {
      // `label` is already the path relative to this root, which is exactly
      // what the id should be derived from. Normalised to '/' so it reads the
      // same regardless of platform, and so the client can split it into
      // folder segments without caring what OS indexed it.
      const label = path.relative(base, full).split(path.sep).join('/');
      out.set(idFor(rootIndex, label), {
        file: full,
        label,
        dir: path.dirname(label) === '.' ? '' : path.dirname(label),
        name: e.name,
      });
    }
  }
}

function buildIndex() {
  const out = new Map();
  for (const [rootIndex, root] of roots.entries()) {
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, recursive ? path.dirname(root) : root, 0, out, rootIndex);
    } else if (VIDEO[path.extname(root).toLowerCase()]) {
      // A root that is itself a file: its "relative path" is its basename.
      out.set(idFor(rootIndex, path.basename(root)), {
        file: root,
        label: path.basename(root),
        dir: '',
        name: path.basename(root),
      });
    }
  }
  library = out;
  indexedAt = Date.now();
  return out;
}

buildIndex();

// `--print-index` dumps the index as JSON and exits. Used by the tests to
// check id stability without standing up auth, and occasionally useful by hand
// when a file isn't appearing and you want to know what was actually scanned.
if (args.includes('--print-index')) {
  console.log(JSON.stringify([...library].map(([id, e]) => ({ id, label: e.label }))));
  process.exit(0);
}

console.log(
  `indexed ${library.size} file(s)${recursive ? ' (including subfolders)' : ''} from:\n  ` +
  roots.join('\n  ')
);

// --- track discovery ---------------------------------------------------------
// Browsers cannot switch between multiple audio tracks in an MP4: the
// HTMLMediaElement.audioTracks API is unimplemented in both Chrome and
// Firefox. Embedded subtitles fare no better — ASS and PGS are not web
// formats at all.
//
// So both are handled here instead. We probe once per file with ffprobe,
// cache the result, and expose the tracks so the host can choose; the choice
// is part of room state, so everyone hears and reads the same thing.
// Subtitles are converted to WebVTT on demand and served as a <track>.
//
// ffprobe is optional. Without it every file simply reports no tracks and
// the app behaves exactly as it did before.

const { execFile } = require('child_process');

let ffprobeOK = null; // null = untested
function checkFfprobe() {
  return new Promise((resolve) => {
    if (ffprobeOK !== null) return resolve(ffprobeOK);
    execFile('ffprobe', ['-version'], (err) => {
      ffprobeOK = !err;
      resolve(ffprobeOK);
    });
  });
}

// Hot path is the in-memory Map; the db behind it only matters across a
// restart, so it is populated lazily on first miss rather than preloaded.
const trackCache = new Map(); // id -> { audio: [], subs: [] }

function describe(stream, i) {
  const t = stream.tags || {};
  const lang = t.language && t.language !== 'und' ? t.language : '';
  const title = t.title || '';
  // Prefer the human title the release group wrote; fall back to language.
  const label = title || (lang ? lang.toUpperCase() : `Track ${i + 1}`);
  return {
    index: stream.index,
    n: i,
    lang,
    label: lang && title && !title.toLowerCase().includes(lang) ? `${label} (${lang})` : label,
    codec: stream.codec_name,
    default: stream.disposition?.default === 1,
  };
}

// Whether a browser stands a chance with this file, and if not, why.
//
// Measured against Chromium/Edge rather than assumed. The surprise is which
// things are fine: MKV demuxes, and FLAC decodes. What actually fails is the
// video codec — HEVC is unsupported in every container, 8-bit and 10-bit
// alike, unless the viewer has bought Microsoft's HEVC Video Extensions.
//
// A file that fails here still plays for anyone whose browser does have the
// codec, so this is a warning and a reason to transcode, never a refusal.
const WEB_VIDEO = /^(h264|vp8|vp9|av1|theora)$/;
const WEB_AUDIO = /^(aac|mp3|opus|vorbis|flac|pcm_|alac)/;

// The video half of the transcode command. These values were benchmarked on a
// 30s 1080p source rather than guessed, because the intuitive choices are both
// wrong:
//
//   ultrafast crf23   14.3x realtime   14.1 Mbps   <- fast but 5x the bandwidth
//   veryfast  crf23   10.4x            4.3 Mbps
//   veryfast  crf26   11.1x            2.8 Mbps    <- fastest AND smallest
//   faster    crf26    9.1x            2.9 Mbps
//   fast      crf26    7.7x            3.2 Mbps    <- slower and bigger
//   medium    crf26    6.7x            3.1 Mbps
//
// Two things to take from that. `ultrafast` trades away far more bandwidth
// than it buys in CPU, which matters over a tunnel. And presets slower than
// `veryfast` cost CPU for nothing here — they came out both slower and larger.
//
// CRF 25 sits between the measured points: 26 was fine on a test pattern, but
// real film has grain and detail that a test pattern does not, and CRF is the
// one knob where being slightly generous costs only bandwidth.
//
// -maxrate/-bufsize cap the peak so a busy scene cannot spike past what the
// tunnel carries; they cost nothing on ordinary content.
// -g 48 puts a keyframe every 2s, which bounds how long a seek takes to show
// a picture.
const TRANSCODE_VIDEO = [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '25',
  '-maxrate', '5M',
  '-bufsize', '10M',
  '-pix_fmt', 'yuv420p',  // 8-bit: the whole point is to leave 10-bit behind
  '-profile:v', 'high',
  '-g', '48',
  // Threads are set per job at spawn time, not here: the budget is shared
  // between however many encoders are alive, and this list is reused by both.
];

// How much of the machine encoding may take, in total, across every ffmpeg we
// start. The earlier figure was per process and assumed only one ran, which on
// a small box meant three encoders each claiming most of the cores.
//
// Half the cores, at least one, is the default: the server still has to read
// files, run the websocket and answer requests while an encode is going, and a
// box that is pegged at 100% drops frames for everyone watching. On a 4-core
// Pi that is 2 threads; on a laptop, 4.
const CPU_BUDGET = Math.max(
  1,
  Number(process.env.TRANSCODE_THREADS) || Math.floor(os.cpus().length / 2)
);

// Split between live encodes and the cache build so the total stays inside the
// budget no matter how many are running.
function threadShare(jobs) {
  return String(Math.max(1, Math.floor(CPU_BUDGET / Math.max(1, jobs))));
}

// --- transcode cache ---------------------------------------------------------
// Re-encoding the same film every time somebody watches it is wasteful, and it
// is what makes seeking slow: every drag restarts ffmpeg. So a completed
// encode is kept on disk and served as an ordinary file, which also restores
// byte-range seeking and a real duration.
//
// The cache is written once per file, in the background, the first time a
// transcode is asked for. Until it finishes, requests stream from ffmpeg as
// before — the first viewer does not wait for a full encode.

// Transcodes are by far the largest thing this writes, so the cache can live
// somewhere other than the data directory — an external disk rather than the SD
// card on a small machine, for instance.
const CACHE_DIR = process.env.CACHE_DIR
  ? path.resolve(process.env.CACHE_DIR)
  : path.join(DATA_DIR, 'transcoded');
const CACHE_LIMIT_GB = Number(process.env.TRANSCODE_CACHE_GB || 20);

// The on-disk name carries the source's own name purely so a human looking at
// CACHE_DIR (or a filename in a log line) can tell which episode a cache file
// is without cross-referencing ids — lookups never rely on it. The id prefix
// stays the sole source of truth: it is unique and stable, while the slug is
// neither (two files can share a name, and a rename upstream orphans nothing
// here since nothing reads the slug back).
function slugify(name) {
  return path
    .basename(name, path.extname(name))
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'file';
}

function cachePath(id, name) {
  return path.join(CACHE_DIR, `${id}.${slugify(name)}.mp4`);
}

// Old caches (or a lookup with no `name` on hand) may only have `<id>.mp4`;
// glob for anything starting with the id so both forms resolve.
function findCachePath(id) {
  const bare = path.join(CACHE_DIR, `${id}.mp4`);
  if (fs.existsSync(bare)) return bare;
  try {
    const hit = fs.readdirSync(CACHE_DIR).find((f) => f.startsWith(`${id}.`) && f.endsWith('.mp4'));
    return hit ? path.join(CACHE_DIR, hit) : bare;
  } catch {
    return bare;
  }
}

function cachedFile(id) {
  try {
    const p = findCachePath(id);
    const st = fs.statSync(p);
    // A part-written file from a killed process would play as a truncated
    // film, so only a finished marker counts.
    if (st.isFile() && st.size > 0 && fs.existsSync(p + '.done')) return p;
  } catch {}
  return null;
}

// Oldest-first eviction once the cache passes its limit. Called after each
// completed encode, so the directory cannot grow without bound.
function pruneCache() {
  try {
    const files = fs
      .readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => {
        const full = path.join(CACHE_DIR, f);
        const st = fs.statSync(full);
        return { full, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => a.at - b.at);
    let total = files.reduce((n, f) => n + f.size, 0);
    const limit = CACHE_LIMIT_GB * 1024 * 1024 * 1024;
    while (total > limit && files.length) {
      const victim = files.shift();
      try {
        fs.rmSync(victim.full, { force: true });
        fs.rmSync(victim.full + '.done', { force: true });
        total -= victim.size;
        log(`cache: evicted ${path.basename(victim.full)}`);
      } catch {
        break;
      }
    }
  } catch {}
}

// --- the encode queue --------------------------------------------------------
//
// Encoding used to happen on demand: the first viewer of an HEVC file got a
// live ffmpeg pipe while a cache build raced alongside it. It was clever and it
// was the wrong shape for this app. A fragmented pipe has no index, so seeking
// restarted the encoder; the restart cost more than the seek; the client grew
// its own scrub bar, its own clock, and a subtitle offset to compensate; and
// two encoders ran at once on a machine that also had to serve the video. The
// first minutes of any unplayable film were spent fighting all of that, in
// front of everyone who had turned up to watch it.
//
// So it is explicit now. An admin queues a file, watches it encode, and plays
// it when it is ready. Nothing is encoded while anyone is waiting on it,
// because nothing is encoded at playback time at all.

// Queue entries, in order. One encodes at a time; the rest wait.
//   { id, label, status, queuedAt, startedAt, finishedAt, percent, error, by }
const encodeQueue = [];
let encodeJob = null; // { id, proc, tmp, entry } — the one running now

function queueEntry(id) {
  return encodeQueue.find((e) => e.id === id) || null;
}

// What the admin panel shows. The library list is sent separately and joined
// by id on the client, so this stays small enough to push on every change.
function encodeState() {
  return {
    type: 'encode',
    // Whether this deployment can encode at all. Without ffmpeg the panel
    // should say so rather than offering a button that silently does nothing.
    available: ffprobeOK !== false,
    cacheDir: CACHE_DIR,
    limitGb: CACHE_LIMIT_GB,
    usedBytes: cacheUsage(),
    // Converted files whose source is no longer in the library — it was
    // deleted or moved, or MEDIA_DIRS was reordered, which changes every id.
    // Nothing will ever ask for these again and they count against the disk
    // budget, so the panel offers to delete them. They are listed separately
    // rather than mixed into `items`: there is no source file to re-encode, so
    // the only thing to do with one is remove it.
    orphans: orphanEncodes(),
    items: encodeQueue.map((e) => ({
      id: e.id,
      label: e.label,
      status: e.status,
      percent: e.percent,
      error: e.error || null,
      by: e.by || null,
      queuedAt: e.queuedAt,
      startedAt: e.startedAt || null,
      finishedAt: e.finishedAt || null,
    })),
  };
}

// Converted files with no matching library entry. See encodeState().
function orphanEncodes() {
  const out = [];
  try {
    for (const id of encodedIds()) {
      if (library.has(id)) continue;
      let size = 0;
      try { size = fs.statSync(findCachePath(id)).size; } catch { continue; }
      out.push({ id, size });
    }
  } catch {}
  return out.sort((a, b) => b.size - a.size);
}

// Remove a converted file and its marker. Only ever called for an orphan: a
// file still in the library is something the host may want to play.
function deleteOrphan(id, by) {
  if (library.has(id)) return { ok: false, error: 'That file is still in the library.' };
  if (!cachedFile(id)) return { ok: false, error: 'No such converted file.' };
  try {
    const p = findCachePath(id);
    fs.rmSync(p, { force: true });
    fs.rmSync(p + '.done', { force: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  log(`encode: deleted orphaned conversion ${id} (${by})`);
  pushEncodeState();
  return { ok: true };
}

function cacheUsage() {
  let total = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.mp4')) continue;
      try { total += fs.statSync(path.join(CACHE_DIR, f)).size; } catch {}
    }
  } catch {}
  return total;
}

// Pushed to admins on every queue change. Viewers have nothing to do with the
// queue and never see it.
function pushEncodeState() {
  notifyAdmins(encodeState());
}

// Add a file to the queue. Idempotent: asking twice for the same file is a
// double-click, not a request for two encodes.
function enqueueEncode(id, by) {
  const entry = library.get(id);
  if (!entry) return { ok: false, error: 'No such file.' };
  if (cachedFile(id)) return { ok: false, error: 'That file is already encoded.' };

  const existing = queueEntry(id);
  if (existing) {
    // A previous attempt that failed is worth retrying; one that is waiting or
    // running is not.
    if (existing.status === 'failed') {
      existing.status = 'queued';
      existing.error = null;
      existing.percent = 0;
      existing.queuedAt = Date.now();
      existing.by = by;
      log(`encode: retrying ${entry.label} (${by})`);
      pumpQueue();
      pushEncodeState();
      return { ok: true };
    }
    return { ok: false, error: 'That file is already in the queue.' };
  }

  encodeQueue.push({
    id,
    label: entry.label,
    status: 'queued',
    percent: 0,
    error: null,
    by,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  });
  log(`encode: queued ${entry.label} (${by})`);
  pumpQueue();
  pushEncodeState();
  return { ok: true };
}

// Take a file out of the queue, killing it first if it is the one running.
function cancelEncode(id, by) {
  const item = queueEntry(id);
  if (!item) return { ok: false, error: 'Not in the queue.' };

  if (encodeJob && encodeJob.id === id) {
    log(`encode: cancelled ${item.label} mid-encode (${by})`);
    killEncodeJob();
  } else {
    log(`encode: removed ${item.label} from the queue (${by})`);
  }
  const at = encodeQueue.indexOf(item);
  if (at >= 0) encodeQueue.splice(at, 1);
  pumpQueue();
  pushEncodeState();
  return { ok: true };
}

// Forget a finished or failed row. The encoded file on disk is untouched —
// this clears the list, it does not delete anything.
function clearFinishedEncodes() {
  for (let i = encodeQueue.length - 1; i >= 0; i--) {
    if (encodeQueue[i].status === 'done' || encodeQueue[i].status === 'failed') {
      encodeQueue.splice(i, 1);
    }
  }
  pushEncodeState();
}

function killEncodeJob() {
  if (!encodeJob) return;
  const { proc, tmp } = encodeJob;
  encodeJob = null;
  try { proc.kill('SIGKILL'); } catch {}
  // The part file cannot be deleted here. SIGKILL is asynchronous, so ffmpeg
  // may not have exited yet — and on Windows the open handle makes the unlink
  // fail outright, which is how cancelled encodes were leaving .part files
  // behind. They are invisible to playback, since only a .done marker counts,
  // but they are the largest thing this writes and nothing else would ever
  // clean them up.
  //
  // 'exit' fires once the process is actually gone, which is the first moment
  // the file is ours to remove. The close handler will not do it: it returns
  // early for a job that is no longer the current one, which this now isn't.
  const reap = () => {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  };
  proc.once('exit', reap);
  // A process that has already exited will not fire it again.
  if (proc.exitCode !== null || proc.signalCode !== null) reap();
}

// Start the next queued file, if nothing is running. The single worker is the
// point: two encoders on a machine that is also serving video is how playback
// starts stuttering for everyone.
function pumpQueue() {
  if (encodeJob) return;
  const next = encodeQueue.find((e) => e.status === 'queued');
  if (!next) return;

  const entry = library.get(next.id);
  if (!entry) {
    next.status = 'failed';
    next.error = 'The file is no longer in the library.';
    next.finishedAt = Date.now();
    pushEncodeState();
    return pumpQueue();
  }

  // Someone may have encoded it by other means since it was queued.
  if (cachedFile(next.id)) {
    next.status = 'done';
    next.percent = 100;
    next.finishedAt = Date.now();
    pushEncodeState();
    return pumpQueue();
  }

  const out = cachePath(next.id, entry.name);
  const tmp = out + '.part';
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  next.status = 'encoding';
  next.startedAt = Date.now();
  next.percent = 0;

  // Duration is what turns ffmpeg's running timestamp into a percentage. It
  // was probed for the playability verdict already, so this is usually a cache
  // hit; a file without one just reports no percentage rather than a wrong one.
  probeTracks(next.id).then((t) => {
    const duration = t.duration || 0;

    const ff = require('child_process').spawn('ffmpeg', [
      '-v', 'error',
      // Machine-readable progress on stdout: key=value lines, including
      // out_time_us, every few hundred milliseconds. Parsing the human stderr
      // for this is the usual approach and it breaks whenever ffmpeg rewords
      // something.
      '-progress', 'pipe:1',
      '-nostats',
      '-i', entry.file,
      '-map', '0:v:0',
      '-map', '0:a?',
      ...TRANSCODE_VIDEO,
      // Nothing else is encoding — the queue guarantees it — so this job gets
      // the whole budget rather than a share of it.
      '-threads', threadShare(1),
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      // A seekable MP4: the index goes at the front so the browser can
      // range-request into it and the native scrub bar works.
      '-movflags', '+faststart',
      '-f', 'mp4',
      tmp,
      '-y',
    ]);

    encodeJob = { id: next.id, proc: ff, tmp, entry };
    log(`encode: started ${entry.label}`);
    pushEncodeState();

    let progressBuf = '';
    ff.stdout.on('data', (d) => {
      progressBuf += d;
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop() || '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        if (line.slice(0, eq) !== 'out_time_us') continue;
        const us = Number(line.slice(eq + 1));
        if (!Number.isFinite(us) || !duration) continue;
        const pct = Math.max(0, Math.min(100, (us / 1e6 / duration) * 100));
        // Only push when the figure has visibly moved: ffmpeg emits progress
        // several times a second and every push is a message to every admin.
        if (Math.abs(pct - next.percent) >= 1) {
          next.percent = pct;
          pushEncodeState();
        }
      }
    });

    let errTail = '';
    ff.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });

    ff.on('error', (e) => {
      if (encodeJob?.proc !== ff) return;
      encodeJob = null;
      next.status = 'failed';
      next.error = e.code === 'ENOENT' ? 'ffmpeg is not installed.' : e.message;
      next.finishedAt = Date.now();
      log(`! encode failed: ${next.error}`);
      try { fs.rmSync(tmp, { force: true }); } catch {}
      pushEncodeState();
      pumpQueue();
    });

    ff.on('close', (code) => {
      // A cancel already tore this down and moved on; nothing to report.
      if (encodeJob?.proc !== ff) return;
      encodeJob = null;

      if (code === 0 && fs.existsSync(tmp)) {
        try {
          fs.renameSync(tmp, out);
          // A part-written file from a killed process would play as a
          // truncated film, so a finished encode is marked as one.
          fs.writeFileSync(out + '.done', '');
          const secs = ((Date.now() - next.startedAt) / 1000).toFixed(0);
          next.status = 'done';
          next.percent = 100;
          next.finishedAt = Date.now();
          log(`encode: ${entry.label} ready in ${secs}s`);
          pruneCache();
          // The client caches the probe, and `cached` is part of it.
          trackCache.delete(next.id);
          db.deleteTrackCache(next.id);
          pushEncodeState();
          notifyAdmins({
            type: 'notice',
            kind: 'info',
            text: `${entry.label} finished encoding`,
            at: Date.now(),
          });
          return pumpQueue();
        } catch (e) {
          next.error = e.message;
        }
      }
      try { fs.rmSync(tmp, { force: true }); } catch {}
      next.status = 'failed';
      next.error =
        next.error ||
        (errTail ? errTail.trim().split(String.fromCharCode(10)).pop() : `ffmpeg exited ${code}`);
      next.finishedAt = Date.now();
      log(`! encode failed for ${entry.label}: ${next.error}`);
      pushEncodeState();
      pumpQueue();
    });
  });
}

// A part file is a dead encode: either one that was cancelled, or one whose
// process died with the server. Nothing will ever finish it — the queue does
// not survive a restart — and they are the largest thing this writes, so they
// are swept at startup rather than left to accumulate silently.
function sweepPartFiles() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.part')) continue;
      try {
        fs.rmSync(path.join(CACHE_DIR, f), { force: true });
        n++;
      } catch {}
    }
  } catch {}
  if (n) log(`cache: cleaned up ${n} unfinished encode(s) from a previous run`);
}

// Encoded files that no queue row remembers — from an earlier run, or rows
// that were cleared. The panel lists these as ready so an admin can see what
// is on disk without keeping the queue forever.
//
// A cache file is `<id>.mp4.done` (old, unlabelled) or `<id>.<slug>.mp4.done`
// (current). The id is only ever the first dot-separated segment, so take
// that rather than assuming the rest of the stem is the id.
function encodedIds() {
  const out = new Set();
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.mp4.done')) continue;
      out.add(f.slice(0, f.indexOf('.')));
    }
  } catch {}
  return out;
}

function playability(video, audio) {
  const reasons = [];

  if (video && !WEB_VIDEO.test(video.codec || '')) {
    const name = (video.codec || 'unknown').toUpperCase();
    reasons.push({
      what: 'video',
      codec: video.codec,
      // The wording a viewer reads, so it says what to do rather than what
      // the pipeline called it.
      text:
        video.codec === 'hevc'
          ? 'This file is HEVC (H.265), which browsers cannot decode without an OS codec'
          : `This file's video is ${name}, which browsers cannot decode`,
    });
  }

  // 10-bit is a separate wall: even where HEVC works, the 10-bit profile
  // usually does not.
  if (video && /10le|10be|p010/.test(video.pixFmt || '') && WEB_VIDEO.test(video.codec || '')) {
    reasons.push({
      what: 'video',
      codec: video.codec,
      text: 'This file is 10-bit, which most browsers cannot decode',
    });
  }

  if (audio.length && !audio.some((a) => WEB_AUDIO.test(a.codec || ''))) {
    const names = [...new Set(audio.map((a) => (a.codec || '').toUpperCase()))].join(', ');
    reasons.push({
      what: 'audio',
      codec: audio[0]?.codec,
      text: `The audio is ${names}, which browsers cannot decode`,
    });
  }

  return { ok: reasons.length === 0, reasons };
}

function probeTracks(id) {
  const cached = trackCache.get(id);
  if (cached) return Promise.resolve(cached);

  // The id is a content hash, so a row from a previous boot is never stale —
  // only possibly for a file that no longer exists, which the entry check
  // below still guards against on every call regardless of cache source.
  const stored = db.getTrackCache(id);
  if (stored) {
    trackCache.set(id, stored);
    return Promise.resolve(stored);
  }

  const entry = library.get(id);
  if (!entry) return Promise.resolve({ audio: [], subs: [], video: null, duration: 0, play: { ok: true } });

  return checkFfprobe().then(
    (ok) =>
      new Promise((resolve) => {
        if (!ok) {
          // No ffprobe: we cannot judge, so claim nothing and let the browser
          // try. Silence is better than a wrong warning. Kept in-memory only —
          // ffprobe showing up later (installed after the fact) should get a
          // real probe next time, not a persisted "unknown" forever.
          const empty = { audio: [], subs: [], video: null, duration: 0, play: { ok: true } };
          trackCache.set(id, empty);
          return resolve(empty);
        }
        execFile(
          'ffprobe',
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', entry.file],
          { maxBuffer: 32 * 1024 * 1024 },
          (err, stdout) => {
            let out = { audio: [], subs: [], video: null, duration: 0, play: { ok: true } };
            if (!err) {
              try {
                const parsed = JSON.parse(stdout);
                const streams = parsed.streams || [];
                // The true length of the source. A transcode that starts at an
                // offset reports only what is left, so the client needs this
                // to present the real timeline.
                const dur = parseFloat(parsed.format?.duration);
                if (Number.isFinite(dur) && dur > 0) out.duration = dur;
                out.audio = streams.filter((x) => x.codec_type === 'audio').map(describe);
                out.subs = streams
                  .filter((x) => x.codec_type === 'subtitle')
                  // Only text subtitles can become WebVTT. PGS and VOBSUB are
                  // bitmap formats and would need OCR.
                  .filter((x) => /subrip|ass|ssa|mov_text|webvtt|text/.test(x.codec_name || ''))
                  .map(describe);
                const vid = streams.find((x) => x.codec_type === 'video');
                if (vid) {
                  out.video = {
                    codec: vid.codec_name,
                    profile: vid.profile || '',
                    pixFmt: vid.pix_fmt || '',
                    width: vid.width,
                    height: vid.height,
                  };
                }
                out.play = playability(out.video, out.audio);
              } catch {}
            }
            trackCache.set(id, out);
            db.setTrackCache(id, out);
            resolve(out);
          }
        );
      })
  );
}

// --- embedded fonts ----------------------------------------------------------
// libass needs the real fonts to place typeset signs correctly. ffmpeg can dump
// container attachments, but only to files, so we extract to a temp dir once
// per file and cache the packed result in memory.
//
// Wire format is deliberately dumb: for each font, a 4-byte big-endian name
// length, the UTF-8 name, a 4-byte big-endian data length, then the bytes. The
// client walks it with a DataView. A tar parser would be more standard and more
// code for no gain.

const fontCache = new Map(); // id -> Buffer

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

function extractFonts(id) {
  const cached = fontCache.get(id);
  if (cached) return Promise.resolve(cached);

  const entry = library.get(id);
  if (!entry) return Promise.resolve(Buffer.alloc(0));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fonts-'));
  return new Promise((resolve) => {
    // -dump_attachment writes every attachment into cwd while the input is
    // parsed, which is all we want. `-t 0` is what stops there: without it
    // ffmpeg goes on to decode the whole video into the null sink, which on a
    // feature-length file is minutes of pointless full-speed CPU.
    execFile(
      'ffmpeg',
      ['-v', 'error', '-dump_attachment:t', '', '-i', entry.file, '-t', '0', '-f', 'null', '-'],
      { cwd: dir, maxBuffer: 64 * 1024 * 1024 },
      () => {
        const parts = [];
        try {
          for (const name of fs.readdirSync(dir)) {
            if (!FONT_EXT.has(path.extname(name).toLowerCase())) continue;
            const data = fs.readFileSync(path.join(dir, name));
            const nameBuf = Buffer.from(name, 'utf8');
            const head = Buffer.alloc(4);
            head.writeUInt32BE(nameBuf.length, 0);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(data.length, 0);
            parts.push(head, nameBuf, size, data);
          }
        } catch {}
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
        const blob = Buffer.concat(parts);
        fontCache.set(id, blob);
        resolve(blob);
      }
    );
  });
}

// --- vendored libass ---------------------------------------------------------
// Served from node_modules rather than a CDN: the whole point of this app is
// that it works over one tunnel with one login.

// jassub ships untranspiled ESM with bare specifiers, so its dependencies have
// to be reachable too. Rather than add a bundler to a project that has none,
// each package's directory is served whole and an import map in watch.html
// points the bare names at these paths.
const NODE_MODULES = path.join(__dirname, 'node_modules');
const VENDOR_PKGS = ['jassub', 'abslink', 'rvfc-polyfill', 'lfa-ponyfill'];

// jassub's debug module imports 'throughput', which is CommonJS and so cannot
// be imported by a browser at all. It only feeds an FPS counter we never turn
// on, so it is stubbed rather than shimmed.
const THROUGHPUT_STUB = 'export default function () { return function () { return 0 } }';

const VENDOR_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

// Module workers do not inherit the page's import map, and jassub's worker
// imports bare specifiers. Rather than bundle, rewrite those few specifiers to
// real /vendor/ paths as the file is served. Only whole-name matches are
// touched, so relative imports in the same file are left alone.
const BARE = {
  abslink: '/vendor/abslink/src/abslink.js',
  'abslink/w3c': '/vendor/abslink/adapters/w3c.js',
  'lfa-ponyfill': '/vendor/lfa-ponyfill/index.js',
  'rvfc-polyfill': '/vendor/rvfc-polyfill/index.js',
  throughput: '/vendor/throughput.js',
};

function rewriteBareImports(src) {
  return src.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\2/g,
    (whole, lead, q, spec) => (BARE[spec] ? `${lead}${q}${BARE[spec]}${q}` : whole)
  );
}

// Resolve a /vendor/ path to a real file, refusing anything that escapes the
// package it names. The path is already decoded here, so '..' has to be caught
// after resolution rather than by looking for it in the string.
function vendorFile(name) {
  const pkg = name.split('/')[0];
  if (!VENDOR_PKGS.includes(pkg)) return null;
  const full = path.resolve(NODE_MODULES, name);
  const base = path.resolve(NODE_MODULES, pkg);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (!VENDOR_TYPES[path.extname(full)]) return null;
  return full;
}

// Whether the libass path is even possible. Without the dependency installed
// the client falls back to WebVTT, which is what it did before.
const HAS_JASSUB = fs.existsSync(path.join(NODE_MODULES, 'jassub', 'dist', 'jassub.js'));

// --- server stats ------------------------------------------------------------
// Feeds the sidebar. Everything here is cheap and sampled on a timer: nothing
// is computed per request beyond incrementing two counters.

// Bytes pushed to clients and read from disk since the last sample. Reset each
// time the rate is computed, so these never grow unbounded.
let bytesOut = 0;
let bytesRead = 0;
const countOut = (n) => { bytesOut += n; };
const countRead = (n) => { bytesRead += n; };

// os.loadavg() is zeros on Windows, so system CPU comes from the difference
// between two readings of the per-core time counters instead.
function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

let lastCpu = cpuSnapshot();
let lastProcCpu = process.cpuUsage();
let lastSampleAt = Date.now();
let stats = { cpu: 0, procCpu: 0, mbpsOut: 0, mbpsRead: 0, rss: 0, uptime: 0 };

function sampleStats() {
  const now = Date.now();
  const elapsed = Math.max(now - lastSampleAt, 1) / 1000;

  const cpu = cpuSnapshot();
  const dIdle = cpu.idle - lastCpu.idle;
  const dTotal = cpu.total - lastCpu.total;
  lastCpu = cpu;

  // process.cpuUsage is microseconds of CPU time; over one wall-clock second
  // a fully busy single core is 1e6. Divided by core count it is comparable
  // to the system figure.
  const proc = process.cpuUsage();
  const dProc = proc.user - lastProcCpu.user + (proc.system - lastProcCpu.system);
  lastProcCpu = proc;

  stats = {
    cpu: dTotal > 0 ? Math.round(1000 * (1 - dIdle / dTotal)) / 10 : 0,
    procCpu: Math.round((1000 * dProc) / (elapsed * 1e6 * os.cpus().length)) / 10,
    mbpsOut: Math.round((bytesOut * 8) / elapsed / 1e5) / 10,
    mbpsRead: Math.round((bytesRead * 8) / elapsed / 1e5) / 10,
    rss: Math.round(process.memoryUsage().rss / 1048576),
    uptime: Math.round(process.uptime()),
  };

  bytesOut = 0;
  bytesRead = 0;
  lastSampleAt = now;
  return stats;
}

// --- static, with byte-range support so seeking works ------------------------

// Parse a single HTTP byte range against a known size. Returns null when the
// header is absent or unparseable (caller should send the whole file), and
// false when it is syntactically valid but unsatisfiable (caller sends 416).
//
// Three forms exist and they are not interchangeable:
//   bytes=200-999   explicit window
//   bytes=200-      from 200 to the end
//   bytes=-500      the LAST 500 bytes  <- a suffix range, not "0 to 500"
//
// That last form is the one worth being careful about: browsers use it to grab
// the moov atom at the tail of an MP4 before they can seek. Treating it as a
// prefix hands back the head of the file under a Content-Range that claims it
// is the tail, and the demuxer reports the file as corrupt.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multipart or malformed — serve the whole thing
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return null;

  let start, end;
  if (!rawStart) {
    // Suffix: the final N bytes. N larger than the file means the whole file.
    const n = parseInt(rawEnd, 10);
    if (!Number.isFinite(n)) return null;
    if (n === 0) return false;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    if (!Number.isFinite(start)) return null;
    // Clamp rather than reject: players routinely ask for a far end offset
    // (bytes=1000-99999999) and expect the server to cut it to the real size.
    end = rawEnd ? Math.min(parseInt(rawEnd, 10), size - 1) : size - 1;
  }

  if (start >= size || start > end) return false;
  return { start, end };
}

function serveFile(filePath, req, res, type, extraHeaders = {}) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const mime = type || VIDEO[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = parseRange(req.headers.range, stat.size);

    if (range === false) {
      log(`416 ${path.basename(filePath)} unsatisfiable range: ${req.headers.range}`);
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }

    const head = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      // The watch page is cross-origin isolated so libass can use
      // SharedArrayBuffer; under require-corp every subresource needs this,
      // same-origin ones included.
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    };
    let opts;
    if (range) {
      head['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      head['Content-Length'] = range.end - range.start + 1;
      opts = { start: range.start, end: range.end };
      res.writeHead(206, head);
    } else {
      head['Content-Length'] = stat.size;
      res.writeHead(200, head);
    }

    if (VERBOSE) {
      const what = path.basename(filePath);
      vlog(
        range
          ? `206 ${what} ${range.start}-${range.end}/${stat.size} (${(range.end - range.start + 1)}B)` +
              (req.headers.range ? `  asked: ${req.headers.range}` : '')
          : `200 ${what} ${stat.size}B`
      );
    }

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    // Seeking abandons in-flight responses constantly. Without this the read
    // keeps going after the socket is gone and an EPIPE takes down the process.
    const stream = fs.createReadStream(filePath, opts);
    stream.on('error', () => res.destroy());
    // Counted here rather than on the socket: this is the payload we chose to
    // send, without TLS and framing overhead muddying the figure.
    stream.on('data', (chunk) => {
      countRead(chunk.length);
      countOut(chunk.length);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

const startedAt = Date.now();

// --- request helpers ---------------------------------------------------------

// The chunks are kept as Buffers and decoded once at the end, never
// concatenated as strings.
//
// `body += chunk` coerces each chunk to UTF-8 independently, so a multi-byte
// character split across a TCP chunk boundary is decoded as two invalid halves
// and comes out as replacement characters. The password is then wrong through
// no fault of the person typing it — and only sometimes, because where the
// boundary falls depends on MTU and timing. A VPN changes both, which is why
// this looked like "I can't log in over the VPN" rather than like an encoding
// bug. It corrupted usernames and invite codes the same way.
//
// The cap counts bytes rather than string length, since bytes are what was
// actually read and what the limit is meant to bound.
function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      // A login form is a few hundred bytes. Anything larger is not a form.
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return resolve(null);
      const body = Buffer.concat(chunks).toString('utf8');
      resolve(Object.fromEntries(new URLSearchParams(body)));
    });
    req.on('error', () => resolve(null));
  });
}

function html(res, body, status = 200, extraHeaders = {}) {
  res
    .writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    })
    .end(body);
}

function redirect(res, to, extraHeaders = {}) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...extraHeaders }).end();
}

// Whether this request wants a page or an asset. Unauthenticated page requests
// get a redirect to /login; unauthenticated asset and media requests get a 401.
//
// The distinction matters: redirecting a <video> element's request pipes an
// HTML login page into the decoder, which surfaces to the viewer as an
// unexplained "this file is corrupt" rather than "you are signed out".
function wantsHtml(req, url) {
  if (
    url.startsWith('/media/') ||
    url.startsWith('/transcode/') ||
    url.startsWith('/subs/') ||
    url.startsWith('/tracks/') ||
    url.startsWith('/fonts/') ||
    url.startsWith('/vendor/')
  ) {
    return false;
  }
  if (url === '/list') return false;
  return (req.headers.accept || '').includes('text/html');
}

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const query = new URLSearchParams(req.url.split('?')[1] || '');

  // Liveness for the container healthcheck and for Dockhand's status display.
  //
  // Two properties this must keep once auth lands: it stays exempt from the
  // access gate, and it reports counts only. A health endpoint that lists
  // filenames is an unauthenticated library index.
  if (url === '/healthz') {
    const body = {
      ok: true,
      files: library.size,
      rooms: rooms.size,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      // Lets a deployment sitting unconfigured be spotted from outside
      // without exposing anything about what it holds.
      setupComplete: db.setupComplete(),
    };
    res
      .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(body));
    return;
  }

  // --- setup mode ------------------------------------------------------------
  // No admin exists yet. Nothing is reachable but /setup — including /media.
  // A half-configured server must not serve video.
  if (!db.setupComplete()) {
    if (url === '/setup' && req.method === 'POST') {
      if (auth.rateLimited(req)) {
        html(res, pages.setup({ error: 'Too many attempts. Wait a minute.', needsToken: !!SETUP_TOKEN }), 429, {
          'Retry-After': String(auth.retryAfterS(req)),
        });
        return;
      }
      const form = (await readBody(req)) || {};
      const fail = (msg) => {
        auth.recordFailure(req);
        html(res, pages.setup({ error: msg, needsToken: !!SETUP_TOKEN }), 400);
      };
      if (SETUP_TOKEN && form.token !== SETUP_TOKEN) return void fail('Wrong setup token.');
      const username = String(form.username || '').trim();
      if (!/^[\w.-]{2,24}$/.test(username)) {
        return void fail('Username must be 2-24 characters: letters, numbers, dot, dash, underscore.');
      }
      if (String(form.password || '').length < 8) return void fail('Password must be at least 8 characters.');
      if (form.password !== form.confirm) return void fail("Passwords don't match.");

      // Re-check under the same tick: two simultaneous setups must not both win.
      if (db.setupComplete()) return void redirect(res, '/login');
      const user = db.createUser({
        username,
        password: form.password,
        role: 'admin',
        status: 'active',
      });
      auth.clearFailures(req);
      log(`setup complete — admin account "${username}" created`);
      redirect(res, '/', { 'Set-Cookie': auth.loginCookie(req, user.id) });
      return;
    }
    if (url === '/setup') {
      html(res, pages.setup({ needsToken: !!SETUP_TOKEN }));
      return;
    }
    // Assets and media get a status code, never a redirect — the same reason
    // as in the main gate below: an HTML page fed to a <video> element reads
    // as a corrupt file rather than as "this server isn't set up".
    if (!wantsHtml(req, url)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Server not set up');
      return;
    }
    redirect(res, '/setup');
    return;
  }

  // Setup is finished; the route stops existing rather than allowing a second
  // admin to be created by anyone who reaches it.
  if (url === '/setup') {
    redirect(res, '/');
    return;
  }

  // --- login / register / logout ---------------------------------------------

  if (url === '/login') {
    if (req.method === 'POST') {
      if (auth.rateLimited(req)) {
        html(res, pages.login({ error: 'Too many attempts. Wait a minute.', registrationOpen: ALLOW_REGISTRATION }), 429, {
          'Retry-After': String(auth.retryAfterS(req)),
        });
        return;
      }
      const form = (await readBody(req)) || {};
      const user = db.getUserByName(String(form.username || '').trim());
      const ok = user && db.verifyPassword(String(form.password || ''), user.password);
      if (!ok) {
        auth.recordFailure(req);
        // Deliberately does not distinguish an unknown user from a bad
        // password: that difference is free reconnaissance.
        log(`! failed login for "${String(form.username || '').slice(0, 24)}" from ${auth.clientIp(req)}`);
        html(res, pages.login({ error: 'Wrong username or password.', registrationOpen: ALLOW_REGISTRATION }), 401);
        return;
      }
      auth.clearFailures(req);
      db.touchUser(user.id);
      redirect(res, '/', { 'Set-Cookie': auth.loginCookie(req, user.id) });
      return;
    }
    // Already signed in and active? Skip the form.
    const existing = auth.userFor(req);
    if (existing && existing.status === 'active') return void redirect(res, '/');
    html(res, pages.login({ registrationOpen: ALLOW_REGISTRATION }));
    return;
  }

  if (url === '/logout') {
    redirect(res, '/login', { 'Set-Cookie': auth.logoutCookie(req) });
    return;
  }

  if (url === '/register') {
    if (!ALLOW_REGISTRATION) {
      html(res, pages.login({ error: 'Registration is closed.', registrationOpen: false }), 403);
      return;
    }
    if (req.method === 'POST') {
      if (auth.rateLimited(req)) {
        html(res, pages.register({ error: 'Too many attempts. Wait a minute.', invite: query.get('invite') }), 429, {
          'Retry-After': String(auth.retryAfterS(req)),
        });
        return;
      }
      const form = (await readBody(req)) || {};
      const fail = (msg) => {
        auth.recordFailure(req);
        // Keep the code in the box: someone who mistyped a password should not
        // have to go back to the invite link to try again.
        html(res, pages.register({ error: msg, invite: form.invite }), 400);
      };
      const username = String(form.username || '').trim();
      if (!/^[\w.-]{2,24}$/.test(username)) {
        return void fail('Username must be 2-24 characters: letters, numbers, dot, dash, underscore.');
      }
      if (String(form.password || '').length < 8) return void fail('Password must be at least 8 characters.');
      if (form.password !== form.confirm) return void fail("Passwords don't match.");
      if (db.getUserByName(username)) return void fail('That username is taken.');
      // Consume the invite last, so a failed validation doesn't burn a code.
      if (!db.consumeInvite(form.invite)) return void fail('That invite code is not valid.');

      let user;
      try {
        user = db.createUser({ username, password: form.password, role: 'viewer', status: 'pending' });
      } catch {
        return void fail('That username is taken.');
      }
      auth.clearFailures(req);
      log(`+ ${username} registered and is awaiting approval`);
      // Admins with the panel open see the new name appear immediately.
      pushAdminState();
      redirect(res, '/', { 'Set-Cookie': auth.loginCookie(req, user.id) });
      return;
    }
    // /register?invite=CODE — the link an admin hands out.
    html(res, pages.register({ invite: query.get('invite') }));
    return;
  }

  // --- the access gate -------------------------------------------------------
  // Default-deny. Everything past this point requires an active session.

  const user = auth.userFor(req);
  if (!user) {
    if (wantsHtml(req, url)) return void redirect(res, '/login');
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Sign in required');
    return;
  }
  if (user.status !== 'active') {
    if (wantsHtml(req, url)) {
      html(res, user.status === 'pending' ? pages.pending() : pages.denied(), 403);
      return;
    }
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Account not approved');
    return;
  }

  if (url === '/' || url === '/watch') {
    // libass is an emscripten pthreads build, so it needs SharedArrayBuffer,
    // which browsers only hand to a cross-origin isolated page. These two
    // headers are what buy that. Everything the page loads is same-origin, so
    // require-corp costs nothing here — but it does mean any future embed of a
    // third-party script or image needs CORP headers or it will be blocked.
    serveFile(path.join(__dirname, 'watch.html'), req, res, 'text/html; charset=utf-8', {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    return;
  }

  if (url === '/list') {
    if (Date.now() - indexedAt > 10000) buildIndex(); // cheap rescan, picks up new files
    // Which files already have an encode on disk. Read once for the whole
    // list rather than stat-ing per file, which on a few hundred entries over
    // a network share is the difference between instant and a visible pause.
    const ready = encodedIds();
    const list = [...library].map(([id, e]) => ({
      id,
      label: e.label,
      dir: e.dir,
      name: e.name,
      // Only what is already known. Probing every file to answer this would
      // run ffprobe across the whole library on first load; the Encode panel
      // fills the gaps by asking /tracks for the rows it is showing.
      encoded: ready.has(id),
      playable: trackCache.get(id)?.play?.ok ?? null,
    }));
    list.sort((a, b) => a.label.localeCompare(b.label));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
    return;
  }

  // What audio and subtitle tracks does this file carry?
  if (url.startsWith('/tracks/')) {
    const id = url.slice('/tracks/'.length);
    if (!library.get(id)) {
      res.writeHead(404).end('Not found');
      return;
    }
    probeTracks(id).then((t) => {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        // `cached` tells the client it can use the seekable file rather than
        // the live pipe, which is the difference between instant scrubbing and
        // a restarted encode per drag.
        .end(JSON.stringify({ ...t, libass: HAS_JASSUB, cached: !!cachedFile(id) }));
    });
    return;
  }

  // One subtitle stream, as WebVTT or as raw ASS.
  //
  // WebVTT is the fallback: ffmpeg's webvtt muxer keeps the timing and the
  // line breaks but throws away everything else — font, size, colour, outline,
  // border style, position. Two differently styled tracks come out looking
  // identical, styled only by our own ::cue rule. That is fine for plain
  // dialogue and wrong for anything typeset.
  //
  // So ASS is served verbatim as well, and the client renders it with libass
  // (see /vendor/ below). Same stream, same ffmpeg call, different muxer.
  const subMatch = /^\/subs\/([^/]+)\/(\d+)\.(vtt|ass)$/.exec(url);
  if (subMatch) {
    const [, id, n, fmt] = subMatch;
    const entry = library.get(id);
    if (!entry) {
      res.writeHead(404).end('Not found');
      return;
    }
    // `n` indexes the list this server published, which has the bitmap
    // formats filtered out of it. `0:s:<n>` would count them back in: a file
    // whose first subtitle stream is PGS hands the client the PGS track under
    // the ASS track's number, and the request yields nothing. The probe
    // already recorded each stream's absolute index, so map by that instead.
    probeTracks(id).then((t) => {
      const stream = t.subs[Number(n)];
      if (!stream) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No such subtitle track');
        return;
      }
      res.writeHead(200, {
        'Content-Type':
          fmt === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      const ff = require('child_process').spawn('ffmpeg', [
        '-v', 'error',
        '-i', entry.file,
        '-map', `0:${stream.index}`,
        '-f', fmt === 'ass' ? 'ass' : 'webvtt',
        'pipe:1',
      ]);
      ff.stdout.pipe(res);
      // An empty 200 beats a hung request if the stream can't be converted.
      ff.on('error', () => res.end());
      res.on('close', () => ff.kill());
    });
    return;
  }

  // Fonts attached to the container. Typeset subtitles name fonts that only
  // ship inside the MKV; without them libass substitutes, and substituted
  // metrics move every sign off its mark. Served as a concatenated stream of
  // length-prefixed blobs so one request covers a file's whole font set.
  const fontMatch = /^\/fonts\/([^/]+)\.bin$/.exec(url);
  if (fontMatch) {
    const entry = library.get(fontMatch[1]);
    if (!entry) {
      res.writeHead(404).end('Not found');
      return;
    }
    extractFonts(fontMatch[1]).then((blob) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Cross-Origin-Resource-Policy': 'same-origin',
      }).end(blob);
    });
    return;
  }

  // The libass build and its wasm, from node_modules. Same auth gate as
  // everything else; no CDN, so the tunnel stays the only thing to trust.
  if (url.startsWith('/vendor/')) {
    const name = url.slice('/vendor/'.length);
    if (name === 'throughput.js') {
      res
        .writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Cross-Origin-Resource-Policy': 'same-origin',
        })
        .end(THROUGHPUT_STUB);
      return;
    }
    const file = vendorFile(name);
    if (!file) {
      res.writeHead(404).end('Not found');
      return;
    }
    // JS goes through the rewrite; wasm and fonts are served as-is. A worker
    // script only loads into an isolated page when its own response carries
    // COEP, so every vendored file gets it.
    const coep = {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (path.extname(file) === '.js') {
      fs.readFile(file, 'utf8', (err, src) => {
        if (err) {
          res.writeHead(404).end('Not found');
          return;
        }
        res
          .writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...coep,
          })
          .end(rewriteBareImports(src));
      });
      return;
    }
    serveFile(file, req, res, VENDOR_TYPES[path.extname(file)], coep);
    return;
  }

  // --- encoded files ---------------------------------------------------------
  // A finished encode only: an ordinary MP4 with its index at the front, so
  // byte ranges work, the duration is real, and the browser's own scrub bar
  // does the seeking.
  //
  // There is deliberately no live fallback here any more. Encoding at playback
  // time meant the first viewer of an unplayable film got a fragmented pipe
  // with no index — every seek restarted ffmpeg, which cost more than the seek
  // saved, and the client needed a substitute scrub bar and a subtitle offset
  // to paper over it. Files are queued and encoded ahead of time instead, from
  // the Encode panel, so by the time anyone presses play there is a real file
  // to serve.
  const txMatch = /^\/transcode\/([^/]+)$/.exec(url);
  if (txMatch) {
    const entry = library.get(txMatch[1]);
    if (!entry) {
      res.writeHead(404).end('Not found');
      return;
    }
    const done = cachedFile(txMatch[1]);
    if (done) {
      serveFile(done, req, res, 'video/mp4');
      return;
    }
    // 409 rather than 404: the file exists, it just has not been encoded yet.
    // The client turns this into "ask the host to encode it" rather than the
    // decoder's misleading "network error".
    res.writeHead(409, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      .end('Not encoded yet');
    return;
  }

  if (url.startsWith('/media/')) {
    const entry = library.get(url.slice('/media/'.length));
    if (!entry) {
      res.writeHead(404).end('Not found');
      return;
    }
    serveFile(entry.file, req, res);
    return;
  }

  res.writeHead(404).end('Not found');
});

// --- sync --------------------------------------------------------------------

const rooms = new Map();

// Users waiting for approval, in the shape the admin UI wants.
function pendingUsers() {
  return db
    .listUsers()
    .filter((u) => u.status === 'pending')
    .map((u) => ({ id: u.id, username: u.username, createdAt: u.created_at }));
}

// The whole account picture an admin needs: who exists, who is waiting, and
// which invite codes are live. Passwords and hashes never leave db.js.
function adminState() {
  const now = Date.now();
  return {
    type: 'admin',
    users: db.listUsers().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
    })),
    invites: db
      .listInvites()
      // An expired or spent code is clutter, not information.
      .filter((i) => i.uses_remaining > 0 && (!i.expires_at || i.expires_at > now))
      .map((i) => ({
        code: i.code,
        usesRemaining: i.uses_remaining,
        expiresAt: i.expires_at,
      })),
  };
}

// A short-lived message for everyone in the room: someone joined, someone's
// connection dropped, playback was paused and why. Distinct from the log,
// which is admin-only and permanent-ish.
function notify(room, text, kind = 'info') {
  broadcast(room, { type: 'notice', kind, text, at: Date.now() });
}

// What the sidebar shows for each person in the room. Latency and drift are
// self-reported by each client — the server cannot measure a viewer's own
// playback position any other way — so they are a diagnostic, not a guarantee.
function clientStats(room) {
  const now = Date.now();
  return [...room.clients].map((c) => {
    const stale = c.statAt ? now - c.statAt > 20000 : true;
    return {
      name: c.name,
      host: !!c.isHost,
      // Buffering is the server's own view: it holds the room for these.
      buffering: room.stalled.has(c),
      rtt: stale ? null : c.rtt,
      drift: stale ? null : c.drift,
      muted: stale ? null : c.muted,
      joinedAt: c.joinedAt,
    };
  });
}

// Push the account picture to every connected admin. Called after any change,
// so two admins working at once see the same thing without refreshing.
function pushAdminState() {
  notifyAdmins(adminState());
}

// Close any live socket belonging to a user who just lost access. HTTP requests
// already re-check the database on every hit, but a WebSocket is long-lived:
// without this a denied viewer keeps receiving state until they reload.
function dropSessionsFor(userId) {
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      if (c.user?.id === userId && c.readyState === 1) {
        try {
          c.send(JSON.stringify({ type: 'revoked' }));
        } catch {}
        c.close(4003, 'Access revoked');
      }
    }
  }
}

// Push a message to every connected admin, across all rooms. Used for things
// that aren't room state — a registration arriving, a client falling behind.
function notifyAdmins(msg) {
  const data = JSON.stringify(msg);
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      if (c.isHost && c.readyState === 1) c.send(data);
    }
  }
}

// A resume is scheduled this far in the future (server clock) rather than
// applied immediately, so every client — host included — starts playback at
// the same instant instead of whenever their own "play" message happens to
// arrive. See the 'control' case below for why. Comfortably above the "high
// latency" threshold the client already warns about for its own clock RTT
// (400ms), so a normal connection has margin to spare.
const PLAY_LEAD_MS = 700;

// A pending scheduled play didn't happen after all — a re-pause, a new seek,
// someone stalling. Broadcasting again after cancelling means every client's
// apply() re-runs and lands on whatever is actually true now, rather than
// firing v.play() at a moment that no longer means anything.
function cancelScheduledPlay(room) {
  clearTimeout(room.playTimer);
  room.playTimer = null;
  room.playAt = null;
}

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, {
      // Kept so a room can delete itself from `rooms` on the way out. The map
      // is keyed by name, so the close handler needs the key, not the object.
      name,
      clients: new Set(),
      src: null,
      label: null,
      paused: true,
      time: 0,
      updatedAt: Date.now(),
      stalled: new Set(),
      audio: 0,     // index into the file's audio tracks
      sub: -1,      // -1 = subtitles off
      playAt: null,     // server-clock instant a scheduled resume fires at, or null
      playTimer: null,  // the setTimeout backing it, so a re-pause can cancel it
    });
  }
  return rooms.get(name);
}

// Where playback *should* be right now, given when we last heard about it.
function projectedTime(room) {
  if (room.paused) return room.time;
  return room.time + (Date.now() - room.updatedAt) / 1000;
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) {
    if (c !== except && c.readyState === 1) c.send(data);
  }
}

// Drop a client from the waiting set and resume if they were the last one.
function releaseStall(room, ws) {
  clearTimeout(ws.stallTimer);
  if (!room.stalled.delete(ws)) return;
  if (room.stalled.size === 0) room.updatedAt = Date.now();
  broadcast(room, stateMsg(room));
}

function stateMsg(room) {
  return {
    type: 'state',
    src: room.src,
    label: room.label,
    paused: room.paused || room.stalled.size > 0,
    time: projectedTime(room),
    serverNow: Date.now(),
    viewers: room.clients.size,
    waitingFor: [...room.stalled].map((c) => c.name),
    audio: room.audio,
    sub: room.sub,
    // Set only while a resume is scheduled but hasn't fired yet. `paused` is
    // still true at this point — the room only actually starts playing once
    // playAt passes — so a client that ignores this field sees a perfectly
    // ordinary pause at the right position, just one that is about to end.
    playAt: room.playAt,
  };
}

// Authenticate at the handshake rather than after the upgrade, so an
// unauthorised socket is never established in the first place. The cookie
// arrives as a normal header here, which is why the session can be shared with
// the HTTP side rather than passing a key in the URL.
const wss = new WebSocketServer({
  server,
  verifyClient({ req }, done) {
    if (!db.setupComplete()) return done(false, 403, 'Setup incomplete');
    const user = auth.userFor(req);
    if (!user) return done(false, 401, 'Sign in required');
    if (user.status !== 'active') return done(false, 403, 'Account not approved');
    req.wtUser = user;
    done(true);
  },
});

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const room = getRoom(params.get('room') || 'main');
  // Identity comes from the session, never from the query string. The old
  // ?name= was client-supplied and trivially spoofed, so "waiting for Dana"
  // could name anyone.
  ws.user = req.wtUser;
  ws.name = req.wtUser.username;
  ws.joinedAt = Date.now();
  ws.rtt = null;
  ws.drift = null;
  ws.muted = null;
  ws.statAt = 0;
  ws.isHost = req.wtUser.role === 'admin';
  room.clients.add(ws);

  log(`+ ${ws.name} joined${ws.isHost ? ' (admin)' : ''} — ${room.clients.size} in room`);
  ws.send(JSON.stringify({ ...stateMsg(room), you: { host: ws.isHost } }));
  if (ws.isHost) {
    ws.send(JSON.stringify(adminState()));
    ws.send(JSON.stringify(encodeState()));
  }
  // Existing viewers only need the new headcount. Sending them a full state
  // would make every one of them re-seek every time somebody joins.
  broadcast(room, { type: 'viewers', viewers: room.clients.size }, ws);
  notify(room, `${ws.name} joined`, 'join');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // Clock sync: client measures round-trip, halves it, derives offset.
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', t: msg.t, serverNow: Date.now() }));
        break;

      case 'control': { // play / pause / seek — host only
        if (!ws.isHost) {
          log(`! ${ws.name} tried to control playback without the key`);
          break;
        }
        // The anchor every viewer extrapolates from, so a NaN here does not
        // desync one client — it desyncs the room, permanently and silently.
        if (!Number.isFinite(msg.time) || msg.time < 0) break;
        vlog(`${ws.name}: ${msg.paused ? 'pause' : 'play'} @ ${(+msg.time).toFixed(2)}s`);

        // A resume (paused -> playing) is the one transition worth scheduling
        // rather than applying immediately. Every other case — pausing,
        // seeking while already playing — takes effect at once, same as
        // always: pausing has nowhere to schedule *to*, and scheduling a
        // seek would just make scrubbing feel laggy for no syncing benefit,
        // since drift correction already closes whatever gap it leaves.
        //
        // The point of a resume specifically is that "click play" and "the
        // picture actually moves" are far apart in wall-clock time once you
        // add network fan-out, and everyone's copy of that gap is a different
        // length — so applying it immediately staggers everyone's start by
        // however long their own trip happened to take. Scheduling a shared
        // future instant and having every client (including the host) wait
        // for it turns "as fast as possible, staggered" into "all at once,
        // slightly delayed" — which is the trade being made here.
        const resuming = !msg.paused && room.paused;
        cancelScheduledPlay(room);
        room.time = msg.time;
        room.updatedAt = Date.now();

        if (resuming) {
          // Stay paused — at the target position — until playAt actually
          // passes. room.paused deliberately stays true here: it is what
          // keeps projectedTime() from advancing and what stops a stall from
          // colliding with a resume that hasn't happened yet. stateMsg()
          // reports this as an ordinary pause plus a playAt for anyone who
          // knows to look at it, so a client that doesn't understand it yet
          // just sees a correctly-positioned pause and nothing plays until a
          // later message says otherwise.
          room.playAt = Date.now() + PLAY_LEAD_MS;
          broadcast(room, { ...stateMsg(room), by: ws.name });
          room.playTimer = setTimeout(() => {
            room.playTimer = null;
            // Something could have intervened in the meantime — a pause, a
            // new seek, a stall — and cancelScheduledPlay already cleared
            // playAt in that case, so this timer firing after the fact would
            // otherwise force a stale resume. Only actually start playing if
            // this schedule is still the current one.
            if (room.playAt === null) return;
            room.playAt = null;
            room.paused = false;
            room.updatedAt = Date.now();
            broadcast(room, stateMsg(room));
          }, PLAY_LEAD_MS);
        } else {
          room.paused = !!msg.paused;
          if (!room.paused) room.stalled.clear();
          broadcast(room, { ...stateMsg(room), by: ws.name });
        }
        break;
      }

      // The host saying where they actually are. Not a control: it never
      // plays, pauses or seeks anyone, it only refreshes the anchor that room
      // time is extrapolated from.
      //
      // Without it the anchor only moved when the host pressed something, so
      // an untouched film left every viewer extrapolating from a reading that
      // could be hours old — and the host's own playback rate is never exactly
      // 1.0, so the reference itself had drifted away from what the viewers
      // were being held to. They would sit steadily ahead or behind with
      // nothing able to correct it, because the thing they measured against
      // was the thing that was wrong.
      case 'heartbeat': {
        if (!ws.isHost) break;
        if (!Number.isFinite(msg.time) || msg.time < 0) break;
        // A heartbeat while the room is paused or holding for a buffering
        // viewer would undo the hold: room.time is deliberately frozen there.
        if (room.paused || room.stalled.size) break;

        const delta = msg.time - projectedTime(room);
        room.time = msg.time;
        room.updatedAt = Date.now();

        // Re-broadcasting every two seconds would have every viewer re-running
        // its correction against a figure that barely moved, and apply()
        // seeks on a 0.75s disagreement — so a steady stream of them is its
        // own source of jitter. Only tell the room when the anchor actually
        // moved enough to matter; otherwise the correction it already has is
        // still the right one.
        if (Math.abs(delta) > 0.5) {
          vlog(`${ws.name}: heartbeat re-anchored room by ${delta.toFixed(2)}s`);
          broadcast(room, stateMsg(room), ws);
        }
        break;
      }

      // Audio/subtitle choice is room-wide: everyone should be hearing the
      // same dub and reading the same subs. Host-only, like every other
      // control. Playback position is untouched, so nobody re-seeks.
      case 'tracks':
        if (!ws.isHost) break;
        if (Number.isInteger(msg.audio)) room.audio = msg.audio;
        if (Number.isInteger(msg.sub)) room.sub = msg.sub;
        log(`${ws.name} set tracks: audio=${room.audio} sub=${room.sub}`);
        // Remembered against the host who chose it, per file, so the same
        // choice comes back the next time this file is played.
        if (room.src) db.setPref(ws.user.id, room.src, { audio: room.audio, sub: room.sub });
        broadcast(room, stateMsg(room));
        break;

      case 'load': {
        if (!ws.isHost) break;
        const entry = library.get(msg.src);
        if (!entry) return;
        cancelScheduledPlay(room);
        room.src = msg.src;
        room.label = entry.label;
        room.time = 0;
        room.paused = true;
        room.updatedAt = Date.now();
        room.stalled.clear();
        // A new file has its own track list, so last file's indexes mean
        // nothing — unless this host has played this file before, in which
        // case their remembered choice is the better default.
        const saved = db.getPrefs(ws.user.id)[msg.src];
        room.audio = Number.isInteger(saved?.audio) ? saved.audio : 0;
        room.sub = Number.isInteger(saved?.sub) ? saved.sub : -1;
        log(
          `${ws.name} loaded: ${entry.label}` +
            (saved ? ` (restored audio=${room.audio} sub=${room.sub})` : '')
        );
        broadcast(room, { ...stateMsg(room), by: ws.name });
        break;
      }

      // Someone's buffer ran dry — hold everyone, but only briefly.
      case 'stall':
        if (room.paused || room.stalled.has(ws)) break;
        room.stalled.add(ws);
        room.time = projectedTime(room);
        room.updatedAt = Date.now();
        clearTimeout(ws.stallTimer);
        // If they don't recover in 15s, carry on without them. Better that
        // one person falls behind than that everyone sits frozen.
        log(`~ ${ws.name} is buffering — holding the room at ${room.time.toFixed(1)}s`);
        ws.stallTimer = setTimeout(() => {
          log(`~ ${ws.name} did not recover in 15s — carrying on without them`);
          releaseStall(room, ws);
        }, 15000);
        broadcast(room, stateMsg(room));
        break;

      case 'ready':
        if (room.stalled.has(ws)) log(`~ ${ws.name} recovered`);
        releaseStall(room, ws);
        break;

      // Whatever the client wants on the server log: decode errors, autoplay
      // blocks, buffering. Guests can't be asked to open devtools, so their
      // problems have to surface where the host can actually see them.
      case 'log':
        if (typeof msg.text === 'string') log(`[${ws.name}] ${msg.text.slice(0, 300)}`);
        break;

      // "I am closing this tab on purpose" — so the room is not paused for it.
      case 'bye':
        ws.bye = true;
        break;

      case 'admin:log':
        if (!ws.isHost) break;
        ws.watchingLog = true;
        ws.send(JSON.stringify({ type: 'log', lines: logBuffer.slice(-200) }));
        break;

      // Self-reported health, for the sidebar. Clamped because these numbers
      // are shown to other people and arrive from the client.
      case 'stat':
        ws.rtt = Number.isFinite(msg.rtt) ? Math.max(0, Math.min(Math.round(msg.rtt), 99999)) : null;
        ws.drift = Number.isFinite(msg.drift) ? Math.round(msg.drift * 100) / 100 : null;
        ws.muted = !!msg.muted;
        ws.statAt = Date.now();
        break;

      // --- account management, admin only -----------------------------------
      // All of these re-read the database and push the result to every admin,
      // so a second admin's view updates without a refresh. Each one re-checks
      // ws.isHost: the socket was authenticated at connect, but an admin can be
      // demoted while it is open.

      case 'admin:state':
        if (!ws.isHost) break;
        ws.send(JSON.stringify(adminState()));
        ws.send(JSON.stringify(encodeState()));
        break;

      // --- the encode queue, admin only -------------------------------------
      // Encoding is no longer something playback triggers, so these are the
      // only way a file gets converted. Each re-checks admin rights for the
      // same reason every other admin message does: the socket was
      // authenticated at connect and the account can be demoted while it is
      // still open.

      case 'encode:queue': {
        if (!ws.isHost) break;
        if (typeof msg.id !== 'string') break;
        const r = enqueueEncode(msg.id, ws.name);
        if (!r.ok) ws.send(JSON.stringify({ type: 'encode:error', error: r.error }));
        break;
      }

      case 'encode:cancel': {
        if (!ws.isHost) break;
        if (typeof msg.id !== 'string') break;
        const r = cancelEncode(msg.id, ws.name);
        if (!r.ok) ws.send(JSON.stringify({ type: 'encode:error', error: r.error }));
        break;
      }

      case 'encode:clear':
        if (!ws.isHost) break;
        clearFinishedEncodes();
        break;

      // Delete a converted file whose source has gone. deleteOrphan refuses
      // anything still in the library, so this cannot be turned into a way to
      // delete a conversion someone is about to watch.
      case 'encode:forget': {
        if (!ws.isHost) break;
        if (typeof msg.id !== 'string') break;
        const r = deleteOrphan(msg.id, ws.name);
        if (!r.ok) ws.send(JSON.stringify({ type: 'encode:error', error: r.error }));
        break;
      }

      case 'encode:state':
        if (!ws.isHost) break;
        ws.send(JSON.stringify(encodeState()));
        break;

      case 'admin:invite': {
        if (!ws.isHost) break;
        // A code nobody can spend is a support ticket waiting to happen, so
        // clamp rather than trust the number that arrived.
        const uses = Math.min(Math.max(parseInt(msg.uses, 10) || 1, 1), 50);
        const days = Math.min(Math.max(parseInt(msg.days, 10) || 0, 0), 365);
        const code = db.createInvite({
          createdBy: ws.user.id,
          uses,
          expiresAt: days ? Date.now() + days * 86400000 : null,
        });
        log(`${ws.name} created invite ${code} (${uses} use(s)${days ? `, ${days}d` : ''})`);
        pushAdminState();
        break;
      }

      case 'admin:revoke':
        if (!ws.isHost) break;
        if (typeof msg.code !== 'string') break;
        db.deleteInvite(msg.code);
        log(`${ws.name} revoked invite ${msg.code}`);
        pushAdminState();
        break;

      case 'admin:status': {
        if (!ws.isHost) break;
        if (!['active', 'pending', 'denied'].includes(msg.status)) break;
        const target = db.getUserById(msg.id);
        if (!target) break;
        // Losing the last admin would leave the deployment unmanageable, and
        // --reset-admin would be the only way back in.
        if (target.role === 'admin' && msg.status !== 'active' && db.countAdmins() < 2) {
          ws.send(JSON.stringify({ type: 'admin:error', error: 'That is the only admin account.' }));
          break;
        }
        db.setUserStatus(target.id, msg.status);
        log(`${ws.name} set ${target.username} to ${msg.status}`);
        pushAdminState();
        // A denied viewer should not sit there watching until they reload.
        if (msg.status !== 'active') dropSessionsFor(target.id);
        break;
      }

      case 'admin:delete': {
        if (!ws.isHost) break;
        const target = db.getUserById(msg.id);
        if (!target) break;
        if (target.role === 'admin' && db.countAdmins() < 2) {
          ws.send(JSON.stringify({ type: 'admin:error', error: 'That is the only admin account.' }));
          break;
        }
        db.deleteUser(target.id);
        log(`${ws.name} deleted ${target.username}`);
        pushAdminState();
        dropSessionsFor(target.id);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(ws.stallTimer);
    room.clients.delete(ws);
    log(`- ${ws.name} left — ${room.clients.size} in room`);
    const wasHolding = room.stalled.delete(ws);
    if (room.clients.size === 0) {
      cancelScheduledPlay(room);
      rooms.delete(room.name);
      // The encode queue deliberately keeps running. It used to be stopped
      // here, because encoding only happened for a file somebody was waiting
      // on — but a queued encode is work the host asked for ahead of time, and
      // an empty room is exactly when it should be getting on with it.
      return;
    }

    // A pending resume assumed everyone still in `room.clients` at the moment
    // it fires. Someone leaving mid-countdown — the host included — breaks
    // that assumption, so let the next real control message decide again
    // rather than have a stale timer un-pause a room whose situation changed.
    cancelScheduledPlay(room);

    // Someone dropping mid-playback is the case this exists for: the rest of
    // the room should not watch on without them. `ws.bye` is set when the
    // client says it is leaving on purpose, which is not worth stopping for.
    const droppedMidPlay = !ws.bye && !room.paused && room.src;
    if (droppedMidPlay) {
      room.time = projectedTime(room);
      room.paused = true;
      room.updatedAt = Date.now();
      log(`  paused: ${ws.name}'s connection dropped`);
      notify(room, `Paused — ${ws.name} lost connection`, 'drop');
    } else {
      notify(room, `${ws.name} left`, 'leave');
    }

    if (wasHolding && room.stalled.size === 0) room.updatedAt = Date.now();
    broadcast(room, stateMsg(room));
  });
});

// New log lines go to admins who currently have the Log tab open. Guarded by
// a flag rather than broadcast to everyone: the log names people and files.
onLogLine = (entry) => {
  const data = JSON.stringify({ type: 'logline', entry });
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      if (c.isHost && c.watchingLog && c.readyState === 1) {
        try {
          c.send(data);
        } catch {}
      }
    }
  }
};

// --- stats broadcast ---------------------------------------------------------
// One timer for the whole server. Rooms with nobody in them cost nothing, and
// the sample runs only while at least one person is connected.

setInterval(() => {
  let anyone = false;
  for (const room of rooms.values()) if (room.clients.size) anyone = true;
  if (!anyone) return;

  const server = sampleStats();
  for (const room of rooms.values()) {
    if (!room.clients.size) continue;
    const clients = clientStats(room);
    // Everyone sees who is in the room and how they are doing; only admins get
    // the machine's vitals, which are nobody else's business.
    const forViewers = JSON.stringify({ type: 'stats', clients });
    const forAdmins = JSON.stringify({ type: 'stats', clients, server });
    for (const c of room.clients) {
      if (c.readyState !== 1) continue;
      c.send(c.isHost ? forAdmins : forViewers);
    }
  }
}, 2000).unref();

// An encoder outliving the server would keep a core busy with nothing to
// receive the result, and the .part file it was writing is worthless without
// the process that was filling it.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killEncodeJob();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  sweepPartFiles();
  console.log(`watching on http://localhost:${PORT}`);
  if (VERBOSE) console.log('  verbose logging on');
  if (!db.setupComplete()) {
    console.log(`
  FIRST RUN — open http://localhost:${PORT}/setup to create the admin account.`);
    if (SETUP_TOKEN_GENERATED) console.log(`  setup token (generated for this run): ${SETUP_TOKEN}`);
    else console.log('  the setup token from SETUP_TOKEN will be required.');
  } else {
    const admins = db.countAdmins();
    const waiting = pendingUsers().length;
    console.log(`  ${admins} admin account(s)${waiting ? `, ${waiting} awaiting approval` : ''}`);
    console.log(`  forgot the password? node server.js --reset-admin <username>`);
  }
});

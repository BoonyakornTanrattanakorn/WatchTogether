// `npm run doctor` — what is installed, and what each missing piece costs.
//
// Everything optional here degrades rather than breaks, so this reports and
// exits 0. The one hard requirement is the Node version, because node:sqlite
// does not exist before it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let problems = 0;
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, detail) => {
  console.log(`  warn  ${label}${detail ? ` — ${detail}` : ''}`);
};
const bad = (label, detail) => {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  problems++;
};

function version(bin) {
  try {
    const out = execFileSync(bin, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')[0].trim();
  } catch {
    return null;
  }
}

console.log('\nwatch-together — environment check\n');

// --- node --------------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) {
  ok('node', process.version);
} else if (major >= 22) {
  warn('node', `${process.version} — node:sqlite exists but is experimental here; 24+ is what this is tested on`);
} else {
  bad('node', `${process.version} — too old: node:sqlite needs 22+, and this is tested on 24+`);
}

// node:sqlite is the one dependency with no fallback.
try {
  require('node:sqlite');
  ok('node:sqlite', 'available');
} catch {
  bad('node:sqlite', 'missing — the database cannot open without it');
}

// --- dependencies ------------------------------------------------------------
const dep = (name, what) => {
  if (fs.existsSync(path.join(__dirname, '..', 'node_modules', name))) {
    ok(name, what);
  } else {
    bad(name, `not installed — run npm install`);
  }
};
dep('ws', 'websocket sync');
dep('jassub', 'ASS/SSA subtitle rendering');

// --- ffmpeg ------------------------------------------------------------------
const ffmpeg = version('ffmpeg');
const ffprobe = version('ffprobe');

if (ffprobe) {
  ok('ffprobe', ffprobe.replace(/^ffprobe version /, '').split(' ')[0]);
} else {
  warn('ffprobe', 'not on PATH — no track pickers, no codec warnings, no subtitles');
}

if (ffmpeg) {
  ok('ffmpeg', ffmpeg.replace(/^ffmpeg version /, '').split(' ')[0]);

  // Which encoders actually work, rather than which are merely compiled in.
  // This is what decides whether transcoding is viable on a given machine.
  let encoders = '';
  try {
    encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {}
  if (/\blibx264\b/.test(encoders)) {
    ok('libx264', 'software H.264 — used for transcoding unplayable files');
  } else {
    warn('libx264', 'missing — HEVC and other unplayable files cannot be converted');
  }
} else {
  warn('ffmpeg', 'not on PATH — no subtitle extraction and no transcoding');
}

// --- data directory ----------------------------------------------------------
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
  const db = path.join(dataDir, 'app.db');
  ok('data directory', fs.existsSync(db) ? `${dataDir} (app.db present)` : `${dataDir} (empty — first run will set up)`);
} catch (e) {
  bad('data directory', `${dataDir} is not writable — ${e.code || e.message}`);
}

console.log(
  problems
    ? `\n${problems} problem(s) above will stop the server from working.\n`
    : '\nEverything needed is present.\n'
);

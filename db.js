// Persistence: users, invites, and a small key/value settings table.
//
// node:sqlite is built into Node 22+, so this adds no dependency. The project's
// premise is one npm package and no build step, and that still holds.
//
// Everything else — room state, the library index, telemetry — stays in memory
// deliberately. It is derived or ephemeral, it is hot, and persisting it buys
// nothing but complexity.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

let db;

// --- schema ------------------------------------------------------------------
// Applied on every boot. Each statement is idempotent, so this doubles as the
// migration path for a database that already exists.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password     TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  status       TEXT NOT NULL CHECK (status IN ('pending', 'active', 'denied')),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  prefs        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code           TEXT PRIMARY KEY,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  uses_remaining INTEGER NOT NULL,
  expires_at     INTEGER
);

-- ffprobe's verdict for a file, keyed by library id. Everything else derived
-- from the library stays in memory (see the note at the top of this file),
-- but ffprobe is a real subprocess and a library can run into the hundreds of
-- files: without this, every server restart re-shells out to ffprobe for the
-- whole library the moment a host's page asks the Encode panel to render.
CREATE TABLE IF NOT EXISTS track_cache (
  id    TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
// add a column to a table that already exists, so each one is applied here and
// the duplicate-column error is the "already migrated" case.
const ADDED_COLUMNS = [
  // Bumped on every login, and carried in the session token. An older token
  // stops verifying, which is what makes one account mean one browser.
  ['users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0'],
  // Remembered audio and subtitle choice, per user per file.
  ['users', 'prefs', 'TEXT'],
];

function migrate() {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    } catch (e) {
      // "duplicate column name" means a previous boot already added it.
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
}

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  // WAL survives an unclean container stop far better than the default
  // rollback journal, and allows reads during a write.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();
  return db;
}

// --- settings ----------------------------------------------------------------

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// The secret that signs session cookies. Taken from the environment when set,
// so it can be rotated deliberately; otherwise generated once and kept, so
// there is nothing mandatory to configure and sessions survive a restart.
function serverSecret() {
  if (process.env.SERVER_SECRET) return process.env.SERVER_SECRET;
  let s = getSetting('server_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('server_secret', s);
  }
  return s;
}

// --- track cache ---------------------------------------------------------------
// ffprobe's verdict for a file, by library id. The id is a content hash, so a
// stale row just means "this exact file was probed before" — never wrong,
// only possibly redundant, which is why there is no expiry.

function getTrackCache(id) {
  const row = db.prepare('SELECT value FROM track_cache WHERE id = ?').get(id);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function setTrackCache(id, value) {
  db.prepare(
    'INSERT INTO track_cache (id, value) VALUES (?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET value = excluded.value'
  ).run(id, JSON.stringify(value));
}

function deleteTrackCache(id) {
  db.prepare('DELETE FROM track_cache WHERE id = ?').run(id);
}

// --- passwords ---------------------------------------------------------------
// scrypt, stored as `salt$hash`. Both halves hex. ~26ms per hash on this
// machine: slow enough to cost an attacker, fast enough for a login.

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    // timingSafeEqual throws on a length mismatch, hence the try/catch and the
    // explicit length check above. Never compare with === : that leaks the
    // answer through timing.
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- users -------------------------------------------------------------------

function createUser({ username, password, role, status }) {
  const info = db
    .prepare(
      'INSERT INTO users (username, password, role, status, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(username, hashPassword(password), role, status, Date.now());
  return getUserById(Number(info.lastInsertRowid));
}

function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all();
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

// Setup mode is "no admin exists yet". Derived rather than stored, so it can
// never disagree with reality.
function setupComplete() {
  return countAdmins() > 0;
}

function setUserStatus(id, status) {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
}

function setUserPassword(id, password) {
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), id);
}

function touchUser(id) {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

// --- one account, one browser ------------------------------------------------
// Sessions are stateless signed cookies, so there is no table to delete from.
// Instead each user carries an epoch that the token is signed against: a new
// login bumps it, and every token issued before that stops verifying.

function bumpSessionEpoch(id) {
  const row = db
    .prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ? RETURNING session_epoch')
    .get(id);
  return row ? row.session_epoch : 0;
}

function sessionEpoch(id) {
  const row = db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(id);
  return row ? row.session_epoch : null;
}

// --- remembered track choices ------------------------------------------------
// Audio and subtitle picks, keyed by file id, so choosing "English subs" once
// holds for that file next time. Stored as JSON in a single column rather than
// a table: it is small, read whole, and never queried across users.

function getPrefs(id) {
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(id);
  if (!row || !row.prefs) return {};
  try {
    const parsed = JSON.parse(row.prefs);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt blob should cost a preference, not a login.
    return {};
  }
}

function setPref(id, fileId, pref) {
  const prefs = getPrefs(id);
  prefs[fileId] = pref;
  // Keep the newest 200 files. Without a cap this grows for the life of the
  // account, and nobody needs the subtitle choice from two years ago.
  const keys = Object.keys(prefs);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete prefs[k];
  }
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), id);
  return prefs;
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// --- invites -----------------------------------------------------------------

function createInvite({ createdBy, uses = 1, expiresAt = null }) {
  // Base32-ish, no vowels and no easily confused characters, so a code can be
  // read aloud or typed without ambiguity.
  const alphabet = '23456789BCDFGHJKMNPQRSTVWXYZ';
  let code = '';
  const bytes = crypto.randomBytes(10);
  for (const b of bytes) code += alphabet[b % alphabet.length];
  code = code.slice(0, 10);
  db.prepare(
    'INSERT INTO invites (code, created_by, created_at, uses_remaining, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(code, createdBy ?? null, Date.now(), uses, expiresAt);
  return code;
}

function listInvites() {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all();
}

function deleteInvite(code) {
  db.prepare('DELETE FROM invites WHERE code = ?').run(code);
}

// Atomically consume one use. Returns true only if a usable code was found and
// decremented, so two simultaneous registrations cannot both spend the last
// use of a single-use code.
function consumeInvite(code) {
  const info = db
    .prepare(
      'UPDATE invites SET uses_remaining = uses_remaining - 1 ' +
        'WHERE code = ? AND uses_remaining > 0 ' +
        'AND (expires_at IS NULL OR expires_at > ?)'
    )
    .run(String(code || '').trim().toUpperCase(), Date.now());
  return info.changes > 0;
}

module.exports = {
  open,
  get handle() {
    return db;
  },
  getSetting,
  setSetting,
  serverSecret,
  hashPassword,
  verifyPassword,
  createUser,
  getUserByName,
  getUserById,
  listUsers,
  countAdmins,
  setupComplete,
  setUserStatus,
  setUserPassword,
  touchUser,
  deleteUser,
  bumpSessionEpoch,
  sessionEpoch,
  getPrefs,
  setPref,
  getTrackCache,
  setTrackCache,
  deleteTrackCache,
  createInvite,
  listInvites,
  deleteInvite,
  consumeInvite,
};

// Covers the parts of db.js where a bug is a security bug: password
// verification, invite consumption, and the setup-mode derivation that gates
// the whole server on first run.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-db-'));
const db = require('../db.js');

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

db.open(path.join(tmp, 'sub', 'app.db'));

// --- schema and bootstrap ----------------------------------------------------

say(fs.existsSync(path.join(tmp, 'sub', 'app.db')), 'creates the database and its parent directory');
say(db.setupComplete() === false, 'setup incomplete when no admin exists');
say(db.countAdmins() === 0, 'no admins on a fresh database');

// Re-opening must not fail on existing tables. Close the first handle first:
// Windows will not let the file be removed while any handle is open.
db.handle.close();
db.open(path.join(tmp, 'sub', 'app.db'));
say(true, 'schema is idempotent across reopen');

// --- passwords ---------------------------------------------------------------

const h1 = db.hashPassword('correct-horse');
const h2 = db.hashPassword('correct-horse');
say(h1 !== h2, 'same password hashes differently (distinct salts)');
say(!h1.includes('correct-horse'), 'plaintext never appears in the stored hash');
say(db.verifyPassword('correct-horse', h1), 'correct password verifies');
say(!db.verifyPassword('wrong', h1), 'wrong password rejected');
say(!db.verifyPassword('', h1), 'empty password rejected');
say(!db.verifyPassword('correct-horse', 'garbage'), 'malformed stored hash rejected, does not throw');
say(!db.verifyPassword('correct-horse', ''), 'empty stored hash rejected');
say(!db.verifyPassword('correct-horse', 'aabb$ccdd'), 'wrong-length hash rejected, does not throw');

// --- users -------------------------------------------------------------------

const admin = db.createUser({
  username: 'owner',
  password: 'admin-pw',
  role: 'admin',
  status: 'active',
});
say(admin.id > 0, 'creates a user');
say(db.setupComplete() === true, 'setup complete once an admin exists');

const found = db.getUserByName('OWNER');
say(found && found.id === admin.id, 'username lookup is case-insensitive');

let dupeRejected = false;
try {
  db.createUser({ username: 'Owner', password: 'x', role: 'viewer', status: 'pending' });
} catch {
  dupeRejected = true;
}
say(dupeRejected, 'duplicate username rejected regardless of case');

let badRoleRejected = false;
try {
  db.createUser({ username: 'x1', password: 'x', role: 'superuser', status: 'active' });
} catch {
  badRoleRejected = true;
}
say(badRoleRejected, 'invalid role rejected by schema constraint');

let badStatusRejected = false;
try {
  db.createUser({ username: 'x2', password: 'x', role: 'viewer', status: 'banned' });
} catch {
  badStatusRejected = true;
}
say(badStatusRejected, 'invalid status rejected by schema constraint');

const viewer = db.createUser({
  username: 'dana',
  password: 'viewer-pw',
  role: 'viewer',
  status: 'pending',
});
db.setUserStatus(viewer.id, 'active');
say(db.getUserById(viewer.id).status === 'active', 'status updates');

db.setUserPassword(viewer.id, 'new-pw');
say(db.verifyPassword('new-pw', db.getUserById(viewer.id).password), 'password reset works');
say(!db.verifyPassword('viewer-pw', db.getUserById(viewer.id).password), 'old password no longer valid');

// --- server secret -----------------------------------------------------------

const s1 = db.serverSecret();
const s2 = db.serverSecret();
say(s1 === s2 && s1.length >= 32, 'server secret is generated once and persists');

// --- invites -----------------------------------------------------------------

const code = db.createInvite({ createdBy: admin.id, uses: 1 });
say(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{10}$/.test(code), `invite code is unambiguous (${code})`);
say(db.consumeInvite(code) === true, 'valid invite consumes');
say(db.consumeInvite(code) === false, 'single-use invite cannot be reused');
say(db.consumeInvite('NOSUCHCODE') === false, 'unknown invite rejected');
say(db.consumeInvite('') === false, 'empty invite rejected');
say(db.consumeInvite(null) === false, 'null invite rejected');

const multi = db.createInvite({ createdBy: admin.id, uses: 3 });
say(
  db.consumeInvite(multi) && db.consumeInvite(multi) && db.consumeInvite(multi),
  'multi-use invite consumes exactly its allowance'
);
say(db.consumeInvite(multi) === false, 'multi-use invite exhausts');

say(db.consumeInvite(code.toLowerCase()) === false, 'exhausted code stays exhausted in any case');
const caseCode = db.createInvite({ createdBy: admin.id, uses: 1 });
say(db.consumeInvite(caseCode.toLowerCase()) === true, 'invite codes accepted case-insensitively');

const expired = db.createInvite({ createdBy: admin.id, uses: 1, expiresAt: Date.now() - 1000 });
say(db.consumeInvite(expired) === false, 'expired invite rejected');

const future = db.createInvite({ createdBy: admin.id, uses: 1, expiresAt: Date.now() + 60000 });
say(db.consumeInvite(future) === true, 'unexpired invite accepted');

// --- cleanup -----------------------------------------------------------------

db.deleteUser(viewer.id);
say(db.getUserById(viewer.id) === undefined, 'deletes a user');

try {
  db.handle.close();
} catch {}
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

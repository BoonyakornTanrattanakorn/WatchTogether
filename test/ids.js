// Verifies the property step 0.4 exists for: /media/<id> must survive moving
// the library to a different parent directory.
//
// Exercises buildIndex() in-process rather than over HTTP. /list now requires
// a session, and standing up auth here would test the gate rather than the
// ids. The index is what actually determines the ids, so that is what this
// drives.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ids-'));
const SERVER = path.join(__dirname, '..', 'server.js');

let failed = 0;
const say = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

function makeTree(base) {
  fs.mkdirSync(path.join(base, 'Season 1'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Season 1', 'ep01.mkv'), '');
  fs.writeFileSync(path.join(base, 'Season 1', 'ep02.mkv'), '');
  fs.writeFileSync(path.join(base, 'movie.mp4'), '');
  return base;
}

// The server dumps its index with --print-index and exits, so this tests the
// real indexing path without standing up auth.
function indexFor(dirs) {
  const stdout = execFileSync(
    process.execPath,
    [SERVER, ...dirs, '-r', '--print-index'],
    {
      encoding: 'utf8',
      cwd: path.dirname(SERVER),
      env: { ...process.env, DATA_DIR: path.join(tmp, 'data') },
    }
  );
  return JSON.parse(stdout.trim().split('\n').pop());
}

const a = makeTree(path.join(tmp, 'here', 'library'));
const b = makeTree(path.join(tmp, 'moved', 'elsewhere', 'library'));

const listA = indexFor([a]);
const listB = indexFor([b]);

const idsA = listA.map((f) => f.id).sort();
const idsB = listB.map((f) => f.id).sort();

say(listA.length === 3, `indexed 3 files (got ${listA.length})`);
say(
  JSON.stringify(idsA) === JSON.stringify(idsB),
  'ids identical after moving the library to a different parent'
);
if (JSON.stringify(idsA) !== JSON.stringify(idsB)) {
  console.log('     ' + a + ': ' + JSON.stringify(idsA));
  console.log('     ' + b + ': ' + JSON.stringify(idsB));
}
say(new Set(idsA).size === 3, 'no collisions within one root');

// Two roots each holding the same relative filename must not collide.
const c1 = path.join(tmp, 'r1');
const c2 = path.join(tmp, 'r2');
fs.mkdirSync(c1, { recursive: true });
fs.mkdirSync(c2, { recursive: true });
fs.writeFileSync(path.join(c1, 'same.mkv'), '');
fs.writeFileSync(path.join(c2, 'same.mkv'), '');

const listC = indexFor([c1, c2]);
say(listC.length === 2, `two roots with the same filename both indexed (got ${listC.length})`);
say(new Set(listC.map((f) => f.id)).size === 2, 'same relative name in two roots does not collide');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

// Plain-node test runner. No framework on purpose: the project's premise is
// no build step and one dependency, and these tests are pure-function checks
// that need nothing more.
//
//   node test/run.js
//
// Functions under test are extracted from server.js by source, so the tests
// exercise the real code rather than a copy that can drift.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Pull a top-level `function name(...) { ... }` out of server.js and return it.
// Relies on the closing brace being at column 0, which is true for every
// function in this file and is checked by the tests failing loudly if not.
function extract(name) {
  const re = new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm');
  const m = SRC.match(re);
  if (!m) throw new Error(`could not find function ${name}() in server.js`);
  return m[0];
}

let passed = 0;
let failed = 0;
const failures = [];

function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
  } else {
    failed++;
    failures.push(`  ${label}\n    got  ${g}\n    want ${w}`);
  }
}

function group(name, fn) {
  const before = failed;
  fn();
  const mark = failed === before ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}`);
}

// --- splitPathList -----------------------------------------------------------
// A value authored on Windows (';') must not become one nonsense path on Linux,
// and a drive letter ("F:/media") must not split at the colon.

group('splitPathList', () => {
  eval(extract('splitPathList'));

  check('windows list', splitPathList('F:/a;F:/b'), ['F:/a', 'F:/b']);
  check('posix list', splitPathList('/a:/b'), ['/a', '/b']);
  check('single posix', splitPathList('/media'), ['/media']);
  check('single windows', splitPathList('D:/Media/Films'), ['D:/Media/Films']);
  check('backslashes', splitPathList('C:\\x;D:\\y'), ['C:\\x', 'D:\\y']);
  check('three posix', splitPathList('/a:/b:/c'), ['/a', '/b', '/c']);
  check('mixed separators', splitPathList('F:/a;/mnt/b'), ['F:/a', '/mnt/b']);
  check('drive then posix', splitPathList('F:/a:/mnt/b'), ['F:/a', '/mnt/b']);
  check('container default', splitPathList('/media:/srv/tv'), ['/media', '/srv/tv']);
  check('empty segments', splitPathList('F:/a;;F:/b'), ['F:/a', 'F:/b']);
  check('whitespace', splitPathList(' /a ; /b '), ['/a', '/b']);
});

// --- parseRange --------------------------------------------------------------
// Subtle and load-bearing: getting suffix ranges wrong returns the head of a
// file under a Content-Range claiming it is the tail, which browsers report as
// a corrupt file the moment you seek. Highest value per line of test in the
// project.

group('parseRange', () => {
  eval(extract('parseRange'));

  const SIZE = 1000;

  check('absent header', parseRange(undefined, SIZE), null);
  check('empty header', parseRange('', SIZE), null);
  check('malformed', parseRange('bytes=abc', SIZE), null);
  check('multipart', parseRange('bytes=0-99,200-299', SIZE), null);
  check('bare dash', parseRange('bytes=-', SIZE), null);

  check('explicit window', parseRange('bytes=200-499', SIZE), { start: 200, end: 499 });
  check('open ended', parseRange('bytes=200-', SIZE), { start: 200, end: 999 });
  check('from zero', parseRange('bytes=0-', SIZE), { start: 0, end: 999 });
  check('single byte', parseRange('bytes=5-5', SIZE), { start: 5, end: 5 });

  // The important one: a suffix range is the LAST n bytes, not "0 to n".
  check('suffix', parseRange('bytes=-500', SIZE), { start: 500, end: 999 });
  check('suffix larger than file', parseRange('bytes=-5000', SIZE), { start: 0, end: 999 });
  check('suffix of zero', parseRange('bytes=-0', SIZE), false);

  // Players routinely ask past the end and expect a clamp, not a rejection.
  check('clamped end', parseRange('bytes=900-99999', SIZE), { start: 900, end: 999 });

  check('start past end of file', parseRange('bytes=1000-', SIZE), false);
  check('start beyond size', parseRange('bytes=5000-6000', SIZE), false);
  check('inverted', parseRange('bytes=500-200', SIZE), false);

  check('whitespace tolerated', parseRange('  bytes=0-99  ', SIZE), { start: 0, end: 99 });
});

// --- report ------------------------------------------------------------------

console.log('');
if (failures.length) console.log(failures.join('\n') + '\n');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// bin/lint-cli.js run as a child process: exit codes, piped output, and
// --diff from a project that is a subdirectory of its git repo. Each run
// boots pmake (~8s), so the cases share as few runs as possible.

var h = require('./_harness');
var test = h.test, section = h.section;
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

section('lint-cli — child process');

var CLI = path.join(__dirname, '..', 'bin', 'lint-cli.js');
var FOAM3 = globalThis.__foamLSPRoots__.foam3;

function run(cwd, args) {
  return cp.spawnSync('node', [ CLI ].concat(args), {
    cwd: cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { FOAM3_ROOT: FOAM3 }),
    stdio: [ 'ignore', 'pipe', 'pipe' ]
  });
}
function git(cwd, args) {
  cp.execFileSync('git', [ '-c', 'user.email=t@t', '-c', 'user.name=t' ].concat(args), { cwd: cwd, stdio: 'ignore' });
}

// A project one directory below its git top level, with one class its pom
// lists (so the index has a source root) and two that no pom lists (pom-membership anchors each finding on the class's own file, so the
// scope filter has to match by path) and one rule that names a rule group
// defined nowhere.
var REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'foam-lint-cli-'));
var APP  = path.join(fs.realpathSync(REPO), 'app');
fs.mkdirSync(path.join(APP, 'deployment', 'beta'), { recursive: true });
fs.writeFileSync(path.join(APP, 'pom.js'), 'foam.POM({ name: "app", projects: [ { name: "foam3/pom" } ], files: [ { name: "src/x/Listed", flags: "js" } ] });\n');
fs.symlinkSync(FOAM3, path.join(APP, 'foam3'));
fs.writeFileSync(path.join(APP, 'deployment', 'beta', 'rules.jrl'),
  'p({"class":"foam.core.ruler.Rule","id":"beta-rule","ruleGroup":"missing-group"})\n');
['Listed', 'Changed', 'Untouched'].forEach(function(n) {
  fs.mkdirSync(path.join(APP, 'src', 'x'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'src', 'x', n + '.js'), 'foam.CLASS({ package: "x", name: "' + n + '" });\n');
});
git(REPO, [ 'init', '-q' ]);
git(REPO, [ 'add', '.' ]);
git(REPO, [ 'commit', '-q', '-m', 'base' ]);
fs.appendFileSync(path.join(APP, 'src', 'x', 'Changed.js'), '\n');

// A bad ref is a usage error (documented exit 2), not a lint failure.
var bad = run(APP, [ '--diff', 'no-such-ref', '--checks', 'rule-group' ]);
test(bad.status === 2, 'bad --diff ref exits 2 (got ' + bad.status + ')');
test(/bad revision 'no-such-ref'/.test(bad.stderr), 'bad --diff ref names the ref on stderr');

// git top level is REPO, cwd is APP: git reports the changed class as
// app/src/x/Changed.js, which must still resolve to APP/src/x/Changed.js.
var diff = run(APP, [ '--diff', 'HEAD', '--checks', 'pom-membership', '--format', 'json' ]);
var parsed = null;
try { parsed = JSON.parse(diff.stdout); } catch (e) {}
var paths = parsed ? parsed.findings.map(function(f) { return path.relative(APP, f.path); }) : [];
test(paths.length === 1 && paths[0] === path.join('src', 'x', 'Changed.js'),
  '--diff from a repo subdirectory reports only the changed class (got ' + JSON.stringify(paths) + ')');

// Full-workspace JSON is larger than a 64 KiB pipe buffer; it must arrive whole.
var full = run(FOAM3, [ '--format', 'json' ]);
var fullParsed = null;
try { fullParsed = JSON.parse(full.stdout); } catch (e) {}
test(fullParsed && Array.isArray(fullParsed.findings), 'large piped --format json output parses (' + full.stdout.length + ' bytes)');
test(full.status === ( fullParsed && fullParsed.errors > 0 ? 1 : 0 ), 'exit code follows the findings');

fs.rmSync(REPO, { recursive: true, force: true });

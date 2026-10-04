/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Unit test for lib/resolveFoam.js. No FOAM boot. Usage: node test/resolveFoam.js

var fs   = require('fs');
var os   = require('os');
var path = require('path');
var resolveFoam = require('../lib/resolveFoam');

var failures = 0;
function test(ok, msg) { console.error(( ok ? 'PASS ' : 'FAIL ' ) + msg); if ( ! ok ) failures++; }
function throws(fn, re) { try { fn(); return false; } catch (e) { return re.test(e.message); } }

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve foam ')));
function foamAt(dir) { fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src', 'foam.js'), ''); }

// App with foam3 as a submodule
var app = path.join(tmp, 'app'); foamAt(path.join(app, 'foam3'));
var r = resolveFoam(app, {});
test(r.project === app && r.foam3 === path.join(app, 'foam3'), 'app with foam3 submodule');

// Project is foam3 itself, reached through its `foam3 -> .` symlink
var f3 = path.join(tmp, 'foam3'); foamAt(f3); fs.symlinkSync('.', path.join(f3, 'foam3'));
r = resolveFoam(f3, {});
test(r.project === f3 && r.foam3 === f3, 'project is foam3 (symlink) gives one canonical root');

// Project is foam3 without the symlink
var bare = path.join(tmp, 'bare'); foamAt(bare);
test(resolveFoam(bare, {}).foam3 === bare, 'project is foam3 (no symlink)');

// FOAM3_ROOT wins over the project's own foam3
var other = path.join(tmp, 'other'); foamAt(other);
test(resolveFoam(app, { FOAM3_ROOT: other }).foam3 === other, 'FOAM3_ROOT wins');

// Bad FOAM3_ROOT is an error, not a fallback
test(throws(function() { resolveFoam(app, { FOAM3_ROOT: path.join(tmp, 'nope') }); }, /FOAM3_ROOT=.*has no src\/foam\.js/),
  'bad FOAM3_ROOT throws naming the variable');

// No foam3 anywhere
var none = path.join(tmp, 'none'); fs.mkdirSync(none);
test(throws(function() { resolveFoam(none, {}); }, /no foam3 found under .*set FOAM3_ROOT/), 'missing foam3 throws');

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);

/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Project-dependent paths come from the resolved roots, not process.cwd(),
// so the LSP behaves the same whatever directory a launcher starts it in.

var h    = require('./_harness');
var os   = require('os');
var test = h.test;

h.section('Resolved roots');
var roots = globalThis.__foamLSPRoots__;
test(roots && roots.project && roots.foam3, 'harness exposes __foamLSPRoots__');

var orig = process.cwd();
process.chdir(os.tmpdir());
try {
  var r = foam.parse.lsp.CSSTokenResolver.create();
  r.loadFromJournals();
  test(Object.keys(r.themeNames_).length > 0, 'theme names load when cwd is outside the project');

  var jrls = h.workspaceWalk.call(h.index);
  test(jrls.some(function(p) { return p.indexOf(roots.foam3) === 0; }), 'workspace .jrl walk starts at the project root');
} finally {
  process.chdir(orig);
}

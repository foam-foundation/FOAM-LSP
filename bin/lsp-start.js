/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Entry point for FOAM LSP server.
// Usage: node <FOAM-LSP>/bin/lsp-start.js [pom-path]   (cwd = project root)
//
// Uses pmake (same as build.sh) to correctly load all FOAM models,
// then starts the LSP JSON-RPC server on stdio.
//
// stdout = JSON-RPC channel, ALL logging goes to stderr.

// Redirect console.log to stderr BEFORE anything loads
console.log = function() { console.error.apply(console, arguments); };
console.warn = function() { console.error.apply(console, arguments); };

// Prevent unhandled rejections from crashing the process.
// Web-only code like JsLib.installLib() may reference 'document' which
// doesn't exist in Node.js — these are non-fatal for the LSP.
process.on('unhandledRejection', function(e) {
  console.error('[LSP] Ignoring unhandled rejection:', e.message || e);
});
process.on('uncaughtException', function(e) {
  // Our pipes are gone (parent died). Logging below would EPIPE again and
  // re-enter this handler forever — a 100% CPU spin. Exit instead.
  if ( e && ( e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED' ) ) {
    process.exit(0);
  }
  // Ignore web-only errors (document, window, etc.)
  if ( e.message && ( e.message.includes('document') || e.message.includes('window') ) ) {
    console.error('[LSP] Ignoring web-only error:', e.message);
    return;
  }
  // Don't crash on syntax errors in loaded files — they're user's in-progress edits
  if ( e instanceof SyntaxError ) {
    console.error('[LSP] Ignoring SyntaxError in loaded file:', e.message);
    return;
  }
  // Log but don't crash — keep the server alive
  console.error('[LSP] Uncaught error (non-fatal):', e.message);
});

// Set globals that buildlib expects (normally set by build.js)
globalThis.SILENT  = false;
globalThis.VERBOSE = false;
globalThis.DRY_RUN = false;
globalThis.HELP    = false;
globalThis.NOP     = '';

var path_       = require('path');
var resolveFoam = require('../lib/resolveFoam');

var pomPath = path_.resolve(process.argv[2] || path_.join(process.cwd(), 'pom'));

var roots;
try {
  roots = resolveFoam(path_.dirname(pomPath));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
globalThis.__foamLSPRoots__ = roots;

var pmake = require(path_.join(roots.foam3, 'tools', 'pmake'));
var buildlib = require(path_.join(roots.foam3, 'tools', 'buildlib'));

// Override buildlib.error to not exit — keep LSP alive even if POM loading has errors
buildlib.error = function() {
  console.error('[LSP] Build error (non-fatal):', Array.prototype.join.call(arguments, ' '));
};

// pmake finds a maker at <foam3>/tools/<path>/<name>Maker.js, so -path points
// it from foam3's tools/ at this repo's LSPMaker.js. Quoted so a path with
// spaces stays one argument (foam3 tools/processArgs.js).
var makerDir = path_.relative(path_.join(roots.foam3, 'tools'), path_.join(__dirname, '..'));
pmake.bind(buildlib, "-makers=LSP -path='" + makerDir + "' -pom='" + pomPath + "'")();

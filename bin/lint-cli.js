#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Registration-completeness lint, CLI entry point for CI / pre-push.
// Boots pmake directly (no LSP server) — pays the index boot (~30s) per run;
// intended for CI jobs and pre-push, not per-commit hooks.
//
// Usage, from the FOAM project root (the dir containing pom.js + foam3/):
//   node <FOAM-LSP>/bin/lint-cli.js [--diff <ref>] [--checks a,b]
//        [--strategy-targets x,y] [--format text|json] [--strict]

var path = require('path');
var cp   = require('child_process');

function arg(flag) {
  var i = process.argv.indexOf(flag);
  return i === -1 ? null : ( process.argv[i + 1] || '' );
}
var has = function(flag) { return process.argv.indexOf(flag) !== -1; };

// Silence the console noise the LSP boot produces on stdout; findings go to
// stdout, boot chatter to stderr (same trick as the test harness).
console.log = function() { console.error.apply(console, arguments); };

var resolveFoam = require('../lib/resolveFoam');
var roots;
try {
  roots = resolveFoam(process.cwd());
} catch (e) {
  console.error('lint-cli: ' + e.message);
  process.exit(2);
}
globalThis.__foamLSPRoots__ = roots;

var pmake    = require(path.join(roots.foam3, 'tools', 'pmake'));
var buildlib = require(path.join(roots.foam3, 'tools', 'buildlib'));
buildlib.error = function() {};
globalThis.SILENT = false; globalThis.VERBOSE = false;
globalThis.DRY_RUN = false; globalThis.HELP = false; globalThis.NOP = '';
process.on('unhandledRejection', function() {});

// pmake finds a maker at <foam3>/tools/<path>/<name>Maker.js, so -path points
// it from foam3's tools/ at this repo's LSPMaker.js, as bin/lsp-start.js does.
var makerDir = path.relative(path.join(roots.foam3, 'tools'), path.join(__dirname, '..'));
try {
  pmake.bind(buildlib, "-makers=LSP -path='" + makerDir + "' -pom='" + path.resolve(process.cwd(), 'pom') + "'")();
} catch (e) {
  console.error('lint-cli: pmake boot failed: ' + e.message);
  process.exit(2);
}

// LSPMaker started the stdio server (src/server.js:99-108). Its stdin reader
// both keeps the process alive when stdin stays open and calls process.exit(0)
// when stdin closes, which cuts a pending write and turns an error exit into 0.
// A CLI run has no client to serve, so detach it before any output.
process.stdin.removeAllListeners('data');
process.stdin.removeAllListeners('end');
process.stdin.pause();

var index = foam.parse.lsp.FoamIndex.create();
index.buildFileIndex();
var validator = foam.parse.lsp.handlers.PomValidator.create({ index: index });
var handler   = foam.parse.lsp.handlers.LintHandler.create({ index: index, pomValidator: validator });

var params = {};
if ( arg('--checks') )           params.checks = arg('--checks').split(',');
if ( arg('--strategy-targets') ) params.strategyTargets = arg('--strategy-targets').split(',');
if ( arg('--diff') != null ) {
  var ref = arg('--diff');
  if ( ! ref || ref.charAt(0) === '-' ) ref = 'HEAD';
  // --relative makes the paths cwd-relative (and drops files outside cwd), the
  // same base as `git ls-files --others` and as LintHandler.root. Without it
  // they are relative to the git top level and match nothing when the project
  // is a repo subdirectory. execFileSync takes no shell, so a ref is never
  // interpreted; `--` stops a ref from being read as a path.
  var out, untracked;
  try {
    out = cp.execFileSync('git', [ 'diff', '--name-only', '--relative', ref, '--' ],
        { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] });
    untracked = cp.execFileSync('git', [ 'ls-files', '--others', '--exclude-standard' ],
        { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] });
  } catch (e) {
    console.error('lint-cli: git failed for --diff ' + ref + ': ' + ( e.stderr ? e.stderr.toString().trim() : e.message ));
    process.exit(2);
  }
  var changed = out.split('\n').concat(untracked.split('\n')).filter(Boolean);
  params.scope = 'paths';
  params.paths = changed.filter(function(p, i) { return changed.indexOf(p) === i; });
}

handler.lint(params).then(report, function(e) {
  console.error('lint-cli: ' + e.message);
  process.exit(2);
});

function report(result) {
  var findings = result.findings;
  var errors   = findings.filter(function(f) { return f.severity === 'error'; }).length;
  var warns    = findings.length - errors;

  var output = '';
  if ( arg('--format') === 'json' ) {
    output = JSON.stringify({ findings: findings, errors: errors, warns: warns }, null, 2) + '\n';
  } else {
    for ( var i = 0 ; i < findings.length ; i++ ) {
      var f = findings[i];
      output += (
        f.severity.toUpperCase().padEnd(6) + ' ' + f.check.padEnd(16) + ' ' +
        path.relative(process.cwd(), f.path) + ':' + f.line + '\n' +
        '       ' + f.message + '\n' +
        ( f.fix ? '       fix: ' + f.fix + '\n' : '' ));
    }
    output += '---\n' + errors + ' error(s), ' + warns + ' warn(s)\n';
  }

  // exitCode, not exit(): process.exit() straight after a large write to a pipe
  // drops what the pipe has not yet taken (macOS pipes take 64 KiB at a time).
  process.exitCode = errors > 0 || ( has('--strict') && warns > 0 ) ? 1 : 0;
  process.stdout.write(output);
}

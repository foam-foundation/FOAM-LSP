/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Registration-completeness lint (LintHandler): jrl discovery, rule-group,
// strategy-ref, parser-order, pom-membership mapping, scope filtering.
// Uses throwaway fixture trees in os.tmpdir() + a duck-typed stub index so
// the checks are tested in isolation from the real workspace.

var h = require('./_harness');
var test = h.test, section = h.section;
var fs = require('fs');
var os = require('os');
var path = require('path');

section('LintHandler — fixtures');

// One shared fixture tree for all lint tests.
var FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'foam-lint-'));
function write(rel, content) {
  var p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// deployment/alpha: rule referencing a group that DOES exist locally
write('deployment/alpha/rules.jrl',
  'p({"class":"foam.core.ruler.Rule","id":"alpha-rule","ruleGroup":"alpha-group"})\n');
write('deployment/alpha/ruleGroups.jrl',
  'p({"class":"foam.core.ruler.RuleGroup","id":"alpha-group"})\n');
// deployment/beta: rule referencing a group defined NOWHERE
write('deployment/beta/rules.jrl',
  'p({"class":"foam.core.ruler.Rule","id":"beta-rule","ruleGroup":"missing-group"})\n');
// deployment/gamma: rule whose group exists only in deployment/alpha (cross-deployment → warn)
write('deployment/gamma/rules.jrl',
  'p({"class":"foam.core.ruler.Rule","id":"gamma-rule","ruleGroup":"alpha-group"})\n');

var handler = foam.parse.lsp.handlers.LintHandler.create({ root: FIX });

var ruleFiles = handler.findJrlFiles_('rules.jrl');
test(ruleFiles.length === 3, 'findJrlFiles_ finds all rules.jrl (got ' + ruleFiles.length + ')');
test(ruleFiles.every(function(f) { return path.isAbsolute(f); }), 'findJrlFiles_ returns absolute paths');

var groupFiles = handler.findJrlFiles_('ruleGroups.jrl');
test(groupFiles.length === 1, 'findJrlFiles_ scoped by basename (got ' + groupFiles.length + ')');

var line = handler.findLine_(path.join(FIX, 'deployment/alpha/rules.jrl'), '"alpha-rule"');
test(line === 1, 'findLine_ returns 1-based line of needle (got ' + line + ')');
test(handler.findLine_(path.join(FIX, 'deployment/alpha/rules.jrl'), '"nope"') === 1,
  'findLine_ falls back to 1 when needle absent');

section('LintHandler — rule-group');

var rg = handler.checkRuleGroups_();

var betaFinding = rg.filter(function(f) { return f.message.indexOf('missing-group') !== -1; });
test(betaFinding.length === 1, 'undefined ruleGroup produces exactly one finding');
test(betaFinding[0] && betaFinding[0].severity === 'error', 'undefined ruleGroup is an error');
test(betaFinding[0] && betaFinding[0].check === 'rule-group', 'finding.check is rule-group');
test(betaFinding[0] && betaFinding[0].path === path.join(FIX, 'deployment/beta/rules.jrl'),
  'finding anchored at the rules.jrl that references the group');
test(betaFinding[0] && /never fire/.test(betaFinding[0].message),
  'message states the consequence (silently never fires)');

var gammaFinding = rg.filter(function(f) { return f.path.indexOf('gamma') !== -1; });
test(gammaFinding.length === 1 && gammaFinding[0].severity === 'warn',
  'group defined only in another deployment dir is a warn');
test(gammaFinding[0] && gammaFinding[0].message.indexOf('deployment/alpha') !== -1,
  'cross-deployment warn names the dir that does define the group');

test(rg.filter(function(f) { return f.path.indexOf('alpha') !== -1; }).length === 0,
  'locally-defined group produces no finding');

section('LintHandler — strategy-ref');

// Fixture jrl + implementor source files
write('src/com/example/strategyReferences.jrl',
  'p({"class":"foam.strategy.StrategyReference","id":"ex.Registered","desiredModelId":"foam.core.ruler.RuleAction","strategy":"com.example.RegisteredAction"})\n' +
  'p({"class":"foam.strategy.StrategyReference","id":"ex.Ghost","desiredModelId":"foam.core.ruler.RuleAction","strategy":"com.example.MissingAction"})\n' +
  'p({"class":"foam.strategy.StrategyReference","id":"ex.TestOnly","desiredModelId":"foam.core.ruler.RuleAction","strategy":"com.example.TestOnlyAction"})\n');
write('src/com/example/RegisteredAction.js',   "foam.CLASS({ package: 'com.example', name: 'RegisteredAction' });\n");
write('src/com/example/UnregisteredAction.js', "foam.CLASS({ package: 'com.example', name: 'UnregisteredAction' });\n");
write('src/com/example/SuppressedAction.js',
  "// foam-lint-ignore: strategy-ref\nfoam.CLASS({ package: 'com.example', name: 'SuppressedAction' });\n");

var stubIndex = {
  classExists:     function(id) {
    return id !== 'com.example.MissingAction' && id !== 'com.example.TestOnlyAction';
  },
  isInterface:     function(id) { return true; },
  getImplementors: function(id) {
    return [ 'com.example.RegisteredAction', 'com.example.UnregisteredAction',
             'com.example.SuppressedAction', 'foam.core.ruler.CompositeRuleAction' ];
  },
  getSubclasses:   function(id) { return []; },
  getFilePath:     function(id) {
    // MissingAction has no file at all (true dangling ref); TestOnlyAction
    // resolves to a path but isn't loaded under current flags (flag-gated).
    if ( id === 'com.example.MissingAction' ) return null;
    if ( id.indexOf('com.example.') !== 0 ) return FIX + '/foam3/src/foam/core/ruler/CompositeRuleAction.js';
    return path.join(FIX, 'src/com/example', id.split('.').pop() + '.js');
  },
  getClassLine:    function(id) { return 0; }
};

var handlerWithIndex = foam.parse.lsp.handlers.LintHandler.create({ root: FIX, index: stubIndex });
var sr = handlerWithIndex.checkStrategyRefs_();

var ghost = sr.filter(function(f) { return f.message.indexOf('MissingAction') !== -1; });
test(ghost.length === 1 && ghost[0].severity === 'error',
  'StrategyReference to a nonexistent class is an error');
test(ghost[0] && ghost[0].path.indexOf('strategyReferences.jrl') !== -1,
  'error anchored at the jrl entry');

var flagGated = sr.filter(function(f) { return f.message.indexOf('TestOnlyAction') !== -1; });
test(flagGated.length === 1 && flagGated[0].severity === 'warn',
  'StrategyReference to a class registered in a pom but flag-gated is a warn, not an error');
test(flagGated[0] && /flag-gated/.test(flagGated[0].message),
  'flag-gated warn message notes it is registered but not loaded under current flags');

var unreg = sr.filter(function(f) { return f.message.indexOf('UnregisteredAction') !== -1; });
test(unreg.length === 1 && unreg[0].severity === 'warn',
  'implementor with no StrategyReference entry is a warn');
test(unreg[0] && /invisible/.test(unreg[0].message),
  'warn states the consequence (invisible in Rule-creation UI)');
test(unreg[0] && unreg[0].line === 1, 'implementor warn line is 1-based');

test(sr.filter(function(f) { return f.message.indexOf('RegisteredAction') !== -1; }).length === 0,
  'registered implementor produces no finding');
test(sr.filter(function(f) { return f.message.indexOf('SuppressedAction') !== -1; }).length === 0,
  'foam-lint-ignore marker suppresses the warn');
test(sr.filter(function(f) { return f.message.indexOf('CompositeRuleAction') !== -1; }).length === 0,
  'implementors outside <root>/src are skipped (foam3 core noise)');

section('LintHandler — parser-order');

write('src/com/example/parsers.jrl',
  'p({"class":"com.example.Parser","id":"generic-xml","order":5})\n');
// delta: local parser colliding with the src-level order 5
write('deployment/delta/parsers.jrl',
  'p({"class":"com.example.Parser","id":"balance-xml","order":5})\n');
// epsilon: no collision (order 4 beats generic 5)
write('deployment/epsilon/parsers.jrl',
  'p({"class":"com.example.Parser","id":"epsilon-xml","order":4})\n');

var po = handler.checkParserOrder_();
var dup = po.filter(function(f) { return f.message.indexOf('balance-xml') !== -1; });
test(dup.length === 1 && dup[0].severity === 'warn', 'duplicate order in a reachable set → one warn');
test(dup[0] && dup[0].message.indexOf('generic-xml') !== -1 && dup[0].message.indexOf('5') !== -1,
  'warn names both parsers and the colliding order value');
test(po.filter(function(f) { return f.message.indexOf('epsilon-xml') !== -1; }).length === 0,
  'distinct orders produce no finding');

section('LintHandler — pom-membership mapping + lint() orchestrator');

var stubValidator = {
  validate: function() {
    return {
      orphans:    [ path.join(FIX, 'src/com/example/Orphan.js') ],
      missing:    [ path.join(FIX, 'src/com/example/Gone.js') ],
      duplicates: [ { path: path.join(FIX, 'src/com/example/Dup.js'),
                      classIds: [ 'com.example.A', 'com.example.B' ] } ]
    };
  }
};
var full = foam.parse.lsp.handlers.LintHandler.create({
  root: FIX, index: stubIndex, pomValidator: stubValidator
});

var pm = full.checkPomMembership_();
test(pm.length === 2, 'orphans + missing buckets → two findings (got ' + pm.length + ')');
test(pm.filter(function(f) { return f.severity === 'error'; }).length === 2,
  'orphan + missing are errors');
test(pm.some(function(f) { return /not listed in any pom\.js/.test(f.message); }),
  'orphan message says not listed in any pom.js');

var all = full.lint({});
test(all && Array.isArray(all.findings), 'lint({}) returns { findings: [] }');
test(all.findings.some(function(f) { return f.check === 'rule-group'; }) &&
     all.findings.some(function(f) { return f.check === 'pom-membership'; }),
  'lint({}) runs every check');

var only = full.lint({ checks: [ 'parser-order' ] });
test(only.findings.every(function(f) { return f.check === 'parser-order'; }),
  'checks filter runs only the named checks');

var scoped = full.lint({ scope: 'paths', paths: [ path.join(FIX, 'deployment/beta/rules.jrl') ] });
test(scoped.findings.length >= 1 &&
     scoped.findings.every(function(f) { return f.path === path.join(FIX, 'deployment/beta/rules.jrl'); }),
  'paths scope keeps only findings anchored in the given files');

var scopedRel = full.lint({ scope: 'paths', paths: [ 'deployment/beta/rules.jrl' ] });
test(scopedRel.findings.length >= 1 &&
     scopedRel.findings.every(function(f) { return f.path === path.join(FIX, 'deployment/beta/rules.jrl'); }),
  'paths scope resolves root-relative inputs (diff mode passes git-relative paths)');

var unknownThrew = false, unknownMsg = '';
try { full.lint({ checks: [ 'pom_membership' ] }); }
catch ( e ) { unknownThrew = true; unknownMsg = e.message; }
test(unknownThrew && unknownMsg.indexOf('unknown check') !== -1,
  'lint() throws on an unrecognized check name instead of silently reading clean');

section('LintHandler — bare-catch');

var bcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-bare-catch-'));
fs.writeFileSync(path.join(bcDir, 'Bad.js'),
  "function f() {\n  try { g(); } catch (e) {}\n}\n");
fs.writeFileSync(path.join(bcDir, 'CommentOnly.js'),
  "function f() {\n  try { g(); } catch (e) { /* ignore */ }\n}\n");
fs.writeFileSync(path.join(bcDir, 'Good.js'),
  "function f() {\n  try { g(); } catch (e) { console.error('x: ' + e.message); }\n}\n");
fs.writeFileSync(path.join(bcDir, 'Suppressed.js'),
  "// foam-lint-ignore: bare-catch\nfunction f() {\n  try { g(); } catch (e) {}\n}\n");
// The marker quoted in a string is not a suppression — only a line of its own is.
fs.writeFileSync(path.join(bcDir, 'QuotesMarker.js'),
  "var hint = 'add // foam-lint-ignore: bare-catch';\nfunction f() {\n  try { g(); } catch (e) {}\n}\n");

var bc = handler.runBareCatch_([ bcDir ]);

test(bc.some(function(f) { return f.path.endsWith('Bad.js') && f.line === 2; }),
  'bare-catch: empty body flagged, 1-based line matches findLine_ convention');
test(bc.some(function(f) { return f.path.endsWith('CommentOnly.js'); }),
  'bare-catch: comment-only body flagged');
test(! bc.some(function(f) { return f.path.endsWith('Good.js'); }),
  'bare-catch: logged catch clean');
test(! bc.some(function(f) { return f.path.endsWith('Suppressed.js'); }),
  'bare-catch: ignore comment suppresses file');
test(bc.some(function(f) { return f.path.endsWith('QuotesMarker.js'); }),
  'bare-catch: marker inside a string does not suppress the file');
test(bc.every(function(f) { return f.check === 'bare-catch' && f.severity === 'error'; }),
  'bare-catch: finding shape (check id + lowercase severity, matching every other check)');

section('LintHandler — bare-catch lint() wiring');

write('tools/lsp/BadRoot.js',
  "function f() {\n  try { g(); } catch (e) {}\n}\n");

var bcViaLint = handler.lint({ checks: [ 'bare-catch' ] });
test(bcViaLint.findings.length === 1 && bcViaLint.findings[0].path.endsWith('BadRoot.js'),
  'lint({checks:["bare-catch"]}) defaults the scan root to <root>/tools/lsp');

test(full.ALL_CHECKS.indexOf('bare-catch') !== -1, 'bare-catch registered in ALL_CHECKS');

var bcInAll = full.lint({});
test(bcInAll.findings.some(function(f) { return f.check === 'bare-catch'; }),
  'lint({}) (all checks) includes bare-catch findings');

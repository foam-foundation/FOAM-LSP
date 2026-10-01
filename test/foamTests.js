/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Runs the foam.parse.lsp.test.* JSTests (src/test). In foam3 they ran only
// through a deployment/lsp pom with the test flag; here the test poms are
// required directly with foam.flags.test on, and each test's runTest(x) gets
// an x whose test() counts results. The tests use nothing else from x, so
// they need none of the test runner's DAOs.

var h    = require('./_harness');
var path = require('path');

var TESTS = [ 'FoamIndexTest', 'FoamClassGrammarTest', 'HandlersTest',
              'LSPIntegrationTest', 'JavaBlockValidatorTest', 'CSSTokenResolverTest' ];

h.section('FOAM-model tests (src/test)');
foam.flags.test = true;
// foam.core.test (JSTest's package) is itself behind the test flag.
foam.require(path.join(h.roots.foam3, 'src', 'foam', 'core', 'test', 'pom'), false, true);
foam.require(path.join(__dirname, '..', 'src', 'test', 'pom'), false, true);

module.exports.done = TESTS.reduce(function(p, name) {
  return p.then(function() {
    var cls = foam.maybeLookup('foam.parse.lsp.test.' + name);
    if ( ! cls ) { h.test(false, name + ' registered'); return; }
    var passed = 0, failures = [];
    var x = { test: function(ok, msg) { if ( ok ) passed++; else failures.push(msg); } };
    return Promise.resolve().then(function() { return cls.create().runTest(x); }).then(function() {
      h.test(failures.length === 0 && passed > 0, name + ': ' + passed + ' passed, ' + failures.length + ' failed' +
        ( failures.length ? '\n      ' + failures.join('\n      ') : '' ));
    }, function(e) { h.test(false, name + ' threw — ' + ( e && e.stack || e )); });
  });
}, Promise.resolve());

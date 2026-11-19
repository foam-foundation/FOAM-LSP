/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Typing style rules (TypingChecker): the diagnostics, their quick fixes, and
// the switch that turns them on (diagnostics.typing, FeatureConfig
// projectDefaults).

var h = require('./_harness');
var test = h.test, section = h.section;
var index = h.index, cache = h.cache, cssTokenResolver = h.cssTokenResolver;
var FeatureConfig = require('../src/FeatureConfig');

section('Typing rules');

var on  = { enabled: function(f) { return true; } };
var off = { enabled: function(f) { return f !== 'diagnostics.typing'; } };
var handlerOn  = foam.parse.lsp.handlers.DiagnosticsHandler.create({ index: index, cache: cache, cssTokenResolver: cssTokenResolver, featureConfig: on });
var handlerOff = foam.parse.lsp.handlers.DiagnosticsHandler.create({ index: index, cache: cache, cssTokenResolver: cssTokenResolver, featureConfig: off });
var bare       = foam.parse.lsp.handlers.DiagnosticsHandler.create({ index: index, cache: cache, cssTokenResolver: cssTokenResolver });
var actions    = foam.parse.lsp.handlers.CodeActionHandler.create({ index: index, cache: cache, typingChecker: handlerOn.typingChecker });

var n = 0;
var uri = function() { return 'file:///typing_' + ( ++n ) + '.js'; };
var typing = function(ds) { return ds.filter(function(d) { return /^typing-/.test(d.code); }); };
var named  = function(ds, code, name) { return typing(ds).filter(function(d) { return d.code === code && d.message.indexOf('"' + name + '"') !== -1; }); };

var src = [
  "foam.CLASS({",
  "  package: 'foam.parse.lsp.test.typing',",
  "  name: 'Sample',",
  "  imports: [ 'plainImport', { name: 'typedImport', key: 'typedImport', type: 'String' },",
  "    { name: 'loneDAO', key: 'loneDAO', type: 'foam.dao.DAO' },",
  "    { name: 'goodDAO', key: 'goodDAO', type: 'foam.dao.DAO', of: 'foam.core.auth.User' } ],",
  "  properties: [",
  "    'shorthand',",
  "    { name: 'count', value: 3 },",
  "    { name: 'ratio', value: 0.5 },",
  "    { name: 'label', value: 'x' },",
  "    { name: 'computed', factory: function() { return 1; } },",
  "    { class: 'String', name: 'typed' }",
  "  ],",
  "  methods: [",
  "    function bare(a, b) { return a; },",
  "    function none() { return 1; },",
  "    { name: 'typedArgs', args: 'String s, Int i', code: function(s, i) {} },",
  "    { name: 'genericArgs', args: 'Map<String, Object> m, Int i', code: function(m, i) {} },",
  "    { name: 'objectArgs', args: [ { name: 's', type: 'String' } ], code: function(s) {} },",
  "    { name: 'halfTyped', args: [ { name: 's' } ], code: function(s) {} }",
  "  ]",
  "});"
].join('\n');
var u1 = uri();
var ds = handlerOn.handle(src, u1);

test(named(ds, 'typing-property-no-class', 'shorthand').length === 1, 'typing: a shorthand property has no class');
test(named(ds, 'typing-property-no-class', 'count').length === 1, 'typing: an object property with no class is flagged');
test(named(ds, 'typing-property-no-class', 'typed').length === 0, 'typing: a property with a class is fine');
test(named(ds, 'typing-untyped-args', 'bare').length === 1, 'typing: a plain function with arguments is flagged');
test(named(ds, 'typing-untyped-args', 'none').length === 0, 'typing: a function with no arguments is fine');
test(named(ds, 'typing-untyped-args', 'typedArgs').length === 0, "typing: args: 'Type name, ...' is typed");
test(named(ds, 'typing-untyped-args', 'objectArgs').length === 0, 'typing: args with a type each are typed');
test(named(ds, 'typing-untyped-args', 'genericArgs').length === 0, "typing: a comma inside Map<String, Object> does not split an argument");
test(named(ds, 'typing-untyped-args', 'halfTyped').length === 1, 'typing: an arg with no type is flagged');
test(named(ds, 'typing-import-no-type', 'plainImport').length === 1, 'typing: a string import has no type');
test(named(ds, 'typing-import-no-type', 'typedImport').length === 0, 'typing: an import with a type is fine');
test(named(ds, 'typing-dao-import-no-of', 'loneDAO').length === 1, 'typing: a DAO import with no of is flagged');
test(named(ds, 'typing-dao-import-no-of', 'goodDAO').length === 0, 'typing: a DAO import with of is fine');

var lines = src.split('\n');
var at = function(code, name) { var d = named(ds, code, name)[0]; return d ? lines[d.range.start.line].slice(d.range.start.character, d.range.end.character) : null; };
test(at('typing-property-no-class', 'count') === 'count', 'typing: the warning sits on the property name');
test(at('typing-untyped-args', 'bare') === 'bare', 'typing: the warning sits on the method name');
test(at('typing-import-no-type', 'plainImport') === 'plainImport', 'typing: the warning sits on the import name');

// Off by default: off in the config, and off in a handler with no config.
test(typing(handlerOff.handle(src, uri())).length === 0, 'typing: diagnostics.typing off reports nothing');
test(typing(bare.handle(src, uri())).length === 0, 'typing: a handler with no config reports nothing');

// A property that overrides a parent's gets the parent's class.
var sub = [
  "foam.CLASS({",
  "  package: 'foam.parse.lsp.test.typing',",
  "  name: 'SubOfSample',",
  "  extends: 'foam.parse.lsp.test.typing.Parent',",
  "  properties: [ { name: 'inherited', value: 2 } ]",
  "});"
].join('\n');
foam.CLASS({ package: 'foam.parse.lsp.test.typing', name: 'Parent', properties: [ { class: 'Int', name: 'inherited' } ] });
foam.CLASS({ package: 'foam.parse.lsp.test.typing', name: 'SubOfSample', extends: 'foam.parse.lsp.test.typing.Parent', properties: [ { name: 'inherited', value: 2 } ] });
test(named(handlerOn.handle(sub, uri()), 'typing-property-no-class', 'inherited').length === 0,
  "typing: a property that overrides a parent's keeps the parent's class");

// Quick fixes: a class from the property's value.
var fixFor = function(name) {
  var d = named(ds, 'typing-property-no-class', name)[0];
  var as = d ? actions.handle(src, d.range, { diagnostics: [ d ] }, u1) : [];
  return as.filter(function(a) { return a.kind === 'quickfix'; })[0] || null;
};
var apply = function(a) {
  var e = a.edit.changes[u1][0], ls = src.split('\n');
  var l = ls[e.range.start.line];
  ls[e.range.start.line] = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.start.character);
  return ls.join('\n');
};
var fCount = fixFor('count');
test(fCount && /Int/.test(fCount.title), "typing fix: value 3 offers class: 'Int'");
test(fCount && apply(fCount).indexOf("{ class: 'Int', name: 'count', value: 3 }") !== -1, 'typing fix: the class goes first inside the braces');
test(fixFor('ratio') && /Float/.test(fixFor('ratio').title), "typing fix: value 0.5 offers class: 'Float'");
test(fixFor('label') && /String/.test(fixFor('label').title), "typing fix: value 'x' offers class: 'String'");
test(fixFor('computed') === null, 'typing fix: a factory says no class, so no fix');
test(fixFor('shorthand') === null, 'typing fix: a shorthand property has no value, so no fix');
// PR #37 review: a whole number does not say which number class. Int, Long
// and Float are three plain fixes, none preferred, so no auto fix picks Int
// for an id or a timestamp. A value that does say keeps one preferred fix.
var fixesFor = function(name) {
  var d = named(ds, 'typing-property-no-class', name)[0];
  var as = d ? actions.handle(src, d.range, { diagnostics: [ d ] }, u1) : [];
  return as.filter(function(a) { return a.kind === 'quickfix'; });
};
var countFixes = fixesFor('count');
test(countFixes.map(function(a) { return ( /'(\w+)'/.exec(a.title) || [] )[1]; }).join() === 'Int,Long,Float',
  "typing fix: value 3 offers Int, Long and Float (got " + countFixes.map(function(a) { return a.title; }).join(' | ') + ')');
test(countFixes.length === 3 && countFixes.every(function(a) { return ! a.isPreferred; }),
  'typing fix: none of the three number fixes is preferred');
test(countFixes[1] && apply(countFixes[1]).indexOf("{ class: 'Long', name: 'count', value: 3 }") !== -1,
  'typing fix: the Long fix writes Long');
test(fixesFor('ratio').length === 1 && fixesFor('ratio')[0].isPreferred === true,
  'typing fix: value 0.5 has one fix, Float, preferred (a decimal is no Int or Long)');
test(fixesFor('label').length === 1 && fixesFor('label')[0].isPreferred === true,
  "typing fix: value 'x' keeps one preferred fix");
var fixed = apply(fCount);
test(named(handlerOn.handle(fixed, uri()), 'typing-property-no-class', 'count').length === 0, 'typing fix: after the fix, the warning is gone');

// The switch: a foam-check.config.json turns it on (projectDefaults);
// foam-lsp.json or the client can still turn it off.
test(FeatureConfig.load({}).enabled('diagnostics.typing') === false, 'typing config: off by default');
test(FeatureConfig.load({ projectDefaults: { 'diagnostics.typing': true } }).enabled('diagnostics.typing') === true,
  'typing config: a project default turns it on');
test(FeatureConfig.load({ projectDefaults: { 'diagnostics.typing': true },
                          initOptions: { features: { 'diagnostics.typing': false } } }).enabled('diagnostics.typing') === false,
  'typing config: the client can still turn it off');

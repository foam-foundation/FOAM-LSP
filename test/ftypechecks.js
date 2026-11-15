/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// FTypechecks.js (experiment): after a change it writes app.d.ts, report.json
// and lsp.json for the FTypechecks plugin, from this process's FOAM and the
// LSP's own checks (TypesFile, TypingChecker, JrlHandler).

var h = require('./_harness');
var test = h.test, section = h.section;
var fs = h.fs, path = h.path, os = require('os');
var FTypechecks = require('../src/FTypechecks');

section('FTypechecks');

var dir  = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-ftc-')));
var src  = path.join(dir, 'src', 'ftc', 'test');
var work = path.join(dir, '.foam-check');
fs.mkdirSync(src, { recursive: true });
fs.mkdirSync(work);

var model = [
  "foam.CLASS({",
  "  package: 'ftc.test',",
  "  name: 'Thing',",
  "  imports: [ 'plainImport' ],",
  "  properties: [ { name: 'count', value: 3 }, { class: 'String', name: 'label' } ],",
  "  methods: [ function go(a) { return a; } ]",
  "});"
].join('\n');
fs.writeFileSync(path.join(src, 'Thing.js'), model);
var savedSource = foam.sourceFile;
foam.sourceFile = path.join(src, 'Thing.js');  // loaded from its file, as at boot
eval(model);
foam.sourceFile = savedSource;
fs.writeFileSync(path.join(dir, 'things.jrl'),
  'p({"class":"ftc.test.Thing","id":1,"label":"a"}, "count":2)\np({"class":"ftc.test.Thing","nope":1})\n');
fs.writeFileSync(path.join(work, 'journals-all.json'), JSON.stringify([ path.join(dir, 'things.jrl') ]));
fs.writeFileSync(path.join(dir, 'foam-check.config.json'), JSON.stringify({ app: '.', 'package': 'ftc.test', sources: [ 'src/ftc/test' ] }));
fs.writeFileSync(path.join(work, 'generator.json'), JSON.stringify({
  generator: '/plugin/scripts/gen-types.js', app: dir, style: 'ftc.test', level: 'strict', journals: path.join(work, 'journals-all.json')
}));

var diag = foam.parse.lsp.handlers.DiagnosticsHandler.create({ index: h.index, cache: h.cache });
var jrl  = foam.parse.lsp.handlers.JrlHandler.create({ index: h.index });
var logs = [];
var ftc  = FTypechecks.create({ root: dir, log: function(m) { logs.push(m); }, cache: h.cache, typingChecker: diag.typingChecker, jrlHandler: jrl });

test(ftc != null, 'ftypechecks: on in a workspace with foam-check.config.json');
test(FTypechecks.create({ root: os.tmpdir() }) === null, 'ftypechecks: off without one');
test(ftc && ftc.write([ path.join(src, 'Thing.js') ]) === true, 'ftypechecks: write succeeds' + ( logs.length ? ' (' + logs.join(' | ').slice(0, 300) + ')' : '' ));

var read = function(f) { try { return JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); } catch (e) { return null; } };
var dts = fs.existsSync(path.join(work, 'app.d.ts')) ? fs.readFileSync(path.join(work, 'app.d.ts'), 'utf8') : '';
test(/Thing/.test(dts) && /label/.test(dts), 'ftypechecks: app.d.ts declares the class and its properties');

var rep = read('report.json') || {};
var style = function(member, rule) { return ( rep.style || [] ).some(function(s) { return s.cls === 'ftc.test.Thing' && s.member === member && s.rule === rule; }); };
test(style('count', 'property has no class'), "ftypechecks: report.style uses the plugin's rule names (property)");
test(style('go', 'argument has no type'), "ftypechecks: report.style has the untyped method");
test(style('plainImport', 'import has no type'), 'ftypechecks: report.style has the untyped import');
test(! style('label', 'property has no class'), 'ftypechecks: a typed property is not reported');

var jr = function(rule) { return ( rep.journal || [] ).filter(function(j) { return j.rule === rule; }); };
test(jr('text after the row').length === 1 && jr('text after the row')[0].line === 1, 'ftypechecks: report.journal has the row with text after it, at its line');
test(jr('unknown key').length === 1 && jr('unknown key')[0].line === 2, 'ftypechecks: report.journal has the unknown key');
test(jr('unknown key')[0] && ! /\d/.test(jr('unknown key')[0].key.split('|')[0]), 'ftypechecks: a journal key carries no line number');
test(rep.shapes && rep.shapes['ftc.test.Thing'], 'ftypechecks: report.shapes has the class');

var lsp = read('lsp.json') || {};
test(lsp.generator === '/plugin/scripts/gen-types.js', 'ftypechecks: lsp.json echoes the request it answered');
test(lsp.seen && lsp.seen[path.join(src, 'Thing.js')] === fs.statSync(path.join(src, 'Thing.js')).mtimeMs, 'ftypechecks: lsp.json saw the changed file');
test(ftc && ftc.isCurrent(path.join(src, 'Thing.js')), 'ftypechecks: isCurrent after the write');

fs.rmSync(dir, { recursive: true, force: true });

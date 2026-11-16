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
// A class the file index holds that this process did not load (a test class).
var indexStub = { getIndexedClassIds: function() { return [ 'ftc.test.unloaded.NotLoaded', 'ftc.test.Thing', 'bad..id' ]; } };
var jrl  = foam.parse.lsp.handlers.JrlHandler.create({ index: h.index });
var logs = [];
var ftc  = FTypechecks.create({ root: dir, log: function(m) { logs.push(m); }, cache: h.cache, typingChecker: diag.typingChecker, jrlHandler: jrl, index: indexStub });

test(ftc != null, 'ftypechecks: on in a workspace with foam-check.config.json');
test(FTypechecks.create({ root: os.tmpdir() }) === null, 'ftypechecks: off without one');
test(ftc && ftc.write([ path.join(src, 'Thing.js') ]) === true, 'ftypechecks: write succeeds' + ( logs.length ? ' (' + logs.join(' | ').slice(0, 300) + ')' : '' ));

var read = function(f) { try { return JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); } catch (e) { return null; } };
var dts = fs.existsSync(path.join(work, 'app.d.ts')) ? fs.readFileSync(path.join(work, 'app.d.ts'), 'utf8') : '';
test(/Thing/.test(dts) && /label/.test(dts), 'ftypechecks: app.d.ts declares the class and its properties');
test(/namespace unloaded \{\s*const NotLoaded: any;/.test(dts), 'ftypechecks: a class the index holds but FOAM did not load is named, as any');
test(! /namespace\s+\{/.test(dts), 'ftypechecks: an id with an empty part is left out');

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

// PR #37 review: a FOAM file changed on disk while the editor holds unsaved
// text for it. reindexFromDisk_ re-registers the disk text, and while it runs
// the document IS the disk text, so the diagnostics it pushes sit on the disk
// text's lines. Once the editor's text is back, the last push for the file
// must be the editor's own.
var laneDone = h.withServerLane(async function() {
  var origWrite = process.stdout.write;
  var ws = null;
  try {
    var frames = [], inBuf = Buffer.alloc(0);
    process.stdout.write = function(chunk) {
      inBuf = Buffer.concat([ inBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8') ]);
      while ( true ) {
        var headerEnd = inBuf.indexOf('\r\n\r\n');
        if ( headerEnd === -1 ) break;
        var m = /Content-Length:\s*(\d+)/i.exec(inBuf.slice(0, headerEnd).toString('utf8'));
        if ( ! m ) { inBuf = inBuf.slice(headerEnd + 4); continue; }
        var len = parseInt(m[1], 10), bodyStart = headerEnd + 4;
        if ( inBuf.length < bodyStart + len ) break;
        try { frames.push(JSON.parse(inBuf.slice(bodyStart, bodyStart + len).toString('utf8'))); } catch (e) { /* not JSON: not ours */ }
        inBuf = inBuf.slice(bodyStart + len);
      }
      return true;
    };
    var send = function(msg) {
      var json = JSON.stringify(msg);
      process.stdin.emit('data', Buffer.from('Content-Length: ' + Buffer.byteLength(json) + '\r\n\r\n' + json, 'utf8'));
    };
    var waitFor = function(pred, what) {
      return new Promise(function(resolve, reject) {
        var deadline = Date.now() + 20000;
        (function poll() {
          for ( var i = 0 ; i < frames.length ; i++ ) if ( pred(frames[i], i) ) return resolve(frames[i]);
          if ( Date.now() > deadline ) return reject(new Error('timed out waiting for ' + what));
          setTimeout(poll, 10);
        })();
      });
    };

    section('FTypechecks — a change on disk keeps the editor text\'s diagnostics');
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-ftc-lane-')));
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'foam-check.config.json'), JSON.stringify({ app: '.', 'package': 'ftc.lane', sources: [ 'src' ] }));
    var file = path.join(ws, 'src', 'Shifted.js'), uri = 'file://' + file;
    var editorText = [
      "foam.CLASS({",
      "  package: 'ftc.lane',",
      "  name: 'Shifted',",
      "  properties: [",
      "    { name: 'count', value: 3 }",
      "  ]",
      "});"
    ].join('\n');
    var diskText = '\n\n\n' + editorText;          // the same class, three lines lower
    fs.writeFileSync(file, editorText);

    process.stdin.removeAllListeners('data');
    require('../src/server').start();
    process.stdin.removeAllListeners('end');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + ws, capabilities: {} } });
    await waitFor(function(f) { return f.id === 1 && f.result; }, 'the initialize response');
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri: uri, languageId: 'javascript', version: 1, text: editorText } } });
    var isPush = function(f) { return f.method === 'textDocument/publishDiagnostics' && f.params.uri === uri; };
    var lines = function(f) {
      return f.params.diagnostics.filter(function(d) { return d.code === 'typing-property-no-class'; })
        .map(function(d) { return d.range.start.line; });
    };
    var opened = await waitFor(isPush, 'the didOpen push');
    test(lines(opened).join() === '4', 'ftypechecks lane: the open document gets its warning on line 4 (got ' + lines(opened) + ')');

    // Another tool writes the file; the editor keeps its unsaved text.
    var before = frames.length;
    await new Promise(function(r) { setTimeout(r, 100); });   // a new mtime
    fs.writeFileSync(file, diskText);
    await waitFor(function(f, i) { return i >= before && isPush(f); }, 'a push after the change on disk');
    await new Promise(function(r) { setTimeout(r, 300); });   // any push that follows it
    var pushes = frames.slice(before).filter(isPush);
    var last = pushes[pushes.length - 1];
    test(lines(last).join() === '4',
      'ftypechecks lane: after a change on disk, the last push is on the editor text\'s lines (line 4, got ' + lines(last) + ' over ' + pushes.length + ' pushes)');
  } catch (e) {
    test(false, 'ftypechecks lane threw: ' + ( e && e.stack ? e.stack : e ));
  } finally {
    process.stdout.write = origWrite;
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('end');
    process.stdin.pause();
    if ( ws ) fs.rmSync(ws, { recursive: true, force: true });
  }
});

module.exports = { done: laneDone };

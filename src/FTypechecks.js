/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// EXPERIMENT: write FTypechecks' files from the FOAM this server already has
// loaded, so the FTypechecks hook (the plugin's check.js) can skip its own slow
// FOAM load (about 4-5 s on a big app) after each edit.
//
// How the two meet, in <config dir>/.foam-check/:
//   - generator.json (written by check.js): the request. The app's package,
//     the level, and the file listing the journals to check.
//   - After a FOAM source file changes this module writes:
//       app.d.ts     the types (TypesFile.js)
//       report.json  the problems, in the plugin's format and with its rule
//                    names: style (TypingChecker), journal (JrlHandler),
//                    asserts and shapes (TypesFile)
//       lsp.json     which file versions it saw, and the request it answered
//   - check.js uses these when lsp.json saw the edited file's current version
//     and answers its request; otherwise it loads FOAM itself, as before.
//
// Each check exists once, here in the LSP: the plugin's report is built from
// the same checks the editor shows.
//
// Plain Node module (no FOAM boot cost), like FeatureConfig.js.

var fs   = require('fs');
var path = require('path');
var TypesFile = require('./TypesFile');

var CONFIG = 'foam-check.config.json';

// LSP diagnostic code -> the plugin's rule name (its rules.js).
var RULE = {
  'typing-property-no-class': 'property has no class',
  'typing-untyped-args':      'argument has no type',
  'typing-import-no-type':    'import has no type',
  'typing-dao-import-no-of':  'DAO import does not say what it holds',
  'jrl-row-split':            'row split over lines',
  'jrl-not-a-row':            'line read as a row',
  'jrl-row-unparsed':         'row does not parse',
  'jrl-row-trailing':         'text after the row',
  'jrl-rows-no-id':           'rows with no id',
  'jrl-unknown-class':        'unknown class',
  'jrl-unknown-key':          'unknown key'
};

function create(opts) {
  var root = opts.root;
  var log  = opts.log || function() {};
  var cfgFile = process.env.FTYPECHECKS_CONFIG ||
    ( root && path.join(root, CONFIG) );
  if ( ! cfgFile || ! fs.existsSync(cfgFile) ) return null;

  var cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }
  catch ( e ) { log('[FTypechecks] ' + cfgFile + ': ' + e.message); return null; }

  var base = path.dirname(cfgFile);
  var app  = path.resolve(base, cfg.app || '.');
  // The server's FOAM is the app's FOAM only when it serves that app.
  if ( root && path.resolve(root) !== app ) {
    log('[FTypechecks] config app ' + app + ' is not this workspace ' + root + '; off');
    return null;
  }
  var work = path.join(base, '.foam-check');
  var dirs = ( cfg.sources || [] ).map(function(s) { return path.resolve(app, s); });
  var inSources = function(f) {
    return dirs.some(function(d) { return f.indexOf(d + path.sep) === 0; });
  };

  var seen = {};          // file -> mtimeMs the last types file included
  // FOAM loaded every source file at boot, so a file unchanged since this process
  // started is already in the first types file. (One changed after the start may
  // have been loaded before or after the change: left out, the watcher sends it.)
  var bootTime = Date.now() - process.uptime() * 1000;

  function walk(d, ext, out) {
    var es; try { es = fs.readdirSync(d, { withFileTypes: true }); }
    catch ( e ) { log('[FTypechecks] cannot read ' + d + ': ' + e.message); return out; }
    es.forEach(function(x) {
      var f = path.join(d, x.name);
      if ( x.isDirectory() ) walk(f, ext, out);
      else if ( x.name.slice(-ext.length) === ext ) out.push(f);
    });
    return out;
  }
  var sourceFiles = function() {
    return dirs.filter(fs.existsSync).reduce(function(all, d) { return walk(d, '.js', all); }, []);
  };
  function seedSeen() {
    sourceFiles().forEach(function(f) {
      try { var m = fs.statSync(f).mtimeMs; if ( m < bootTime ) seen[f] = m; }
      catch ( e ) { log('[FTypechecks] cannot read ' + f + ': ' + e.message); }
    });
  }

  function request() {
    try { return JSON.parse(fs.readFileSync(path.join(work, 'generator.json'), 'utf8')); }
    catch ( e ) { return null; }          // check.js has not run yet
  }
  function readList(file) {
    try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; }
    catch ( e ) { log('[FTypechecks] cannot read ' + file + ': ' + e.message); return []; }
  }

  // Findings per file, kept while the file's mtime is unchanged: a write
  // re-checks only the files that changed.
  var memo = {};
  function perFile(kind, f, find) {
    var m; try { m = fs.statSync(f).mtimeMs; } catch ( e ) { return []; }
    var k = kind + ' ' + f;
    if ( ! memo[k] || memo[k].mtime !== m ) {
      var text = fs.readFileSync(f, 'utf8');
      memo[k] = { mtime: m, found: find(text) };
    }
    return memo[k].found;
  }

  // The typing rules over the package's classes this process loaded, as the
  // plugin reports them (a class FOAM did not load, a test class, it never sees).
  function styleOf(pkg) {
    if ( ! opts.typingChecker || ! opts.cache ) return [];
    return sourceFiles().reduce(function(all, f) {
      return all.concat(perFile('style', f, function(text) {
        var out = [];
        opts.cache.getModels('file://' + f, text).forEach(function(m) {
          var id = m.refines || ( m['package'] ? m['package'] + '.' : '' ) + m.name;
          if ( ! id || id.indexOf(pkg) !== 0 || ! foam.maybeLookup(id) ) return;
          opts.typingChecker.check(m, text).forEach(function(x) {
            out.push({ cls: id, member: x.name, rule: RULE[x.code], file: f });
          });
        });
        return out;
      }));
    }, []);
  }

  // The journal diagnostics, as the plugin reports them. The key (no line
  // number) lets the plugin's starting list survive edits above a row.
  function journalOf(files) {
    if ( ! opts.jrlHandler ) return [];
    return files.reduce(function(all, f) {
      return all.concat(perFile('journal', f, function(text) {
        var lines = text.split('\n');
        return opts.jrlHandler.handleDiagnostics(text, 'file://' + f).filter(function(d) {
          return RULE[d.code];
        }).map(function(d) {
          var line = d.range.start.line;
          return { file: f, line: line + 1, rule: RULE[d.code], detail: d.message,
                   key: d.code + '|' + ( lines[line] || '' ).trim().slice(0, 120) };
        });
      }));
    }, []);
  }

  // Write to a temp name, then rename: check.js may be reading the old file.
  function put(file, text) {
    var tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  function write(changed) {
    var g = request();
    if ( ! g ) return false;
    var t0 = Date.now();
    if ( ! changed && ! Object.keys(seen).length ) seedSeen();     // the first types file
    var out = path.join(work, 'app.d.ts.' + process.pid + '.tmp');
    var r;
    try {
      r = TypesFile.generate({ out: out, level: g.level, 'package': g.style, log: log });
      fs.renameSync(out, path.join(work, 'app.d.ts'));
      put(path.join(work, 'report.json'), JSON.stringify({
        'package': g.style,
        asserts:   r.asserts,
        style:     g.style ? styleOf(g.style) : [],
        journal:   journalOf(readList(g.journals)),
        shapes:    r.shapes
      }, null, 1));
    } catch ( e ) {
      log('[FTypechecks] write failed: ' + ( e.stack || e.message ));
      return false;
    }
    ( changed || [] ).forEach(function(f) {
      try { seen[f] = fs.statSync(f).mtimeMs; }
      catch ( e ) { log('[FTypechecks] cannot read ' + f + ': ' + e.message); }
    });
    put(path.join(work, 'lsp.json'), JSON.stringify({
      // generator echoes the request: these files answer that check.js.
      pid: process.pid, generator: g.generator, level: g.level,
      written: Date.now(), ms: Date.now() - t0, seen: seen
    }, null, 1));
    log('[FTypechecks] wrote types in ' + ( Date.now() - t0 ) + ' ms (' +
      r.classes + ' classes)' + ( changed ? ' after ' + changed.join(', ') : '' ));
    return true;
  }

  // Watch the checked folders: an edit made outside the editor (Claude Code's
  // Edit tool) reaches the server no other way. onChange re-registers the file.
  function watch(onChange) {
    var timers = {};
    dirs.forEach(function(d) {
      if ( ! fs.existsSync(d) ) return;
      try {
        fs.watch(d, { recursive: true }, function(ev, name) {
          if ( ! name || ! /\.js$/.test(name) ) return;
          var f = path.join(d, name);
          clearTimeout(timers[f]);
          timers[f] = setTimeout(function() {
            delete timers[f];
            if ( fs.existsSync(f) ) onChange(f);
          }, 30);
        });
      } catch ( e ) {
        log('[FTypechecks] cannot watch ' + d + ': ' + e.message);
      }
    });
  }

  return {
    app: app, inSources: inSources, write: write, watch: watch,
    // The file's current version is already in the types file.
    isCurrent: function(f) {
      try { return seen[f] === fs.statSync(f).mtimeMs; } catch ( e ) { return false; }
    }
  };
}

module.exports = { create: create, RULE: RULE };

/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// EXPERIMENT: write FTypechecks' types file from the FOAM this server already
// has loaded, so the FTypechecks hook (check.js) can skip its own slow FOAM
// load (about 4-5 s on a big app) after each edit.
//
// How the two meet:
//   - check.js writes <config dir>/.foam-check/generator.json on every run:
//     the generator it uses (gen-types.js), the app, the package and the level.
//   - This module finds the config (FTYPECHECKS_CONFIG, else
//     <workspace root>/foam-check.config.json), reads generator.json, and after
//     a FOAM file changes it calls the generator in this process, writing
//     app.d.ts, report.json and lsp.json (which file version it saw).
//   - check.js reuses app.d.ts when lsp.json saw the edited file's current
//     version; otherwise it loads FOAM itself, as before.
//
// Plain Node module (no FOAM boot cost), like FeatureConfig.js.

var fs   = require('fs');
var path = require('path');

var CONFIG = 'foam-check.config.json';

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
  function seedSeen() {
    var walk = function(d) {
      var es; try { es = fs.readdirSync(d, { withFileTypes: true }); }
      catch ( e ) { log('[FTypechecks] cannot read ' + d + ': ' + e.message); return; }
      es.forEach(function(x) {
        var f = path.join(d, x.name);
        if ( x.isDirectory() ) return walk(f);
        if ( ! /\.js$/.test(x.name) ) return;
        try { var m = fs.statSync(f).mtimeMs; if ( m < bootTime ) seen[f] = m; }
        catch ( e ) { log('[FTypechecks] cannot read ' + f + ': ' + e.message); }
      });
    };
    dirs.forEach(function(d) { if ( fs.existsSync(d) ) walk(d); });
  }
  var genPath = null, gen = null;

  function loadGenerator() {
    var g;
    try { g = JSON.parse(fs.readFileSync(path.join(work, 'generator.json'), 'utf8')); }
    catch ( e ) { return null; }          // check.js has not run yet
    if ( g.generator !== genPath ) {
      try {
        delete require.cache[require.resolve(g.generator)];
        gen = require(g.generator);
        genPath = g.generator;
      } catch ( e ) {
        log('[FTypechecks] cannot load ' + g.generator + ': ' + e.message);
        return null;
      }
    }
    return typeof gen.generate === 'function' ? g : null;
  }

  // Write to a temp name, then rename: check.js may be reading the old file.
  function put(file, text) {
    var tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  function write(changed) {
    var g = loadGenerator();
    if ( ! g ) return false;
    var t0 = Date.now();
    if ( ! changed && ! Object.keys(seen).length ) seedSeen();     // the first types file
    var out = path.join(work, 'app.d.ts.' + process.pid + '.tmp');
    var rep = path.join(work, 'report.json.' + process.pid + '.tmp');
    try {
      var r = gen.generate({
        out: out, report: rep, style: g.style, level: g.level, app: g.app,
        journals: g.journals && gen.readList ? gen.readList(g.journals) : []
      });
      fs.renameSync(out, path.join(work, 'app.d.ts'));
      fs.renameSync(rep, path.join(work, 'report.json'));
    } catch ( e ) {
      log('[FTypechecks] generate failed: ' + ( e.stack || e.message ));
      return false;
    }
    ( changed || [] ).forEach(function(f) {
      try { seen[f] = fs.statSync(f).mtimeMs; }
      catch ( e ) { log('[FTypechecks] cannot read ' + f + ': ' + e.message); }
    });
    put(path.join(work, 'lsp.json'), JSON.stringify({
      pid: process.pid, generator: genPath, level: g.level,
      written: Date.now(), ms: Date.now() - t0, seen: seen
    }, null, 1));
    log('[FTypechecks] wrote types in ' + ( Date.now() - t0 ) + ' ms (' +
      ( r && r.classes ) + ' classes)' + ( changed ? ' after ' + changed.join(', ') : '' ));
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

module.exports = { create: create };

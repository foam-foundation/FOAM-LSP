/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Finds the foam3 a project builds with, so the LSP indexes the project
// against that foam3 rather than a copy of its own.

var fs   = require('fs');
var path = require('path');

function hasFoam(dir) { return fs.existsSync(path.join(dir, 'src', 'foam.js')); }

function resolveFoam(projectRoot, env) {
  env = env || process.env;
  var project = fs.realpathSync(projectRoot);

  if ( env.FOAM3_ROOT ) {
    if ( ! hasFoam(env.FOAM3_ROOT) ) throw new Error('FOAM-LSP: FOAM3_ROOT=' + env.FOAM3_ROOT + ' has no src/foam.js');
    return { project: project, foam3: fs.realpathSync(env.FOAM3_ROOT) };
  }

  var candidates = [ path.join(project, 'foam3'), project ];
  for ( var i = 0 ; i < candidates.length ; i++ ) {
    if ( hasFoam(candidates[i]) ) return { project: project, foam3: fs.realpathSync(candidates[i]) };
  }
  throw new Error('FOAM-LSP: no foam3 found under ' + project + '; set FOAM3_ROOT');
}

module.exports = resolveFoam;

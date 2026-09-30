/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.parse.lsp.handlers',
  name: 'LintHandler',

  documentation: `Registration-completeness lint — cross-file checks the
    per-file diagnostics cannot see: a Rule whose ruleGroup is defined
    nowhere (rule silently never fires), a StrategyReference pointing at a
    missing class, strategy implementors with no StrategyReference entry
    (invisible in the Rule-creation UI), ambiguous parser order, POM
    membership (delegates to PomValidator), and empty catch blocks under
    tools/lsp (bare-catch — errors vanish silently). Serves the custom
    foam/lint request. Never uses reference search — jrl cross-referencing
    goes through JrlLoader + FoamIndex only. Checks degrade gracefully:
    without 'index' the strategy-ref implementor direction (Direction B) is
    skipped, and without 'pomValidator' pom-membership returns no findings.`,

  requires: [ 'foam.parse.lsp.JrlLoader' ],

  constants: {
    // Canonical list lives in ../lintChecks.js — shared with the MCP
    // foam_lint schema so a new check registers on both surfaces at once.
    ALL_CHECKS: require('../lintChecks'),
    DEFAULT_STRATEGY_TARGETS: [ 'foam.core.ruler.RuleAction' ],
    IGNORE_MARKER: 'foam-lint-ignore: strategy-ref'
  },

  properties: [
    { name: 'index' },
    { name: 'pomValidator' },
    {
      name: 'loader',
      factory: function() { return this.JrlLoader.create(); }
    },
    {
      name: 'root',
      factory: function() { return process.cwd(); }
    }
  ],

  methods: [
    function findJrlFiles_(basename) {
      /** Bounded walk from root collecting files with this exact basename.
          Same skip rules as PomValidator.walkSourceTree_. */
      var fs = require('fs');
      var path = require('path');
      var out = [];
      var stack = [ this.root ];
      while ( stack.length ) {
        var dir = stack.pop();
        var entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { require('../logError').logLspError('lint: read dir ' + dir, e); continue; }
        for ( var i = 0 ; i < entries.length ; i++ ) {
          var ent = entries[i];
          if ( ent.name.charAt(0) === '.' )             continue;
          if ( ent.name === 'node_modules' )            continue;
          if ( ent.name === 'build' || ent.name === 'out' ) continue;
          var full = path.join(dir, ent.name);
          if ( ent.isDirectory() ) stack.push(full);
          else if ( ent.isFile() && ent.name === basename ) out.push(full);
        }
      }
      return out;
    },

    function findLine_(filePath, needle) {
      /** 1-based line of the first line containing needle; 1 if absent.
          JrlLoader eval-loads entries and loses source positions, so
          findings re-anchor by searching for the quoted id — a heuristic,
          with line 1 as the fallback when the needle isn't found. */
      var fs = require('fs');
      try {
        var lines = fs.readFileSync(filePath, 'utf8').split('\n');
        for ( var i = 0 ; i < lines.length ; i++ ) {
          if ( lines[i].indexOf(needle) !== -1 ) return i + 1;
        }
      } catch (e) {
        require('../logError').logLspError('lint: read ' + filePath, e);
      }
      return 1;
    },

    function finding_(check, severity, filePath, line, message, fix) {
      var f = { check: check, severity: severity, path: filePath, line: line, message: message };
      if ( fix ) f.fix = fix;
      return f;
    },

    function checkRuleGroups_() {
      var path = require('path');
      var self = this;
      var findings = [];

      // groupId → [defining files]
      var defs = {};
      var groupFiles = this.findJrlFiles_('ruleGroups.jrl');
      for ( var i = 0 ; i < groupFiles.length ; i++ ) {
        var groups = this.loader.filterByClass(
          this.loader.loadFile(groupFiles[i]), 'foam.core.ruler.RuleGroup');
        for ( var j = 0 ; j < groups.length ; j++ ) {
          if ( groups[j].id == null ) continue;
          ( defs[groups[j].id] || (defs[groups[j].id] = []) ).push(groupFiles[i]);
        }
      }

      // Reachable = same dir as the rules.jrl, OR anywhere under
      // <root>/journals/, OR any /src/ path; a group only defined in a
      // DIFFERENT deployment dir demotes the finding to a warn (not an error).
      function reachable(defFile, ruleFile) {
        if ( path.dirname(defFile) === path.dirname(ruleFile) ) return true;
        if ( defFile.indexOf(path.join(self.root, 'journals') + path.sep) === 0 ) return true;
        if ( defFile.indexOf(path.sep + 'src' + path.sep) !== -1 ) return true;
        return false;
      }

      var ruleFiles = this.findJrlFiles_('rules.jrl');
      for ( var i = 0 ; i < ruleFiles.length ; i++ ) {
        var rules = this.loader.filterByClass(
          this.loader.loadFile(ruleFiles[i]), 'foam.core.ruler.Rule');
        for ( var j = 0 ; j < rules.length ; j++ ) {
          var rule = rules[j];
          if ( ! rule.ruleGroup ) continue;
          var defFiles = defs[rule.ruleGroup] || [];
          var line = this.findLine_(ruleFiles[i], '"' + (rule.id || rule.ruleGroup) + '"');
          if ( defFiles.length === 0 ) {
            findings.push(this.finding_('rule-group', 'error', ruleFiles[i], line,
              "rule '" + rule.id + "' references ruleGroup '" + rule.ruleGroup +
              "' — not defined in any ruleGroups.jrl (rule will silently never fire)",
              'add the group to ' + path.join(path.dirname(ruleFiles[i]), 'ruleGroups.jrl')));
          } else if ( ! defFiles.some(function(d) { return reachable(d, ruleFiles[i]); }) ) {
            findings.push(this.finding_('rule-group', 'warn', ruleFiles[i], line,
              "rule '" + rule.id + "' references ruleGroup '" + rule.ruleGroup +
              "' — only defined in other deployment dirs: " +
              defFiles.map(function(d) { return path.relative(self.root, path.dirname(d)); }).join(', '),
              'define the group beside the rule or in journals/'));
          }
        }
      }
      return findings;
    },

    function checkStrategyRefs_(strategyTargets) {
      var fs = require('fs');
      var path = require('path');
      var findings = [];
      var targets = ( strategyTargets && strategyTargets.length ) ?
        strategyTargets : this.DEFAULT_STRATEGY_TARGETS;

      // Collect all StrategyReference entries; Direction A along the way.
      var registered = {};
      var refFiles = this.findJrlFiles_('strategyReferences.jrl');
      for ( var i = 0 ; i < refFiles.length ; i++ ) {
        var refs = this.loader.filterByClass(
          this.loader.loadFile(refFiles[i]), 'foam.strategy.StrategyReference');
        for ( var j = 0 ; j < refs.length ; j++ ) {
          var ref = refs[j];
          if ( ! ref.strategy ) continue;
          registered[ref.strategy] = true;
          if ( this.index && ! this.index.classExists(ref.strategy) ) {
            var flagGatedPath = this.index.getFilePath && this.index.getFilePath(ref.strategy);
            if ( flagGatedPath ) {
              findings.push(this.finding_('strategy-ref', 'warn', refFiles[i],
                this.findLine_(refFiles[i], '"' + ref.strategy + '"'),
                "StrategyReference '" + (ref.id || '') + "' points at class '" + ref.strategy +
                "' — registered in a pom but flag-gated (not loaded under current flags)",
                'expected for test-only strategies; verify the flags if this should be a production class'));
            } else {
              findings.push(this.finding_('strategy-ref', 'error', refFiles[i],
                this.findLine_(refFiles[i], '"' + ref.strategy + '"'),
                "StrategyReference '" + (ref.id || '') + "' points at class '" + ref.strategy +
                "' which does not exist in the index",
                'fix the class id or delete the stale entry'));
            }
          }
        }
      }

      // Direction B: implementors of each target with no entry.
      if ( ! this.index ) return findings;
      var srcRoot = path.join(this.root, 'src') + path.sep;
      for ( var t = 0 ; t < targets.length ; t++ ) {
        var impls = this.index.isInterface(targets[t]) ?
          this.index.getImplementors(targets[t]) :
          this.index.getSubclasses(targets[t]);
        for ( var k = 0 ; k < impls.length ; k++ ) {
          if ( registered[impls[k]] ) continue;
          var file = this.index.getFilePath(impls[k]);
          if ( ! file || file.indexOf(srcRoot) !== 0 ) continue;
          var text;
          try { text = fs.readFileSync(file, 'utf8'); }
          catch (e) { require('../logError').logLspError('lint: read ' + file, e); continue; }
          if ( text.indexOf(this.IGNORE_MARKER) !== -1 ) continue;
          findings.push(this.finding_('strategy-ref', 'warn', file,
            (this.index.getClassLine(impls[k]) || 0) + 1,
            "'" + impls[k] + "' implements " + targets[t] +
            " but has no StrategyReference entry — invisible in the Rule-creation UI" +
            " (intentional for jrl-only actions)",
            "add an entry to strategyReferences.jrl, or add '// " + this.IGNORE_MARKER + "' to the class file"));
        }
      }
      return findings;
    },

    function checkParserOrder_() {
      var path = require('path');
      var self = this;
      var findings = [];
      var seen = {};

      var files = this.findJrlFiles_('parsers.jrl');
      var srcFiles = files.filter(function(f) { return f.indexOf(path.sep + 'src' + path.sep) !== -1; });
      var depFiles = files.filter(function(f) { return srcFiles.indexOf(f) === -1; });

      function entriesOf(fileList) {
        var out = [];
        for ( var i = 0 ; i < fileList.length ; i++ ) {
          var objs = self.loader.loadFile(fileList[i]);
          for ( var j = 0 ; j < objs.length ; j++ ) {
            if ( typeof objs[j].order === 'number' ) out.push({ entry: objs[j], file: fileList[i] });
          }
        }
        return out;
      }

      // Different policy from checkRuleGroups_: parsers share one global
      // registry, so each deployment parsers.jrl is checked against its own
      // entries plus ALL /src/ entries pooled in; src-only entries also form
      // one extra set on their own.
      var srcEntries = entriesOf(srcFiles);
      var sets = [ srcEntries ];
      for ( var i = 0 ; i < depFiles.length ; i++ ) {
        sets.push(entriesOf([ depFiles[i] ]).concat(srcEntries));
      }

      for ( var s = 0 ; s < sets.length ; s++ ) {
        var byOrder = {};
        for ( var i = 0 ; i < sets[s].length ; i++ ) {
          var it = sets[s][i];
          ( byOrder[it.entry.order] || (byOrder[it.entry.order] = []) ).push(it);
        }
        for ( var order in byOrder ) {
          var group = byOrder[order];
          if ( group.length < 2 ) continue;
          var ids = group.map(function(g) { return g.entry.id; }).sort();
          var key = order + ':' + ids.join(',');
          if ( seen[key] ) continue;
          seen[key] = true;
          findings.push(this.finding_('parser-order', 'warn', group[0].file,
            this.findLine_(group[0].file, '"' + group[0].entry.id + '"'),
            "parsers " + ids.map(function(x) { return "'" + x + "'"; }).join(' and ') +
            " share order " + order + " in the same reachable set — parser selection is ambiguous",
            'give each parser a distinct order value'));
        }
      }
      return findings;
    },

    function checkPomMembership_() {
      if ( ! this.pomValidator ) return [];
      var r = this.pomValidator.validate();
      var findings = [];
      for ( var i = 0 ; i < r.orphans.length ; i++ ) {
        findings.push(this.finding_('pom-membership', 'error', r.orphans[i], 1,
          'foam.CLASS file not listed in any pom.js — the class never compiles into a build',
          'add an entry to the nearest pom.js (copy a sibling entry for the flags)'));
      }
      for ( var i = 0 ; i < r.missing.length ; i++ ) {
        findings.push(this.finding_('pom-membership', 'error', r.missing[i], 1,
          'pom.js entry points at a file that does not exist',
          'remove the stale entry or restore the file'));
      }
      return findings;
    },

    function runBareCatch_(roots) {
      /**
       * Flag catch clauses whose block holds zero statements (comment-only
       * counts as empty — a comment is not a runtime trace). Text-based
       * brace walk, consistent with the other checks' non-AST style.
       * File-scoped suppression: a `// foam-lint-ignore: bare-catch` line.
       */
      var fs_ = require('fs'), path_ = require('path');
      var findings = [];
      var files = [];

      function walk(dir) {
        var names;
        try { names = fs_.readdirSync(dir); }
        catch (e) { require('../logError').logLspError('lint: read dir ' + dir, e); return; }
        for ( var i = 0 ; i < names.length ; i++ ) {
          // Same skip rules as findJrlFiles_ / PomValidator.walkSourceTree_ —
          // keeps vendor/generated trees (vscode extension's node_modules,
          // compiled out/) out of the scan.
          if ( names[i].charAt(0) === '.' )                continue;
          if ( names[i] === 'node_modules' )               continue;
          if ( names[i] === 'build' || names[i] === 'out' ) continue;
          var p = path_.join(dir, names[i]);
          var st;
          try { st = fs_.lstatSync(p); }
          catch (e) { require('../logError').logLspError('lint: stat ' + p, e); continue; }
          if ( st.isSymbolicLink() ) continue;   // foam3 root has `foam3 -> .`
          if ( st.isDirectory() ) walk(p);
          else if ( p.endsWith('.js') ) files.push(p);
        }
      }
      for ( var r = 0 ; r < roots.length ; r++ ) walk(roots[r]);

      for ( var f = 0 ; f < files.length ; f++ ) {
        var content;
        try { content = fs_.readFileSync(files[f], 'utf8'); }
        catch (e) { require('../logError').logLspError('lint: read ' + files[f], e); continue; }
        // The marker counts only as a line of its own. A plain indexOf also
        // matched the marker quoted in a string or doc comment, so this file,
        // which names the marker in its fix hint, was never scanned itself.
        if ( /^\s*\/\/\s*foam-lint-ignore: bare-catch/m.test(content) ) continue;

        var re = /catch\s*(?:\(\s*[\w$]*\s*\))?\s*\{/g;
        var m;
        while ( ( m = re.exec(content) ) !== null ) {
          var i = m.index + m[0].length;   // just past the '{'
          var depth = 1, hasStatement = false;
          while ( i < content.length && depth > 0 ) {
            var ch = content[i];
            if ( ch === '/' && content[i+1] === '/' ) {
              while ( i < content.length && content[i] !== '\n' ) i++;
            } else if ( ch === '/' && content[i+1] === '*' ) {
              i += 2;
              while ( i < content.length && !(content[i] === '*' && content[i+1] === '/') ) i++;
              i++;
            } else if ( ch === '{' ) depth++;
            else if ( ch === '}' ) depth--;
            else if ( ! /\s/.test(ch) ) hasStatement = true;
            i++;
          }
          if ( ! hasStatement ) {
            // 1-based line, matching findLine_'s contract used by every other check.
            var line = content.slice(0, m.index).split('\n').length;
            findings.push(this.finding_('bare-catch', 'error', files[f], line,
              "empty catch block — error vanishes; broken feature indistinguishable from an empty result",
              "log it with logLspError(context, err) from tools/lsp/logError.js, or add a `// foam-lint-ignore: bare-catch` line saying why"));
          }
        }
      }
      return findings;
    },

    function lint(params) {
      params = params || {};
      var checks = ( params.checks && params.checks.length ) ? params.checks : this.ALL_CHECKS;
      var allChecks = this.ALL_CHECKS;
      var unknown = checks.filter(function(c) { return allChecks.indexOf(c) === -1; });
      if ( unknown.length ) {
        throw new Error('unknown check(s): ' + unknown.join(', ') + ' — valid: ' + this.ALL_CHECKS.join(', '));
      }
      var findings = [];
      if ( checks.indexOf('pom-membership') !== -1 ) findings = findings.concat(this.checkPomMembership_());
      if ( checks.indexOf('rule-group') !== -1 )     findings = findings.concat(this.checkRuleGroups_());
      if ( checks.indexOf('strategy-ref') !== -1 )   findings = findings.concat(this.checkStrategyRefs_(params.strategyTargets));
      if ( checks.indexOf('parser-order') !== -1 )   findings = findings.concat(this.checkParserOrder_());
      if ( checks.indexOf('bare-catch') !== -1 )     findings = findings.concat(
        this.runBareCatch_([ require('path').join(this.root, 'tools/lsp') ]));

      if ( params.scope === 'paths' && Array.isArray(params.paths) ) {
        var path = require('path');
        var keep = {};
        for ( var i = 0 ; i < params.paths.length ; i++ ) {
          keep[path.resolve(this.root, params.paths[i])] = true;
        }
        findings = findings.filter(function(f) { return keep[f.path]; });
      }
      return { findings: findings };
    }
  ]
});

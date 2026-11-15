/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.parse.lsp.handlers',
  name: 'TypingChecker',

  documentation: `Typing style rules: a model says the type of each property,
    method argument and import, so tools (a type checker, completion, hover)
    know it. Off unless the project asks (diagnostics.typing; a
    foam-check.config.json turns it on, see FeatureConfig projectDefaults).

    Reads the model as written (the FileModelCache model): only what this file
    declares is checked. The live class then has the last word where FOAM
    fills a type in: a property with no class that overrides a parent's gets
    the parent's class, and a method override inherits its parent's args.
    Each finding carries its quick fix, so DiagnosticsHandler (the warning)
    and CodeActionHandler (the fix) share one answer.`,

  requires: [
    'foam.parse.lsp.CursorAnalyzer',
    'foam.parse.lsp.Diagnostic'
  ],

  constants: {
    // What each rule says, by diagnostic code.
    RULES: {
      'typing-property-no-class': {
        message: 'Property "%s" has no class, so its type is unknown.',
        fix: "Add a class, for example class: 'String'."
      },
      'typing-untyped-args': {
        message: 'Method "%s" has arguments with no type.',
        fix: "Use the object form: { name, args: 'Type name', code: function(name) {...} }."
      },
      'typing-import-no-type': {
        message: 'Import "%s" has no type.',
        fix: "Use the object form: { name: 'x', key: 'x', type: 'Type' }."
      },
      'typing-dao-import-no-of': {
        message: 'DAO import "%s" does not say what it holds.',
        fix: "Add of: '<class id>' to the import."
      }
    }
  },

  properties: [
    { name: 'index' },
    { name: 'grammar' },
    {
      class: 'FObjectProperty',
      of: 'foam.parse.lsp.CursorAnalyzer',
      name: 'analyzer',
      factory: function() { return this.CursorAnalyzer.create(); }
    }
  ],

  methods: [
    function check(m, text) {
      /**
       * The findings for model m in text: [{ code, name, start, end, fix }],
       * start/end the offsets of the member's name, fix null or
       * { title, offset, insert }.
       */
      if ( ! m || m.type_ === 'LIB' ) return [];
      var entry = this.grammar && this.grammar.modelEntryFor(text, m);
      var live  = this.liveAxiom_(m);
      var out = [];
      var at = function(list, name) {
        var e = entry && ( entry[list] || [] ).filter(function(x) { return x.name === name; })[0];
        return e || null;
      };
      var add = function(code, name, span, opt_fix) {
        out.push({ code: code, name: name, start: span[0], end: span[1], fix: opt_fix || null });
      };
      var fallback = entry ? [ entry.nameStart || entry.startPos, entry.nameEnd || entry.startPos ] : [ 0, 0 ];

      ( m.properties || [] ).forEach(function(p) {
        var name = typeof p === 'string' ? p : Array.isArray(p) ? p[0] : p && p.name;
        if ( ! name || ( p && typeof p === 'object' && ! Array.isArray(p) && p['class'] ) ) return;
        var ax = live(name);
        if ( ax && ax.cls_ && ax.cls_.id !== 'foam.lang.Property' ) return;   // a class FOAM gave it
        var e = at('properties', name);
        add('typing-property-no-class', name, e ? [ e.nameStart, e.nameEnd ] : fallback,
          e && typeof p === 'object' && ! Array.isArray(p) ? this.classFix_(p, e, text) : null);
      }, this);

      ( m.methods || [] ).forEach(function(f) {
        var name = typeof f === 'function' ? f.name : f && f.name;
        var code = typeof f === 'function' ? f : f && f.code;
        if ( ! name || typeof code !== 'function' || ! code.length ) return;
        if ( typeof f === 'object' && this.argsTyped_(f.args, code.length) ) return;
        var ax = live(name);
        if ( ax && this.argsTyped_(ax.args, code.length) ) return;            // args it inherits
        var e = at('methods', name);
        add('typing-untyped-args', name, e ? [ e.nameStart, e.nameEnd ] : fallback);
      }, this);

      ( m.imports || [] ).forEach(function(im) {
        // 'key? as name': the class's member is the name; the text to find is the key.
        var parts = typeof im === 'string' ? im.split(/\s+as\s+/) : null;
        var key   = parts ? parts[0].replace(/\?$/, '') : im && ( im.key || im.name );
        var name  = parts ? ( parts[1] || key ) : im && im.name;
        if ( ! name ) return;
        var span = this.importSpan_(text, entry, key) || this.importSpan_(text, entry, name) || fallback;
        if ( typeof im === 'string' || ( typeof im.type !== 'string' && typeof im.of !== 'string' ) ) {
          add('typing-import-no-type', name, span);
        } else if ( im.type === 'foam.dao.DAO' && typeof im.of !== 'string' ) {
          add('typing-dao-import-no-of', name, span);
        }
      }, this);

      return out;
    },

    function validateModel(m, text, diagnostics) {
      /** Push the findings for m as WARNING diagnostics (DiagnosticsHandler.validateModel_). */
      var self = this;
      this.check(m, text).forEach(function(f) {
        var r = self.RULES[f.code];
        diagnostics.push(self.Diagnostic.create({
          range: {
            start: self.analyzer.offsetToPosition(text, f.start),
            end:   self.analyzer.offsetToPosition(text, f.end)
          },
          severity: self.Diagnostic.WARNING,
          message:  r.message.replace('%s', f.name) + ' ' + r.fix,
          code:     f.code,
          fix:      f.fix
        }));
      });
    },

    function liveAxiom_(m) {
      /**
       * name -> the live axiom of that name, or null. From the class itself;
       * when this process did not load it (a test class), from what it
       * extends and implements, which hold what an override inherits.
       */
      var self = this;
      var own  = m.refines || ( m['package'] ? m['package'] + '.' : '' ) + m.name;
      var ids  = this.index && this.index.getClass(own) ? [ own ] :
        [ m['extends'] || 'foam.lang.FObject' ].concat(m['implements'] || []);
      var classes = ids.map(function(id) {
        return typeof id === 'string' && self.index ? self.index.getClass(id) : null;
      }).filter(Boolean);
      return function(name) {
        for ( var i = 0 ; i < classes.length ; i++ ) {
          try {
            var ax = classes[i].getAxiomByName(name);
            if ( ax ) return ax;
          } catch (e) {
            require('../logError').logLspError('typing check: axiom ' + name + ' of ' + classes[i].id, e);
          }
        }
        return null;
      };
    },

    function argsTyped_(args, count) {
      /** Whether args (an array of Arg specs, or 'Type a, Type b') types at least count arguments. */
      if ( typeof args === 'string' ) args = args.split(',');
      if ( ! Array.isArray(args) || args.length < count ) return false;
      return args.every(function(a) {
        if ( typeof a === 'string' ) return /^\s*\S+\s+\S+\s*$/.test(a);    // 'Type name'
        return !! ( a && a.type );
      });
    },

    function classFix_(p, e, text) {
      /**
       * The class a property's value says, as an insert after its '{'; null
       * when the value does not say (no value, null, an object, a factory).
       */
      if ( ! ( 'value' in p ) ) return null;
      var v = p.value;
      var cls = typeof v === 'string'  ? 'String' :
                typeof v === 'boolean' ? 'Boolean' :
                typeof v === 'number'  ? ( Number.isInteger(v) ? 'Int' : 'Float' ) :
                Array.isArray(v)       ? 'Array' : null;
      if ( ! cls || text.charAt(e.startPos) !== '{' ) return null;
      return { title: "Add class: '" + cls + "' (from its value)", offset: e.startPos + 1, insert: " class: '" + cls + "'," };
    },

    function importSpan_(text, entry, name) {
      /** Offsets of the import's name inside the model's imports: list, or null. */
      if ( ! entry ) return null;
      var body = text.slice(entry.startPos, entry.endPos);
      var list = /\bimports\s*:\s*\[/.exec(body);
      if ( ! list ) return null;
      var re = new RegExp('[\'"`]' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s?\'"`])', 'g');
      re.lastIndex = list.index;
      var hit = re.exec(body);
      return hit ? [ entry.startPos + hit.index + 1, entry.startPos + hit.index + 1 + name.length ] : null;
    }
  ]
});

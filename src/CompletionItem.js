/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.parse.lsp',
  name: 'CompletionItem',

  documentation: 'Typed LSP completion item. Serialize with toLSP() for protocol wire format (no `class` field).',

  constants: {
    // LSP CompletionItemKind enum values (subset used by this LSP)
    KIND_TEXT: 1,
    KIND_METHOD: 2,
    KIND_CLASS: 7,
    KIND_PROPERTY: 10,
    KIND_VALUE: 12,
    KIND_ENUM: 13,
    KIND_KEYWORD: 14,
    KIND_COLOR: 16,
    KIND_FILE: 17,
    KIND_CONSTANT: 21,
    KIND_OPERATOR: 24,

    // InsertTextFormat
    FORMAT_PLAIN: 1,
    FORMAT_SNIPPET: 2,

    // CompletionItemTag
    TAG_DEPRECATED: 1   // editor strikes the label through
  },

  properties: [
    { class: 'String', name: 'label' },
    { class: 'Int',    name: 'kind', value: 1 },
    { class: 'String', name: 'detail' },
    { name: 'documentation' },    // string | { kind: 'markdown', value: string }
    { class: 'String', name: 'insertText' },
    { class: 'Int',    name: 'insertTextFormat' },
    { name: 'textEdit' },         // { range, newText }
    { class: 'String', name: 'filterText' },
    { class: 'String', name: 'sortText' },
    { class: 'Boolean', name: 'preselect' },
    { name: 'labelDetails' },     // { detail?, description? } — see toLSPItems
    { class: 'Array', name: 'tags' }, // CompletionItemTag values — see toLSPItems
    { name: 'additionalTextEdits' } // [{ range, newText }] applied with the pick
  ],

  static: [
    function toLSPItems(items, opt_itemSupport) {
      /**
       * Normalize a completion list to wire shape for one client.
       *
       * Handlers attach `labelDetails` (`{ description: 'foam.dao' }`,
       * `{ detail: ': String' }`) wherever they know it, but LSP only lets a
       * server send it to a client that declared
       * `completionItem.labelDetailsSupport` — a client that never declared it
       * may render the object as garbage or reject the item. So the field is
       * dropped here, in one place, unless `opt_itemSupport` (the client's
       * `textDocument.completion.completionItem` capability) says yes. The
       * plain `detail` string is never touched, so an older client sees the
       * same list it always did.
       *
       * `tags` (TAG_DEPRECATED on a property marked `deprecated:`) gets the
       * same treatment: kept only as far as the client listed the value in
       * `completionItem.tagSupport.valueSet`.
       *
       * Model instances (CompletionItem) are flattened via toLSP(); raw
       * objects pass through, copied only when a field has to go.
       */
      if ( ! items ) return items;
      var keepLabelDetails = !! ( opt_itemSupport && opt_itemSupport.labelDetailsSupport );
      var tagSet = opt_itemSupport && opt_itemSupport.tagSupport && opt_itemSupport.tagSupport.valueSet;
      var out = new Array(items.length);
      for ( var i = 0 ; i < items.length ; i++ ) {
        var it = items[i];
        var o  = ( it && typeof it.toLSP === 'function' ) ? it.toLSP() : it;
        if ( o && ( ( o.labelDetails && ! keepLabelDetails ) || o.tags ) ) {
          o = Object.assign({}, o);
          if ( ! keepLabelDetails ) delete o.labelDetails;
          var tags = o.tags && Array.isArray(tagSet) ?
            o.tags.filter(function(t) { return tagSet.indexOf(t) !== -1; }) : [];
          if ( tags.length ) o.tags = tags; else delete o.tags;
        }
        out[i] = o;
      }
      return out;
    }
  ],

  methods: [
    function toLSP() {
      /** Return a plain LSP-protocol-shaped object (no FOAM `class` field). */
      var o = { label: this.label, kind: this.kind };
      if ( this.detail ) o.detail = this.detail;
      if ( this.documentation ) o.documentation = this.documentation;
      if ( this.insertText ) o.insertText = this.insertText;
      if ( this.insertTextFormat ) o.insertTextFormat = this.insertTextFormat;
      if ( this.textEdit ) o.textEdit = this.textEdit;
      if ( this.filterText ) o.filterText = this.filterText;
      if ( this.sortText ) o.sortText = this.sortText;
      if ( this.preselect ) o.preselect = this.preselect;
      if ( this.labelDetails ) o.labelDetails = this.labelDetails;
      if ( this.tags.length ) o.tags = this.tags;
      if ( this.additionalTextEdits ) o.additionalTextEdits = this.additionalTextEdits;
      return o;
    }
  ]
});

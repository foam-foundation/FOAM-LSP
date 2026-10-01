/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.parse.lsp.test',
  name: 'JavaBlockValidatorTest',
  extends: 'foam.core.test.JSTest',

  methods: [
    async function runTest(x) {
      var index     = foam.parse.lsp.FoamIndex.create();
      var cache     = foam.parse.lsp.FileModelCache.create();
      var validator = foam.parse.lsp.handlers.JavaBlockValidator.create({ index: index });

      // Validate one file's text the way DiagnosticsHandler does: parse it
      // into models, then check each one.
      function validate(text) {
        var diags  = [];
        var models = cache.getModels('file:///JavaBlockValidatorTest_' + Math.random() + '.js', text);
        models.forEach(function(m) { validator.validateModel(m, cache.getClassId(m), diags, text); });
        return diags;
      }

      var model = "foam.CLASS({\n  package: 'foam.parse.lsp.test',\n  name: 'JavaTestModel',\n" +
        "  properties: [ { class: 'String', name: 'firstName' }, { class: 'Int', name: 'age' } ],\n";

      var diags = validate(model + "  javaCode: `getFirstName();`\n})");
      x.test(diags.filter(function(d) { return d.message.indexOf('firstName') !== -1; }).length === 0,
        'Valid getter should not be flagged');

      diags = validate(model + "  javaCode: `getNonexistent();`\n})");
      x.test(diags.some(function(d) { return d.message.indexOf('nonexistent') !== -1; }),
        'Invalid getter should be flagged');

      diags = validate(model + "  javaImports: ['foam.nanos.logger.Logger']\n})");
      x.test(diags.some(function(d) { return d.message.indexOf('foam.core.logger') !== -1; }),
        'foam.nanos import should suggest foam.core alternative');
    }
  ]
});

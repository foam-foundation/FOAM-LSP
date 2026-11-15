/**
 * Canonical list of foam-lint check names — the single registration point.
 * LintHandler's ALL_CHECKS constant and the MCP foam_lint schema (enum +
 * description) both derive from this module, so adding a check here
 * registers it on every surface at once instead of requiring manual syncs.
 */
// Run by default.
var DEFAULT = [
  'pom-membership',
  'rule-group',
  'strategy-ref'
];
// Run only when named (--checks typing): typing reports a style most
// workspaces have not adopted, and journal-rows would turn existing CI red on
// journals no one has looked at yet.
//   typing        TypingChecker's rules over the project's model files
//   journal-rows  JrlHandler's journal diagnostics: rows FOAM's reader cannot
//                 use, unknown classes, unknown keys
var OPT_IN = [
  'typing',
  'journal-rows'
];

module.exports = DEFAULT.concat(OPT_IN);
module.exports.DEFAULT = DEFAULT;
module.exports.OPT_IN  = OPT_IN;

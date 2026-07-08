const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const proposalStart = source.indexOf('function renderActionProposals');
const markdownStart = source.indexOf('function escapeHtml');
const markdownEnd = source.indexOf('function resizeCommandInput');
assert(proposalStart >= 0, 'renderActionProposals not found');
assert(markdownStart >= 0, 'escapeHtml not found');
assert(markdownEnd > markdownStart, 'markdown block end not found');

const markdownInput = '<script>alert(1)</script> **ok** `x<y`';
const harness = [
  "currentActionProposals = [{",
  "  id: 'p1',",
  "  action_type: 'copy_text_to_clipboard',",
  "  confirmation_required: true,",
  "  action_token: 'tok-1',",
  "}];",
  "globalThis.testResult = {",
  `  markdown: renderSafeMarkdown(${JSON.stringify(markdownInput)}),`,
  "  chips: renderActionProposals(currentActionProposals),",
  "  noTokenChips: renderActionProposals([{ id: 'p2', action_type: 'copy_text_to_clipboard' }]),",
  "};",
].join('\n');

const extracted = [
  'let currentActionProposals = [];',
  source.slice(proposalStart, markdownStart),
  source.slice(markdownStart, markdownEnd),
  harness,
].join('\n');

const context = {};
vm.runInNewContext(extracted, context, { filename: 'overlay_static_test.vm.js' });

assert(context.testResult.markdown.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert(context.testResult.markdown.includes('<strong>ok</strong>'));
assert(context.testResult.markdown.includes('<code>x&lt;y</code>'));
assert(context.testResult.chips.includes('data-action-index="0"'));
assert(context.testResult.chips.includes('Confirm copy path'));
assert.strictEqual(context.testResult.noTokenChips, '');
console.log('overlay static test ok');

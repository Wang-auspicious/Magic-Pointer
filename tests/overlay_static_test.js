const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const html = fs.readFileSync('electron/renderer/index.html', 'utf8');
const css = fs.readFileSync('electron/renderer/styles.css', 'utf8');
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
  "const replaceProposal = {",
  "  id: 'p3',",
  "  action_type: 'office_replace_selection',",
  "  confirmation_required: true,",
  "  action_token: 'tok-3',",
  "  parameters: { document: 'C:/demo/doc.docx', expected_text_excerpt: '<old>', replacement_text_excerpt: 'new text' },",
  "};",
  "const undoProposal = {",
  "  id: 'p4',",
  "  action_type: 'office_undo_last_action',",
  "  confirmation_required: true,",
  "  action_token: 'tok-4',",
  "  parameters: { document: 'C:/demo/doc.docx' },",
  "};",
  "globalThis.testResult = {",
  `  markdown: renderSafeMarkdown(${JSON.stringify(markdownInput)}),`,
  "  chips: renderActionProposals(currentActionProposals),",
  "  replace: renderActionProposals([replaceProposal]),",
  "  undo: renderActionProposals([undoProposal]),",
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

assert(context.testResult.replace.includes('Word write preview'));
assert(context.testResult.replace.includes('Confirm replace Word selection'));
assert(context.testResult.replace.includes('&lt;old&gt;'));
assert(context.testResult.undo.includes('Precise Magic Pointer restore'));
assert(context.testResult.undo.includes('Confirm undo Word edit'));
assert(html.includes('id="dictation"'));
assert(html.includes('placeholder="描述问题或期望，不需要找源码"'));
assert(source.includes("dictationButton.addEventListener('click'"));
assert(source.includes('window.magicPointer?.startDictation()'));
assert(css.includes('.pill-dictation'));

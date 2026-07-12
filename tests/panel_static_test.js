const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('electron/renderer/panel.js', 'utf8');
const html = fs.readFileSync('electron/renderer/panel.html', 'utf8');
const css = fs.readFileSync('electron/renderer/panel.css', 'utf8');
const renderStart = source.indexOf('function escapeHtml');
const submitStart = source.indexOf('function submitCommand');
assert(renderStart >= 0, 'escapeHtml not found');
assert(submitStart > renderStart, 'submitCommand not found');

const extracted = [
  'let currentActionProposals = [];',
  source.slice(renderStart, submitStart),
  `const replaceProposal = { action_type: 'office_replace_selection', confirmation_required: true, action_token: 'tok', parameters: { document: 'C:/demo.docx', expected_text_excerpt: '<old>', replacement_text_excerpt: 'new' } };`,
  `const undoProposal = { action_type: 'office_undo_last_action', confirmation_required: true, action_token: 'tok2', parameters: { document: 'C:/demo.docx' } };`,
  `globalThis.testResult = { markdown: renderSafeMarkdown('<b>x</b> **bold** \`x<y\`\\n- item'), replace: renderActionProposals([replaceProposal]), undo: renderActionProposals([undoProposal]) };`,
].join('\n');

const context = {};
vm.runInNewContext(extracted, context, { filename: 'panel_static_test.vm.js' });
assert(context.testResult.markdown.includes('&lt;b&gt;x&lt;/b&gt;'));
assert(context.testResult.markdown.includes('<strong>bold</strong>'));
assert(context.testResult.markdown.includes('<code>x&lt;y</code>'));
assert(context.testResult.markdown.includes('<li>item</li>'));
assert(context.testResult.replace.includes('Word write preview'));
assert(context.testResult.replace.includes('确认替换当前选区'));
assert(context.testResult.replace.includes('&lt;old&gt;'));
assert(context.testResult.undo.includes('Precise Magic Pointer restore'));
assert(context.testResult.undo.includes('确认恢复上次修改'));
assert(source.includes("runButton.addEventListener('click', () => submitCommand())"));
assert(!source.includes("runButton.addEventListener('click', submitCommand)"));
assert(source.includes("commandInput.value = '';"));
assert(source.includes("setRailState('ready')"));
assert(source.includes('suggestedCommands.slice(0, 1)'));
assert(source.includes('computeRailWidth(primaryIntent)'));
assert(source.includes('height: 44'));
assert(html.includes('id="inline-action-rail"'));
assert(html.includes('<input id="command"'));
assert(html.includes('id="primary-intent"'));
assert(!html.includes('class="panel-title"'));
assert(!html.includes('class="capture-summary"'));
assert(!html.includes('class="bubble-action-row"'));
assert(!html.includes('id="expand-command"'));
assert(!html.includes('<span>Magic Pointer</span>'));
assert(!source.includes("panelMode = 'bubble'"));
assert(!source.includes("setPanelMode('expanded'"));
assert(css.includes('.inline-action-rail'));
assert(css.includes('height: 44px'));
assert(css.includes('white-space: nowrap'));
assert(!source.includes('????????'));
console.log('panel static test ok');

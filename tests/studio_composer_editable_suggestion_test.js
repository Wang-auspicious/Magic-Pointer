'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
const functionNames = ['applyComposerPlaceholder', 'clearComposerSuggestion', 'acceptComposerSuggestion', 'fitComposer'];
const statements = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && functionNames.includes(node.name?.text))
  || (ts.isExpressionStatement(node) && (
    node.getText(ast).startsWith("document.querySelectorAll('form.dshw-input-form')")
    || node.getText(ast).startsWith("document.getElementById('composer-form')?.querySelector('button[type=\"submit\"]')?.addEventListener('click'")
  )));
const listeners = new Map();
let stopClick;
let submits = 0;
let stops = 0;
let prevented = 0;
let fitFrame;
const textarea = {
  value: '', selectionStart: 0, placeholder: '', attrs: {}, style: {}, scrollHeight: 900,
  addEventListener: (kind, handler) => {
    if (!listeners.has(kind)) listeners.set(kind, []);
    listeners.get(kind).push(handler);
  },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
};
const form = {
  querySelector: selector => selector === 'textarea' ? textarea : { addEventListener: (_kind, handler) => { stopClick = handler; } },
  addEventListener() {}, requestSubmit() { submits++; },
};
const context = {
  COMPOSER_PLACEHOLDER_HOME: 'Describe a task', COMPOSER_PLACEHOLDER_THREAD: 'Type / for commands',
  composerSuggestion: '请解释具体差异', composerSuggestionRequest: 0,
  composerFitRaf: null, composerFitTarget: null,
  window: { requestAnimationFrame: callback => { fitFrame = callback; return 1; } },
  getComputedStyle: () => ({ maxHeight: '374px' }),
  studioComposerBusy: false, pendingConversation: null, externalConversationRun: null,
  document: {
    querySelectorAll: () => [form], querySelector: () => textarea,
    getElementById: id => id === 'composer-form' ? form : id === 'studio-home' ? { hidden: true } : null,
  },
  syncComposerSubmitState() {},
  SlashTrigger: { detectSlashToken: () => null }, closeSlashMenu() {},
  stopActiveConversation() { stops++; },
  Event: class { constructor(type) { this.type = type; } },
};
vm.runInNewContext(ts.transpileModule(statements.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
fitFrame();
assert.equal(textarea.style.height, '374px', 'long drafts must grow to the actual CSS limit, without an earlier 336px clamp');
function key(key, extra = {}) {
  const event = { key, shiftKey: false, isComposing: false, preventDefault() { prevented++; }, ...extra };
  for (const fn of listeners.get('keydown') || []) fn(event);
}
context.applyComposerPlaceholder();
assert.equal(textarea.placeholder, '请解释具体差异');
key('Tab');
assert.equal(textarea.value, '请解释具体差异', 'Tab must accept the real suggestion into an editable draft');
assert.equal(submits, 0, 'accepting a suggestion must not submit it');
assert.equal(prevented, 1);
assert.equal(context.composerSuggestion, '');
assert.equal(textarea.selectionStart, textarea.value.length);
context.composerSuggestion = 'another suggestion';
textarea.value = 'My own draft';
key('Tab');
assert.equal(textarea.value, 'My own draft', 'a suggestion must never replace user text');
textarea.value = '';
key('Tab', { shiftKey: true });
assert.equal(textarea.value, '', 'Shift+Tab must keep reverse focus navigation');
key('Tab', { isComposing: true });
assert.equal(textarea.value, '', 'IME composition must not accept a suggestion');
context.studioComposerBusy = true;
context.externalConversationRun = { requestId: 'selection-request' };
stopClick({ preventDefault() {}, stopPropagation() {} });
assert.equal(stops, 1, 'GUI Stop must stop the selection-owned task through the same handler');
console.log('Studio editable suggestion and external Stop interaction tests ok');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const DshChat = require('../electron/renderer/dsh_chat');

async function main() {
  const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
  const start = source.indexOf('      pendingPermissionChoice = null;', source.indexOf('const response = await Data.sendConversation('));
  const end = source.indexOf('      /* 命令结算的副作用', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const context = {
    response: { ok: false, conversationId: 'saved-failure', error: 'Provider unavailable' },
    activeConversationId: null, pendingPermissionChoice: {}, pendingPermissionAsk: {}, pendingAskInput: {},
    composerAttachments: ['notes.txt'], composerSelectedSourceIds: new Set(),
    renderPermissionAsk() {}, renderComposerAttachments() {}, renderComposerMaterials() {},
    openConversation: async id => calls.push(id), renderSidebar: async () => calls.push('sidebar'),
  };
  const code = ts.transpileModule(`async function settle() {${source.slice(start, end)}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, context);
  await assert.rejects(context.settle(), /Provider unavailable/);
  assert.equal(context.activeConversationId, 'saved-failure', 'retry must continue the saved failed task');
  assert.deepEqual(calls, ['saved-failure', 'sidebar'], 'failure must reopen its persisted trace and refresh task navigation');

  const nodes = DshChat.assistantTurnNode({ answer: 'Read one page.', failed: true, error: 'Provider unavailable' });
  const html = nodes.map(node => node.outerHTML).join('');
  assert.match(html, /Read one page\./);
  assert.match(html, /Provider unavailable/, 'partial output must not hide the terminal failure');
  const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
  let proxyInput;
  const inspect = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'CardModel.normalizeCard'
      && node.arguments[0]?.getText(ast).includes('t.failed')) proxyInput = node.arguments[0].getText(ast);
    ts.forEachChild(node, inspect);
  };
  inspect(ast);
  assert.ok(proxyInput, 'openConversation must register its actual live-card projection');
  const proxy = vm.runInNewContext(`(${proxyInput})`, {
    t: { at: 1, failed: true, answer: 'Read one page.', error: 'Client interrupted; continue to verify results.' },
  });
  assert.equal(proxy.answer, 'Read one page.');
  assert.equal(proxy.error, 'Client interrupted; continue to verify results.', 'the live-card path must use the real error rather than relabel partial text as an error');
  console.log('Studio failed task persistence tests ok');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

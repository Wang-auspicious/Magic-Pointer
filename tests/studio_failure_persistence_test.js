'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const ChatView = require('../electron/renderer/chat_view');

async function main() {
  const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
  const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
  let responseBlock;
  const findResponse = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isAwaitExpression(node.initializer)
      && ts.isCallExpression(node.initializer.expression)
      && node.initializer.expression.expression.getText(ast) === 'Data.sendConversation') {
      responseBlock = node.parent.parent.parent;
    }
    ts.forEachChild(node, findResponse);
  };
  findResponse(ast);
  assert.ok(responseBlock && ts.isBlock(responseBlock), 'send must settle inside its response block');
  const statements = responseBlock.statements;
  const start = statements.findIndex(node => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
    && node.expression.left.getText(ast) === 'pendingPermissionChoice');
  const end = statements.findIndex(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'command'));
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = {
    response: { ok: false, conversationId: 'saved-failure', error: 'Provider unavailable' },
    activeConversationId: null, pendingPermissionChoice: {}, pendingPermissionAsk: {}, pendingAskInput: {},
    composerAttachments: ['notes.txt'], composerSelectedSourceIds: new Set(),
    renderPermissionAsk() {}, renderComposerAttachments() {}, renderComposerMaterials() {},
    openConversation: async id => calls.push(id), renderSidebar: async () => calls.push('sidebar'),
  };
  const settlement = statements.slice(start, end).map(node => node.getText(ast)).join('\n');
  const code = ts.transpileModule(`async function settle() {${settlement}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, context);
  await assert.rejects(context.settle(), /Provider unavailable/);
  assert.equal(context.activeConversationId, 'saved-failure', 'retry must continue the saved failed task');
  assert.deepEqual(calls, ['saved-failure', 'sidebar'], 'failure must reopen its persisted trace and refresh task navigation');

  const nodes = ChatView.assistantTurnNode({ answer: 'Read one page.', failed: true, error: 'Provider unavailable' });
  const html = nodes.map(node => node.outerHTML).join('');
  assert.match(html, /Read one page\./);
  assert.match(html, /Provider unavailable/, 'partial output must not hide the terminal failure');
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

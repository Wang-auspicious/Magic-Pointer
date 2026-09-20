import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const channels = ['stage:stop-selection-command', 'conversations:stop'];
const registrations = ast.statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.arguments.some((arg) => ts.isStringLiteral(arg) && channels.includes(arg.text)))
  .map((node) => node.getText(ast));
assert.equal(registrations.length, channels.length);
const code = ts.transpileModule(registrations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const cancellations: string[] = [];
vm.runInNewContext(code, {
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => Promise<any>) => handlers.set(channel, fn) },
  isSurfaceSender: () => true, isConversationSender: () => true, resultTargetWindow() {},
  dashboardWindow: {}, companionWindow: null,
  stageLiveTurns: new Map([['selection-1', { progress: { requestId: 'request-1', agentSessionId: 'agent-selection' } }]]),
  cancelSessionChild: (token: string) => cancellations.push(token),
});
async function run() {
  assert.equal((await handlers.get(channels[0])!({}, { selectionSessionToken: 'selection-1' })).ok, true);
  assert.equal((await handlers.get(channels[1])!({}, { requestId: 'request-1' })).ok, true);
  assert.deepEqual(cancellations, ['selection-1', 'selection-1'], 'both explicit Stop buttons address the same running task');
  assert.equal((await handlers.get(channels[0])!({}, { selectionSessionToken: 'old-selection' })).ok, false);
  console.log('selection explicit stop test ok');
}
void run();

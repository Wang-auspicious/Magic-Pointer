import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const registration = ast.statements.find((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === 'extensions:inventory'));
assert.ok(registration, 'Customize must reach real read-only extension configuration');
const code = ts.transpileModule(registration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let handler: (...args: any[]) => any;
const calls: any[] = [];
const fixture = { ok: true, plugins: { items: [] }, mcp: { servers: [] } };
vm.runInNewContext(code, {
  ipcMain: { handle: (_name: string, callback: (...args: any[]) => any) => { handler = callback; } },
  isDashboardSender: (event: any) => event.trusted,
  runPythonBridgePromise: async (...args: any[]) => { calls.push(args); return fixture; },
});
void (async () => {
  assert.equal((await handler!({ trusted: false })).ok, false);
  assert.equal(calls.length, 0);
  assert.equal(await handler!({ trusted: true }), fixture);
  assert.equal(calls[0][0].operation, 'extensions.inventory');
  assert.equal(calls[0][1], 'scripts/fabric_bridge.py');
  console.log('extensions inventory IPC test ok');
})();

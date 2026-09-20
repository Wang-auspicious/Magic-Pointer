import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const { createContextTrackerRuntime } = require('../electron/context_trackers');

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const channels = ['context-trackers:list', 'context-trackers:set-enabled', 'context-trackers:remove'];
const registrations = ast.statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.arguments.some((arg) => ts.isStringLiteral(arg) && channels.includes(arg.text)))
  .map((node) => node.getText(ast));
assert.equal(registrations.length, channels.length, 'Scheduled controls must reach the real tracker runtime');
const code = ts.transpileModule(registrations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let saved: any[] = [];
const runtime = createContextTrackerRuntime({ loadTrackers: () => saved,
  persistTrackers: (value: any[]) => { saved = value; }, runTask: async () => ({ ok: true }) });
runtime.upsert({ trackerId: 'daily-report', kind: 'filesystem', enabled: false, sourceIds: ['source:report'],
  folderRoot: 'D:/reports', task: 'Summarize changes', outputType: 'report',
  trigger: { kind: 'schedule', startAtMs: 0, everyMs: 86_400_000 } });
const handlers = new Map<string, (...args: any[]) => any>();
vm.runInNewContext(code, { ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  isDashboardSender: (event: any) => event.trusted, contextTrackerRuntime: runtime });
const trusted = { trusted: true };
assert.equal(handlers.get(channels[0])!(trusted).trackers.length, 1);
assert.equal(handlers.get(channels[1])!(trusted, { trackerId: 'daily-report', enabled: true }).ok, true);
assert.equal(saved[0].enabled, true);
assert.equal(handlers.get(channels[2])!({}, { trackerId: 'daily-report' }).ok, false);
assert.equal(runtime.list().length, 1);
assert.equal(handlers.get(channels[2])!(trusted, { trackerId: 'daily-report' }).ok, true);
assert.equal(saved.length, 0);
console.log('context tracker library IPC test ok');

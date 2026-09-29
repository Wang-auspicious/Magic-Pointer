import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalActivityService } from '../electron/personal_activity_service';

async function main() {
  const source = fs.readFileSync('electron/main.ts', 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const channels = ['personal-activity:read', 'personal-activity:configure', 'personal-activity:generate'];
  const registrations = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.arguments.some(arg => ts.isStringLiteral(arg) && channels.includes(arg.text))).map(node => node.getText(ast));
  assert.equal(registrations.length, 3, 'the personal memory page must reach the actual recorder and report service');
  const directory = await mkdtemp(join(tmpdir(), 'mp-personal-ipc-'));
  const service = new PersonalActivityService(directory, { createNative: () => ({ start: async () => {}, stop: async () => {}, flush: async () => {} }) });
  try {
    await service.start();
    const handlers = new Map<string, (...args: any[]) => any>();
    vm.runInNewContext(ts.transpileModule(registrations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) }, personalActivityService: service, isDashboardSender: (event: any) => event.trusted });
    assert.equal((await handlers.get(channels[0])!({})).ok, false);
    assert.equal((await handlers.get(channels[1])!({trusted:true}, {enabled:true,screenEnabled:false})).ok, true);
    const result = await handlers.get(channels[0])!({trusted:true});
    assert.equal(result.status.enabled, true);
    assert.equal((await handlers.get(channels[2])!({trusted:true}, {date:'2026-09-29'})).report.date, '2026-09-29');
  } finally { await service.stop(); await rm(directory, {force:true, recursive:true}); }
  console.log('personal activity IPC reaches real persistence and reporting');
}
void main();

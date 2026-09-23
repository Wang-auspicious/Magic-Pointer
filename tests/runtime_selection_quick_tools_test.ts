import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../electron/runtime/tools';
import { registerSelectionQuickTools } from '../electron/runtime/selection_quick_tools';
import { runRuntime } from '../electron/runtime/index';

test('frozen selection tools copy its text and report its existing capture and source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-quick-tools-'));
  const capture = path.join(root, 'selection.png');
  await writeFile(capture, Buffer.from('frozen pixels'));
  const registry = new ToolRegistry();
  const copied: string[] = [];
  registerSelectionQuickTools(registry, {
    context: { content: 'Selected text', artifacts: { terminal_evidence: { window: { text: 'Selected text and surrounding terminal output' } } } }, capture_path: capture,
    source_window: { title: 'Document', process_name: 'WINWORD.EXE' },
  }, async value => { copied.push(value); });
  const copy = await registry.execute({ id: 'copy', name: 'copy_selected_text', arguments: {} });
  const screenshot = await registry.execute({ id: 'save', name: 'save_screenshot', arguments: {} });
  const source = await registry.execute({ id: 'source', name: 'show_source', arguments: {} });
  assert.deepEqual(copied, ['Selected text']);
  assert.equal(copy.is_error, false, copy.error_message);
  assert.deepEqual((copy.value as { verification: unknown }).verification, { matched: true });
  assert.equal(screenshot.is_error, false, screenshot.error_message);
  assert.deepEqual((screenshot.value as { verification: unknown }).verification, { matched: true });
  assert.equal((screenshot.value as { path: string }).path, capture);
  assert.equal(source.value, '来源：Document（WINWORD.EXE）');
  assert.equal(registry.get('copy_selected_text').effect, 'reversible_write');
  assert.equal(registry.get('show_source').effect, 'read');
  await writeFile(capture, '');
  const missing = await registry.execute({ id: 'missing', name: 'save_screenshot', arguments: {} });
  assert.equal(missing.is_error, true);
});

test('Studio one-time permission reaches TS Runtime and authorizes only one matching action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-once-tool-'));
  const userDataDir = path.join(root, 'user');
  const plugin = path.join(userDataDir, 'data', 'plugins', 'once');
  const marker = path.join(root, 'executed.txt');
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, 'plugin.json'), JSON.stringify({ main: 'entry.cjs' }));
  await writeFile(path.join(plugin, 'entry.cjs'), `module.exports={name:'once',apply(ctx){ctx.get('tools').register({name:'WriteFixture',description:'Write fixture',effect:'local_irreversible',input_schema:{type:'object',properties:{key:{type:'string'}},required:['key']},execute(args){require('node:fs').appendFileSync(${JSON.stringify(marker)},args.key);return {verification:{matched:true}}}});let n=0;ctx.provideUp('llm',async()=>++n===1?{text:'',tool_calls:[{id:'first',name:'WriteFixture',arguments:{key:'a'}},{id:'second',name:'WriteFixture',arguments:{key:'b'}}]}:{text:'Done',tool_calls:[]})}}`);
  await writeFile(path.join(userDataDir, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: { 'llm-provider': { disabled: true } } }));
  const result = await runRuntime({ question: 'Perform one action', permissionGrantOnce: ['WriteFixture'], modelRuntime: { model: 'fixture', baseUrl: 'http://127.0.0.1:1', credential: 'fixture' } }, { root, userDataDir, signal: AbortSignal.timeout(10000) });
  assert.equal(result.awaitingUserInput, true, JSON.stringify(result));
  assert.equal(await readFile(marker, 'utf8'), 'a');
  assert.equal(result.events[0].is_error, false);
  assert.equal(result.events[1].is_error, true);
});

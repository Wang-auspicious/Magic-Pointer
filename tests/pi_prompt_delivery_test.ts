import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
async function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../integrations/pi/magic_pointer_extension.ts'), 'utf8');
  const module = { exports: {} as any };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pi-delivery-'));
  const registered: string[] = [], hooks: string[] = [], messages: string[] = [];
  let command: any;
  try {
    vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
      module, exports: module.exports, process,
      require: (name: string) => name === 'typebox' ? { Type: new Proxy({}, { get: () => () => ({}) }) } : require(name),
    });
    module.exports.default({
      registerTool: (tool: any) => registered.push(tool.name), on: (event: string) => hooks.push(event),
      registerCommand: (_name: string, value: any) => { command = value; },
      sendUserMessage: (text: string) => messages.push(text),
    });
    assert.deepEqual(registered, [], 'Pi receives an explicit prepared prompt; it cannot invoke MP plans or actions');
    assert.deepEqual(hooks, [], 'ordinary Pi turns cannot silently acquire MP frozen context');
    const file = path.join(root, 'prepared prompt.md');
    fs.writeFileSync(file, 'User-reviewed Magic Pointer prompt\nKeep this exact text.');
    await command.handler(`"${file}"`, { ui: { notify: (message: string) => { throw new Error(message); } } });
    assert.deepEqual(messages, ['User-reviewed Magic Pointer prompt\nKeep this exact text.']);
    console.log('pi_prompt_delivery_test: passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

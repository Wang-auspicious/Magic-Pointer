import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';

const chat = require('../electron/renderer/chat_view');

async function shell(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-shell-receipt-'));
  try {
    const script = path.join(root, 'command.js');
    fs.writeFileSync(script, source);
    const session = await EventSession.open(root, 'agent-shell-receipt');
    const registry = new ToolRegistry();
    registerCodingTools(registry, root, session);
    const command = `"${process.execPath}" "${script}"`;
    const result = await registry.execute({
      id: 'shell',
      name: 'Bash',
      arguments: {command},
    });
    return {
      result,
      command,
      contents: fs.existsSync(path.join(root, 'done.txt'))
        ? fs.readFileSync(path.join(root, 'done.txt'), 'utf8')
        : '',
    };
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

test('a nonzero shell exit retains structured output and a useful visible error after a real partial write', async () => {
  const {result, command, contents} = await shell(
    'require("node:fs").writeFileSync("done.txt", "actual file before failure"); process.stdout.write("completed part\\n"); process.stderr.write("specific shell failure\\n"); process.exitCode=7;',
  );
  assert.equal(contents, 'actual file before failure');
  assert.equal(result.is_error, true);
  const value = result.value as any;
  assert.equal(value.exit, 7);
  assert.equal(value.stdout, 'completed part\n');
  assert.equal(value.stderr, 'specific shell failure\n');
  const model = chat.toolRowModel('Bash', JSON.stringify({command}), {
    text: JSON.stringify(value),
    isError: true,
  });
  assert.equal(model.errorSummary, 'specific shell failure');
  assert.equal(model.output, 'completed part\nspecific shell failure\n');
});

test('successful shell output preserves terminal whitespace without JSON transport fields', async () => {
  const {result, command} = await shell(
    'process.stdout.write("\\n  indented output\\n\\n"); process.stderr.write("warning only\\n");',
  );
  assert.equal(result.is_error, false);
  const model = chat.toolRowModel('Bash', JSON.stringify({command}), {
    text: JSON.stringify(result.value),
    isError: false,
  });
  assert.equal(model.output, '\n  indented output\n\nwarning only\n');
  assert.equal(model.errorSummary, null);
});

test('UTF-8 shell output survives actual pipe chunks split inside Chinese and emoji characters', async () => {
  const {result} = await shell(
    'const text=Buffer.from("中文🙂"); process.stdout.write(text.subarray(0,2)); process.stderr.write(text.subarray(0,5)); setTimeout(()=>{process.stdout.write(text.subarray(2));process.stderr.write(text.subarray(5));},100);',
  );
  assert.equal(result.is_error, false);
  assert.equal((result.value as any).stdout, '中文🙂');
  assert.equal((result.value as any).stderr, '中文🙂');
});

test('older shell receipts use their stderr for the failure summary and preserve separate stream boundaries', () => {
  const model = chat.toolRowModel('Bash', '{"command":"legacy"}', {
    text: JSON.stringify({
      exit: 8,
      stdout: 'completed part',
      stderr: 'legacy failure\nmore detail\n',
    }),
    isError: true,
  });
  assert.equal(model.errorSummary, 'legacy failure');
  assert.equal(model.output, 'completed part\nlegacy failure\nmore detail\n');
});

test('a shell exit with no printed output still explains its actual failure', async () => {
  const {result, command} = await shell('process.exitCode=9;');
  assert.equal(result.is_error, true);
  const model = chat.toolRowModel('Bash', JSON.stringify({command}), {
    text: JSON.stringify(result.value),
    isError: true,
  });
  assert.equal(model.output, 'Command exited with code 9');
  assert.equal(model.errorSummary, 'Command exited with code 9');
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {ToolRegistry} from '../electron/runtime/tools';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {createConversationStore} from '../electron/conversation_store';

async function fixture(name: string) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'mp-file-evidence-'));
  const session = await EventSession.open(workspace, name);
  const registry = new ToolRegistry();
  registerCodingTools(registry, workspace, session);
  return {workspace, registry};
}

test('Write records actual creation and overwrite state after persistence', async () => {
  const {workspace, registry} = await fixture('write-change-kind');
  try {
    const run = async (content: string, expectedTitle: string) => {
      const result = await registry.execute({
        id: 'write',
        name: 'Write',
        arguments: {path: 'notes.txt', content},
      });
      assert.equal(result.is_error, false, result.error_message);
      const chat = require('../electron/renderer/chat_view');
      assert.equal(
        chat.toolRowModel('Write', JSON.stringify(result.arguments), {
          text: JSON.stringify(result.value),
        }).title,
        expectedTitle,
      );
      return result.value as {created: boolean};
    };
    assert.equal((await run('first\n', 'Created')).created, true);
    assert.equal((await run('second\n', 'Updated')).created, false);
    assert.equal(
      await readFile(path.join(workspace, 'notes.txt'), 'utf8'),
      'second\n',
    );
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
});

test('actual overwrite status survives activity projection and history reopening into the independent file row', async () => {
  const {workspace, registry} = await fixture('write-card-history');
  try {
    await writeFile(path.join(workspace, 'existing.ts'), 'old content\n');
    await registry.execute({
      id: 'read',
      name: 'Read',
      arguments: {path: 'existing.ts'},
    });
    const result = await registry.execute({
      id: 'overwrite',
      name: 'Write',
      arguments: {path: 'existing.ts', content: 'new content\n'},
    });
    assert.equal(result.is_error, false, result.error_message);
    const sink = new RuntimeActivitySink(() => {});
    sink.onEvent({kind: 'tool_call_finished', result} as any);
    const store = createConversationStore({baseDir: workspace});
    const conversation = store.appendTurn({
      newConversation: true,
      question: 'Update existing.ts',
      answer: 'Saved.',
      trajectory: sink.trajectory,
    });
    store.flush();
    const reopened = createConversationStore({baseDir: workspace}).get(
      conversation.id,
    )!;
    const chat = require('../electron/renderer/chat_view');
    const html = chat
      .assistantTurnNode(reopened.turns[0])
      .map((node: {outerHTML: string}) => node.outerHTML)
      .join('');
    assert.doesNotMatch(html, /class="mp-chat-files"/);
    assert.match(html, /data-file-path="existing.ts"/);
    assert.deepEqual(
      Array.from(
        html.matchAll(/class="mp-chat-title">([^<]*)<\/span>/g),
        match => match[1],
      ),
      ['Updated', 'Updated'],
    );
    assert.equal(
      await readFile(path.join(workspace, 'existing.ts'), 'utf8'),
      'new content\n',
    );
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
});

test('Read reports actual byte and line ending evidence; Edit changes only the matched bytes', async () => {
  const {workspace, registry} = await fixture('mixed-lines');
  const before = Buffer.from(
    '\uFEFFOrder: Aurora\r\nQuantity: 98\nDelivery: Tuesday\r\n',
  );
  const after = Buffer.from(
    '\uFEFFOrder: Aurora\r\nQuantity: 112\nDelivery: Tuesday\r\n',
  );
  await writeFile(path.join(workspace, 'order.txt'), before);
  const read = await registry.execute({
    id: 'read',
    name: 'Read',
    arguments: {path: 'order.txt'},
  });
  assert.equal(read.is_error, false, read.error_message);
  assert.match(String(read.value), new RegExp(`utf8Bytes=${before.length}`));
  assert.match(String(read.value), /bom=present/);
  assert.match(String(read.value), /lineEndings=mixed/);
  const edit = await registry.execute({
    id: 'edit',
    name: 'Edit',
    arguments: {
      path: 'order.txt',
      old_string: 'Quantity: 98',
      new_string: 'Quantity: 112',
    },
  });
  assert.equal(edit.is_error, false, edit.error_message);
  assert.deepEqual(await readFile(path.join(workspace, 'order.txt')), after);
  const result = edit.value as {
    verification: {
      matched: boolean;
      method: string;
      preservedUntouchedBytes: boolean;
      originalBytes: number;
      finalBytes: number;
    };
  };
  assert.equal(result.verification.matched, true);
  assert.equal(result.verification.preservedUntouchedBytes, true);
  assert.equal(result.verification.originalBytes, before.length);
  assert.equal(result.verification.finalBytes, after.length);
});

test('Edit preserves unrelated CSV bytes instead of re-encoding the whole file', async () => {
  const {workspace, registry} = await fixture('csv-lines');
  const before = Buffer.from('item,qty\r\nAurora,98\nother,7\r\n');
  const after = Buffer.from('item,qty\r\nAurora,112\nother,7\r\n');
  await writeFile(path.join(workspace, 'order.csv'), before);
  await registry.execute({
    id: 'read',
    name: 'Read',
    arguments: {path: 'order.csv'},
  });
  const edit = await registry.execute({
    id: 'edit',
    name: 'Edit',
    arguments: {
      path: 'order.csv',
      old_string: 'Aurora,98',
      new_string: 'Aurora,112',
    },
  });
  assert.equal(edit.is_error, false, edit.error_message);
  assert.deepEqual(await readFile(path.join(workspace, 'order.csv')), after);
});

test('multiline Edit maps a normalized search onto raw offsets without consuming the following CRLF', async () => {
  const {workspace, registry} = await fixture('multiline-lines');
  await writeFile(path.join(workspace, 'mixed.txt'), 'pre\r\nA\r\nB\r\npost\n');
  await registry.execute({
    id: 'read',
    name: 'Read',
    arguments: {path: 'mixed.txt'},
  });
  const edit = await registry.execute({
    id: 'edit',
    name: 'Edit',
    arguments: {path: 'mixed.txt', old_string: 'A\nB', new_string: 'X\nY'},
  });
  assert.equal(edit.is_error, false, edit.error_message);
  assert.deepEqual(
    await readFile(path.join(workspace, 'mixed.txt')),
    Buffer.from('pre\r\nX\nY\r\npost\n'),
  );
});

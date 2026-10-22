import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {createConversationStore} from '../electron/conversation_store';
import {readFileDiffPresentation} from '../electron/file_diff_presentation';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-change-counts-'));
  const session = await EventSession.open(root, 'agent-changes');
  await session.startTurn();
  const registry = new ToolRegistry();
  registerCodingTools(registry, root, session);
  const sink = new RuntimeActivitySink(() => {});
  let seq = 0;
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await registry.execute({
      id: `call-${++seq}`,
      name,
      arguments: args,
    });
    assert.equal(result.is_error, false, result.error_message);
    if (name !== 'Read')
      sink.onEvent({kind: 'tool_call_finished', result} as any);
    return result.value as any;
  };
  return {root, session, registry, sink, run};
}

test('batch edits on the same physical line count the persisted line once', async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.root, 'code.ts'),
      'const a = 1, b = 2;\nunchanged\n',
    );
    await f.run('Read', {path: 'code.ts'});
    const result = await f.run('Edit', {
      path: 'code.ts',
      edits: [
        {old_string: 'a = 1', new_string: 'a = 10'},
        {old_string: 'b = 2', new_string: 'b = 20'},
      ],
    });
    assert.deepEqual(result.diffStat, {added: 1, removed: 1});
    assert.deepEqual(result.turnDiffStat, {added: 1, removed: 1});
    const chat = require('../electron/renderer/chat_view');
    const model = chat.toolRowModel(
      'Edit',
      JSON.stringify({path: 'code.ts', edits: []}),
      {text: JSON.stringify(result)},
    );
    assert.deepEqual(model.diffStat, {added: 1, removed: 1});
    assert.equal(
      await readFile(path.join(f.root, 'code.ts'), 'utf8'),
      'const a = 10, b = 20;\nunchanged\n',
    );
  } finally {
    await f.session.endTurn('completed');
    await rm(f.root, {recursive: true, force: true});
  }
});

test('later operations retain the turn baseline and an undo has zero net changes', async () => {
  const f = await fixture();
  try {
    const original = 'first\nsecond\nthird\n';
    await writeFile(path.join(f.root, 'notes.txt'), original);
    await f.run('Read', {path: 'notes.txt'});
    await f.run('Edit', {
      path: 'notes.txt',
      old_string: 'first\n',
      new_string: '',
    });
    const changed = await f.run('Edit', {
      path: 'notes.txt',
      old_string: 'third',
      new_string: 'third updated',
    });
    assert.deepEqual(changed.diffStat, {added: 1, removed: 1});
    assert.deepEqual(changed.turnDiffStat, {added: 1, removed: 2});
    const store = createConversationStore({baseDir: f.root});
    const conversation = store.appendTurn({
      newConversation: true,
      question: 'Update notes',
      answer: 'Saved.',
      trajectory: f.sink.trajectory,
    });
    store.flush();
    const reopened = createConversationStore({baseDir: f.root}).get(
      conversation.id,
    )!;
    const chat = require('../electron/renderer/chat_view');
    const html = chat
      .assistantTurnNode(reopened.turns[0])
      .map((n: {outerHTML: string}) => n.outerHTML)
      .join('');
    const card = html.slice(html.indexOf('<div class="mp-chat-files">'));
    assert.match(card, /mp-chat-diff-add">\+1</);
    assert.match(card, /mp-chat-diff-del">−2</);
    const undone = await f.run('Write', {path: 'notes.txt', content: original});
    assert.deepEqual(undone.turnDiffStat, {added: 0, removed: 0});
    const undoHtml = chat
      .assistantTurnNode({answer: 'Restored.', trajectory: f.sink.trajectory})
      .map((n: {outerHTML: string}) => n.outerHTML)
      .join('');
    assert.doesNotMatch(
      undoHtml.slice(undoHtml.indexOf('<div class="mp-chat-files">')),
      /mp-chat-diff-(?:add|del)/,
    );
    assert.equal(
      await readFile(path.join(f.root, 'notes.txt'), 'utf8'),
      original,
    );
  } finally {
    await f.session.endTurn('completed');
    await rm(f.root, {recursive: true, force: true});
  }
});

test('a created file keeps all final lines and a new turn establishes a fresh baseline', async () => {
  const f = await fixture();
  try {
    await f.run('Write', {path: 'new.txt', content: 'first\nsecond\n'});
    const created = await f.run('Edit', {
      path: 'new.txt',
      old_string: 'second',
      new_string: 'changed',
    });
    assert.deepEqual(created.turnDiffStat, {added: 2, removed: 0});
    await f.session.endTurn('completed');
    await f.session.startTurn();
    const next = await f.run('Edit', {
      path: 'new.txt',
      old_string: 'changed',
      new_string: 'next turn',
    });
    assert.deepEqual(next.turnDiffStat, {added: 1, removed: 1});
  } finally {
    await f.session.endTurn('completed');
    await rm(f.root, {recursive: true, force: true});
  }
});

test('a bounded statistic does not fail a successful large write', async () => {
  const f = await fixture();
  try {
    const lines = Array.from({length: 2000}, (_, i) => `line ${i}\n`);
    await writeFile(path.join(f.root, 'large.txt'), lines.join(''));
    await f.run('Read', {path: 'large.txt'});
    const content = [...lines].reverse().join('');
    const result = await f.run('Write', {path: 'large.txt', content});
    assert.equal(result.diffStat, null);
    assert.equal(result.turnDiffStat, null);
    assert.equal(
      await readFile(path.join(f.root, 'large.txt'), 'utf8'),
      content,
    );
  } finally {
    await f.session.endTurn('completed');
    await rm(f.root, {recursive: true, force: true});
  }
});

test('persisted Edit previews retain context and actual counts', async () => {
  const f = await fixture();
  try {
    const before = 'first retained\nold changed\nlast retained\n';
    const after = 'first retained\nnew changed\nlast retained\n';
    await writeFile(path.join(f.root, 'context.txt'), before);
    await f.run('Read', {path: 'context.txt'});
    const result = await f.run('Edit', {
      path: 'context.txt',
      old_string: before,
      new_string: after,
    });
    assert.equal(
      await readFile(path.join(f.root, 'context.txt'), 'utf8'),
      after,
    );
    assert.deepEqual(result.diffStat, {added: 1, removed: 1});
    const store = createConversationStore({baseDir: f.root});
    const conversation = store.appendTurn({
      newConversation: true,
      question: 'Change the middle line',
      answer: 'Saved.',
      trajectory: f.sink.trajectory,
    });
    store.flush();
    const saved = createConversationStore({baseDir: f.root}).get(
      conversation.id,
    )!;
    for (const entry of saved.turns[0].trajectory || []) {
      if (entry.presentation) {
        const loaded = await readFileDiffPresentation(entry.presentation as any);
        assert.equal(loaded.ok, true);
        if (loaded.ok) entry.presentation = loaded.presentation;
      }
    }
    const chat = require('../electron/renderer/chat_view');
    const html = chat
      .assistantTurnNode(saved.turns[0])
      .map((node: {outerHTML: string}) => node.outerHTML)
      .join('');
    assert.match(html, /data-kind="context"> {2}first retained/);
    assert.doesNotMatch(html, /[-+] first retained|[-+] last retained/);
    assert.ok(html.includes('- old changed'));
    assert.ok(html.includes('+ new changed'));
    assert.match(html, /mp-chat-diff-add">\+1/);
    assert.doesNotMatch(html, /mp-chat-tool-output|absolutePath|checkpointId/);
  } finally {
    await f.session.endTurn('completed');
    await rm(f.root, {recursive: true, force: true});
  }
});

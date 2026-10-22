import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {createConversationStore} from '../electron/conversation_store';

const chat = require('../electron/renderer/chat_view');
async function fixture(runCase: (f: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-patch-files-'));
  const session = await EventSession.open(root, 'agent-patch-files');
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
  const html = () => {
    const store = createConversationStore({baseDir: root});
    const conversation = store.appendTurn({
      newConversation: true,
      question: 'Change files',
      answer: 'Saved.',
      trajectory: sink.trajectory,
    });
    store.flush();
    const saved = createConversationStore({baseDir: root}).get(
      conversation.id,
    )!;
    return chat
      .assistantTurnNode(saved.turns[0])
      .map((n: {outerHTML: string}) => n.outerHTML)
      .join('');
  };
  try {
    await runCase({root, session, registry, sink, run, html});
  } finally {
    await session.endTurn('completed');
    await rm(root, {recursive: true, force: true});
  }
}

test('a multi-file patch projects actual added, edited and deleted files with a readable deletion snapshot', () =>
  fixture(async f => {
    await writeFile(path.join(f.root, 'old.txt'), 'old\n');
    await writeFile(path.join(f.root, 'gone.txt'), 'deleted content\n');
    const result = await f.run('Patch', {
      patch:
        '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: old.txt\n@@\n-old\n+updated\n*** Delete File: gone.txt\n*** End Patch',
    });
    assert.equal(result.fileChanges.length, 3);
    const deleted = result.fileChanges.find((c: any) => c.path === 'gone.txt');
    assert.equal(deleted.exists, false);
    assert.deepEqual(deleted.turnDiffStat, {added: 0, removed: 1});
    assert.equal(
      await readFile(path.resolve(f.root, deleted.previewPath), 'utf8'),
      'deleted content\n',
    );
    await assert.rejects(access(path.join(f.root, 'gone.txt')));
    const html = f.html();
    assert.match(html, /data-file-path="new.txt"/);
    assert.match(html, /data-file-path="old.txt"/);
    assert.match(html, /data-file-path="gone.txt"/);
    assert.match(html, /data-file-state="deleted"/);
    assert.match(html, /data-preview-path="[^"]+"/);
  }));

test('patch arrays and moves retain all actual path results after reopening history', () =>
  fixture(async f => {
    await writeFile(path.join(f.root, 'source.txt'), 'before\r\n');
    const result = await f.run('Patch', {
      patch: [
        '*** Begin Patch\n*** Add File: extra.txt\n+extra\n*** End Patch',
        '*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-before\n+after\n*** End Patch',
      ],
    });
    assert.equal(result.patches.length, 2);
    const html = f.html();
    for (const name of ['extra.txt', 'source.txt', 'destination.txt'])
      assert.ok(html.includes(`data-file-path="${name}"`), name);
    assert.equal(
      await readFile(path.join(f.root, 'destination.txt'), 'utf8'),
      'after\r\n',
    );
    await assert.rejects(access(path.join(f.root, 'source.txt')));
  }));

test('a full rewind removes net-unchanged file changes instead of leaving stale delivered targets', () =>
  fixture(async f => {
    await writeFile(path.join(f.root, 'old.txt'), 'original\n');
    await f.run('Read', {path: 'old.txt'});
    await f.run('Edit', {
      path: 'old.txt',
      old_string: 'original',
      new_string: 'edited',
    });
    await f.run('Write', {path: 'new.txt', content: 'new\n'});
    const result = await f.run('Rewind', {steps: 0});
    assert.equal(result.fileChanges.length, 2);
    assert.equal(
      await readFile(path.join(f.root, 'old.txt'), 'utf8'),
      'original\n',
    );
    await assert.rejects(access(path.join(f.root, 'new.txt')));
    assert.doesNotMatch(f.html(), /class="mp-chat-files"/);
  }));

test('partial rewind keeps the remaining net change and a new-turn rewind uses the current baseline', () =>
  fixture(async f => {
    await writeFile(path.join(f.root, 'old.txt'), 'first\nsecond\n');
    await f.run('Read', {path: 'old.txt'});
    await f.run('Edit', {
      path: 'old.txt',
      old_string: 'first',
      new_string: 'FIRST',
    });
    await f.run('Edit', {
      path: 'old.txt',
      old_string: 'second',
      new_string: 'SECOND',
    });
    const partial = await f.run('Rewind', {steps: 1});
    assert.deepEqual(partial.fileChanges[0].turnDiffStat, {
      added: 1,
      removed: 1,
    });
    assert.equal(
      await readFile(path.join(f.root, 'old.txt'), 'utf8'),
      'FIRST\nsecond\n',
    );
    await f.session.endTurn('completed');
    await f.session.startTurn();
    const next = await f.run('Rewind', {steps: 1});
    assert.deepEqual(next.fileChanges[0].turnDiffStat, {added: 1, removed: 1});
    assert.equal(next.fileChanges[0].unchanged, false);
  }));

test('a failed later patch preserves earlier verified file changes while the tool remains failed', () =>
  fixture(async f => {
    const failure = await f.registry.execute({
      id: 'partial-array',
      name: 'Patch',
      arguments: {
        patch: [
          '*** Begin Patch\n*** Add File: done.txt\n+saved\n*** End Patch',
          '*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch',
        ],
      },
    });
    assert.equal(failure.is_error, true);
    assert.equal(
      await readFile(path.join(f.root, 'done.txt'), 'utf8'),
      'saved\n',
    );
    assert.match(
      chat.toolRowModel('Patch', '', {
        text: JSON.stringify(failure.value),
        isError: true,
      }).errorSummary,
      /ENOENT/,
    );
    f.sink.onEvent({kind: 'tool_call_finished', result: failure});
    assert.match(f.html(), /data-file-path="done.txt"/);
  }));

test('a single patch reports only the completed writes when a later path cannot be written', () =>
  fixture(async f => {
    await writeFile(path.join(f.root, 'blocker'), 'a regular file');
    const failure = await f.registry.execute({
      id: 'partial-write',
      name: 'Patch',
      arguments: {
        patch:
          '*** Begin Patch\n*** Add File: done.txt\n+saved\n*** Add File: blocker/child.txt\n+cannot write\n*** End Patch',
      },
    });
    assert.equal(failure.is_error, true);
    assert.equal(
      await readFile(path.join(f.root, 'done.txt'), 'utf8'),
      'saved\n',
    );
    f.sink.onEvent({kind: 'tool_call_finished', result: failure});
    const html = f.html();
    assert.match(html, /data-file-path="done.txt"/);
    assert.doesNotMatch(html, /data-file-path="blocker\/child.txt"/);
  }));

test('deleting binary bytes keeps a snapshot without inventing text line counts', () =>
  fixture(async f => {
    const bytes = Buffer.from([137, 80, 78, 71, 0, 13, 10, 26, 10]);
    await writeFile(path.join(f.root, 'image.png'), bytes);
    const result = await f.run('Patch', {
      patch: '*** Begin Patch\n*** Delete File: image.png\n*** End Patch',
    });
    const change = result.fileChanges[0];
    assert.equal(change.diffStat, null);
    assert.equal(change.turnDiffStat, null);
    assert.deepEqual(
      await readFile(path.resolve(f.root, change.previewPath)),
      bytes,
    );
  }));

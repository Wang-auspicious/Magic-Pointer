import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../electron/conversation_store';


function countingStringify(): { restore: () => void; conversations: () => number } {
  const real = JSON.stringify;
  let count = 0;
  (JSON as unknown as { stringify: unknown }).stringify = function patched(value: unknown, ...rest: unknown[]) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'objectKey' in (value as object)) {
      count += 1;
    }
    return (real as (...args: unknown[]) => string)(value, ...rest);
  };
  return {
    restore: () => { (JSON as unknown as { stringify: unknown }).stringify = real; },
    conversations: () => count,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conv-incr-'));
}

function onDisk(baseDir: string, name = 'conversations.json'): unknown {
  return JSON.parse(fs.readFileSync(path.join(baseDir, name), 'utf8'));
}


{
  const dir = tempDir();
  let tick = 1_770_000_000_000;
  const store = createConversationStore({ baseDir: dir, now: () => (tick += 1000) });
  const first = store.appendTurn({ newConversation: true, question: '第一个问题', answer: '一', object: { app: 'Word' } });
  const second = store.appendTurn({ newConversation: true, question: '第二个问题', answer: '二', object: { app: 'Code' } });
  const before = onDisk(dir) as Array<{ id: string }>;
  assert.strictEqual(before.length, 2, 'sanity: the on-disk document is the conversation array');
  assert.deepStrictEqual(
    before.map((c) => c.id).sort(),
    [first.id, second.id].sort(),
    'sanity: both conversations are on disk',
  );

  const updated = store.updateTurn({ conversationId: first.id, answer: '一，改了' });
  assert.ok(updated.ok);
  const after = onDisk(dir) as Array<{ id: string; answer?: string; turns: Array<{ answer: string }> }>;
  assert.strictEqual(after.length, 2, 'the same two conversations must still be there');
  const firstOnDisk = after.find((c) => c.id === first.id);
  const secondOnDisk = after.find((c) => c.id === second.id);
  assert.strictEqual(firstOnDisk?.turns[0].answer, '一，改了', 'the mutation must reach disk');
  assert.strictEqual(secondOnDisk?.turns[0].answer, '二', 'the untouched conversation must be untouched');
  console.log('conversation_store_incremental_persist_test: mutations land, neighbours untouched');
}


{
  const dir = tempDir();
  const store = createConversationStore({ baseDir: dir, now: () => 42 });
  const conversation = store.appendTurn({ newConversation: true, question: '不会动的时钟', answer: '旧' });
  for (let i = 0; i < 5; i += 1) {
    store.updateTurn({ conversationId: conversation.id, answer: `新-${i}` });
  }
  const onDiskConversation = (onDisk(dir) as Array<{ turns: Array<{ answer: string }> }>)[0];
  assert.strictEqual(onDiskConversation.turns[0].answer, '新-4', 'the newest answer must win even with a frozen clock');
  console.log('conversation_store_incremental_persist_test: a frozen clock cannot strand a mutation');
}


{
  const dir = tempDir();
  const store = createConversationStore({ baseDir: dir, deferPersist: true, persistDebounceMs: 10_000, now: () => 7 });
  const conversation = store.appendTurn({ newConversation: true, question: '绕过标记', answer: 'x' });
  store.flush();
  assert.strictEqual((onDisk(dir) as Array<{ turns: unknown[] }>)[0].turns.length, 1);

  const live = store.get(conversation.id) as unknown as { turns: Array<{ answer: string }> };
  live.turns.push({ answer: '从外面塞进来的一轮' } as never);
  store.rename(conversation.id, '新标题');
  store.flush();
  const onDiskTurns = (onDisk(dir) as Array<{ turns: unknown[] }>)[0].turns;
  assert.strictEqual(onDiskTurns.length, 2, 'a turn appended through get() must not be swallowed by the cache');
  console.log('conversation_store_incremental_persist_test: direct mutations still invalidate');
}


{
  const dir = tempDir();
  const counter = countingStringify();
  try {
    let tick = 5_000;
    const store = createConversationStore({ baseDir: dir, now: () => (tick += 1_000) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(store.appendTurn({ newConversation: true, question: `问题 ${i}`, answer: 'a' }).id);
    }
    const afterFirstWrite = counter.conversations();
    assert.strictEqual(afterFirstWrite, 5, 'appends must serialise only the conversation they touched');

    store.updateTurn({ conversationId: ids[2], answer: '只改了这一条' });
    assert.strictEqual(
      counter.conversations() - afterFirstWrite,
      1,
      'a second write must serialise exactly one conversation, not all five',
    );
    const onDiskAnswers = (onDisk(dir) as Array<{ id: string; turns: Array<{ answer: string }> }>);
    assert.strictEqual(onDiskAnswers.find((c) => c.id === ids[2])?.turns[0].answer, '只改了这一条');
    assert.strictEqual(onDiskAnswers.find((c) => c.id === ids[0])?.turns[0].answer, 'a');
  } finally {
    counter.restore();
  }
  console.log('conversation_store_incremental_persist_test: only the changed conversation is serialised');
}


{
  const dir = tempDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const failures: Array<{ context: string }> = [];
  let clock = 0;
  const store = createConversationStore({
    baseDir: blocker,
    now: () => (clock += 61_000),
    deferPersist: true,
    persistDebounceMs: 5,
    onPersistError: (_error, context) => { failures.push({ context }); },
  });

  store.appendTurn({ newConversation: true, question: '写不进去', answer: 'x' });
  for (let i = 0; i < 60; i += 1) store.flush();
  assert.ok(failures.length >= 1, 'a persist failure must not be silent');
  assert.ok(failures.length <= 5, `failure reporting must be bounded, saw ${failures.length}`);
  assert.ok(
    failures.every((entry) => typeof entry.context === 'string' && entry.context.length > 0),
    'each report must say which write path failed',
  );

  const recovery = tempDir();
  const recovered = createConversationStore({ baseDir: recovery, now: () => 1 });
  recovered.appendTurn({ newConversation: true, question: '恢复', answer: 'y' });
  recovered.flush();
  assert.strictEqual((onDisk(recovery) as unknown[]).length, 1, 'a healthy store still writes');
  console.log('conversation_store_incremental_persist_test: failures are reported, bounded and non-fatal');
}

console.log('conversation_store_incremental_persist_test: all assertions passed');

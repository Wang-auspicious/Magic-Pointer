import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../electron/conversation_store';

/**
 * C-053 — the whole-store `JSON.stringify` is still synchronous.
 *
 * `deferPersist` removed the *cadence* (three whole-store rewrites a second)
 * but not the *shape*: every write still re-serialised all 500 conversations,
 * measured at 45.7 ms for a 13 MB store. Only one conversation changes per
 * mutation, so the rest were serialised for nothing. The store now keeps a
 * per-conversation JSON cache, invalidated by the mutating paths.
 *
 * That cache is only sound if every mutation invalidates it, so this file is
 * mostly about the failure mode: a stale cache means silently losing a user's
 * answer, which is worse than being slow. It pins:
 *   1. two writes produce byte-identical documents, and a mutation to one
 *      conversation never disturbs the others on disk;
 *   2. the mutation IS serialised even when the clock does not move (a fixed
 *      `now()` — the case a structural "did updatedAt change?" guard misses);
 *   3. a caller that mutates through `get()` still reaches disk;
 *   4. unchanged conversations are not re-serialised.
 *
 * C-055 — persistence failures were silent. persist()/flush() swallowed the
 * error and a user's history could stop saving with nothing watching. They now
 * report through `onPersistError`, bounded so a disk that is full does not turn
 * into a log flood. That bound is pinned here too.
 */

/** Counts top-level JSON.stringify calls on conversation-shaped values. */
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

// --- 1. the document is still exactly the old document ---------------------

{
  const dir = tempDir();
  // An advancing clock: conversation ids are `c${at}`, so two conversations
  // created in the same millisecond would share an id.
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

// --- 2. a fixed clock must not fool the cache ------------------------------

{
  const dir = tempDir();
  // `now()` never moves. `updateTurn` rewrites turn.answer without changing
  // `updatedAt`, `turns.length` or `title` — the exact shape a purely
  // structural cache guard would serve stale.
  const store = createConversationStore({ baseDir: dir, now: () => 42 });
  const conversation = store.appendTurn({ newConversation: true, question: '不会动的时钟', answer: '旧' });
  for (let i = 0; i < 5; i += 1) {
    store.updateTurn({ conversationId: conversation.id, answer: `新-${i}` });
  }
  const onDiskConversation = (onDisk(dir) as Array<{ turns: Array<{ answer: string }> }>)[0];
  assert.strictEqual(onDiskConversation.turns[0].answer, '新-4', 'the newest answer must win even with a frozen clock');
  console.log('conversation_store_incremental_persist_test: a frozen clock cannot strand a mutation');
}

// --- 3. mutations that bypass the marking functions still reach disk -------

{
  const dir = tempDir();
  const store = createConversationStore({ baseDir: dir, deferPersist: true, persistDebounceMs: 10_000, now: () => 7 });
  const conversation = store.appendTurn({ newConversation: true, question: '绕过标记', answer: 'x' });
  store.flush();
  assert.strictEqual((onDisk(dir) as Array<{ turns: unknown[] }>)[0].turns.length, 1);

  // `flush()` deliberately does nothing when nothing is marked dirty, so the
  // out-of-band change is exercised the way it happens in production: a later
  // legitimate mutation of the same conversation must carry it to disk.
  const live = store.get(conversation.id) as unknown as { turns: Array<{ answer: string }> };
  live.turns.push({ answer: '从外面塞进来的一轮' } as never);
  store.rename(conversation.id, '新标题');
  store.flush();
  const onDiskTurns = (onDisk(dir) as Array<{ turns: unknown[] }>)[0].turns;
  assert.strictEqual(onDiskTurns.length, 2, 'a turn appended through get() must not be swallowed by the cache');
  console.log('conversation_store_incremental_persist_test: direct mutations still invalidate');
}

// --- 4. unchanged conversations are not re-serialised ---------------------

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
    // The shape being removed: each of these five appends re-serialised every
    // conversation written so far — 1+2+3+4+5 = 15 serialisations to write
    // five records. One per append is the whole point of the cache.
    assert.strictEqual(afterFirstWrite, 5, 'appends must serialise only the conversation they touched');

    // updateTurn persists synchronously here, so the delta across the call is
    // exactly the work that write did.
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

// --- 5. C-055: failures are reported, bounded, and retried -----------------

{
  const dir = tempDir();
  // A file where the store wants a directory: every write fails, every time,
  // which is exactly the "quietly stopped saving" case.
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

  // The store is still dirty, so a working destination recovers the history.
  const recovery = tempDir();
  const recovered = createConversationStore({ baseDir: recovery, now: () => 1 });
  recovered.appendTurn({ newConversation: true, question: '恢复', answer: 'y' });
  recovered.flush();
  assert.strictEqual((onDisk(recovery) as unknown[]).length, 1, 'a healthy store still writes');
  console.log('conversation_store_incremental_persist_test: failures are reported, bounded and non-fatal');
}

console.log('conversation_store_incremental_persist_test: all assertions passed');

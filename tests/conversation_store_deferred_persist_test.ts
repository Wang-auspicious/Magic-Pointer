const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../electron/conversation_store');

/**
 * The defect this covers: persist() rewrites the *entire* conversation store
 * on every mutation — JSON.stringify of everything, then writeFileSync +
 * renameSync — measured at 18 ms for a 3 MB store and 85 ms for a 13 MB one.
 * It hangs off updateTurn, and the stage's live answer flushes on a 300 ms
 * timer, so the main thread stopped to rewrite the whole store three times a
 * second while the user was reading.
 *
 * `deferPersist` coalesces those writes. These tests pin the coalescing, the
 * flush-on-demand contract, and the fact that the default is unchanged.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conv-defer-'));
}

function seed(store: ReturnType<typeof createConversationStore>, question: string) {
  return store.appendTurn({
    newConversation: true,
    question,
    answer: 'ok',
    object: { app: 'Word', windowTitle: '报告.docx' },
  });
}

function onDiskCount(baseDir: string): number {
  const file = path.join(baseDir, 'conversations.json');
  if (!fs.existsSync(file)) return -1;
  return JSON.parse(fs.readFileSync(file, 'utf8')).length;
}

// --- the default is unchanged ---------------------------------------------

{
  const baseDir = tempDir();
  const store = createConversationStore({ baseDir });
  seed(store, '默认必须同步落盘');
  assert.strictEqual(onDiskCount(baseDir), 1,
    'without deferPersist the store must still write synchronously');
  console.log('conversation_store_deferred_persist_test: default stays synchronous');
}

// --- deferred writes are coalesced ----------------------------------------

{
  const baseDir = tempDir();
  const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 10_000 });
  seed(store, '第一条');
  seed(store, '第二条');
  seed(store, '第三条');
  assert.strictEqual(onDiskCount(baseDir), -1,
    'three deferred mutations must not have produced a single write yet');
  assert.strictEqual(typeof store.flush, 'function', 'the store must expose flush()');
  console.log('conversation_store_deferred_persist_test: mutations coalesce, no write on the hot path');
}

// --- flush writes everything pending --------------------------------------

{
  const baseDir = tempDir();
  const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 10_000 });
  seed(store, '甲');
  seed(store, '乙');
  store.flush();
  assert.strictEqual(onDiskCount(baseDir), 2, 'flush() must write every pending mutation');
  console.log('conversation_store_deferred_persist_test: flush() writes all pending changes');
}

// --- the debounce window actually elapses ---------------------------------

(async () => {
  const baseDir = tempDir();
  const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 20 });
  seed(store, '窗口到点');
  assert.strictEqual(onDiskCount(baseDir), -1, 'nothing is written before the window elapses');
  // The timer is unref'd so it cannot hold the process open; yield to the
  // event loop and let it fire rather than blocking the thread it needs.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && onDiskCount(baseDir) !== 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.strictEqual(onDiskCount(baseDir), 1, 'the debounce timer must write once it fires');
  console.log('conversation_store_deferred_persist_test: the debounce window eventually writes');
  await runRest();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function runRest(): void {
  // --- flush is idempotent and safe with nothing pending ------------------

  {
    const baseDir = tempDir();
    const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 10_000 });
    store.flush(); // nothing pending, must not throw
    assert.strictEqual(onDiskCount(baseDir), -1, 'a flush with nothing pending writes nothing');
    seed(store, '一次');
    store.flush();
    store.flush();
    assert.strictEqual(onDiskCount(baseDir), 1);
    console.log('conversation_store_deferred_persist_test: flush() is idempotent');
  }

  // --- clear reaches disk -------------------------------------------------

  {
    const baseDir = tempDir();
    const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 10_000 });
    seed(store, '待清空');
    store.flush();
    store.clear();
    store.flush();
    assert.strictEqual(onDiskCount(baseDir), 0, 'clear() must reach disk on flush');
    console.log('conversation_store_deferred_persist_test: clear() flushes to an empty store');
  }

  // --- deferred store survives a reload after flush -----------------------

  {
    const baseDir = tempDir();
    const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 10_000 });
    const created = seed(store, '重载');
    store.rename(created.id, '自定义标题');
    store.flush();
    const reloaded = createConversationStore({ baseDir });
    assert.strictEqual(reloaded.get(created.id)?.title, '自定义标题',
      'a flushed deferred store must reload identically');
    console.log('conversation_store_deferred_persist_test: flushed state reloads');
  }

  console.log('conversation_store_deferred_persist_test: all assertions passed');
}

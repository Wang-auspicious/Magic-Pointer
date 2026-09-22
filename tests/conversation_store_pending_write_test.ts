const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../electron/conversation_store');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-conversation-pending-'));
  const originalWrite = fs.writeFile;
  let release: (() => void) | undefined;
  let held = false;
  fs.writeFile = (...args: any[]) => {
    if (!held && String(args[0]).startsWith(baseDir)) {
      held = true;
      release = () => originalWrite(...args);
    } else originalWrite(...args);
  };
  const store = createConversationStore({ baseDir, deferPersist: true, persistDebounceMs: 10 });
  try {
    const created = store.appendTurn({ newConversation: true, question: 'first', answer: 'one' });
    for (let attempt = 0; !release && attempt < 100; attempt++) await delay(10);
    assert.ok(release, 'first background write starts');
    store.appendTurn({ conversationId: created.id, question: 'second', answer: 'two' });
    await delay(40);  
    release!();
    release = undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const reopened = createConversationStore({ baseDir }).get(created.id);
      if (reopened?.turns?.length === 2) break;
      await delay(10);
    }
    assert.equal(createConversationStore({ baseDir }).get(created.id)?.turns?.length, 2,
      'background completion must persist a mutation received during its disk write');
    console.log('conversation_store_pending_write_test: passed');
  } finally {
    fs.writeFile = originalWrite;
    if (release) release();
    store.flush();
    await delay(40);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

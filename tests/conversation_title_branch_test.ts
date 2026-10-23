import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createConversationStore} from '../electron/conversation_store';

const title = 'A carefully named project review with decisions and next steps';
function fixture(deferPersist = false) {
  const baseDir = fs.mkdtempSync(path.join(tmpdir(), 'mp-title-branch-'));
  let at = 1000;
  const store = createConversationStore({
    baseDir,
    deferPersist,
    persistDebounceMs: 10000,
    now: () => ++at,
  });
  const parent = store.appendTurn({
    newConversation: true,
    question: 'Original task',
    answer: 'Checked facts',
  });
  return {baseDir, store, parent};
}

test('the exposed 60-character custom title survives saving and reopening', () => {
  const {baseDir, store, parent} = fixture();
  const input = title.slice(0, 60);
  assert.equal(input.length, 60);
  assert.equal(store.rename(parent.id, input).conversation?.title, input);
  assert.equal(createConversationStore({baseDir}).get(parent.id)?.title, input);
  store.appendTurn({
    conversationId: parent.id,
    question: 'A later task should not replace the chosen title',
  });
  assert.equal(store.get(parent.id)?.title, input);
});

test('a branch of a long custom title uses the custom title budget', () => {
  const {store, parent} = fixture();
  const input = title.slice(0, 52).trimEnd();
  store.rename(parent.id, input);
  const branch = store.branch(parent.id, 0)!;
  assert.equal(branch.title, `${input} · 分支`);
  assert.equal(store.get(parent.id)?.title, input);
});

test('a branch is durable before success even when transcript persistence is deferred', () => {
  const {baseDir, store, parent} = fixture(true);
  store.flush();
  const branch = store.branch(parent.id, 0)!;
  assert.equal(
    createConversationStore({baseDir}).get(branch.id)?.turns[0].answer,
    'Checked facts',
  );
  store.flush();
});

test('a failed branch commit leaves neither a false success nor a ghost conversation', () => {
  const {baseDir, store, parent} = fixture();
  const original = fs.renameSync;
  fs.renameSync = (() => {
    throw Object.assign(new Error('Cannot replace conversation file'), {
      code: 'EPERM',
    });
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => store.branch(parent.id, 0), /Cannot replace/);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(store.list().length, 1);
  assert.equal(createConversationStore({baseDir}).list().length, 1);
  assert.equal(store.get(parent.id)?.turns[0].answer, 'Checked facts');
  const retry = store.branch(parent.id, 0)!;
  assert.equal(
    createConversationStore({baseDir}).get(retry.id)?.title,
    retry.title,
  );
});

test('a rejected branch preserves pending progress in the source conversation', () => {
  const {baseDir, store, parent} = fixture(true);
  store.flush();
  store.appendTurn({
    conversationId: parent.id,
    question: 'Continue',
    answer: 'New progress not flushed yet',
  });
  const rename = fs.renameSync;
  fs.renameSync = (() => {
    throw new Error('Cannot replace conversation file');
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => store.branch(parent.id, 0), /Cannot replace/);
  } finally {
    fs.renameSync = rename;
  }
  store.flush();
  const reopened = createConversationStore({baseDir});
  assert.equal(reopened.list().length, 1);
  assert.equal(
    reopened.get(parent.id)?.turns.at(-1)?.answer,
    'New progress not flushed yet',
  );
});

test('automatic titles keep their existing concise budget', () => {
  const {store, parent} = fixture();
  store.appendTurn({conversationId: parent.id, question: title});
  assert.ok(store.get(parent.id)!.title.length <= 28);
  assert.ok(store.branch(parent.id, 0)!.title.length <= 28);
});

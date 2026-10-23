import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createConversationStore} from '../electron/conversation_store';

test('resumed work with no new question preserves the existing conversation title', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-title-resume-'));
  const store = createConversationStore({baseDir: root});
  const first = store.appendTurn({
    newConversation: true,
    question: '接入个人活动记录',
  });
  const title = first.title;
  store.appendTurn({conversationId: first.id, question: '然后核对记录结果'});
  assert.equal(store.get(first.id)?.title, title);
  store.appendTurn({
    conversationId: first.id,
    question: '',
    answer: '继续完成原任务',
  });
  assert.equal(store.get(first.id)?.title, title);
  assert.equal(
    createConversationStore({baseDir: root}).get(first.id)?.title,
    title,
  );
});

test('existing overwritten placeholder titles recover from real questions while custom titles stay intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-old-title-'));
  writeFileSync(
    join(root, 'conversations.json'),
    JSON.stringify([
      {
        id: 'old',
        title: '未命名',
        turns: [{question: '接入个人活动记录'}, {question: '然后核对结果'}, {question: ''}],
      },
      {
        id: 'custom',
        title: '未命名',
        titleCustom: true,
        turns: [{question: '自定义标题不能改'}],
      },
    ]),
  );
  const store = createConversationStore({baseDir: root});
  assert.equal(store.get('old')?.title, '接入个人活动记录');
  assert.equal(store.get('custom')?.title, '未命名');
});

import test from 'node:test';
import assert from 'node:assert/strict';
const activity = require('../electron/renderer/conversation_state');

test('activity labels follow the current Studio language', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const ts = require('typescript');
  const context = {
    module: {exports: {}},
    exports: {},
    document: {documentElement: {lang: 'en', dataset: {}}},
    localStorage: {getItem: () => null, setItem() {}},
  };
  const script = ['locale', 'conversation_state']
    .map(
      name =>
        ts.transpileModule(
          fs.readFileSync(`electron/renderer/${name}.ts`, 'utf8'),
          {compilerOptions: {target: ts.ScriptTarget.ES2022}},
        ).outputText,
    )
    .join('\n');
  vm.runInNewContext(script, context);
  assert.equal(
    vm.runInNewContext('ConversationState.label("awaiting")', context),
    'Needs input',
  );
  vm.runInNewContext('applyStudioLanguage("zh-CN")', context);
  for (const [state, label] of Object.entries({
    idle: '未开始',
    running: '运行中',
    awaiting: '需要输入',
    interrupted: '已中断',
    failed: '失败',
    pending: '待继续',
    completed: '已完成',
  })) {
    assert.equal(
      vm.runInNewContext(
        `ConversationState.label(${JSON.stringify(state)})`,
        context,
      ),
      label,
    );
  }
});

test('activity reads real list summaries whose turns field is a count', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {createConversationStore} = require('../electron/conversation_store');
  const store = createConversationStore({
    baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-summary-state-')),
  });
  const conversation = store.appendTurn({
    newConversation: true,
    question: 'A completed task',
    outcome: '已完成',
  });
  assert.equal(typeof store.list()[0].turns, 'number');
  assert.equal(activity.derive(store.list()[0]), 'completed');
  store.updateTurn({
    conversationId: conversation.id,
    turnIndex: 0,
    outcome: '等待输入',
    pendingInput: {requestId: 'question', kind: 'ask'},
  });
  assert.equal(activity.derive(store.list()[0]), 'awaiting');
});

test('a user-stopped task remains interrupted instead of being labelled as a failure', () => {
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      lastOutcome: '已停止',
      lastFailed: true,
    }),
    'interrupted',
  );
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      turns: [{outcome: '已停止', failed: true}],
    }),
    'interrupted',
  );
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      lastOutcome: '失败',
      lastFailed: true,
    }),
    'failed',
  );
  assert.equal(
    activity.derive({
      hasPendingWork: true,
      turns: [{pendingInput: {requestId: 'ask'}}],
    }),
    'awaiting',
  );
});

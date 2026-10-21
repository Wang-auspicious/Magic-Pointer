'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fork} = require('node:child_process');
const {
  ResourceCollectionService,
} = require('../build/electron/resource_collection_service');
const {
  createConversationStore,
} = require('../build/electron/conversation_store');
const {
  resourceAnalysisTask,
} = require('../build/electron/resource_analysis_task');
const {createStashRuntime} = require('../build/electron/stash_runtime');
const clipboard = {
  availableFormats: () => [],
  readText: () => '',
  readImage: () => ({isEmpty: () => true}),
};
const output = path.resolve('data/runtime/resource-recovery');
const answer = JSON.stringify({
  summary: 'Result retained across process termination',
  coverage: 'Saved local text',
  decision: 'keep',
});

async function worker(mode, baseDir) {
  const stash = createStashRuntime({baseDir, clipboard});
  const store = createConversationStore({
    baseDir: path.join(baseDir, 'history'),
  });
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    canOrganize: () => true,
    analysisTask: (taskId, requestId) =>
      resourceAnalysisTask(store, taskId, requestId),
    analyze: async input => {
      fs.appendFileSync(
        path.join(baseDir, 'model-calls.txt'),
        input.requestId + '\n',
      );
      const task = store.appendTurn({
        newConversation: true,
        question: input.question,
        request: {taskInput: {inputId: `input:studio:${input.requestId}`}},
        answer: '',
        outcome: '进行中',
        hasPendingWork: true,
      });
      store.flush();
      if (mode !== 'unbound') input.onStarted(task.id);
      if (mode !== 'running') {
        store.updateTurn({
          conversationId: task.id,
          outcome: mode === 'waiting' ? '等待输入' : '已完成',
          answer: mode === 'waiting' ? 'Choose the project' : answer,
          pendingInput:
            mode === 'waiting'
              ? {requestId: 'project', question: 'Which project?'}
              : null,
          hasPendingWork: mode === 'waiting',
          usedBackend: 'fixture.persisted-worker',
          timingMs: 12,
        });
        store.flush();
      }
      process.send({taskId: task.id});
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    },
  });
  if (mode === 'recover') {
    service.recover();
    await service.drain();
    process.send({collection: service.list()[0].collection});
    process.disconnect();
    return;
  }
  const item = await service.add({
    text: 'Original local reference',
    title: 'Process recovery',
  });
  service.enqueue(item.id);
  await service.drain();
}

function launch(mode, baseDir) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['worker', mode, baseDir], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`Worker timeout: ${mode}`));
    }, 15000);
    child.once('error', reject);
    child.once('message', message => {
      clearTimeout(deadline);
      resolve({child, message});
    });
  });
}

async function main() {
  fs.mkdirSync(output, {recursive: true});
  const results = [];
  for (const mode of ['completed', 'unbound', 'waiting', 'running']) {
    const baseDir = fs.mkdtempSync(path.join(output, mode + '-'));
    const first = await launch(mode, baseDir);
    const exited = new Promise(resolve => first.child.once('exit', resolve));
    first.child.kill('SIGKILL');
    await exited;
    const next = await launch('recover', baseDir);
    const recovered = next.message.collection;
    assert.equal(recovered.taskId, first.message.taskId);
    assert.equal(
      recovered.state,
      mode === 'waiting'
        ? 'waiting'
        : mode === 'running'
          ? 'processing'
          : 'ready',
    );
    if (mode === 'completed' || mode === 'unbound')
      assert.equal(recovered.summary, JSON.parse(answer).summary);
    assert.equal(
      fs
        .readFileSync(path.join(baseDir, 'model-calls.txt'), 'utf8')
        .trim()
        .split('\n').length,
      1,
    );
    results.push({
      mode,
      state: recovered.state,
      sameTaskId: true,
      modelCalls: 1,
    });
  }
  const report = {
    ok: true,
    usedBackend:
      'production service, Stash and ConversationStore in killed/restarted Node processes; controlled analysis result, no cloud model',
    results,
  };
  fs.writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

void (
  process.argv[2] === 'worker'
    ? worker(process.argv[3], process.argv[4])
    : main()
).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

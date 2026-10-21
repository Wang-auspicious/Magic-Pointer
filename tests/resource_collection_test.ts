import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceCollectionService} from '../electron/resource_collection_service';
import {createConversationStore} from '../electron/conversation_store';
import {resourceAnalysisTask} from '../electron/resource_analysis_task';

const {createStashRuntime} = require('../electron/stash_runtime');
const clipboard = {
  availableFormats: () => [],
  readText: () => '',
  readImage: () => ({isEmpty: () => true}),
  write: () => {},
};

test('collected page retains its source and editable project intent after reopening; stale analysis cannot overwrite an edit', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resources-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  const entry = await runtime.addText({
    text: 'A spring panel demo',
    collection: {
      url: 'https://example.com/demo',
      title: 'Panel',
      projectId: 'ui-project',
      intent: 'reference',
      state: 'inbox',
      note: 'Use for the sidebar',
      revision: 1,
    },
  });
  assert.equal(entry.collection.url, 'https://example.com/demo');
  const reopened = createStashRuntime({baseDir, clipboard});
  assert.equal(reopened.get(entry.id).collection.projectId, 'ui-project');
  reopened.updateResource(entry.id, {note: 'Reference only, not a clone'}, 1);
  assert.throws(
    () => reopened.updateResource(entry.id, {note: 'Clone it'}, 1),
    /resource_revision_conflict/,
  );
  assert.equal(
    reopened.get(entry.id).collection.note,
    'Reference only, not a clone',
  );
  assert.equal(
    readFileSync(join(baseDir, entry.relPath), 'utf8'),
    'A spring panel demo',
  );
});

test('processing can filter an unrelated item and propose a known project without turning a like into execution', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-filter-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [{id: 'ui', name: 'UI', root: ''}],
    attach: () => {},
    analyze: async () => ({
      ok: true,
      answer: JSON.stringify({
        summary: 'An unrelated giveaway',
        coverage: 'Saved text',
        decision: 'ignore',
        decisionReason: 'User rule excludes giveaways',
        projectId: 'ui',
      }),
    }),
  });
  const item = await service.add({
    text: 'Giveaway',
    note: 'Only keep UI design and research',
  });
  const processed = await service.process(item.id);
  assert.equal(processed.collection!.state, 'ignored');
  assert.equal(processed.collection!.intent, 'save');
  assert.equal(
    processed.collection!.decisionReason,
    'User rule excludes giveaways',
  );
});

test('a processed resource is exported into its selected project and a new service can recover it', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-collection-service-'));
  const root = mkdtempSync(join(tmpdir(), 'mp-collection-project-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  const registered: string[] = [];
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [{id: 'paper', name: 'Paper', root}],
    attach: (_id, paths) => {
      registered.push(...paths);
    },
    analyze: async () => ({
      ok: true,
      answer: JSON.stringify({
        summary: 'A useful baseline',
        nextStep: 'Read section 3',
        coverage: 'Supplied excerpt only',
      }),
      usedBackend: 'fixture.runtime',
      timingMs: 4,
    }),
  });
  const item = await service.add({
    text: 'Study description',
    url: 'https://example.com/paper',
    projectId: 'paper',
    title: 'Study',
  });
  await service.process(item.id);
  const exported = await service.deliver(item.id);
  assert.ok(exported.collection!.exportedPath.startsWith(root));
  assert.match(
    readFileSync(exported.collection!.exportedPath, 'utf8'),
    /A useful baseline/,
  );
  assert.ok(registered.includes(exported.collection!.exportedPath));
  assert.equal(
    service.list().find(row => row.id === item.id)?.collection?.usedBackend,
    'fixture.runtime',
  );
  const again = await service.deliver(item.id);
  assert.equal(
    again.collection!.exportedPath,
    exported.collection!.exportedPath,
  );
  const edited = service.update(
    item.id,
    {projectId: 'paper', note: 'Keep this'},
    again.collection!.revision,
  );
  assert.equal(edited.collection!.exportedPath, '');
  const selection = await service.add({
    url: 'https://example.com/paper',
    text: 'A newly selected paragraph',
  });
  assert.notEqual(selection.id, item.id);
  const repeated = await service.add({
    url: 'https://example.com/paper',
    text: 'A newly selected paragraph',
  });
  assert.equal(repeated.id, selection.id);
});

test('an unsuccessful or unreadable analysis retains its task and execution details for inspection', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-analysis-error-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  for (const response of [
    {
      ok: true,
      answer: 'This is not JSON',
      conversationId: 'bad-json-task',
      usedBackend: 'fixture.runtime',
      timingMs: 30,
    },
    {
      ok: false,
      error: 'Provider disconnected',
      conversationId: 'failed-task',
      usedBackend: 'fixture.runtime',
      timingMs: 40,
    },
  ]) {
    const service = new ResourceCollectionService({
      stash: () => runtime,
      projects: () => [],
      attach: () => {},
      analyze: async () => response,
    });
    const item = await service.add({text: response.conversationId});
    await assert.rejects(service.process(item.id));
    const result = runtime.get(item.id).collection;
    assert.equal(result.state, 'error');
    assert.equal(result.taskId, response.conversationId);
    assert.equal(result.usedBackend, 'fixture.runtime');
    assert.equal(result.timingMs, response.timingMs);
  }
});

test('no-op edits keep the delivery marker; changed content and new analysis require redelivery', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-redelivery-'));
  const root = mkdtempSync(join(tmpdir(), 'mp-resource-redelivery-project-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [{id: 'p', name: 'Project', root}],
    attach: () => {},
    analyze: async () => ({
      ok: true,
      answer: JSON.stringify({
        summary: 'Updated analysis',
        coverage: 'Saved text',
        decision: 'keep',
      }),
    }),
  });
  const item = await service.add({text: 'A reference', projectId: 'p'});
  let edited = service.update(
    item.id,
    {summary: 'First summary'},
    item.collection!.revision,
  );
  const delivered = await service.deliver(item.id);
  edited = service.update(
    item.id,
    {summary: 'First summary'},
    delivered.collection!.revision,
  );
  assert.equal(
    edited.collection!.exportedPath,
    delivered.collection!.exportedPath,
  );
  edited = service.update(
    item.id,
    {intent: 'reference'},
    edited.collection!.revision,
  );
  assert.equal(edited.collection!.exportedPath, '');
  await service.deliver(item.id);
  const processed = await service.process(item.id);
  assert.equal(processed.collection!.exportedPath, '');
  assert.equal(
    readFileSync(delivered.collection!.exportedPath, 'utf8').includes(
      'First summary',
    ),
    true,
  );
});

test('automatic queue survives service reconstruction and respects pause before each item', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-queue-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  let enabled = false;
  const analyzed: string[] = [];
  const options = {
    stash: () => runtime,
    projects: () => [],
    attach: () => {},
    canOrganize: () => enabled,
    analyze: async (input: {requestId: string}) => {
      analyzed.push(input.requestId);
      enabled = false;
      return {
        ok: true,
        answer: JSON.stringify({
          summary: 'Read original',
          coverage: 'Saved text',
          decision: 'keep',
        }),
      };
    },
  };
  const first = new ResourceCollectionService(options);
  const one = await first.add({text: 'First saved original'});
  const two = await first.add({text: 'Second saved original'});
  first.enqueue(one.id);
  first.enqueue(two.id);
  first.enqueue(one.id);
  assert.equal(runtime.get(one.id).collection.state, 'queued');
  const next = new ResourceCollectionService({
    ...options,
    stash: () => createStashRuntime({baseDir, clipboard}),
  });
  next.recover();
  await next.drain();
  assert.equal(analyzed.length, 0);
  enabled = true;
  await next.drain();
  assert.equal(analyzed.length, 1);
  assert.equal(
    next.list().filter(row => row.collection?.state === 'queued').length,
    1,
  );
  enabled = true;
  await next.drain();
  assert.equal(analyzed.length, 2);
  assert.equal(new Set(analyzed).size, 2);
});

test('analysis task identity is saved before execution completes', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-task-link-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  let release!: (value: any) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [],
    attach: () => {},
    analyze: async input => {
      input.onStarted?.('actual-task');
      started();
      return new Promise(resolve => {
        release = resolve;
      });
    },
  });
  const item = await service.add({text: 'Retained reference'});
  const pending = service.process(item.id);
  await ready;
  const saved = createStashRuntime({baseDir, clipboard}).get(
    item.id,
  ).collection;
  assert.equal(saved.taskId, 'actual-task');
  assert.ok(saved.analysisRequestId);
  release({
    ok: true,
    conversationId: 'actual-task',
    answer: JSON.stringify({summary: 'Result', coverage: 'Saved original'}),
  });
  await pending;
});

test('recovered result joins its original task and never runs the model again', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-result-recovery-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  const store = createConversationStore({baseDir: join(baseDir, 'history')});
  let calls = 0;
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [],
    attach: () => {},
    analysisTask: (taskId, requestId) =>
      resourceAnalysisTask(store, taskId, requestId),
    analyze: async () => {
      calls++;
      return {ok: false};
    },
  });
  const item = await service.add({text: 'Original'});
  const queued = service.enqueue(item.id);
  const requestId = queued.collection!.analysisRequestId;
  runtime.updateResource(
    item.id,
    {state: 'processing', analysisRevision: queued.collection!.revision + 1},
    queued.collection!.revision,
  );
  const task = store.appendTurn({
    newConversation: true,
    question: 'Organize original',
    request: {taskInput: {inputId: `input:studio:${requestId}`}},
    answer: JSON.stringify({
      summary: 'Durable completed analysis',
      coverage: 'Read source',
      decision: 'keep',
    }),
    outcome: '已完成',
    hasPendingWork: false,
    usedBackend: 'fixture.persisted',
    timingMs: 8,
  });
  store.flush();
  const reopened = new ResourceCollectionService({
    stash: () => createStashRuntime({baseDir, clipboard}),
    projects: () => [],
    attach: () => {},
    analysisTask: (taskId, requestId) =>
      resourceAnalysisTask(
        createConversationStore({baseDir: join(baseDir, 'history')}),
        taskId,
        requestId,
      ),
    analyze: async () => {
      calls++;
      return {ok: false};
    },
  });
  reopened.recover();
  await reopened.drain();
  const result = reopened.list().find(row => row.id === item.id)!.collection!;
  assert.equal(result.state, 'ready');
  assert.equal(result.summary, 'Durable completed analysis');
  assert.equal(result.taskId, task.id);
  assert.equal(calls, 0);
  assert.equal(result.usedBackend, 'fixture.persisted');
});

test('waiting tasks stay linked and late recovered results cannot overwrite newer edits', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-waiting-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  let task: any = {id: 'waiting-task', state: 'waiting'};
  let calls = 0;
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [],
    attach: () => {},
    analysisTask: () => task,
    analyze: async () => {
      calls++;
      return {ok: false};
    },
  });
  const item = await service.add({text: 'Original'});
  const queued = service.enqueue(item.id);
  runtime.updateResource(
    item.id,
    {
      state: 'processing',
      taskId: 'waiting-task',
      analysisRevision: queued.collection!.revision + 1,
    },
    queued.collection!.revision,
  );
  service.recover();
  assert.equal(runtime.get(item.id).collection.state, 'waiting');
  await assert.rejects(service.process(item.id), /existing|already/i);
  const before = runtime.get(item.id).collection;
  service.update(item.id, {note: 'My newer instruction'}, before.revision);
  task = {
    id: 'waiting-task',
    state: 'succeeded',
    ok: true,
    answer: JSON.stringify({summary: 'Old result', coverage: 'Old source'}),
  };
  service.reconcileTask('waiting-task');
  assert.equal(runtime.get(item.id).collection.note, 'My newer instruction');
  assert.notEqual(runtime.get(item.id).collection.summary, 'Old result');
  assert.equal(calls, 0);
});

test('ignored or edited queued resources are not automatically analyzed', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-queue-edits-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  let calls = 0;
  const service = new ResourceCollectionService({
    stash: () => runtime,
    projects: () => [],
    attach: () => {},
    canOrganize: () => true,
    analyze: async () => {
      calls++;
      return {ok: false};
    },
  });
  const ignored = await service.add({text: 'Ignore this'});
  const edited = await service.add({text: 'Edit this'});
  const a = service.enqueue(ignored.id);
  const b = service.enqueue(edited.id);
  service.update(ignored.id, {state: 'ignored'}, a.collection!.revision);
  service.update(edited.id, {note: 'Review manually'}, b.collection!.revision);
  await service.drain();
  assert.equal(calls, 0);
  assert.equal(runtime.get(ignored.id).collection.state, 'ignored');
  assert.equal(runtime.get(edited.id).collection.note, 'Review manually');
});

test('queue stops on a persistence failure instead of spinning on the same item', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-queue-write-'));
  const runtime = createStashRuntime({baseDir, clipboard});
  let writes = 0;
  let scans = 0;
  const failing = {
    ...runtime,
    list: () => {
      if (++scans > 2) {
        throw new Error('Repeated the same failed queue item');
      }
      return runtime.list();
    },
    updateResource: () => {
      writes++;
      throw new Error('Disk unavailable');
    },
  };
  let failWrites = false;
  const service = new ResourceCollectionService({
    stash: () => (failWrites ? failing : runtime),
    projects: () => [],
    attach: () => {},
    canOrganize: () => true,
    analyze: async () => {
      throw new Error('Must not reach model');
    },
  });
  const item = await service.add({text: 'Saved original'});
  service.enqueue(item.id);
  failWrites = true;
  await assert.rejects(service.drain(), /Disk unavailable/);
  assert.equal(writes, 1);
  assert.equal(runtime.get(item.id).collection.state, 'queued');
});

test('task lookup uses the saved analysis request even after unrelated later turns', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-task-turn-'));
  const store = createConversationStore({baseDir});
  const task = store.appendTurn({
    newConversation: true,
    question: 'Organize source',
    request: {taskInput: {inputId: 'input:studio:original-analysis'}},
    answer: 'Original result',
    outcome: '已完成',
  });
  store.appendTurn({
    conversationId: task.id,
    question: 'Unrelated follow-up',
    answer: 'Later answer',
    outcome: '等待输入',
    pendingInput: {requestId: 'unrelated', question: 'Continue?'},
  });
  const result = resourceAnalysisTask(store, task.id, 'original-analysis');
  assert.equal(result?.state, 'succeeded');
  assert.equal(result?.answer, 'Original result');
  assert.equal(resourceAnalysisTask(store, task.id, 'missing'), null);
  const unfinished = store.appendTurn({
    newConversation: true,
    question: 'Review source',
    request: {taskInput: {inputId: 'input:studio:unfinished'}},
    answer: 'Partial result',
    outcome: '已完成',
    hasPendingWork: true,
  });
  assert.equal(
    resourceAnalysisTask(store, unfinished.id, 'unfinished')?.state,
    'waiting',
  );
});

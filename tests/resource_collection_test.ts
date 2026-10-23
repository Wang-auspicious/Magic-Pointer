import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceCollectionService} from '../electron/resource_collection_service';
import {createConversationStore} from '../electron/conversation_store';
import {resourceAnalysisTask} from '../electron/resource_analysis_task';
import type {ResourcePost} from '../electron/resource_post';

const {createStashRuntime} = require('../electron/stash_runtime');
const clipboard = {
  availableFormats: () => [],
  readText: () => '',
  readImage: () => ({isEmpty: () => true}),
  write: () => {},
};

test('pasted share text captures an offline readable post and retains a failed source for retry', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-collected-post-'));
  const stash = createStashRuntime({baseDir, clipboard});
  let fail = true;
  const post: ResourcePost = {
    platform: 'xiaohongshu',
    id: 'abc123',
    url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=keep',
    title: 'Design reference',
    text: 'The complete retained source text',
    author: {name: 'Creator'},
    capturedAt: Date.now(),
    media: [],
    links: [],
    coverage: 'Full note text',
    usedBackend: 'fixture.page',
    timingMs: 5,
  };
  const create = () =>
    new ResourceCollectionService({
      stash: () => stash,
      projects: () => [],
      attach() {},
      analyze: async () => {
        throw new Error('Capture must not call a model');
      },
      capturePost: async () => {
        if (fail) {
          throw new Error('auth_required');
        }
        return structuredClone(post);
      },
      fetchMedia: async () => new Response(''),
    });
  const service = create();
  const saved = await service.add({
    text: '想借鉴这里的动效 ' + post.url,
    sourceAccount: 'xiaohongshu-2',
  });
  assert.equal(saved.collection!.url, post.url);
  assert.equal(saved.collection!.captureStatus, 'auth_required');
  assert.equal(
    stash.list().flatMap((group: {items: unknown[]}) => group.items).length,
    1,
  );
  fail = false;
  const captured = await service.capture(saved.id);
  assert.equal(captured.collection!.captureStatus, 'saved');
  assert.equal(captured.collection!.sourceAccount, 'xiaohongshu-2');
  const reopened = create();
  const document = reopened.post(saved.id);
  assert.equal(document.text, post.text);
  assert.equal(document.author.name, 'Creator');
  assert.match(
    readFileSync(join(baseDir, captured.collection!.postTextPath), 'utf8'),
    /complete retained source text/,
  );
  assert.equal(
    reopened.search('complete retained source').length,
    1,
    'search reaches original text rather than title only',
  );
  assert.equal(reopened.search('not in this library').length, 0);
});

test('organization proposes a use and tags without replacing the user intent; project delivery carries the saved post', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-post-handoff-'));
  const root = mkdtempSync(join(tmpdir(), 'mp-post-project-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [{id: 'ui', name: 'UI', root}],
    attach() {},
    capturePost: async url => ({
      platform: 'web',
      id: url,
      url,
      title: 'Reference',
      text: 'A complete original reference',
      author: {name: 'Author'},
      capturedAt: 1,
      media: [],
      links: [],
      coverage: 'Full page text',
      usedBackend: 'fixture.page',
      timingMs: 1,
    }),
    analyze: async () => ({
      ok: true,
      answer: JSON.stringify({
        summary: 'Keep this technique for the interface.',
        coverage: 'Saved text',
        decision: 'keep',
        projectId: 'ui',
        suggestedIntent: 'todo',
        tags: ['动效', '侧栏'],
      }),
    }),
  });
  const entry = await service.add({url: 'https://example.com/reference'});
  service.update(entry.id, {intent: 'reference'}, entry.collection!.revision);
  const organized = await service.process(entry.id);
  assert.equal(organized.collection!.intent, 'reference');
  assert.equal(organized.collection!.suggestedIntent, 'todo');
  assert.deepEqual(organized.collection!.tags, ['动效', '侧栏']);
  const delivered = await service.deliver(entry.id);
  assert.match(
    readFileSync(
      join(root, 'references', 'inbox', entry.id, 'post', 'original.txt'),
      'utf8',
    ),
    /complete original reference/,
  );
  assert.match(
    readFileSync(delivered.collection!.exportedPath, 'utf8'),
    /post\/original.txt/,
  );
});

test('a batch saves every link before capture starts and resumes queued originals after reopening', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-post-batch-'));
  const stash = createStashRuntime({baseDir, clipboard});
  let captures = 0;
  const make = () =>
    new ResourceCollectionService({
      stash: () => stash,
      projects: () => [],
      attach() {},
      analyze: async () => ({}),
      capturePost: async url => {
        captures++;
        assert.equal(
          stash.list().flatMap((group: {items: unknown[]}) => group.items)
            .length,
          2,
        );
        return {
          platform: 'web',
          id: url,
          url,
          title: url,
          text: 'Retained ' + url,
          author: {name: ''},
          capturedAt: 1,
          media: [],
          links: [],
          coverage: 'Full page',
          usedBackend: 'fixture.page',
          timingMs: 1,
        };
      },
    });
  const first = make();
  const items = await first.addBatch({
    text: '第一条 https://example.com/one\n第二条 https://example.com/two',
  });
  assert.equal(captures, 0);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.collection!.captureStatus === 'queued'));
  const reopened = make();
  await reopened.drainCaptures();
  assert.equal(captures, 2);
  assert.ok(
    reopened.list().every(item => item.collection!.captureStatus === 'saved'),
  );
});

test('opening a resource updates revisit history without invalidating an in-flight analysis', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-viewed-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    analyze: async () => ({}),
  });
  const entry = await service.add({text: 'A useful thought'});
  const started = stash.updateResource(entry.id, {state: 'processing'});
  const viewed = service.update(
    entry.id,
    {lastViewedAt: 123456},
    started.collection.revision,
  );
  assert.equal(viewed.collection!.revision, started.collection.revision);
  assert.equal(viewed.collection!.lastViewedAt, 123456);
  assert.doesNotThrow(() =>
    stash.updateResource(
      entry.id,
      {summary: 'Analysis finished'},
      started.collection.revision,
    ),
  );
});

test('one social note keeps its identity across changed access tokens without merging separate accounts', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-social-identity-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    analyze: async () => ({}),
  });
  const first = await service.add({
    url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=old',
    sourceAccount: 'xiaohongshu-1',
  });
  const repeated = await service.add({
    url: 'https://www.xiaohongshu.com/user/profile/author/abc123?xsec_token=new',
    sourceAccount: 'xiaohongshu-1',
  });
  assert.equal(repeated.id, first.id);
  assert.match(repeated.collection!.url, /xsec_token=new/);
  const other = await service.add({
    url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=other',
    sourceAccount: 'xiaohongshu-2',
  });
  assert.notEqual(other.id, first.id);
});

test('enabled automatic organization queues captured originals rather than analyzing bare share links', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-source-organize-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    canOrganize: () => true,
    capturePost: async url => ({
      platform: 'web',
      id: url,
      url,
      title: 'Reference',
      text: 'Original details for later recall',
      author: {name: 'Author'},
      capturedAt: 1,
      media: [],
      links: [],
      coverage: 'Full page',
      usedBackend: 'fixture.page',
      timingMs: 1,
    }),
    analyze: async input => {
      assert.ok(
        input.attachments.some(file =>
          readFileSync(file, 'utf8').includes(
            'Original details for later recall',
          ),
        ),
      );
      return {
        ok: true,
        answer: JSON.stringify({
          summary: 'A useful reference',
          coverage: 'Saved original text',
          decision: 'keep',
          suggestedIntent: 'reference',
        }),
      };
    },
  });
  const [item] = await service.addBatch({
    text: 'https://example.com/auto-reference',
  });
  await service.drainCaptures();
  assert.equal(stash.get(item.id).collection.state, 'queued');
  await service.drain();
  assert.equal(stash.get(item.id).collection.suggestedIntent, 'reference');
  assert.equal(stash.get(item.id).collection.state, 'ready');
});

test('manual organization waits for a queued original before sending attachments to MP', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-original-before-analysis-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    capturePost: async url => ({
      platform: 'web',
      id: url,
      url,
      title: 'Original',
      text: 'Original body must arrive before analysis',
      author: {name: ''},
      capturedAt: 1,
      media: [],
      links: [],
      coverage: 'Full page',
      usedBackend: 'fixture.page',
      timingMs: 1,
    }),
    analyze: async input => {
      assert.ok(
        input.attachments.some(file =>
          readFileSync(file, 'utf8').includes(
            'Original body must arrive before analysis',
          ),
        ),
      );
      return {
        ok: true,
        answer: JSON.stringify({
          summary: 'Original analyzed',
          coverage: 'Full text',
          decision: 'keep',
        }),
      };
    },
  });
  const [item] = await service.addBatch({
    text: 'https://example.com/original-first',
  });
  const result = await service.process(item.id);
  assert.equal(result.collection!.captureStatus, 'saved');
  assert.equal(result.collection!.state, 'ready');
});

test('revisiting a page recalls its saved note and linked references without treating a social feed as one topic', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-resource-recall-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    analyze: async () => ({}),
    capturePost: async url => ({
      platform: 'xiaohongshu',
      id: 'abc123',
      url,
      title: 'A source',
      text: 'See this article',
      author: {name: ''},
      capturedAt: 1,
      media: [],
      links: ['https://example.com/article'],
      coverage: 'Full note',
      usedBackend: 'fixture.page',
      timingMs: 1,
    }),
  });
  const note = await service.add({
    url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=old',
  });
  assert.equal(
    service.related(
      'https://www.xiaohongshu.com/user/profile/author/abc123?xsec_token=new',
    )[0].entry.id,
    note.id,
  );
  assert.equal(
    service.related('https://example.com/article#part')[0].relation,
    'link',
  );
  assert.equal(
    service.related('https://www.xiaohongshu.com/explore/def456').length,
    0,
  );
  service.update(
    note.id,
    {state: 'ignored'},
    stash.get(note.id).collection.revision,
  );
  assert.equal(service.related('https://example.com/article').length, 0);
});

test('removing a collected post removes only its owned original and media directory', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-post-removal-'));
  const stash = createStashRuntime({baseDir, clipboard});
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    analyze: async () => ({}),
    capturePost: async url => ({
      platform: 'web',
      id: url,
      url,
      title: 'A page',
      text: 'Original',
      author: {name: ''},
      capturedAt: 1,
      media: [],
      links: [],
      coverage: 'Full page',
      usedBackend: 'fixture.page',
      timingMs: 1,
    }),
  });
  const first = await service.add({url: 'https://example.com/first'});
  const second = await service.add({url: 'https://example.com/second'});
  assert.equal(stash.remove(first.id).ok, true);
  assert.equal(existsSync(join(baseDir, 'posts', first.id)), false);
  assert.equal(existsSync(join(baseDir, 'posts', second.id)), true);
});

test('a deleted item is not recreated when its pending capture returns', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-pending-post-removal-'));
  const stash = createStashRuntime({baseDir, clipboard});
  let release!: (post: ResourcePost) => void;
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    analyze: async () => ({}),
    capturePost: async () =>
      new Promise<ResourcePost>(resolve => {
        release = resolve;
      }),
  });
  const [item] = await service.addBatch({text: 'https://example.com/pending'});
  const pending = service.capture(item.id);
  stash.remove(item.id);
  release({
    platform: 'web',
    id: 'pending',
    url: 'https://example.com/pending',
    title: 'Deleted page',
    text: 'Original',
    author: {name: ''},
    capturedAt: 1,
    media: [],
    links: [],
    coverage: 'Full page',
    usedBackend: 'fixture.page',
    timingMs: 1,
  });
  await assert.rejects(pending, /resource_not_found/);
  assert.equal(stash.get(item.id), null);
  assert.equal(existsSync(join(baseDir, 'posts', item.id)), false);
});

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

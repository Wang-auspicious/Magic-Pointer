import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceCollectionService} from '../electron/resource_collection_service';

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

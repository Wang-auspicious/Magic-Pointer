import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceCollectionService} from '../electron/resource_collection_service';
import {handoffsForTurn} from '../electron/resource_handoff';
const {createStashRuntime} = require('../electron/stash_runtime');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mp-project-inbox-'));
  const stash = createStashRuntime({
    baseDir: join(root, 'stash'),
    clipboard: {
      availableFormats: () => [],
      readText: () => '',
      readImage: () => ({isEmpty: () => true}),
    },
  });
  const project = {
    id: 'project',
    name: 'Project',
    root,
    sharedFiles: [] as string[],
  };
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [project],
    attach: (_id, files) => {
      project.sharedFiles = [...new Set([...project.sharedFiles, ...files])];
    },
    analyze: async () => {
      throw new Error('No model needed for project handoffs');
    },
  });
  return {root, stash, project, service};
}

test('handoff versions survive reopening, repeated delivery and later edits', async () => {
  const {stash, service} = setup();
  const item = await service.add({text: 'Original', projectId: 'project'});
  service.update(item.id, {summary: 'First summary'}, 1);
  const first = await service.deliver(item.id);
  assert.equal(first.collection!.handoffVersion, 1);
  const repeat = await service.deliver(item.id);
  assert.equal(repeat.collection!.handoffVersion, 1);
  service.update(
    item.id,
    {summary: 'New summary'},
    repeat.collection!.revision,
  );
  const second = await service.deliver(item.id);
  assert.equal(second.collection!.handoffVersion, 2);
  assert.notEqual(
    second.collection!.exportedPath,
    first.collection!.exportedPath,
  );
  assert.equal(stash.get(item.id).collection.handoffVersion, 2);
});

test('project inbox preserves handled and snoozed choices without marking a task complete', async () => {
  const {service, project} = setup();
  const item = await service.add({text: 'Reference', projectId: project.id});
  service.update(item.id, {summary: 'Useful source'}, 1);
  const delivered = await service.deliver(item.id);
  const inbox = service.projectInbox(project.id);
  assert.equal(inbox[0].state, 'unread');
  const handled = service.setHandoffState(
    item.id,
    'handled',
    delivered.collection!.revision,
  );
  assert.equal(service.projectInbox(project.id)[0].state, 'handled');
  const until = Date.now() + 86400000;
  service.setHandoffState(
    item.id,
    'snoozed',
    handled.collection!.revision,
    until,
  );
  assert.equal(service.projectInbox(project.id)[0].snoozedUntil, until);
  assert.equal(service.projectInbox(project.id)[0].available, true);
  project.sharedFiles = [];
  assert.equal(
    service.projectInbox(project.id).length,
    0,
    'removed project material no longer enters its inbox',
  );
});

test('resume preserves the original handoff, while later turns receive new versions and due reminders', async () => {
  const {service, project} = setup();
  const item = await service.add({text: 'Original', projectId: project.id});
  service.update(item.id, {summary: 'Version one'}, 1);
  const first = await service.deliver(item.id);
  const frozen = handoffsForTurn(service.projectInbox(project.id));
  const turns = [{request: {projectHandoffs: frozen}, handoffsAcceptedAt: 123}];
  assert.equal(
    handoffsForTurn(service.projectInbox(project.id), turns).length,
    0,
  );
  service.update(item.id, {summary: 'Version two'}, first.collection!.revision);
  const second = await service.deliver(item.id);
  const resumed = handoffsForTurn(
    service.projectInbox(project.id),
    turns,
    true,
  );
  assert.equal(resumed[0].summary, 'Version one');
  assert.equal(resumed[0].version, 1);
  resumed[0].summary = 'Modified payload';
  assert.equal(frozen[0].summary, 'Version one');
  assert.equal(
    handoffsForTurn(service.projectInbox(project.id), turns)[0].version,
    2,
  );
  service.setHandoffState(
    item.id,
    'snoozed',
    second.collection!.revision,
    Date.now() + 86400000,
  );
  assert.equal(
    handoffsForTurn(service.projectInbox(project.id), turns).length,
    0,
  );
  assert.equal(
    handoffsForTurn(
      service.projectInbox(project.id),
      turns,
      false,
      Date.now() + 86400001,
    ).length,
    1,
  );
  service.setHandoffState(item.id, 'handled', second.collection!.revision);
  assert.equal(
    handoffsForTurn(service.projectInbox(project.id), turns).length,
    0,
  );
});

test('read-state changes preserve an in-flight analysis revision and survive restart', async () => {
  const {stash, service, root} = setup();
  const item = await service.add({text: 'Original', projectId: 'project'});
  const processing = stash.updateResource(
    item.id,
    {state: 'processing', taskId: 'task', analysisRevision: 2},
    1,
  );
  const changed = service.setHandoffState(
    item.id,
    'handled',
    processing.collection.revision,
  );
  assert.equal(changed.collection!.revision, processing.collection.revision);
  const completed = stash.updateResource(
    item.id,
    {state: 'ready', summary: 'Completed analysis'},
    processing.collection.revision,
  );
  assert.equal(completed.collection.handoffState, 'handled');
  const reopened = createStashRuntime({
    baseDir: join(root, 'stash'),
    clipboard: {
      availableFormats: () => [],
      readText: () => '',
      readImage: () => ({isEmpty: () => true}),
    },
  });
  assert.equal(reopened.get(item.id).collection.handoffState, 'handled');
  assert.equal(reopened.get(item.id).collection.summary, 'Completed analysis');
});

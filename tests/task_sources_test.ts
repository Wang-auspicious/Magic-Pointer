'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TaskSources = require('../electron/task_sources');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'task_input', 'reference_correction.json'),
  'utf8',
));

const sources = fixture.sources.map(TaskSources.normalizeSourceRef);
const initialUpdates = fixture.initialUpdates.map(TaskSources.normalizeReferenceUpdate);
const updates = fixture.updates.map(TaskSources.normalizeReferenceUpdate);

let state = TaskSources.emptyTaskContext(fixture.taskId);
state = TaskSources.reduceTaskContext(state, {
  type: 'context/updated',
  data: { taskId: fixture.taskId, sources, referenceUpdates: [], referenceRevision: 0 },
});
state = TaskSources.reduceTaskContext(state, {
  type: 'context/updated',
  data: { taskId: fixture.taskId, sources: [], referenceUpdates: initialUpdates, referenceRevision: 1 },
});
state = TaskSources.reduceTaskContext(state, {
  type: 'context/updated',
  data: { taskId: fixture.taskId, sources: [], referenceUpdates: updates, referenceRevision: 2 },
});

assert.strictEqual(state.sources.length, 2);
assert.strictEqual(state.sources[0].title, state.sources[1].title);
assert.notStrictEqual(state.sources[0].sourceId, state.sources[1].sourceId);
assert.strictEqual(state.references['ref-a'].active, false);
assert.strictEqual(state.references['ref-b'].label, 'B', 'removing A must not renumber B');
assert.strictEqual(state.references['ref-b'].role, 'target');
assert.deepStrictEqual(state.references['ref-b'].locator.value, { pageIndex: 4, textQuote: '里程碑' });
assert.strictEqual(state.references['ref-c'].label, 'C');
assert.strictEqual(state.referenceRevision, 2);

const replayed = [
  { type: 'context/updated', data: { taskId: fixture.taskId, sources, referenceUpdates: [], referenceRevision: 0 } },
  { type: 'context/updated', data: { taskId: fixture.taskId, sources: [], referenceUpdates: initialUpdates, referenceRevision: 1 } },
  { type: 'context/updated', data: { taskId: fixture.taskId, sources: [], referenceUpdates: updates, referenceRevision: 2 } },
].reduce(TaskSources.reduceTaskContext, TaskSources.emptyTaskContext(fixture.taskId));
assert.deepStrictEqual(replayed, state, 'event replay must reproduce roles and locators exactly');

const beta = TaskSources.reduceTaskContext(TaskSources.emptyTaskContext('task-beta'), {
  type: 'context/updated',
  data: { taskId: 'task-beta', sources: [TaskSources.normalizeSourceRef(fixture.otherTaskSource)], referenceUpdates: [], referenceRevision: 0 },
});
assert.deepStrictEqual(beta.sources.map((source: { sourceId: string }) => source.sourceId), ['source-other']);
assert.throws(
  () => TaskSources.reduceTaskContext(state, {
    type: 'context/updated',
    data: { taskId: 'task-beta', sources: beta.sources, referenceUpdates: [], referenceRevision: 2 },
  }),
  /taskId/,
);

const coverage = TaskSources.normalizeCoverage(fixture.coverage);
assert.strictEqual(coverage.complete, false);
assert.strictEqual(coverage.nextCursor, 'page:1');
assert.deepStrictEqual(TaskSources.normalizeTaskInput(fixture.referenceOnlyInput), fixture.referenceOnlyInput);

assert.throws(
  () => TaskSources.normalizeSourceRef({ ...fixture.sources[0], silentlyIgnored: true }),
  /unknown field/,
);

const submittedAt = 1_725_000_000_000;
const studioInput = TaskSources.bindConversationTaskInput({
  inputId: 'input:studio:1',
  taskId: 'renderer-placeholder',
  instruction: '结合附件修改第 4 页',
  referenceUpdates: [fixture.initialUpdates[0]],
  sourceIds: ['source-existing'],
  timeline: [],
  capturedAtMs: submittedAt - 5,
}, {
  taskId: 'agent-studio-new-abc',
  instruction: '结合附件修改第 4 页',
  attachments: ['D:\\work\\brief.pptx', 'D:\\work\\brief.pptx'],
  capturedAtMs: submittedAt,
});
assert.strictEqual(studioInput.taskId, 'agent-studio-new-abc',
  'main must rebind the renderer placeholder to the authoritative Agent session');
assert.strictEqual(studioInput.instruction, '结合附件修改第 4 页');
assert.deepStrictEqual(studioInput.sourceIds, [
  'source-existing',
  'source:attachment:D:/work/brief.pptx',
]);
assert.deepStrictEqual(studioInput.referenceUpdates, [fixture.initialUpdates[0]],
  'structured reference corrections must survive the Studio send boundary');
assert.strictEqual(studioInput.timeline[0].kind, 'utterance');
assert.strictEqual(studioInput.timeline[0].text, '结合附件修改第 4 页');

const attachedSource = TaskSources.attachmentSourceRef('D:\\work\\brief.pptx', 'agent-studio-new-abc');
assert.deepStrictEqual(attachedSource, {
  sourceId: 'source:attachment:D:/work/brief.pptx',
  taskId: 'agent-studio-new-abc',
  kind: 'document',
  title: 'brief.pptx',
  identity: { absolutePath: 'D:\\work\\brief.pptx' },
  revision: { authority: 'disk' },
  capabilities: ['read', 'search', 'follow', 'patch'],
  origin: 'user-attached',
  parentSourceId: null,
});

console.log('task sources test ok');

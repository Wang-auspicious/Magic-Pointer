import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkflowCardModel,
  layoutWorkflowArcs,
  parseWorkflowSnapshot,
  type WorkflowCardModel,
} from '../electron/renderer/workflow_card';

function presentation(steps: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'workflow_run',
    runId: 'run-1',
    title: 'Cmd run',
    status: 'succeeded',
    tokens: 120,
    steps,
    ...extra,
  };
}

test('parseWorkflowSnapshot returns the last complete JSON object with runId and steps', () => {
  const first = JSON.stringify({
    runId: 'run-1',
    title: 'Cmd run',
    status: 'running',
    tokens: 40,
    steps: [{id: 'a', title: 'A', status: 'succeeded', attempts: 1}],
  });
  const second = JSON.stringify({
    runId: 'run-1',
    title: 'Cmd run',
    status: 'running',
    tokens: 80,
    steps: [
      {id: 'a', title: 'A', status: 'succeeded', attempts: 1},
      {id: 'b', title: 'B', status: 'running', attempts: 1},
    ],
  });
  const snapshot = parseWorkflowSnapshot(`前置输出\n${first}\n${second}`);
  assert.ok(snapshot, 'the trailing snapshot must be found');
  assert.equal(snapshot.runId, 'run-1');
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.tokens, 80);
  assert.equal(snapshot.steps.length, 2);
  assert.equal(snapshot.steps[1]!.status, 'running');
});

test('parseWorkflowSnapshot skips a head-truncated snapshot and keeps a later complete one', () => {
  const text =
    '{"runId":"run-1","title":"t","status":"running","tokens":1,"steps":[{"id":"a","title":"A","stat';
  const complete = JSON.stringify({
    runId: 'run-2',
    title: 't',
    status: 'running',
    tokens: 2,
    steps: [{id: 'z', title: 'Z', status: 'pending', attempts: 0}],
  });
  const snapshot = parseWorkflowSnapshot(text + complete);
  assert.ok(snapshot, 'a truncated head snapshot must not hide the next complete one');
  assert.equal(snapshot!.runId, 'run-2');
});

test('parseWorkflowSnapshot returns null for plain text or JSON without the run shape', () => {
  assert.equal(parseWorkflowSnapshot(''), null);
  assert.equal(parseWorkflowSnapshot('普通进度文本，没有 JSON'), null);
  assert.equal(parseWorkflowSnapshot('{"ok":true}'), null);
  assert.equal(parseWorkflowSnapshot('{"runId":"r","steps":"not-array"}'), null);
});

test('buildWorkflowCardModel layers stations topologically and keeps declaration order per layer', () => {
  const model = buildWorkflowCardModel(
    presentation([
      {id: 'a', title: 'A', status: 'succeeded', attempts: 1, depends_on: [], readonly: true},
      {id: 'b', title: 'B', status: 'succeeded', attempts: 1, depends_on: ['a'], readonly: false},
      {id: 'c', title: 'C', status: 'succeeded', attempts: 1, depends_on: [], readonly: false},
      {id: 'd', title: 'D', status: 'succeeded', attempts: 1, depends_on: ['b', 'c'], readonly: false},
    ]),
    null,
  );
  assert.ok(model);
  assert.deepEqual(
    model!.stations.map(station => station.stepId),
    ['a', 'c', 'b', 'd'],
    'same-layer steps stay in declaration order: layer 0 is a,c then b then d',
  );
  assert.deepEqual(
    model!.stations.map(station => station.index),
    [0, 1, 2, 3],
  );
});

test('buildWorkflowCardModel maps every dependency to an arc and drops adjacent track edges', () => {
  const model = buildWorkflowCardModel(
    presentation([
      {id: 'a', title: 'A', status: 'succeeded', attempts: 1, depends_on: [], readonly: true},
      {id: 'b', title: 'B', status: 'succeeded', attempts: 1, depends_on: ['a'], readonly: false},
      {id: 'c', title: 'C', status: 'succeeded', attempts: 1, depends_on: [], readonly: false},
      {id: 'd', title: 'D', status: 'succeeded', attempts: 1, depends_on: ['b', 'c'], readonly: false},
    ]),
    null,
  );
  assert.ok(model);
  // Sorted stations: a=0 c=1 b=2 d=3. b->a is 0->2 (arc), d->b is 2->3
  // (adjacent, stays on the track), d->c is 1->3 (arc).
  assert.deepEqual(model!.arcs, [
    {fromIndex: 0, toIndex: 2},
    {fromIndex: 1, toIndex: 3},
  ]);
});

test('a running snapshot overrides terminal presentation statuses and tokens', () => {
  const model = buildWorkflowCardModel(
    presentation([
      {id: 'a', title: 'A', status: 'pending', attempts: 0, depends_on: [], readonly: false},
      {id: 'b', title: 'B', status: 'pending', attempts: 0, depends_on: ['a'], readonly: false},
    ], {status: 'succeeded', tokens: 999}),
    {
      runId: 'run-1',
      title: 'Cmd run',
      status: 'running',
      tokens: 55,
      steps: [
        {id: 'a', title: 'A', status: 'succeeded', attempts: 1},
        {id: 'b', title: 'B', status: 'running', attempts: 1},
      ],
    },
  );
  assert.ok(model);
  assert.equal(model!.status, 'running', 'a live snapshot re-opens a settled presentation');
  assert.equal(model!.tokens, 55);
  const byId = new Map(model!.steps.map(step => [step.id, step]));
  assert.equal(byId.get('a')!.status, 'succeeded');
  assert.equal(byId.get('a')!.attempts, 1);
  assert.equal(byId.get('b')!.status, 'running');
  assert.equal(model!.doneCount, 1);
  assert.equal(model!.total, 2);
});

test('a snapshot alone still lights the card while the run is in flight', () => {
  const model = buildWorkflowCardModel(undefined, {
    runId: 'run-1',
    title: 'Cmd run',
    status: 'running',
    tokens: 10,
    steps: [
      {id: 'a', title: 'A', status: 'succeeded', attempts: 1},
      {id: 'b', title: 'B', status: 'running', attempts: 1},
    ],
  });
  assert.ok(model, 'the running path has no presentation yet, so the snapshot carries the card');
  assert.equal(model!.status, 'running');
  assert.equal(model!.title, 'Cmd run');
  assert.equal(model!.total, 2);
  assert.equal(model!.doneCount, 1);
  assert.deepEqual(model!.arcs, [], 'snapshot steps carry no dependency edges');
});

test('invalid presentations return null', () => {
  assert.equal(buildWorkflowCardModel(null, null), null);
  assert.equal(buildWorkflowCardModel('not json', null), null);
  assert.equal(
    buildWorkflowCardModel({kind: 'file_diff', beforePath: null, afterPath: 'a.txt'}, null),
    null,
  );
  assert.equal(
    buildWorkflowCardModel(
      {kind: 'workflow_run', runId: 'r', title: 't', status: 'succeeded', tokens: 1,
        steps: [{id: 42, title: 'A'}]},
      null,
    ),
    null,
    'a step without a string id is a malformed presentation',
  );
  assert.equal(buildWorkflowCardModel({kind: 'workflow_run', steps: []}, null), null);
});

test('a dependency cycle still yields declaration order instead of hanging', () => {
  const model: WorkflowCardModel | null = buildWorkflowCardModel(
    presentation([
      {id: 'x', title: 'X', status: 'pending', attempts: 0, depends_on: ['y'], readonly: false},
      {id: 'y', title: 'Y', status: 'pending', attempts: 0, depends_on: ['x'], readonly: false},
    ]),
    null,
  );
  assert.ok(model);
  assert.deepEqual(
    model!.stations.map(station => station.stepId),
    ['x', 'y'],
  );
});

test('layoutWorkflowArcs separates overlapping spans by level and stacks same-origin arcs', () => {
  const layout = layoutWorkflowArcs([
    {fromIndex: 0, toIndex: 3},
    {fromIndex: 0, toIndex: 2},
  ]);
  assert.deepEqual(layout.map(arc => arc.level), [1, 2], 'same-origin arcs must not share a lane');

  const disjoint = layoutWorkflowArcs([
    {fromIndex: 0, toIndex: 3},
    {fromIndex: 4, toIndex: 6},
  ]);
  assert.deepEqual(disjoint.map(arc => arc.level), [1, 1], 'disjoint spans share the lowest lane');

  const nested = layoutWorkflowArcs([
    {fromIndex: 0, toIndex: 5},
    {fromIndex: 1, toIndex: 4},
  ]);
  assert.deepEqual(nested.map(arc => arc.level), [1, 2]);
});

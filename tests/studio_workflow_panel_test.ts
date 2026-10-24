import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupWorkflowTasks,
  isWorkflowStepTaskId,
} from '../electron/renderer/studio_workflow_panel';

const RUN_ID = 'e3f1c2ab9d104f6a8b7c1a2b3c4d5e6f';
const RUN_PREFIX = RUN_ID.slice(0, 8);

function stepTask(overrides: Record<string, any> = {}) {
  return {
    id: `wf-${RUN_PREFIX}-build-a1`,
    parentCallId: `workflow-${RUN_ID}`,
    description: '[workflow-step build] Compile the module\n\nRun the build.',
    status: 'running',
    stepCount: 1,
    currentTool: 'Read',
    summary: '',
    readonly: false,
    steps: [],
    startedAt: 1000,
    completedAt: 0,
    modelUsage: {totalTokens: 1200},
    ...overrides,
  };
}

test('groups workflow step subagents by the full runId in parentCallId', () => {
  const blocks = groupWorkflowTasks([
    stepTask(),
    stepTask({
      id: `wf-${RUN_PREFIX}-test-a1`,
      description: '[workflow-step test] Run the suite\n\nRun tests.',
      startedAt: 1100,
      status: 'completed',
    }),
  ]);
  assert.equal(blocks.length, 1, 'both steps belong to one run');
  assert.equal(blocks[0]!.runId, RUN_ID);
  assert.deepEqual(
    blocks[0]!.steps.map(step => step.stepId),
    ['build', 'test'],
    'steps follow their startedAt order',
  );
  assert.equal(blocks[0]!.active, true);
});

test('non-wf tasks never appear in the returned blocks', () => {
  const blocks = groupWorkflowTasks([
    stepTask(),
    stepTask({id: 'agent-1', parentCallId: 'toolu_01'}),
    stepTask({id: `wf-${RUN_PREFIX}`, parentCallId: 'toolu_02'}),
    stepTask({id: 'wfbuild-a1', parentCallId: 'toolu_03'}),
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(
    blocks[0]!.steps.map(step => step.subagentId),
    [`wf-${RUN_PREFIX}-build-a1`],
  );
});

test('retries collapse to one line keeping the attempt count and latest state', () => {
  const blocks = groupWorkflowTasks([
    stepTask({
      id: `wf-${RUN_PREFIX}-build-a1`,
      status: 'failed',
      completedAt: 1200,
      startedAt: 1000,
    }),
    stepTask({
      id: `wf-${RUN_PREFIX}-build-a2`,
      status: 'running',
      startedAt: 1300,
      completedAt: 0,
    }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.steps.length, 1);
  const step = blocks[0]!.steps[0]!;
  assert.equal(step.attempts, 2);
  assert.equal(step.status, 'running', 'a non-terminal retry wins over an older terminal one');
  assert.equal(step.subagentId, `wf-${RUN_PREFIX}-build-a2`);
  assert.equal(blocks[0]!.active, true);
});

test('when every attempt settled the largest attempt number wins', () => {
  const blocks = groupWorkflowTasks([
    stepTask({
      id: `wf-${RUN_PREFIX}-build-a1`,
      status: 'failed',
      startedAt: 1000,
      completedAt: 1100,
      modelUsage: {totalTokens: 300},
    }),
    stepTask({
      id: `wf-${RUN_PREFIX}-build-a2`,
      status: 'completed',
      startedAt: 1200,
      completedAt: 1500,
      modelUsage: {totalTokens: 900},
    }),
  ]);
  const step = blocks[0]!.steps[0]!;
  assert.equal(step.status, 'succeeded');
  assert.equal(step.attempts, 2);
  assert.equal(step.tokens, 900, 'tokens come from the representative attempt');
  assert.equal(blocks[0]!.active, false);
});

test('titles come from the [workflow-step] marker on the first line', () => {
  const blocks = groupWorkflowTasks([
    stepTask({description: '[workflow-step build] Compile the module\n\nRun the build.'}),
    stepTask({
      id: `wf-${RUN_PREFIX}-plain-a1`,
      description: 'No marker on this step',
      startedAt: 1200,
    }),
  ]);
  assert.equal(blocks[0]!.steps[0]!.title, 'Compile the module');
  assert.equal(blocks[0]!.steps[1]!.title, 'No marker on this step');
});

test('child statuses map onto the timeline light states', () => {
  const cases: Array<[string, string]> = [
    ['running', 'running'],
    ['awaiting_user', 'pending'],
    ['completed', 'succeeded'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['error', 'failed'],
    ['stopped', 'pending'],
    ['user_interrupt', 'pending'],
  ];
  const tasks = cases.map(([status], index) =>
    stepTask({
      id: `wf-${RUN_PREFIX}-s${index}-a1`,
      description: `[workflow-step s${index}] Step ${index}`,
      status,
      startedAt: 1000 + index,
    }),
  );
  const blocks = groupWorkflowTasks(tasks);
  assert.equal(blocks.length, 1);
  assert.deepEqual(
    blocks[0]!.steps.map(step => step.status),
    cases.map(([, expected]) => expected),
  );
});

test('tool-call parentCallIds fall back to prefix grouping', () => {
  const blocks = groupWorkflowTasks([
    stepTask({parentCallId: 'toolu_01ABC'}),
    stepTask({
      id: `wf-${RUN_PREFIX}-test-a1`,
      parentCallId: 'toolu_01ABC',
      description: '[workflow-step test] Run the suite\n\nRun tests.',
      startedAt: 1100,
      status: 'completed',
    }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.runId, RUN_PREFIX, 'the id prefix is the only runId available');
  assert.equal(blocks[0]!.steps.length, 2);
});

test('two runs stay separate blocks ordered by their earliest step', () => {
  const blocks = groupWorkflowTasks([
    stepTask({
      id: `wf-bbbbbbbb-docs-a1`,
      parentCallId: 'workflow-bbbbbbbb1111xyz',
      description: '[workflow-step docs] Write docs\n\nGo.',
      startedAt: 5000,
    }),
    stepTask({startedAt: 900}),
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map(block => block.runId),
    [RUN_ID, 'bbbbbbbb1111xyz'],
    'runs order by their earliest step start',
  );
});

test('tokens fall back to input+output when totalTokens is absent', () => {
  const blocks = groupWorkflowTasks([
    stepTask({modelUsage: {inputTokens: 700, outputTokens: 250}}),
  ]);
  assert.equal(blocks[0]!.steps[0]!.tokens, 950);
});

test('isWorkflowStepTaskId matches only workflow step subagent ids', () => {
  assert.equal(isWorkflowStepTaskId(`wf-${RUN_PREFIX}-build-a1`), true);
  assert.equal(isWorkflowStepTaskId(`wf-${RUN_PREFIX}-build-a12`), true);
  assert.equal(isWorkflowStepTaskId(`wf-${RUN_PREFIX}-build`), false);
  assert.equal(isWorkflowStepTaskId('agent-1'), false);
  assert.equal(isWorkflowStepTaskId(''), false);
});

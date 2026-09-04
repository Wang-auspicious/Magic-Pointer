'use strict';

const assert = require('node:assert');
const { projectSubagentTasks } = require('../electron/renderer/studio_subagents');
const { activeSubagentParentCallId } = require('../electron/renderer/studio_subagents');

const turns = [{
  trajectory: [
    {
      kind: 'tool', callId: 'parent-agent-1', name: 'Agent', state: 'done',
      text: JSON.stringify({ task: '审查 Claude 设置页信息架构', readonly: true }),
      result: '[subagent id=child-a status=completed steps=3]\n检查完成，设置分为模型、权限和扩展。',
      usedBackend: 'subagent_loop',
      latencyMs: 8120,
    },
    {
      kind: 'tool', callId: 'parent-agent-2', name: 'delegate_task', state: 'running',
      text: JSON.stringify({ task: '核对 Inspector 文件预览', readonly: false }),
      result: '',
      usedBackend: 'subagent_loop',
    },
  ],
}];

const live = [{
  id: 'child-b',
  parentCallId: 'parent-agent-2',
  description: '核对 Inspector 文件预览',
  status: 'running',
  stepCount: 2,
  currentTool: 'Read',
  steps: [
    { index: 1, tool: 'Grep', status: 'completed' },
    { index: 2, tool: 'Read', status: 'running' },
  ],
}];

const tasks = projectSubagentTasks(turns, live);
assert.deepStrictEqual(tasks.map((task: any) => task.id), ['child-b', 'child-a']);
assert.strictEqual(tasks[0].description, '核对 Inspector 文件预览');
assert.strictEqual(tasks[0].status, 'running');
assert.strictEqual(tasks[0].stepCount, 2);
assert.strictEqual(tasks[0].currentTool, 'Read');
assert.strictEqual(tasks[0].steps[1].status, 'running');
assert.strictEqual(tasks[1].description, '审查 Claude 设置页信息架构');
assert.strictEqual(tasks[1].status, 'completed');
assert.strictEqual(tasks[1].stepCount, 3);
assert(tasks[1].summary.includes('检查完成'));
assert.strictEqual(tasks[1].readonly, true);

assert.deepStrictEqual(projectSubagentTasks([{ events: [{ name: 'Read' }] }], []), []);

const interrupted = projectSubagentTasks([{ trajectory: [
  {
    kind: 'tool', callId: 'parent-agent-budget', name: 'Agent', state: 'done',
    text: JSON.stringify({ task: 'Long audit' }),
    result: '[subagent id=child-budget status=budget_exhausted steps=4]\nPartial result',
  },
  {
    kind: 'tool', callId: 'parent-agent-stop', name: 'Agent', state: 'done',
    text: JSON.stringify({ task: 'Stopped audit' }),
    result: '[subagent id=child-stop status=user_interrupt steps=2]\nStopped',
  },
] }], []);
assert.strictEqual(interrupted.find((task: any) => task.id === 'child-budget')?.status, 'failed',
  'an exhausted child must never be presented as completed');
assert.strictEqual(interrupted.find((task: any) => task.id === 'child-stop')?.status, 'stopped',
  'an interrupted child must retain its stopped state');

assert.strictEqual(activeSubagentParentCallId([
  { phase: 'tool_call', fields: { id: 'read-1', name: 'Read' } },
  { phase: 'tool_call', fields: { id: 'parent-agent-live', name: 'Agent' } },
]), 'parent-agent-live', 'live child snapshots must attach to the running parent Agent row');
assert.strictEqual(activeSubagentParentCallId([
  { phase: 'tool_call', fields: { id: 'read-1', name: 'Read' } },
]), '');
console.log('studio subagent projection test ok');

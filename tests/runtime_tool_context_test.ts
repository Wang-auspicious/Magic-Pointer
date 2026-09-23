import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { runAgent, buildSystemPrompt } from '../electron/runtime/agent';
import { ToolRegistry } from '../electron/runtime/tools';
import { initialToolNames, projectContextMessages, registerToolResultReader } from '../electron/runtime/agent_services';

const schema = { type: 'object', properties: {}, required: [] };

test('initial schemas stay small while the actual registry directory and exact loading remain available', () => {
  const registry = new ToolRegistry();
  for (const name of ['Tools', 'AskUser', 'ToolResult.read', 'Read', 'Write', 'Edit', 'Patch', 'Glob', 'Bash', 'get_app_state', 'Agent']) {
    registry.register({ name, description: `${name} fixture`, input_schema: schema, execute: () => name });
  }
  registry.setInitialTools(initialToolNames({ workspace: 'C:/work' }));
  assert.deepEqual(registry.schemas().map(item => item.name), ['Tools', 'AskUser', 'ToolResult.read', 'Read', 'Write', 'Edit', 'Patch']);
  assert(registry.directory().split(', ').includes('Bash'));
  assert(!registry.directory().split(', ').includes('Read'));
  registry.discover({ names: ['Bash', 'Agent'] });
  assert(registry.schemas().some(item => item.name === 'Bash'));
  assert(registry.schemas().some(item => item.name === 'Agent'));
});

test('ordinary task metadata is not described as a user screen selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-prompt-selection-'));
  const prompt = await buildSystemPrompt({ userDataDir: root, workspace: root, evidence: 'Current task sources and references: []' });
  assert.doesNotMatch(prompt, /用户圈选了对象/);
});

test('structured source and desktop target add only their direct readers without text routing', () => {
  const names = initialToolNames({ taskContext: { sources: [{ sourceId: 'attached', kind: 'file' }] }, selectionSnapshot: { snapshot_id: 'target' } });
  assert(names.includes('Context.read'));
  assert(names.includes('Context.search'));
  assert(names.includes('look'));
  assert(names.includes('get_app_state'));
  assert(!names.includes('Bash'));
  assert(!names.includes('Agent'));
  assert.deepEqual(initialToolNames({ workspace: 'C:/work', permissionMode: 'safe' }), ['Tools', 'AskUser', 'ToolResult.read', 'Read']);
});

test('large results project to a short model message and remain readable by call id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-tool-context-'));
  const session = await EventSession.open(root, 'tool-context');
  const full = 'START\n' + 'x'.repeat(12000) + '\nEND';
  await session.append('operation/prepared', { operationId: 'op', callId: 'call-1', name: 'Inspect', effect: 'read', dispatched: true });
  await session.append('operation/settled', { operationId: 'op', outcome: 'succeeded', message: { role: 'tool', name: 'Inspect', tool_call_id: 'call-1', content: full } });
  const registry = new ToolRegistry(); registerToolResultReader(registry, session);
  const projected = projectContextMessages([{ role: 'tool', name: 'Inspect', tool_call_id: 'call-1', content: full }]);
  assert(projected[0]!.content!.length < 4000);
  assert.match(projected[0]!.content!, /ToolResult\.read/);
  assert.match(projected[0]!.content!, /call-1/);
  const page = await registry.execute({ id: 'read-result', name: 'ToolResult.read', arguments: { tool_call_id: 'call-1', offset: 11900, limit: 200 } });
  assert.equal(page.is_error, false, page.error_message);
  assert.equal((page.value as { content: string }).content, full.slice(11900));
});

test('production loop retains a result over 64K and reads its tail through the model tool', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-large-result-'));
  const session = await EventSession.open(root, 'large-result');
  const registry = new ToolRegistry(); registerToolResultReader(registry, session);
  const full = 'START\n' + 'x'.repeat(70000) + '\nEND';
  registry.register({ name: 'LargeEvidence', description: 'Read large evidence', input_schema: schema, execute: () => full });
  let step = 0;
  const result = await runAgent({ root, userDataDir: root, session, registry, system: 'Test', instruction: 'Read the tail of evidence',
    model: async request => {
      step++;
      if (step === 1) return { text: '', tool_calls: [{ id: 'big', name: 'LargeEvidence', arguments: {} }] };
      if (step === 2) {
        const projected = request.messages.at(-1)!.content!;
        assert(projected.length < 4000);
        assert.match(projected, /ToolResult\.read/);
        return { text: '', tool_calls: [{ id: 'tail', name: 'ToolResult.read', arguments: { tool_call_id: 'big', offset: 69950, limit: 100 } }] };
      }
      assert.match(request.messages.at(-1)!.content!, /END/);
      return { text: 'Read back', tool_calls: [] };
    } });
  assert.equal(result.reason, 'completed');
  assert.equal(step, 3);
  const saved = session.events.find(event => event.type === 'operation/settled' && event.data.operationId)?.data.message as { content: string };
  assert.equal(saved.content, full);
});

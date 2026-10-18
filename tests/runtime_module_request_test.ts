import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAgent, type ModelRequest} from '../electron/runtime/agent';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';

test('module request context reaches the model and the same request audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-request-'));
  try {
    const session = await EventSession.open(root, 'module-request');
    let seen: ModelRequest | undefined;
    const options = {
      root,
      userDataDir: root,
      session,
      registry: new ToolRegistry(),
      instruction: 'Explain the current source',
      system: 'Core system',
      requestContext: async () => [
        {
          moduleId: 'project-evidence',
          text: 'The verified source is quarterly-report.txt.',
        },
      ],
      model: async (request: ModelRequest) => {
        seen = request;
        return {text: 'Read current context.', tool_calls: []};
      },
    };
    const result = await runAgent(options);
    assert.equal(result.reason, 'completed');
    const context = seen?.messages.find(message =>
      message.content?.includes('[Module context: project-evidence]'),
    );
    assert.equal(
      context?.content,
      '[Module context: project-evidence]\nThe verified source is quarterly-report.txt.',
    );
    assert.equal(context.origin, 'data');
    assert.equal(context.injected, true);
    const request = session.events.find(
      event => event.type === 'model/request',
    );
    assert.ok(request);
    assert.ok(
      (request.data.estimatedTokenBreakdown as Record<string, number>)
        .evidence > 0,
    );
    const saved = session.events.find(
      event => event.type === 'module/request_context',
    );
    assert.deepEqual(saved?.data.contexts, [
      {
        moduleId: 'project-evidence',
        text: 'The verified source is quarterly-report.txt.',
      },
    ]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('compaction refreshes module context for each later request without persisting it as user instruction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-compaction-'));
  try {
    const session = await EventSession.open(root, 'module-compaction');
    for (let index = 0; index < 12; index++) {
      await session.appendMessage({
        role: index % 2 ? 'assistant' : 'user',
        content: `Historical step ${index}: ${'older evidence '.repeat(300)}`,
      });
    }
    const registry = new ToolRegistry();
    registry.register({
      name: 'ReadStatus',
      description: 'Read current status',
      input_schema: {type: 'object', properties: {}, required: []},
      execute: () => ({status: 'ready'}),
    });
    const turns: number[] = [];
    const observed: string[] = [];
    let calls = 0;
    let compactions = 0;
    const result = await runAgent({
      root,
      userDataDir: root,
      session,
      registry,
      instruction: 'Continue the pending work',
      system: 'Core system',
      contextTokens: 4096,
      requestContext: async request => {
        turns.push(request.turn);
        return [
          {moduleId: 'current-state', text: `State at turn ${request.turn}`},
        ];
      },
      model: async request => {
        if (request.system.startsWith('为下个上下文窗口')) {
          compactions++;
          return {
            text: 'Earlier read-only work was completed. Continue the pending work.',
            tool_calls: [],
          };
        }
        const context = request.messages.filter(message =>
          message.content?.startsWith('[Module context: current-state]'),
        );
        assert.equal(context.length, 1);
        observed.push(context[0].content!);
        return ++calls === 1
          ? {
              text: '',
              tool_calls: [{id: 'status', name: 'ReadStatus', arguments: {}}],
            }
          : {text: 'Ready.', tool_calls: []};
      },
    });
    assert.equal(result.reason, 'completed');
    assert.ok(
      compactions > 0,
      'the test must actually compact the saved history',
    );
    assert.deepEqual(turns, [1, 2]);
    assert.deepEqual(observed, [
      '[Module context: current-state]\nState at turn 1',
      '[Module context: current-state]\nState at turn 2',
    ]);
    assert.ok(
      !session
        .deriveMessages()
        .some(message => message.content?.startsWith('[Module context:')),
    );
    const saved = session.events.filter(
      event => event.type === 'module/request_context',
    );
    assert.deepEqual(
      saved.map(event => event.data.contexts),
      turns.map(turn => [
        {moduleId: 'current-state', text: `State at turn ${turn}`},
      ]),
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

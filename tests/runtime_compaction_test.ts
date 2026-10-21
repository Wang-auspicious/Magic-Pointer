import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  compactSession,
  runAgent,
  type AgentEvent,
  type ModelReply,
} from '../electron/runtime/agent';
import {
  EventSession,
  estimateTokens,
  handleSessionRead,
} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {taskSources} from '../electron/runtime/context';
import {runRuntime} from '../electron/runtime/index';

async function fixture(
  id: string,
  content = 'Historical evidence '.repeat(1200),
) {
  const root = await mkdtemp(join(tmpdir(), 'mp-compaction-'));
  const session = await EventSession.open(root, id);
  for (let i = 0; i < 6; i++) {
    await session.appendMessage({
      role: i % 2 ? 'assistant' : 'user',
      content: `HISTORY ${i}: ${content}`,
    });
  }
  return {
    root,
    userDataDir: root,
    session,
    registry: new ToolRegistry(),
    system: 'Core task instructions',
    contextTokens: 8192,
  };
}
const usage = (input: number, output: number) => ({
  prompt_tokens: input,
  completion_tokens: output,
  prompt_tokens_details: {cached_tokens: 0},
});
const reply = (text: string, input = 60, output = 10): ModelReply => ({
  text,
  tool_calls: [],
  usage: usage(input, output),
  usedBackend: 'magic_pointer.chat-completions_streaming',
});

test('automatic compaction contributes usage and priced requests without replacing primary context usage', async () => {
  const f = await fixture('automatic-usage');
  let summaries = 0;
  const result = await runAgent({
    ...f,
    instruction: 'Finish the task',
    config: {
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
    },
    model: async request => {
      if (request.system.startsWith('为下个上下文窗口')) {
        summaries++;
        return reply('Previous steps are complete.');
      }
      return reply('Done.', 20, 5);
    },
  });
  assert.ok(summaries > 0);
  assert.equal(result.model_usage.inputTokens, summaries * 60 + 20);
  assert.equal(result.model_usage.outputTokens, summaries * 10 + 5);
  assert.equal(result.model_usage.contextTokens, 20);
  assert.equal(result.model_usage.pricedRequests, summaries + 1);
  assert.ok(result.model_usage.estimatedCostUsd > 0);
});

test('manual compaction receipts survive reopening and produce progress without streaming the summary as an answer', async () => {
  const f = await fixture('manual-usage');
  await f.session.append(
    'user/message',
    {
      message: {role: 'user', content: 'Resume the saved work'},
      inputId: 'request-usage',
    },
    'append',
  );
  const events: AgentEvent[] = [];
  const phases: string[] = [];
  const sink = new RuntimeActivitySink(phase => phases.push(phase));
  sink.onEvent({kind: 'turn_started', turn: 1});
  sink.onEvent({kind: 'model_usage', usage: {contextTokens: 123}});
  phases.length = 0;
  await compactSession(
    {
      ...f,
      onEvent: event => {
        events.push(event);
        sink.onEvent(event);
      },
      model: async request => {
        request.onEvent?.({
          type: 'text_delta',
          text: 'Private compaction summary',
        });
        return reply('Retain the saved work.');
      },
    },
    f.system,
    new AbortController().signal,
    true,
  );
  const reopened = await EventSession.open(f.root, f.session.id, false);
  const responses = reopened.events.filter(
    event => event.type === 'compaction/response',
  );
  assert.ok(
    responses.length > 0,
    'each summarizer request has a durable response',
  );
  assert.equal(
    (responses[0].data.requestUsage as Record<string, number>).inputTokens,
    60,
  );
  assert.ok(Number(responses[0].data.timingMs) >= 0);
  assert.equal(
    responses[0].data.usedBackend,
    'magic_pointer.chat-completions_streaming',
  );
  assert.ok(phases.includes('context_compacting'));
  assert.ok(
    !phases.includes('model_request'),
    'a summary is not acceptance of the primary task input',
  );
  assert.ok(!events.some(event => event.kind === 'model_chunk'));
  assert.equal(
    (
      sink.trajectory.find(item => item.kind === 'message')
        ?.modelUsage as Record<string, number>
    ).contextTokens,
    123,
    'summary usage must not replace the primary request context gauge',
  );
  const status = await handleSessionRead(
    {action: 'status', sessionId: f.session.id, inputId: 'request-usage'},
    f.root,
  );
  assert.equal(
    (status.taskModelUsage as Record<string, number>).inputTokens,
    responses.length * 60,
  );
});

test('summary input and output fit a configured small context window even with Chinese evidence', async () => {
  const f = await fixture(
    'small-window',
    '中文研究进度与关键事实。'.repeat(1000),
  );
  let requests = 0;
  const compacted = await compactSession(
    {
      ...f,
      contextTokens: 2048,
      model: async request => {
        requests++;
        assert.ok(
          estimateTokens(request.system + JSON.stringify(request.messages)) +
            (request.maxTokens || 0) <=
            2048,
          'summarizer request must fit the active window',
        );
        return reply('关键事实仍在，继续核验。');
      },
    },
    f.system,
    new AbortController().signal,
    true,
  );
  assert.equal(compacted, true);
  assert.ok(requests > 1);
  assert.ok(estimateTokens(JSON.stringify(f.session.deriveMessages())) < 1024);
});

test('automatic compaction does not retain an oversized historical tail', async () => {
  const f = await fixture('bounded-tail', 'large evidence '.repeat(2500));
  await f.session.appendMessage({
    role: 'user',
    content: 'LATEST: verify the final output',
  });
  const compacted = await compactSession(
    {
      ...f,
      contextTokens: 4096,
      model: async () => reply('Earlier work is saved; verify the output.'),
    },
    f.system,
    new AbortController().signal,
  );
  assert.equal(compacted, true);
  assert.ok(estimateTokens(JSON.stringify(f.session.deriveMessages())) < 2048);
  assert.equal(
    f.session.deriveMessages().at(-1)?.content,
    'LATEST: verify the final output',
  );
});

test('multi-chunk summaries are reduced to a bounded handoff rather than concatenated indefinitely', async () => {
  const f = await fixture('summary-reduction', 'HISTORY '.repeat(12000));
  let reductions = 0;
  const compacted = await compactSession(
    {
      ...f,
      model: async request => {
        if (
          request.messages.some(message => message.content?.includes('HISTORY'))
        ) {
          return reply('SUMMARY: a verified fact. '.repeat(200));
        }
        reductions++;
        return reply(
          'The verified facts are saved. Continue the remaining task.',
        );
      },
    },
    f.system,
    new AbortController().signal,
    true,
  );
  assert.equal(compacted, true);
  assert.ok(reductions > 0);
  assert.ok(estimateTokens(JSON.stringify(f.session.deriveMessages())) < 4096);
});

test('large source directories remain valid JSON with complete navigation back to durable entries', async () => {
  const f = await fixture('source-directory');
  const sources = Array.from({length: 100}, (_, i) => ({
    sourceId: `source-${i}`,
    taskId: f.session.id,
    kind: 'file',
    title: `Document ${i}`,
    identity: {path: `/project/${i}.md`, details: 'metadata '.repeat(100)},
    revision: {size: 1200},
    capabilities: ['read'],
    origin: 'project',
    parentSourceId: null,
  }));
  await f.session.append('context/updated', {
    taskId: f.session.id,
    sources,
    referenceUpdates: [],
    referenceRevision: 0,
  });
  assert.equal(
    await compactSession(
      {...f, model: async () => reply('Read the project sources as needed.')},
      f.system,
      new AbortController().signal,
      true,
    ),
    true,
  );
  const text = f.session.deriveMessages()[0].content!;
  const json = text
    .split(
      '[Task source/reference entries; read full content through Context tools]\n',
    )[1]
    .split('\n<<<MAGIC_POINTER_EVIDENCE>>>')[0];
  const directory = JSON.parse(json);
  assert.equal(directory.sourceCount, 100);
  assert.equal(directory.sources.length + directory.omittedSources, 100);
  assert.equal(directory.readMore, 'Context.list');
  assert.equal(
    taskSources((await EventSession.open(f.root, f.session.id, false)).events)
      .length,
    100,
  );
});

test('steering received while a summary is running cannot be overwritten by the summary', async () => {
  const f = await fixture('compaction-steer');
  let steered = false;
  const compacted = await compactSession(
    {
      ...f,
      model: async () => {
        if (!steered) {
          steered = true;
          const writer = await EventSession.open(f.root, f.session.id, false);
          await writer.appendMessage({
            role: 'user',
            content: 'NEW STEER: preserve the revised scope',
          });
        }
        return reply('Old scope only.');
      },
    },
    f.system,
    new AbortController().signal,
    true,
  );
  assert.equal(compacted, false);
  assert.equal(
    f.session.deriveMessages().at(-1)?.content,
    'NEW STEER: preserve the revised scope',
  );
});

test('the public compact command returns actual model usage', async () => {
  const f = await fixture('agent-studio-new-public-compact');
  const folder = join(f.root, 'data', 'plugins', 'fixture');
  await mkdir(folder, {recursive: true});
  await writeFile(
    join(folder, 'plugin.json'),
    JSON.stringify({main: 'entry.cjs'}),
  );
  await writeFile(
    join(folder, 'entry.cjs'),
    `module.exports={name:'provider',async apply(ctx){await ctx.provideUp('llm',async()=>(${JSON.stringify(reply('Previous steps are saved.'))}))}}`,
  );
  await writeFile(
    join(f.root, 'data', 'harness.patch.json'),
    JSON.stringify({
      schemaVersion: 1,
      patch: {'llm-provider': {disabled: true}},
    }),
  );
  const result = await runRuntime(
    {
      question: '/compact',
      agentSessionId: f.session.id,
      modelRuntime: {model: 'fixture-unknown', credential: 'fixture'},
    },
    {root: f.root, userDataDir: f.root},
  );
  assert.equal(result.ok, true, result.error);
  assert.ok(
    Number((result.modelUsage as Record<string, number>)?.inputTokens) > 0,
  );
});

test('truncated summaries never replace history and still account for the spent request', async () => {
  const f = await fixture('truncated-summary');
  const before = f.session.deriveMessages();
  assert.equal(
    await compactSession(
      {
        ...f,
        model: async () => ({
          ...reply('Partial fact.'),
          stop_reason: 'max_output_tokens',
        }),
      },
      f.system,
      new AbortController().signal,
      true,
    ),
    false,
  );
  assert.deepEqual(f.session.deriveMessages(), before);
  assert.ok(
    f.session.events.some(
      event =>
        event.type === 'compaction/response' &&
        event.data.outcome === 'max_output_tokens',
    ),
  );
});

test('a stream failure retains reported usage and leaves historical messages intact', async () => {
  const f = await fixture('stream-failure');
  const before = f.session.deriveMessages();
  const compacted = await compactSession(
    {
      ...f,
      model: async request => {
        request.onEvent?.({type: 'usage', usage: usage(44, 7)});
        throw new Error('Summary connection closed');
      },
    },
    f.system,
    new AbortController().signal,
    true,
  );
  assert.equal(compacted, false);
  assert.deepEqual(f.session.deriveMessages(), before);
  const response = f.session.events.find(
    event => event.type === 'compaction/response',
  )!;
  assert.equal(
    (response.data.requestUsage as Record<string, number>).inputTokens,
    44,
  );
  assert.equal(response.data.error, 'Summary connection closed');
});

test('cancelling during a summary preserves history and does not dispatch the main model', async () => {
  const f = await fixture('cancel-summary');
  const controller = new AbortController();
  let primary = 0;
  const before = f.session.deriveMessages();
  const result = await runAgent({
    ...f,
    signal: controller.signal,
    model: async request => {
      if (request.system.startsWith('为下个上下文窗口')) {
        controller.abort();
        return reply('Partial summary');
      }
      primary++;
      return reply('Must not run');
    },
  });
  assert.equal(result.reason, 'user_interrupt');
  assert.equal(primary, 0);
  assert.ok(
    !f.session.events.some(event => event.type === 'context/compacted'),
  );
  assert.deepEqual(f.session.deriveMessages().slice(0, before.length), before);
});

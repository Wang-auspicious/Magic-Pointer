import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry, type ToolContext} from '../electron/runtime/tools';
import {runAgent, registerAgentTools, type ModelReply, type ModelRequest} from '../electron/runtime/agent';

const str = (value: unknown) => String(value ?? '');

/**
 * Deterministic model: replays a script of replies. Summarizer calls from
 * compactSession are answered with a canned summary unless the script says
 * otherwise. Captures every request so scenarios can assert what the loop
 * actually sent.
 */
class ScriptedModel {
  readonly requests: ModelRequest[] = [];
  private replies: Array<ModelReply | ((request: ModelRequest) => ModelReply)>;
  constructor(replies: Array<ModelReply | ((request: ModelRequest) => ModelReply)>) {
    this.replies = [...replies];
  }
  run = async (request: ModelRequest): Promise<ModelReply> => {
    this.requests.push(request);
    if (request.system.startsWith('为下个上下文窗口写交接摘要')) {
      return {text: 'SUMMARY: progress kept, two steps remain.', tool_calls: []};
    }
    const next = this.replies.shift();
    if (!next) {
      throw new Error('scripted model exhausted');
    }
    return typeof next === 'function' ? next(request) : next;
  };
}

const call = (name: string, arguments_: Record<string, unknown> = {}) => ({
  id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  arguments: arguments_,
});
const text = (body: string): ModelReply => ({text: body, tool_calls: []});

async function harness(
  replies: Array<ModelReply | ((request: ModelRequest) => ModelReply)>,
) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-capability-'));
  const session = await EventSession.open(userDataDir, 'scenario');
  const registry = new ToolRegistry();
  let step = 0;
  registry.register({
    name: 'Probe',
    description: 'test probe',
    input_schema: {type: 'object', properties: {mode: {type: 'string'}}, required: []},
    effect: 'read',
    execute: () => ({ok: true, step: ++step, data: `probe-${step}`}),
  });
  registry.register({
    name: 'ProbeWrite',
    description: 'test write',
    input_schema: {type: 'object', properties: {target: {type: 'string'}}, required: ['target']},
    effect: 'reversible_write',
    execute: args_ => ({written: str(args_.target)}),
  });
  registry.register({
    name: 'ProbeBig',
    description: 'huge output',
    input_schema: {type: 'object', properties: {}, required: []},
    effect: 'read',
    execute: () => ({blob: 'x'.repeat(60000), step: ++step}),
  });
  registry.register({
    name: 'ProbeEcho',
    description: 'constant output',
    input_schema: {type: 'object', properties: {}, required: []},
    effect: 'read',
    execute: () => ({same: 'always'}),
  });
  registry.register({
    name: 'ProbeIrreversible',
    description: 'irreversible local action',
    input_schema: {type: 'object', properties: {target: {type: 'string'}}, required: ['target']},
    effect: 'local_irreversible',
    execute: args_ => ({done: str(args_.target)}),
  });
  registerAgentTools(registry, session);
  const model = new ScriptedModel(replies);
  return {userDataDir, session, registry, model};
}

test('long multi-turn task completes with a succeeded receipt', async () => {
  const rounds = 30;
  const replies = Array.from({length: rounds}, () => ({
    text: '',
    tool_calls: [call('Probe', {mode: 'tick'})],
  }));
  replies.push(text('交付：30 步探测全部完成。'));
  const {userDataDir, session, registry, model} = await harness(replies);
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '连续探测 30 次然后汇报。',
    timeoutMs: 10000,
  });
  assert.equal(result.reason, 'completed');
  assert.equal(result.results.length, rounds);
  assert.equal(result.receipt.status, 'succeeded');
  assert.equal(result.receipt.verificationMethod, 'response_completed');
  assert.ok(result.timingMs > 0);
});

test('irreversible write in default mode asks once, grant unlocks the rerun', async () => {
  const first = await harness([
    {text: '', tool_calls: [call('ProbeIrreversible', {target: 'purge-cache'})]},
  ]);
  const asked = await runAgent({
    workMode: 'code',
    root: first.userDataDir,
    userDataDir: first.userDataDir,
    session: first.session,
    registry: first.registry,
    model: first.model.run,
    instruction: '清理缓存。',
    timeoutMs: 10000,
  });
  assert.equal(asked.reason, 'awaiting_user');
  assert.equal(asked.pending_input?.kind, 'permission');
  assert.equal(
    (asked.pending_input?.action as {tool: string}).tool,
    'ProbeIrreversible',
  );
  await first.session.answer(
    str(asked.pending_input?.requestId),
    {decision: 'grant'},
  );
  const secondModel = new ScriptedModel([
    {text: '', tool_calls: [call('ProbeIrreversible', {target: 'purge-cache'})]},
    text('已清理并核对。'),
  ]);
  const rerun = await runAgent({
    workMode: 'code',
    root: first.userDataDir,
    userDataDir: first.userDataDir,
    session: first.session,
    registry: first.registry,
    model: secondModel.run,
    instruction: '',
    timeoutMs: 10000,
  });
  assert.equal(rerun.reason, 'completed');
  const acted = rerun.results.find(
    result => result.tool_name === 'ProbeIrreversible',
  );
  assert.ok(acted, 'granted irreversible action executed on the resumed run');
  assert.equal(acted?.is_error, false);
});

test('plan mode denies writes outright without asking the user', async () => {
  const {userDataDir, session, registry, model} = await harness([
    {text: '', tool_calls: [call('ProbeWrite', {target: 'plan-out.md'})]},
    text('研究完成，方案如下。'),
  ]);
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '先规划。',
    permissionMode: 'plan',
    timeoutMs: 10000,
  });
  assert.equal(result.reason, 'completed');
  const blocked_ = result.results[0];
  assert.equal(blocked_.is_error, true);
  assert.equal(blocked_.failure_type, 'permission_denied');
  assert.equal(result.pending_input, null);
});

test('abort mid-run records user_interrupt and resume injects saved state', async () => {
  const controller = new AbortController();
  const {userDataDir, session, registry, model} = await harness([
    {text: '', tool_calls: [call('Probe', {mode: 'one'})]},
    {
      text: '',
      tool_calls: [
        call('Probe', {mode: 'two'}),
        call('Probe', {mode: 'abort-here'}),
      ],
    },
  ]);
  const original = registry.get('Probe');
  registry.unregister('Probe');
  registry.register({
    ...original,
    execute: (args_: Record<string, unknown>, _context: ToolContext) => {
      if (args_.mode === 'abort-here') {
        controller.abort(new DOMException('User interrupted', 'AbortError'));
      }
      return {ok: true, mode: str(args_.mode)};
    },
  });
  const stopped = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '会被中断的任务。',
    signal: controller.signal,
    timeoutMs: 10000,
  });
  assert.equal(stopped.reason, 'user_interrupt');
  assert.equal(stopped.receipt.status, 'interrupted');
  const resumeModel = new ScriptedModel([text('恢复后完成了。')]);
  const resumed = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: resumeModel.run,
    instruction: '',
    timeoutMs: 10000,
  });
  assert.equal(resumed.reason, 'completed');
  const resumeEvidence = resumed.results.length;
  const injected = session.events.some(
    event =>
      event.type === 'user/message' &&
      str(
        (event.data.message as {content?: string})?.content,
      ).includes('Saved unfinished task state'),
  );
  assert.ok(injected, 'resume run injects the saved unfinished state');
  assert.ok(resumeEvidence >= 0);
});

test('context pressure triggers compaction and the task still completes', async () => {
  const rounds = 18;
  const replies = Array.from({length: rounds}, () => ({
    text: '',
    tool_calls: [call('ProbeBig')],
  }));
  replies.push(text('大输出任务完成。'));
  const {userDataDir, session, registry, model} = await harness(replies);
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '连续读取大输出。',
    contextTokens: 6000,
    timeoutMs: 10000,
  });
  assert.equal(result.reason, 'completed');
  assert.ok(
    session.events.some(
      event =>
        event.type === 'surface/replace' &&
        event.data.reason === 'compaction',
    ),
    'compaction replaced the message history at least once',
  );
});

test('identical repeated calls trip the stall detector', async () => {
  const replies = Array.from({length: 6}, () => ({
    text: '',
    tool_calls: [call('ProbeEcho')],
  }));
  replies.push(text('应该到不了这里。'));
  const {userDataDir, session, registry, model} = await harness(replies);
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '重复探测。',
    timeoutMs: 10000,
  });
  assert.equal(result.reason, 'stalled');
  assert.match(result.message, /no new progress/i);
});

test('emergency fuse ends the run as resumable, not as a crash', async () => {
  const forever = () => ({
    text: '',
    tool_calls: [call('Probe', {mode: `tick-${Math.random()}`})],
  });
  const {userDataDir, session, registry, model} = await harness([
    forever,
    forever,
    forever,
    forever,
    forever,
  ]);
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '永不停止的任务。',
    emergencyFuse: 4,
    timeoutMs: 10000,
  });
  assert.ok(result.turns > 4, `turns=${result.turns} exceeds the fuse`);
  assert.match(result.message, /fuse/i);
  assert.notEqual(result.receipt.status, 'succeeded');
});

test('four empty model replies surface as provider_unavailable, not silence', async () => {
  const {userDataDir, session, registry, model} = await harness([
    text(''),
    text(''),
    text(''),
    text(''),
  ]);
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '测试空回复。',
    timeoutMs: 10000,
  });
  assert.equal(result.reason, 'provider_unavailable');
  assert.equal(result.message, 'backend_error:empty_response');
});

test('mid-run steering lands in the next model request', async () => {
  const {userDataDir, session, registry, model} = await harness([
    {
      text: '',
      tool_calls: [call('Probe', {mode: 'before-steer'})],
    },
    (request: ModelRequest) => {
      const steered = request.messages.some(
        message =>
          message.role === 'user' &&
          !message.injected &&
          str(message.content).includes('改用汇总模式'),
      );
      return steered
        ? text('已按新指令汇总完成。')
        : {text: '', tool_calls: [call('Probe', {mode: 'after-steer'})]};
    },
  ]);
  const original = registry.get('Probe');
  registry.unregister('Probe');
  registry.register({
    ...original,
    execute: async args_ => {
      if (args_.mode === 'before-steer') {
        await session.enqueue('改用汇总模式', 'next-step');
      }
      return {ok: true, mode: str(args_.mode)};
    },
  });
  const result = await runAgent({
    workMode: 'code',
    root: userDataDir,
    userDataDir,
    session,
    registry,
    model: model.run,
    instruction: '先探测，中途会收到新指令。',
    timeoutMs: 10000,
  });
  assert.equal(result.reason, 'completed');
  assert.equal(result.message, '已按新指令汇总完成。');
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {
  createOutputThrottle,
  registerCodingTools,
} from '../electron/runtime/agent_files';
import {ToolRegistry, scheduleToolCalls} from '../electron/runtime/tools';

const schema = {type: 'object', properties: {}, required: []};

test('a foreground Bash run with timeout_s=1 is killed quickly and returns structured output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-bash-timeout-'));
  const session = await EventSession.open(root, 'bash-timeout');
  const registry = new ToolRegistry();
  registerCodingTools(registry, root, session);
  const started = Date.now();
  const result = await registry.execute({
    id: 'slow-ping',
    name: 'Bash',
    arguments: {command: 'ping -n 10 127.0.0.1', timeout_s: 1},
  });
  const elapsed = Date.now() - started;
  assert.equal(result.is_error, true);
  assert.ok(elapsed < 8000, `expected a fast kill, took ${elapsed}ms`);
  const value = JSON.parse(String(result.value)) as {
    exit: unknown;
    stdout: string;
    stderr: string;
  };
  assert.ok('exit' in value && 'stdout' in value && 'stderr' in value);
  assert.notEqual(value.exit ?? null, 0);
});

test('the output throttle delivers fragments by size, interval and final flush', async () => {
  const received: string[] = [];
  const throttle = createOutputThrottle(chunk => received.push(chunk), 25, 16);
  throttle.push('first line\n');
  throttle.push('0123456789abcdef');
  assert.deepEqual(received, ['first line\n0123456789abcdef']);
  throttle.push('tail\n');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(received.slice(1), ['tail\n']);
  throttle.push('never lost');
  throttle.flush();
  assert.equal(received.at(-1), 'never lost');
});

test('a foreground Bash run streams multi-line output fragments through on_progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-bash-progress-'));
  const session = await EventSession.open(root, 'bash-progress');
  const registry = new ToolRegistry();
  registerCodingTools(registry, root, session);
  const fragments: string[] = [];
  const result = await registry.execute(
    {
      id: 'multi-line',
      name: 'Bash',
      arguments: {command: 'ping -n 4 127.0.0.1'},
    },
    {on_progress: text => fragments.push(text)},
  );
  assert.equal(result.is_error, false, result.error_message);
  assert.ok(
    fragments.length >= 2,
    `expected >=2 fragments, got ${fragments.length}`,
  );
  const lines = fragments.join('').split(/\r?\n/).filter(Boolean);
  assert.ok(
    lines.length >= 4,
    `expected multi-line output, got ${lines.length}`,
  );
});

test('scheduleToolCalls dispatches on_progress to the emitting call', async () => {
  const registry = new ToolRegistry();
  const register = (name: string, mark: string) =>
    registry.register({
      name,
      description: `${name} fixture`,
      input_schema: schema,
      execute: (args, context) => {
        void args;
        context.on_progress?.(`${mark}-first`);
        context.on_progress?.(`${mark}-second`);
        return name;
      },
    });
  register('EmitA', 'A');
  register('EmitB', 'B');
  const seen: Array<{id: string; text: string}> = [];
  let committed = 0;
  for await (const event of scheduleToolCalls(
    [
      {id: 'call-a', name: 'EmitA', arguments: {}},
      {id: 'call-b', name: 'EmitB', arguments: {}},
    ],
    registry,
    {on_progress: (call, text) => seen.push({id: call.id, text})},
  )) {
    if (event.type === 'committed') {
      committed++;
    }
  }
  assert.deepEqual(seen, [
    {id: 'call-a', text: 'A-first'},
    {id: 'call-a', text: 'A-second'},
    {id: 'call-b', text: 'B-first'},
    {id: 'call-b', text: 'B-second'},
  ]);
  assert.equal(committed, 2);
});

test('the Bash description steers search, probing timeouts, background runs and interactivity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-bash-desc-'));
  const session = await EventSession.open(root, 'bash-desc');
  const registry = new ToolRegistry();
  registerCodingTools(registry, root, session);
  const description = registry.get('Bash').description;
  assert.match(description, /Grep/);
  assert.match(description, /Glob/);
  assert.match(description, /timeout_s/);
  assert.match(description, /background/);
  assert.match(description, /interactive/i);
});

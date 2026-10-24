import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {decidePermission, permissionFor} from '../electron/runtime/agent';
import type {AgentOptions} from '../electron/runtime/agent';
import {ToolRegistry} from '../electron/runtime/tools';

test('answering a permission request with modeRaise lifts the session mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-perm-raise-'));
  const session = await EventSession.open(dir, 'perm-raise');
  await session.append('permission/requested', {
    requestId: 'req-1',
    pendingInput: {
      kind: 'permission',
      tool: 'Bash',
      question: '允许执行 Bash？',
      options: ['允许这一次', '允许并本会话切到自动模式', '拒绝'],
      modeRaise: 'auto',
      requestId: 'req-1',
      awaitingUserInput: true,
    },
  });
  await session.answer('req-1', {decision: 'once', modeRaise: 'auto'});
  assert.equal(session.permissionMode('default'), 'accept_reversible');
  const answered = session.events.find(
    event => event.type === 'user_input/answered',
  )!;
  assert.equal(asRecord(asRecord(answered.data.response)).decision, 'once');
  const modeEvent = [...session.events]
    .reverse()
    .find(event => event.type === 'permission/mode')!;
  assert.equal(modeEvent.data.requested, 'accept_reversible');
});

test('modeRaise is only valid as auto on a non-deny answer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-perm-raise2-'));
  const session = await EventSession.open(dir, 'perm-raise2');
  await session.append('permission/requested', {
    requestId: 'req-2',
    pendingInput: {
      kind: 'permission',
      tool: 'Bash',
      question: 'q',
      requestId: 'req-2',
      awaitingUserInput: true,
    },
  });
  await assert.rejects(
    session.answer('req-2', {decision: 'once', modeRaise: 'bypass'}),
    /mode_raise/,
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

const EFFECTS = [
  'read',
  'reversible_write',
  'local_irreversible',
  'external_send',
  'destructive',
  'purchase',
] as const;

const call = (name: string, effect: string) => ({
  id: `c-${name}-${effect}`,
  name,
  arguments: {},
  effect,
});

async function options(): Promise<AgentOptions> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-perm-ladder-'));
  const session = await EventSession.open(dir, 'perm-ladder');
  const registry = new ToolRegistry();
  const schema = {type: 'object', properties: {}, required: []};
  registry.register({
    name: 'Bash',
    description: 'shell',
    input_schema: schema,
    effect: 'local_irreversible',
    execute: async () => ({}),
  });
  registry.register({
    name: 'Send',
    description: 'send',
    input_schema: schema,
    effect: 'external_send',
    execute: async () => ({}),
  });
  registry.register({
    name: 'Purge',
    description: 'purge',
    input_schema: schema,
    effect: 'destructive',
    execute: async () => ({}),
  });
  return {
    root: dir,
    userDataDir: dir,
    session,
    registry,
    permissionMode: 'accept_reversible',
    model: async () => ({text: '', tool_calls: []}),
  } as unknown as AgentOptions;
}

async function optionsWithMode(mode: string): Promise<AgentOptions> {
  const base = await options();
  return {...base, permissionMode: mode} as unknown as AgentOptions;
}

test('the mode ladder widens monotonically: safe < default < auto < bypass', () => {
  const allows = (mode: string) =>
    new Set(
      EFFECTS.filter(effect => decidePermission(mode, effect) === 'allow'),
    );
  const safe = allows('safe');
  const def = allows('default');
  const auto = allows('accept_reversible');
  const bypass = allows('bypass');
  for (const effect of safe) {
    assert.ok(def.has(effect), `default must not narrow safe (${effect})`);
  }
  for (const effect of def) {
    assert.ok(auto.has(effect), `auto must not narrow default (${effect})`);
  }
  for (const effect of auto) {
    assert.ok(bypass.has(effect), `bypass must not narrow auto (${effect})`);
  }
});

test('auto mode allows local actions without a reviewer round-trip', () => {
  assert.equal(decidePermission('accept_reversible', 'local_irreversible'), 'allow');
  assert.equal(decidePermission('accept_reversible', 'reversible_write'), 'allow');
  assert.equal(decidePermission('accept_reversible', 'read'), 'allow');
});

test('auto mode still asks the user about external, destructive and purchase effects', () => {
  assert.equal(decidePermission('accept_reversible', 'external_send'), 'ask');
  assert.equal(decidePermission('accept_reversible', 'destructive'), 'ask');
  assert.equal(decidePermission('accept_reversible', 'purchase'), 'ask');
  assert.equal(decidePermission('bypass', 'external_send'), 'allow');
  assert.equal(decidePermission('bypass', 'destructive'), 'allow');
  assert.equal(decidePermission('bypass', 'purchase'), 'ask');
});

test('plan mode stays read-only and safe mode asks for every write', () => {
  assert.equal(decidePermission('plan', 'read'), 'allow');
  for (const effect of EFFECTS.filter(item => item !== 'read')) {
    assert.equal(decidePermission('plan', effect), 'deny');
    assert.equal(decidePermission('safe', effect), 'ask');
  }
});

test('default mode still asks before local irreversible actions', () => {
  assert.equal(decidePermission('default', 'reversible_write'), 'allow');
  assert.equal(decidePermission('default', 'local_irreversible'), 'ask');
});

test('the auto reviewer is reserved for external and destructive asks', async () => {
  const opts = await options();
  assert.equal(
    permissionFor(opts, call('Bash', 'local_irreversible'), new Set()),
    'allow',
    'a local command in auto mode must not spawn a permission review',
  );
  assert.equal(
    permissionFor(opts, call('Send', 'external_send'), new Set()),
    'review',
    'an external send in auto mode goes through the model reviewer',
  );
  assert.equal(
    permissionFor(opts, call('Purge', 'destructive'), new Set()),
    'review',
  );
  const defaults = await optionsWithMode('default');
  assert.equal(
    permissionFor(defaults, call('Bash', 'local_irreversible'), new Set()),
    'ask',
    'default mode still asks the user directly',
  );
});

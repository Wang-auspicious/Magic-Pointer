import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopActionSession, type DesktopElement, type DesktopSnapshot, type DesktopWindow } from '../electron/runtime/desktop';

const window: DesktopWindow = { hwnd: 42, pid: 7, title: 'Fixture', bbox: [0, 0, 400, 300] };
const element = (index: number, name: string): DesktopElement => ({
  index, hwnd: 42, name, role: 'text', rect: [10, index * 20, 100, index * 20 + 16], runtime_id: [index], patterns: [],
});
const snapshot = (id: string, elements: DesktopElement[]): DesktopSnapshot => ({
  snapshot_id: id, state_id: id, window, windows: [window], elements, root_ref: '@r1', mode: 'ax',
});

test('act_ui keeps each action verification separate from a final condition on one target', async () => {
  const desktop = new DesktopActionSession('batch-evidence');
  const before = snapshot('before', [element(1, 'Field A'), element(2, 'Field B')]);
  const afterA = snapshot('after-a', before.elements);
  const afterB = snapshot('after-b', [...before.elements, element(3, 'B done')]);
  let reads = 0;
  const original = DesktopActionSession.prototype.call;
  Object.assign(desktop, {
    requireSnapshot: async () => before,
    observe: async () => [afterA, afterB][reads++],
    call: async function (name: string, args: Record<string, unknown>) {
      if (name === 'act_ui') return original.call(this, name, args);
      return { ok: true, verification: { matched: args.ref === '@e2', status: 'checked' } };
    },
  });
  const result = await desktop.call('act_ui', { state_id: 'before', actions: [
    { action: 'type_text', ref: '@e1', text: 'A' },
    { action: 'type_text', ref: '@e2', text: 'B' },
  ], expect: { text: 'B done' }, verify_action_index: 1 });
  assert.equal(result.actions.length, 2);
  assert.equal(result.verification.matched, false, 'the final condition cannot verify the entire batch');
  assert.deepEqual(result.actionResults.map((item: { verification: { matched: boolean } }) => item.verification.matched), [false, true]);
  assert.equal(result.actionResults[0].postcondition, undefined);
  assert.equal(result.actionResults[1].postcondition.matched, true);
  assert.equal(result.actionResults[0].actionTarget.stateId, 'before');
  assert.equal(result.actionResults[1].actionTarget.stateId, 'after-a');
});

test('act_ui never treats verified input as proof of nested submit delivery', async () => {
  const desktop = new DesktopActionSession('submit-evidence');
  const before = snapshot('before', [element(1, 'Send field')]);
  const after = snapshot('after', [element(1, 'Sent label')]);
  const original = DesktopActionSession.prototype.call;
  Object.assign(desktop, {
    requireSnapshot: async () => before,
    observe: async () => after,
    call: async function (name: string, args: Record<string, unknown>) {
      if (name === 'act_ui') return original.call(this, name, args);
      return { ok: true, submitted: true, verification: { matched: true, status: 'matched' } };
    },
  });
  const result = await desktop.call('act_ui', { state_id: 'before', actions: [
    { action: 'type_text', ref: '@e1', text: 'message', submit: true },
  ], expect: { text: 'Sent label' } });
  assert.equal(result.actionResults[0].inputVerified, true);
  assert.equal(result.actionResults[0].effect, 'external_send');
  assert.equal(result.actionResults[0].verification.matched, false);
  assert.equal(result.actionResults[0].verification.scope, 'input_only_not_delivery');
  assert.equal(result.verification.matched, false);
});

test('wait_for emits postcondition verification only for an explicit call and newly met condition', async () => {
  const before = snapshot('before', [element(1, 'Open')]);
  const after = snapshot('after', [...before.elements, element(2, 'Done')]);
  const make = (prior: DesktopSnapshot) => {
    const desktop = new DesktopActionSession('wait-evidence');
    Object.assign(desktop, { requireSnapshot: async () => prior, observe: async () => after });
    return desktop;
  };
  const verified = await make(before).call('wait_for', { state_id: 'before', text: 'Done', verify_call_id: 'click-1', timeout_ms: 20 });
  assert.equal(verified.matched, true);
  assert.deepEqual({ matched: verified.verification.matched, forCallId: verified.verification.forCallId,
    windowHwnd: verified.verification.windowHwnd, stateId: verified.verification.stateId,
    scope: verified.verification.scope },
  { matched: true, forCallId: 'click-1', windowHwnd: 42, stateId: 'before', scope: 'ui_postcondition' });
  const unbound = await make(before).call('wait_for', { state_id: 'before', text: 'Done', timeout_ms: 20 });
  assert.equal(unbound.verification, undefined);
  const preexisting = await make(after).call('wait_for', { state_id: 'after', text: 'Done', verify_call_id: 'click-1', timeout_ms: 20 });
  assert.equal(preexisting.matched, true);
  assert.equal(preexisting.verification.matched, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PersonalActivityNative, type PersonalActivityBatch } from '../electron/personal_activity_native';

const fixture = path.join(__dirname, 'fixtures', 'personal_activity_native_fixture.cjs');

test('native feed waits for readiness, delivers complete aggregate batches, and flushes before stopping', async () => {
  const batches: PersonalActivityBatch[] = [];
  let launches = 0;
  const native = new PersonalActivityNative({
    onBatch: batch => batches.push(batch),
    launch: async () => { launches++; return spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); },
  });
  try {
    await Promise.all([native.start(), native.start()]);
    assert.equal(launches, 1);
    assert.equal(native.status, 'running');
    await native.flush();
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].keyboard, { Enter: 2, KeyA: 1 });
    assert.deepEqual(batches[0].applications, [{ appId: 'notepad.exe', label: 'Notepad', activeMs: 500, activations: 1 }]);
    await native.stop();
    assert.equal(batches.length, 2, 'the final native aggregate is consumed before stop resolves');
    assert.equal(native.status, 'stopped');
  } finally { await native.stop(); }
});

test('native startup reports the actual hook failure and leaves no running process', async () => {
  const errors: string[] = [];
  const native = new PersonalActivityNative({
    onBatch: () => assert.fail('failed hook cannot emit a successful batch'),
    onError: error => errors.push(error.message),
    launch: async () => spawn(process.execPath, [fixture, 'fail'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  });
  try {
    await assert.rejects(native.start(), /keyboard_hook_failed:5/);
    assert.equal(native.status, 'error');
    assert.ok(errors.some(message => message.includes('keyboard_hook_failed:5')));
  } finally { await native.stop(); }
});

test('pausing while the native process is starting settles both lifecycle calls without an orphan', { timeout: 2000 }, async () => {
  const native = new PersonalActivityNative({
    onBatch: () => {},
    launch: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    },
  });
  const started = native.start();
  await native.stop();
  await started;
  assert.equal(native.status, 'stopped');
});

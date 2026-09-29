import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { PersonalActivityNative, type PersonalActivityBatch } from '../electron/personal_activity_native';
import { desktopRuntimeRoot, ensureNativeTool } from '../electron/runtime/desktop';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('real Windows hook sees SendInput press edges, excludes injection from personal keys, attributes foreground, and stops cleanly', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp-activity-native-'));
  const executable = path.join(directory, 'activity-input-fixture.exe');
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  let fixture: ChildProcessWithoutNullStreams | undefined;
  let nativePid = 0;
  const batches: PersonalActivityBatch[] = [], failures: string[] = [];
  const native = new PersonalActivityNative({ batchMs: 500, idleMs: 1000, onBatch: batch => batches.push(batch), onError: error => failures.push(error.message),
    launch: async args => { const child = spawn(await ensureNativeTool('personal_activity_host'), args, { cwd: desktopRuntimeRoot(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); nativePid = child.pid || 0; return child; },
  });
  try {
    await promisify(execFile)(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
      ...['System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${path.join(framework, name)}`),
      path.join(__dirname, 'fixtures', 'personal_activity_input_fixture.cs')], { windowsHide: true });
    fixture = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const messages: Array<Record<string, any>> = [];
    createInterface({ input: fixture.stdout }).on('line', line => messages.push(JSON.parse(line)));
    const waitMessage = async (type: string) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const failed = messages.find(row => row.type === 'error'); if (failed) throw new Error(String(failed.message));
        const index = messages.findIndex(row => row.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(30);
      }
      throw new Error(`fixture_message_timeout:${type}`);
    };
    const ready = await waitMessage('ready');
    assert.equal(ready.visible, true);
    assert.equal(ready.minimized, false);
    await native.start();
    fixture.stdin.write('exercise\n');
    const sent = await waitMessage('sent');
    assert.equal(sent.foreground, ready.hwnd, 'fixture revalidated its foreground HWND immediately before SendInput');
    await native.flush();
    await delay(300);
    fixture.stdin.write('inspect\n');
    const received = await waitMessage('inspect');
    assert.equal((String(received.text).match(/\r\n/g) || []).length, 3, 'the native target received all three Enter keydown messages');
    await native.flush();
    const injected = (key: string) => batches.reduce((total, row) => total + (row.injectedKeyboard[key] || 0), 0);
    assert.equal(injected('Enter'), 2, 'holding Enter emits repeated keydown messages but counts as one press');
    assert.equal(injected('KeyA'), 1);
    assert.equal(batches.reduce((total, row) => total + (row.keyboard.Enter || 0), 0), 0, 'injected Enter presses do not count as personal keys');
    assert.ok(batches.some(row => row.applications.some(app => app.appId.includes('activity-input-fixture') && app.activeMs > 0)));
    assert.ok(batches.every(row => !('events' in row) && !('text' in row.keyboard)), 'native feed contains aggregates, not typed content or key order');
    await delay(1300);
    fixture.stdin.write('inspect\n');
    const idleWitness = await waitMessage('inspect');
    await native.flush();
    if (idleWitness.idleMs > 1200) assert.ok(batches.some(row => row.coverage.idleMs > 0), 'independently observed Windows idle time produces idle coverage');
    const beforeSession = injected('Enter');
    fixture.stdin.write('hold-enter\n'); await waitMessage('sent');
    fixture.stdin.write(`session:${nativePid}:7\n`); await waitMessage('session-posted');
    await delay(300); await native.flush();
    assert.ok(batches.some(row => row.state === 'locked' && row.coverage.lockedMs > 0 && row.foreground === null));
    fixture.stdin.write(`session:${nativePid}:8\n`); await waitMessage('session-posted');
    await delay(100);
    fixture.stdin.write('hold-enter\n'); await waitMessage('sent');
    fixture.stdin.write('release-enter\n'); await waitMessage('sent');
    await delay(150); await native.flush();
    assert.equal(injected('Enter') - beforeSession, 2, 'unlock resets keys whose releases could not be observed on the secure desktop');
    await native.stop();
    const count = batches.length;
    await delay(650);
    assert.equal(batches.length, count, 'stopping removes the native producer');
    assert.equal(native.status, 'stopped');
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ usedBackend: batches[0]?.usedBackend, batches: count, injectedPresses: { Enter: injected('Enter'), KeyA: injected('KeyA') }, deliveredKeydowns: { Enter: received.enterDowns, KeyA: received.aDowns }, foregroundVerified: true, independentlyObservedIdleMs: idleWitness.idleMs, idleVerified: idleWitness.idleMs > 1200, sessionNotificationsSimulated: true, actualOsLockTested: false, stopped: true }));
  } finally {
    await native.stop();
    if (fixture && fixture.exitCode === null) { const exited = new Promise(resolve => fixture!.once('close', resolve)); fixture.stdin.end('release-enter\nstop\n'); const timer = setTimeout(() => fixture!.kill(), 2000); await exited; clearTimeout(timer); }
    await rm(directory, { recursive: true, force: true });
  }
});

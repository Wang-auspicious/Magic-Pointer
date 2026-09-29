import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { PersonalActivityService } from '../electron/personal_activity_service';
import { PersonalActivityNative } from '../electron/personal_activity_native';
import { closeDesktop, nativeRequest, type DesktopWindow } from '../electron/runtime/desktop';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('personal service persists actual native application activity and a readable capture of its owned temporary window', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-personal-service-'));
  const watched = path.join(root, 'watched'); await mkdir(watched);
  const executable = path.join(root, 'activity-input-fixture.exe');
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const failures: string[] = [], reports: string[] = [];
  let hwnd = 0, fixture: ChildProcessWithoutNullStreams | undefined, native: PersonalActivityNative | undefined;
  let excludedForegroundBatches = 0;
  const service = new PersonalActivityService(path.join(root, 'activity'), { onError: error => failures.push(String(error)),
    onReport: report => reports.push(report.date),
    createNative: callbacks => {
      native = new PersonalActivityNative({ ...callbacks, batchMs: 500,
        onBatch: batch => {
          if (batch.foreground?.hwnd === hwnd) callbacks.onBatch(batch);
          else excludedForegroundBatches++;
        },
      });
      return native;
    },
  });
  try {
    await nativeRequest('ping');
    await promisify(execFile)(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
      ...['System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${path.join(framework, name)}`),
      path.join(__dirname, 'fixtures', 'personal_activity_input_fixture.cs')], { windowsHide: true });
    fixture = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const messages: Array<Record<string, any>> = [];
    createInterface({ input: fixture.stdout }).on('line', line => messages.push(JSON.parse(line)));
    const waitMessage = async (type: string) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const error = messages.find(row => row.type === 'error'); if (error) throw new Error(String(error.message));
        const index = messages.findIndex(row => row.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(25);
      }
      throw new Error(`fixture_timeout:${type}`);
    };
    const ready = await waitMessage('ready'); hwnd = Number(ready.hwnd);
    assert.equal(ready.visible, true, 'the native target must actually be visible before testing capture');
    assert.equal(ready.minimized, false);
    const nativeWindow = await nativeRequest<DesktopWindow>('window', { hwnd });
    assert.equal(nativeWindow.pid, ready.pid);
    assert.deepEqual(nativeWindow.bbox, [ready.left, ready.top, ready.left + ready.width, ready.top + ready.height]);
    await service.start();
    await service.configure({ enabled: true, screenEnabled: true, paused: false, roots: [watched] });
    fixture.stdin.write('exercise\n');
    assert.equal((await waitMessage('sent')).foreground, hwnd);
    await native!.flush();
    const deadline = Date.now() + 35000;
    let snapshot = await service.snapshot();
    while (!snapshot.day?.screens.length && Date.now() < deadline && failures.length === 0) {
      await delay(150);
      snapshot = await service.snapshot();
    }
    assert.deepEqual(failures, []);
    assert.ok(snapshot.day?.screens.length, `no real screen sample: ${JSON.stringify({ excludedForegroundBatches, native: snapshot.nativeStatus, nativeError: snapshot.nativeError, screenError: snapshot.screenError })}`);
    const screen = snapshot.day.screens[0];
    assert.deepEqual([screen.width, screen.height], [ready.width, ready.height]);
    assert.match(screen.text, /ACTIVITY\s+SCREEN\s+WITNESS\s+7392/i);
    assert.match(screen.usedBackend, /gdi|window|capture/i);
    assert.match(screen.usedBackend, /ocr/i);
    assert.ok((await stat(screen.path)).size > 1000);
    assert.ok(snapshot.day.applications.some(app => app.appId.includes('activity-input-fixture') && app.activeMs > 0));
    await writeFile(path.join(watched, 'acceptance-note.txt'), 'Real filesystem activity for the owned personal-activity acceptance.\n');
    await delay(1000);
    await service.configure({ paused: true });
    assert.equal(native?.status, 'stopped');
    snapshot = await service.snapshot();
    const report = await service.generateReport();
    await service.stop();
    closeDesktop();
    const evidence = { root, fixture: ready, nativeWindow, imageDimensions: [screen.width, screen.height], screenPath: screen.path, screenText: screen.text, screenBackend: screen.usedBackend,
      nativeBackend: snapshot.day?.usedBackends, activeApplications: snapshot.day?.applications, excludedForegroundBatches,
      fileChanges: snapshot.day?.files, reportPath: path.join(root, 'activity', 'reports', `${report.date}.md`), reports, failures, nativeStopped: native?.status === 'stopped' };
    await writeFile(path.join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    await service.stop(); closeDesktop();
    if (fixture && fixture.exitCode === null) { const exited = new Promise(resolve => fixture!.once('close', resolve)); fixture.stdin.end('stop\n'); const timer = setTimeout(() => fixture!.kill(), 2000); await exited; clearTimeout(timer); }
  }
});

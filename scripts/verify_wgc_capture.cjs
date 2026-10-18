// Explicit native acceptance: creates only its own window, never sends OS input.
const {app, BrowserWindow, screen} = require('electron');
require('tsx/cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/wgc-native-acceptance');
const {WgcCaptureSession} = require('../electron/runtime/wgc_capture.ts');
const desktop = require('../electron/runtime/desktop.ts');
const {
  FrameCaptureWorkerClient,
} = require('../electron/frame_capture_worker_client.ts');
const {
  CaptureCommitCoordinator,
} = require('../electron/capture_commit_coordinator.ts');
app.setPath('userData', path.join(out, 'electron-profile'));
app.on('window-all-closed', () => {});
process.env.MAGIC_POINTER_USER_DATA_DIR = path.join(out, 'runtime-profile');
desktop.configureDesktop(root);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const report = {
  checks,
  modelCalls: 0,
  physicalMouseGesture: false,
  installedApp: false,
};
async function pixels(png) {
  return sharp(png).removeAlpha().raw().toBuffer({resolveWithObject: true});
}
function countColor({data, info}, color) {
  let count = 0;
  for (let p = 0; p < data.length; p += info.channels) {
    if (
      color.every((value, channel) => Math.abs(data[p + channel] - value) < 8)
    )
      count++;
  }
  return count;
}
function nativeHandle(win) {
  const buffer = win.getNativeWindowHandle();
  return Number(
    buffer.length === 8 ? buffer.readBigUInt64LE() : buffer.readUInt32LE(),
  );
}
app.whenReady().then(async () => {
  await fs.mkdir(out, {recursive: true});
  const target = new BrowserWindow({
    width: 600,
    height: 340,
    x: 80,
    y: 80,
    show: false,
    frame: false,
    webPreferences: {sandbox: true, contextIsolation: true},
  });
  const capture = new WgcCaptureSession();
  let worker;
  const deadline = setTimeout(() => {
    report.error = 'native_acceptance_timeout';
    app.exit(2);
  }, 60000);
  try {
    await target.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<html><body style="margin:0;background:rgb(21,147,72);height:100vh;display:grid;place-items:center;color:white;font:36px system-ui">WGC WITNESS 7392</body></html>',
        ),
    );
    target.setAlwaysOnTop(true, 'screen-saver');
    target.show();
    target.focus();
    await pause(350);
    console.log('wgc acceptance: target ready');
    const hwnd = nativeHandle(target);
    const window = await desktop.nativeRequest('window', {hwnd});
    report.window = {
      hwnd,
      pid: window.pid,
      bbox: window.bbox,
      focused: target.isFocused(),
    };

    await capture.arm({epochId: 'window-resize', target: 'window', hwnd});
    console.log('wgc acceptance: native window armed');
    await pause(180);
    target.setSize(660, 380);
    await pause(200);
    const resized = await capture.commit('window-resize');
    console.log('wgc acceptance: resized frame committed');
    assert.equal(resized.source, 'wgc-window');
    assert.ok(
      resized.resizeCount > 0,
      'native pool must recreate after the real window changes size',
    );
    assert.ok(
      countColor(
        await pixels(Buffer.from(resized.png, 'base64')),
        [21, 147, 72],
      ) > 10000,
    );
    await fs.writeFile(
      path.join(out, 'window-resized.png'),
      Buffer.from(resized.png, 'base64'),
    );
    checks.push('real window GPU capture and resize');
    report.resize = {...resized, png: undefined};

    const display = screen.getDisplayMatching(target.getBounds());
    const origin = screen.dipToScreenPoint({
      x: display.bounds.x,
      y: display.bounds.y,
    });
    const bounds = [
      origin.x,
      origin.y,
      origin.x + Math.round(display.bounds.width * display.scaleFactor),
      origin.y + Math.round(display.bounds.height * display.scaleFactor),
    ];
    await capture.arm({epochId: 'display-visible', surfaceBoundsPx: bounds});
    await pause(220);
    const visible = await capture.commit('display-visible');
    assert.equal(visible.source, 'wgc-display');
    const greenVisible = countColor(
      await pixels(Buffer.from(visible.png, 'base64')),
      [21, 147, 72],
    );
    assert.ok(
      greenVisible > 10000,
      'own witness must actually appear in the display pixels',
    );
    target.setContentProtection(true);
    await capture.arm({epochId: 'display-excluded', surfaceBoundsPx: bounds});
    await pause(220);
    const excluded = await capture.commit('display-excluded');
    const greenExcluded = countColor(
      await pixels(Buffer.from(excluded.png, 'base64')),
      [21, 147, 72],
    );
    assert.ok(
      greenExcluded < greenVisible / 10,
      'capture protection must exclude our visible overlay from WGC display pixels',
    );
    checks.push('display capture respects actual capture exclusion');
    report.exclusion = {
      greenVisible,
      greenExcluded,
      source: excluded.source,
      displayBounds: bounds,
    };
    target.setContentProtection(false);

    const nodeExecutable = process.env.MP_ACCEPTANCE_NODE;
    assert.ok(
      nodeExecutable,
      'MP_ACCEPTANCE_NODE must name the real Node executable for the production worker',
    );
    worker = new FrameCaptureWorkerClient({
      root,
      requestTimeoutMs: 12000,
      spawnWorker: () =>
        spawn(
          nodeExecutable,
          [
            '--require',
            'tsx/cjs',
            path.join(root, 'electron/runtime/desktop_capture.ts'),
            root,
          ],
          {
            cwd: root,
            windowsHide: true,
            env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      logger: {log() {}},
    });
    await worker.start();
    const timeline = [];
    const coordinator = new CaptureCommitCoordinator({
      provider: worker,
      releaseOverlay: () => {
        timeline.push('release');
        target.hide();
      },
      beginSession: (_gesture, lease) => {
        timeline.push('session');
        assert.equal(lease.source, 'wgc-display');
      },
    });
    const current = await desktop.nativeRequest('window', {hwnd});
    await coordinator.arm({
      epochId: 'production',
      displayId: String(display.id),
      scaleFactor: display.scaleFactor,
      surfaceBoundsPx: bounds,
      targetWindow: {
        hwnd,
        processId: current.pid,
        processName: current.process_name,
        title: current.title,
      },
      overlayExcluded: false,
    });
    await pause(180);
    const committedAt = performance.now();
    const lease = await coordinator.complete({
      schemaVersion: 2,
      coordinateSpace: 'physical_screen_pixels',
      strokes: [],
    });
    const durationMs = performance.now() - committedAt;
    assert.deepEqual(timeline, ['release', 'session']);
    const persisted = await fs.readFile(lease.localArtifact.path);
    assert.ok(
      countColor(await pixels(persisted), [21, 147, 72]) > 10000,
      'committed historical pixels must retain the witness after overlay release hides it',
    );
    assert.equal(lease.source, 'wgc-display');
    checks.push(
      'actual worker → FrameCaptureService → native WGC → validated FrameLease → coordinator release ordering',
    );
    report.production = {lease, durationMs};
    await capture.arm({epochId: 'cancelled', surfaceBoundsPx: bounds});
    await capture.cancel('cancelled');
    await assert.rejects(capture.commit('cancelled'), /epoch_not_armed/);
    const released = await capture.status();
    assert.equal(released.resourcesReleased, true);
    assert.equal(released.pumpRunning, false);
    assert.equal(released.armed, false);
    report.released = released;
    checks.push('cancel releases capture and rejects a later commit');
    target.showInactive();
    const samples = [];
    for (let index = 0; index < 8; index++) {
      const started = performance.now();
      await capture.arm({
        epochId: `benchmark-${index}`,
        surfaceBoundsPx: bounds,
      });
      const armMs = performance.now() - started;
      await pause(120);
      const requested = performance.now();
      const captured = await capture.commit(`benchmark-${index}`);
      samples.push({
        armMs,
        commitMs: performance.now() - requested,
        nativeFreezeMs: captured.nativeFreezeMs,
        frameAgeMs: captured.captureLatencyMs,
        source: captured.source,
        bytes: Buffer.byteLength(captured.png, 'base64'),
      });
    }
    const distribution = key => {
      const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
      return {
        p50: values[Math.ceil(values.length * 0.5) - 1],
        p95: values[Math.ceil(values.length * 0.95) - 1],
        max: values.at(-1),
      };
    };
    report.benchmark = {
      samples,
      successes: samples.length,
      failures: 0,
      armMs: distribution('armMs'),
      commitMs: distribution('commitMs'),
      nativeFreezeMs: distribution('nativeFreezeMs'),
      frameAgeMs: distribution('frameAgeMs'),
      scope:
        '8 repeated arms on the same native process; native freeze excludes Node/IPC/encoding; commit includes IPC/PNG',
    };
    assert.equal((await capture.status()).resourcesReleased, true);
    checks.push(
      'eight native captures with timings and final GPU resource release',
    );
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error.stack || error);
    console.error(report.error);
  } finally {
    clearTimeout(deadline);
    capture.close();
    if (worker) await worker.shutdown();
    desktop.closeDesktop();
    target.destroy();
    await fs.writeFile(
      path.join(out, 'result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ok: report.ok, checks, evidence: out}));
    app.exit(report.ok ? 0 : 1);
  }
});

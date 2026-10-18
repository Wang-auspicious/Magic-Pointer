// Main-process/native acceptance; gesture coordinates are submitted programmatically.
const {app, BrowserWindow, screen} = require('electron');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const hungPlugin = process.argv.includes('--hung-plugin');
const out = path.join(
  root,
  hungPlugin
    ? 'data/runtime/wgc-main-hung-plugin'
    : 'data/runtime/wgc-main-acceptance',
);
fs.mkdirSync(out, {recursive: true});
process.env.MAGIC_POINTER_USER_DATA_DIR = path.join(
  out,
  `profile-${process.pid}`,
);
app.setPath('userData', process.env.MAGIC_POINTER_USER_DATA_DIR);
if (hungPlugin) {
  const directory = path.join(
    process.env.MAGIC_POINTER_USER_DATA_DIR,
    'data/plugins/hung-capture-witness',
  );
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(
    path.join(directory, 'plugin.json'),
    JSON.stringify({main: 'plugin.cjs'}),
  );
  fs.writeFileSync(
    path.join(directory, 'plugin.cjs'),
    `module.exports={name:'hung-capture-witness',scopes:['surface'],inject:['surface_adapters'],apply(ctx){ctx.get('surface_adapters').register({id:'hung-capture-witness',matches:()=>true,resolve:()=>new Promise(()=>{})});}};`,
  );
}
app.on('window-all-closed', () => {});
const originalWhenReady = app.whenReady.bind(app);
app.whenReady = () => ({then() {}});
const mainPath = path.join(root, 'build/electron/main.js');
const mainModule = new Module(mainPath, module);
mainModule.filename = mainPath;
mainModule.paths = Module._nodeModulePaths(path.dirname(mainPath));
mainModule._compile(
  fs.readFileSync(mainPath, 'utf8') +
    `
module.exports.captureAcceptance = {
  setup(target) {
    fabricSettings = defaultSettings();
    fabricSettings.activation.gesture_interaction_mode = 'exclusive_overlay';
    fabricSettings.privacy.upload_screenshots = false;
    pointerInputState = {...pointerInputState,foregroundApp:target.process_name,
      foregroundHwnd:target.hwnd,foregroundProcessId:target.pid};
    onboardingRequired = false;
  },
  arm: armSelectionGesture,
  complete: completeSelectionGesture,
  getState() { return {arm:selectionGestureArm,activity:desktopPerceptionActivity,
    activeChildren:activeSessionChildren.size,
    entry:activeSelectionSessionToken ? selectionSessions.get(activeSelectionSessionToken) : null,
    overlayReady:overlayReadiness.isReady,stageReady:stageReadiness.isReady}; },
  async stop() {
    isQuitting = true;
    cancelSelectionGesture('acceptance_finished');
    stopMouseShakePolling();
    for (const child of activeSessionChildren.values()) child?.kill?.();
    await frameCaptureWorkerClient?.shutdown();
    overlayWindow?.destroy(); stageWindow?.destroy();
  }
};`,
  mainPath,
);
app.whenReady = originalWhenReady;
const main = mainModule.exports.captureAcceptance;
const desktop = require('../build/electron/runtime/desktop.js');
desktop.configureDesktop(root);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate, timeout = 18000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await pause(40);
  }
  throw new Error(`Timed out: ${label}`);
}
originalWhenReady().then(async () => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const target = new BrowserWindow({
    width: 650,
    height: 360,
    x: display.bounds.x + 100,
    y: display.bounds.y + 100,
    show: false,
    frame: false,
    webPreferences: {sandbox: true, contextIsolation: true},
  });
  const report = {
    modelCalls: 0,
    physicalMouseGesture: false,
    installedApp: false,
    boundary:
      'Actual compiled main arm/complete, real overlay/Stage, native WGC capture worker and selection_snapshot worker; gesture IPC coordinates and source HWND supplied by this self-owned witness',
  };
  const updates = [];
  const started = performance.now();
  const deadline = setTimeout(() => app.exit(2), 30000);
  let sampler;
  try {
    await target.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<html><body style="margin:0;background:#159348;color:white;font:26px system-ui;padding:60px">WGC MAIN WITNESS 7392<br>Revenue 120 Target 210</body></html>',
        ),
    );
    target.setAlwaysOnTop(true, 'screen-saver');
    target.show();
    target.focus();
    await pause(350);
    const handle = target.getNativeWindowHandle();
    const hwnd = Number(
      handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE(),
    );
    const window = await desktop.nativeRequest('window', {hwnd});
    main.setup(window);
    sampler = setInterval(() => {
      const value = main.getState().activity;
      if (JSON.stringify(updates.at(-1)?.value) !== JSON.stringify(value))
        updates.push({
          atMs: performance.now() - started,
          value: structuredClone(value),
        });
    }, 20);
    main.arm('shortcut-wake');
    await wait('first native frame and real overlay/Stage readiness', () => {
      const s = main.getState();
      return s.arm?.captureReady && s.overlayReady && s.stageReady;
    });
    await pause(850);
    const arm = main.getState().arm;
    assert.ok(arm, 'gesture must still be armed');
    const targetBounds = target.getBounds();
    const x = targetBounds.x - arm.displayBounds.x + 55;
    const y = targetBounds.y - arm.displayBounds.y + 88;
    const points = [
      {x, y, t: 0},
      {x: x + 200, y, t: 80},
      {x: x + 470, y, t: 160},
    ];
    assert.equal(
      main.complete({
        selectionGestureToken: arm.token,
        points,
        strokes: [{points}],
      }),
      true,
    );
    await wait('real snapshot and provider result', () => {
      const state = main.getState();
      if (state.activity?.state === 'failed')
        throw Error(JSON.stringify(state.activity));
      return Boolean(state.entry?.snapshot?.frame_lease);
    });
    const state = main.getState();
    const snapshot = state.entry.snapshot;
    assert.equal(snapshot.frame_lease.source, 'wgc-display');
    assert.equal(snapshot.frame_lease.targetWindow.hwnd, hwnd);
    assert.equal(snapshot.frame_lease.overlayExcluded, true);
    const evidence = JSON.stringify({
      content: snapshot.content,
      contexts: snapshot.structured_contexts,
      ocr: snapshot.ocr,
    });
    assert.match(evidence, /7392/);
    assert.equal(
      state.activeChildren,
      0,
      'snapshot worker must have actually exited before successful completion',
    );
    if (hungPlugin) {
      const failed = snapshot.perception_trace.attempts.find(
        item => item.adapter === 'hung-capture-witness',
      );
      assert.equal(
        failed?.status,
        'timeout',
        'uncooperative plugin must time out without erasing the other evidence',
      );
      assert.ok(
        updates.some(update =>
          JSON.stringify(update.value).includes('hung-capture-witness'),
        ),
        'real provider progress must reach main',
      );
      report.hungPlugin = failed;
    }
    report.ok = true;
    report.totalMs = performance.now() - started;
    report.frame = snapshot.frame_lease;
    report.content = snapshot.content;
    report.usedBackend = snapshot.usedBackend;
    report.latencyMs = snapshot.latencyMs;
    report.trace = snapshot.perception_trace;
    report.updates = updates;
    fs.writeFileSync(
      path.join(out, 'snapshot.json'),
      JSON.stringify(snapshot, null, 2),
    );
  } catch (error) {
    report.ok = false;
    report.error = String(error.stack || error);
    console.error(report.error);
  } finally {
    clearInterval(sampler);
    await main.stop();
    desktop.closeDesktop();
    target.destroy();
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        ok: report.ok,
        usedBackend: report.usedBackend,
        evidence: out,
        error: report.error,
      }),
    );
    app.exit(report.ok ? 0 : 1);
  }
});

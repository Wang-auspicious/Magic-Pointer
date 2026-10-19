// Native acceptance restricts input (exclusive mode) to its own witness window.
const {app, BrowserWindow, ipcMain, screen} = require('electron');
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {buildSync, transformSync} = require('esbuild');
const sharp = require('sharp');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const root = path.resolve(__dirname, '..');
const exclusive = process.argv.includes('--exclusive');
const physical = exclusive && process.argv.includes('--physical');
const out = path.join(root, 'data/runtime/gesture-preparation-ui' + (exclusive ? '-exclusive' : ''));
fs.mkdirSync(path.join(out, 'renderer'), {recursive: true});
app.setPath('userData', path.join(out, 'profile'));
const {WgcCaptureSession} = require('../electron/runtime/wgc_capture.ts');
const desktop = require('../electron/runtime/desktop.ts');
desktop.configureDesktop(root);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function readiness() {
  let ready = false;
  let queue = [];
  return {
    reset() { ready = false; },
    whenReady(callback) { if (ready) callback(); else queue.push(callback); },
    markReady() { ready = true; const callbacks = queue; queue = []; callbacks.forEach(fn => fn()); },
  };
}
const checks = [];
const report = {checks, errors: [], physicalInput: physical, installedApp: false};
const check = (condition, description) => { assert.ok(condition, description); checks.push(description); };
const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function extract(name) {
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  return ts.transpileModule(node.getText(source), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const capture = new WgcCaptureSession();
  const timers = new Set();
  const deadline = setTimeout(() => app.exit(2), 60000);
  let context;
  try {
    buildSync({entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(out, 'preload.js'), bundle: true, platform: 'node', external: ['electron'], logLevel: 'silent'});
    for (const name of ['index.html', 'styles.css', 'typography.css']) {
      fs.copyFileSync(path.join(root, 'electron/renderer', name), path.join(out, 'renderer', name));
    }
    fs.copyFileSync(path.join(root, 'build/electron/renderer/sweep_visual.js'), path.join(out, 'renderer/sweep_visual.js'));
    fs.copyFileSync(path.join(root, 'build/electron/gesture_capture.js'), path.join(out, 'gesture_capture.js'));
    fs.writeFileSync(path.join(out, 'renderer/overlay.js'), transformSync(fs.readFileSync(path.join(root, 'electron/renderer/overlay.ts'), 'utf8'), {loader: 'ts', format: 'iife'}).code);
    const target = new BrowserWindow({x: 80, y: 80, width: 640, height: 400, show: false, webPreferences: {sandbox: true}});
    await target.loadURL('data:text/html,' + encodeURIComponent('<body style="background:#e5e8ec;font:24px system-ui;padding:40px">Gesture preparation witness</body>'));
    await target.webContents.executeJavaScript('window.witnessDowns=0;window.addEventListener("pointerdown",()=>window.witnessDowns++)');
    target.show();
    target.focus();
    const display = screen.getDisplayMatching(target.getBounds());
    const scale = display.scaleFactor;
    const origin = screen.dipToScreenPoint({x: display.bounds.x, y: display.bounds.y});
    const bounds = [origin.x, origin.y, origin.x + Math.round(display.bounds.width * scale), origin.y + Math.round(display.bounds.height * scale)];
    const stage = new BrowserWindow({show: false, transparent: true, frame: false, ...display.bounds, webPreferences: {preload: path.join(out, 'preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false}});
    stage.setContentProtection(true);
    stage.setIgnoreMouseEvents(true, {forward: true});
    const stageReady = readiness();
    const overlayReady = readiness();
    ipcMain.on('stage:renderer-ready', () => stageReady.markReady());
    ipcMain.on('overlay:renderer-ready', () => overlayReady.markReady());
    let readySignals = 0;
    let startedSignals = 0;
    let strokeSignals = 0;
    ipcMain.on('overlay:gesture-ready', () => readySignals++);
    ipcMain.on('overlay:gesture-start', () => startedSignals++);
    ipcMain.on('overlay:gesture-stroke', () => strokeSignals++);
    await stage.loadFile(path.join(root, 'build/electron/renderer/stage.html'));
    let releaseCapture;
    const preparationGate = new Promise(resolve => { releaseCapture = resolve; });
    const commands = [];
    const shortcuts = new Map();
    context = {
      BrowserWindow, path, __dirname: out, crypto, Date, CAPSULE_CONTENT_PROTECTED: true,
      screen: {...screen, getCursorScreenPoint: () => ({x: display.bounds.x + 180, y: display.bounds.y + 180}), getDisplayNearestPoint: () => display},
      overlayWindow: null, overlayCaptureExcluded: false, overlayOwnsPointerInput: false,
      overlayReadiness: overlayReady, stageReadiness: stageReady, overlayBoundDisplayId: null,
      selectionGestureArm: null, selectionGestureExpiryTimer: null,
      pointerInputState: {foregroundApp: 'witness', foregroundHwnd: 1, foregroundProcessId: process.pid},
      fabricSettings: {appearance: {}},
      gestureRuntimeContract: () => ({armDelayMs: 120, timeoutMs: 5000, chainGapMs: 1000, interactionMode: exclusive ? 'exclusive_overlay' : 'pass_through', lineStyle: 'demo6_band', lineWidthDip: 22}),
      physicalDisplayBounds: () => bounds,
      getCaptureCommitCoordinator: () => ({arm: async request => { await preparationGate; await capture.arm({...request, targetWindow: undefined}); }}),
      passThroughGestureCapture: {arm() {}},
      sendPointerInputCommand: command => commands.push(command),
      createStageWindow: () => stage,
      globalShortcut: {register(key, callback) {shortcuts.set(key, callback); return true;}, unregister(key) {shortcuts.delete(key);}},
      temporarySurfaceButtons: 0, temporaryDismissShortcutRegistered: false,
      stageWindow: stage, activeSelectionSessionToken: null, lastStageResult: null,
      sendAgentCursorCommand() {}, setStageMouseCapture() {}, detachSelectionSurface() {},
      hideOverlay: () => {context.overlayWindow?.hide(); context.overlayWindow?.webContents.send('overlay:hide');},
      log() {},
      setTimeout: (fn, ms) => {const timer = setTimeout(fn, ms); timers.add(timer); return timer;}, clearTimeout,
      cancelSelectionGesture: () => {
        if (context.selectionGestureExpiryTimer) clearTimeout(context.selectionGestureExpiryTimer);
        context.selectionGestureArm = null;
        context.overlayWindow?.hide();
        context.overlayWindow?.webContents.send('overlay:hide');
      },
      selectionSessions: new Map(), selectionVisualForStage: () => 'sweep_band', stageVisualTuningForStage: () => ({}), kickTaskWatch() {},
      stageBounds: () => stage.getBounds(), invalidateStageBounds() {},
      deliverStageError: (_token, message) => stage.webContents.send('stage:update', {event: {type: 'ERROR', error: {message}}}),
    };
    vm.createContext(context);
    vm.runInContext(['createOverlayWindow', 'ensureFreshGestureOverlay', 'armSelectionGesture', 'reportFrameCommitFailure', 'placeStageOnDisplay', 'showStage', 'armTemporaryDismissShortcut', 'disarmTemporaryDismissShortcut', 'dismissTemporarySurfaces', 'hideStage'].map(extract).join('\n'), context);
    ipcMain.on('stage:hidden', () => context.hideStage());
    context.armSelectionGesture('acceptance');
    const overlay = context.overlayWindow;
    overlay.webContents.on('preload-error', (_e, _p, error) => report.errors.push(String(error)));
    async function until(expression) {
      for (let n = 0; n < 150; n++) { if (await overlay.webContents.executeJavaScript(expression)) return; await wait(30); }
      throw new Error('overlay condition timeout: ' + expression);
    }
    await until("document.querySelector('#hint')?.textContent.includes('正在准备')");
    check(overlay.isVisible() && target.isFocused(), 'preparing feedback is visible without changing foreground focus');
    check(!context.selectionGestureArm.captureReady && readySignals === 0, 'preparing overlay does not claim a capturable frame');
    let heldDrag;
    if (exclusive) {
      await overlay.webContents.executeJavaScript('window.witnessDowns=0;window.addEventListener("pointerdown",()=>window.witnessDowns++)');
      const handle = target.getNativeWindowHandle();
      const hwnd = Number(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE());
      const window = await desktop.nativeRequest('window', {hwnd});
      const start = screen.dipToScreenPoint({x: target.getBounds().x + 100, y: target.getBounds().y + 180});
      const end = screen.dipToScreenPoint({x: target.getBounds().x + 300, y: target.getBounds().y + 180});
      const hit = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class HitWitness{[StructLayout(LayoutKind.Sequential)]public struct Point{public int x,y;}[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(Point p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);}'; $p=New-Object HitWitness+Point;$p.x=${start.x};$p.y=${start.y};$h=[HitWitness]::GetAncestor([HitWitness]::WindowFromPoint($p),2); Write-Output ($h.ToInt64().ToString()+','+[HitWitness]::GetWindowLong($h,-20).ToString())`], {windowsHide: true});
      const overlayHandle = overlay.getNativeWindowHandle();
      const overlayHwnd = Number(overlayHandle.length === 8 ? overlayHandle.readBigUInt64LE() : overlayHandle.readUInt32LE());
      const [hitHwnd, exStyle] = hit.stdout.trim().split(',').map(Number);
      report.exclusiveHitTest = {hitHwnd, overlayHwnd, exStyle};
      check(hitHwnd === overlayHwnd && (exStyle & 0x20) === 0, 'Win32 hit testing routes the preparation point to the exclusive overlay, without click-through style');
      if (physical) {
        heldDrag = desktop.nativeRequest('input', {action: 'drag', window, x: start.x, y: start.y, to_x: end.x, to_y: end.y, duration_ms: 2500}).catch(error => {report.inputError = String(error); throw error;});
        heldDrag.catch(() => {});
      } else {
        overlay.webContents.sendInputEvent({type: 'mouseDown', x: 180, y: 260, button: 'left', clickCount: 1});
      }
      await until('window.witnessDowns===1');
      check(await target.webContents.executeJavaScript('window.witnessDowns===0'), 'the target has not received the preparation press');
    } else {
      check(commands[0].startsWith('capture-next:12000'), 'native early click suppression remains armed during preparation');
      await overlay.webContents.executeJavaScript("window.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:100,clientY:100})); window.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:1,clientX:200,clientY:100}));");
    }
    await wait(50);
    check(startedSignals === 0, 'preparing renderer does not consume an early stroke');
    async function screenshot(win, name) {
      await win.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await wait(60);
      const png = (await win.webContents.capturePage()).toPNG();
      await sharp(png).flatten({background: '#e5e8ec'}).toFile(path.join(out, name));
    }
    await screenshot(overlay, 'preparing.png');
    releaseCapture();
    await until("document.querySelector('#hint')?.textContent.includes('可以划线')");
    check(context.selectionGestureArm.captureReady && readySignals === 1, 'ready hint and acknowledgement follow the actual native first frame and grace interval');
    check(target.isFocused(), 'ready transition retains witness focus');
    await screenshot(overlay, 'ready.png');
    if (exclusive) {
      if (physical) await heldDrag;
      else {
        overlay.webContents.sendInputEvent({type: 'mouseMove', x: 260, y: 260, modifiers: ['leftButtonDown']});
        overlay.webContents.sendInputEvent({type: 'mouseUp', x: 280, y: 260, button: 'left', clickCount: 1});
      }
      await wait(120);
      check(strokeSignals === 1, 'a Chromium pointer held across preparation and grace remains one complete stroke');
      check(await target.webContents.executeJavaScript('window.witnessDowns===0'), 'the target receives no click from the exclusive held stroke');
    }
    const frozen = await capture.commit(context.selectionGestureArm.token);
    check(frozen.source === 'wgc-display', 'the first epoch commits an actual WGC display frame');
    // Bright witness styling is confined to this probe, on the actual overlay HWND.
    await overlay.webContents.insertCSS('#hint{opacity:1!important;background:rgb(219,17,173)!important;color:rgb(219,17,173)!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important;width:400px;height:70px;}');
    async function countWitness(epoch) {
      await capture.arm({epochId: epoch, surfaceBoundsPx: bounds});
      await wait(160);
      const frame = await capture.commit(epoch);
      const {data, info} = await sharp(Buffer.from(frame.png, 'base64')).removeAlpha().raw().toBuffer({resolveWithObject: true});
      let count = 0;
      for (let i = 0; i < data.length; i += info.channels) if (Math.abs(data[i]-219)<5 && Math.abs(data[i+1]-17)<5 && Math.abs(data[i+2]-173)<5) count++;
      return count;
    }
    const excluded = await countWitness('protected-overlay');
    overlay.setContentProtection(false);
    const included = await countWitness('unprotected-overlay');
    overlay.setContentProtection(true);
    report.exclusion = {excluded, included};
    check(included > 10000 && excluded < included / 10, 'actual preparation overlay HWND is excluded from native WGC pixels');
    context.reportFrameCommitFailure(new Error('acceptance_capture_failure'));
    await wait(400);
    const failure = await stage.webContents.executeJavaScript("({text:document.body.innerText,visible:[...document.querySelectorAll('*')].filter(x=>x.textContent.includes('这次没能冻结画面')&&x.getBoundingClientRect().width>0).length})");
    check(stage.isVisible() && failure.visible > 0 && failure.text.includes('这次没能冻结画面'), 'capture failure opens the existing Stage error surface');
    check(!overlay.isVisible() && target.isFocused(), 'failure cancels gesture and retains foreground focus');
    await screenshot(stage, 'failure.png');
    check(shortcuts.has('Escape'), 'capture failure rearms the existing global Escape callback');
    shortcuts.get('Escape')();
    for (let n = 0; n < 60 && stage.isVisible(); n++) await wait(30);
    check(!stage.isVisible(), 'existing Escape dismissal hides the actual error Stage');
    const previousToken = context.selectionGestureArm?.token;
    context.armSelectionGesture('wiggle');
    for (let n = 0; n < 150; n++) {
      if (context.selectionGestureArm?.captureReady && context.overlayWindow.isVisible()) break;
      await wait(30);
    }
    check(context.selectionGestureArm?.captureReady && context.selectionGestureArm.token !== previousToken && context.overlayWindow.isVisible(), 'a new wiggle arm recovers after failure and Escape dismissal');
    if (exclusive) {
      const nextOverlay = context.overlayWindow;
      const beforeGraceEnds = Date.now() < context.selectionGestureArm.readyAt;
      check(beforeGraceEnds, 'second exclusive press begins within the visual grace interval');
      nextOverlay.webContents.sendInputEvent({type: 'mouseDown', x: 180, y: 260, button: 'left', clickCount: 1});
      await wait(200);
      nextOverlay.webContents.sendInputEvent({type: 'mouseMove', x: 260, y: 260, modifiers: ['leftButtonDown']});
      nextOverlay.webContents.sendInputEvent({type: 'mouseUp', x: 280, y: 260, button: 'left', clickCount: 1});
      await wait(100);
      check(strokeSignals === 2, 'the next fresh exclusive window preserves a stroke pressed during grace');
      check(await target.webContents.executeJavaScript('window.witnessDowns===0'), 'both exclusive strokes leave the target untouched');
    }
    check(report.errors.length === 0, 'production preload has no errors');
    report.backend = 'production overlay renderer/preload/main functions + native WGC, own witness windows';
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({passed: checks.length, out}));
  } catch (error) {
    report.error = String(error.stack || error);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.error(error);
    process.exitCode = 1;
  } finally {
    capture.close(); timers.forEach(clearTimeout); clearTimeout(deadline);
    BrowserWindow.getAllWindows().forEach(win => win.destroy());
    app.exit(process.exitCode || 0);
  }
});

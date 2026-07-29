'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const styles = fs.readFileSync('electron/renderer/styles.css', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const dashboardHtml = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const overlayHtml = fs.readFileSync('electron/renderer/index.html', 'utf8');
const { defaultSettings } = require('../electron/settings_store');

const defaults = defaultSettings();
assert.strictEqual(defaults.activation.gesture_arm_delay_ms, 180);
assert.strictEqual(defaults.activation.gesture_timeout_ms, 5000);
assert.strictEqual(defaults.appearance.gesture_line_style, 'demo6_band');
assert.strictEqual(defaults.appearance.gesture_line_width_dip, 22);
for (const id of ['gesture-arm-delay', 'gesture-timeout', 'gesture-line-style', 'gesture-line-width']) {
  assert(dashboardHtml.includes(`id="${id}"`), `Dashboard must expose ${id}`);
}

const requestActivation = main.slice(
  main.indexOf('function requestActivation('),
  main.indexOf('function cleanupDictationStopFile('),
);
const surfaceWarmup = main.slice(
  main.indexOf('function queueActivationUntilSurfacesReady('),
  main.indexOf('function requestActivation('),
);
assert.match(surfaceWarmup, /stageReadiness\.isReady[\s\S]*?overlayReadiness\.isReady/,
  'activation must wait until both transparent renderers have acknowledged listeners');
assert.match(surfaceWarmup, /setImmediate\(\(\)\s*=>\s*requestActivation/,
  'a wake detected during cold start must be replayed instead of dropped');
assert.match(requestActivation, /queueActivationUntilSurfacesReady\(reason\)/,
  'cold-start activation must enter the renderer warmup queue');
const overlayWindowFactory = main.slice(
  main.indexOf('function createOverlayWindow('),
  main.indexOf('function createStageWindow('),
);
const stageWindowFactory = main.slice(
  main.indexOf('function createStageWindow('),
  main.indexOf('function placeStageOnDisplay('),
);
assert.match(overlayWindowFactory, /backgroundThrottling:\s*false/,
  'resident armed overlay must not incur hidden-renderer wake throttling');
assert.match(stageWindowFactory, /backgroundThrottling:\s*false/,
  'resident stage must receive the release IPC on the next compositor frame');
const gestureArm = main.slice(
  main.indexOf('function armSelectionGesture('),
  main.indexOf('function startMouseShakePolling('),
);
assert.match(gestureArm, /const residentStage = createStageWindow\(\)/,
  'gesture arming must keep a direct handle to the resident stage');
assert.match(gestureArm, /stageReadiness\.whenReady\([\s\S]*?overlayReadiness\.whenReady\([\s\S]*?show/,
  'drawing may become ready only after both resident renderers acknowledge their listeners');
assert.match(gestureArm, /gestureAcceptAt:\s*arm\.readyAt/,
  'the renderer must receive the visual grace deadline');
assert.doesNotMatch(gestureArm, /setTimeout\(reveal,\s*armDelayMs\)/,
  'input capture must begin immediately so an early held click cannot disappear');
assert.match(requestActivation, /reason\s*===\s*'wiggle'[\s\S]*?armSelectionGesture\(/,
  'wiggle must arm drawing instead of opening a selection session');

const beginSelection = main.slice(
  main.indexOf('function beginSelectionSession('),
  main.indexOf('app.whenReady().then('),
);
assert.match(beginSelection, /gesture[\s\S]*?releasePoint/,
  'selection capture must receive completed gesture geometry');
const gestureCompletion = beginSelection.slice(
  beginSelection.indexOf('if (gesture) {'),
  beginSelection.indexOf('updateStage({'),
);
assert.match(gestureCompletion, /type:\s*'OPEN_CAPSULE'/,
  'release must always open the conversation capsule');
assert.doesNotMatch(gestureCompletion, /type:\s*'ERROR'/,
  'grounding weakness must not replace the release capsule with an error card');
const captureStart = beginSelection.indexOf('runPythonBridge(');
const immediateGestureStage = beginSelection.slice(0, captureStart);
assert.match(immediateGestureStage, /if\s*\(gesture\)[\s\S]*?showStage\([\s\S]*?OPEN_CAPSULE/,
  'the release capsule must open before background grounding starts');
assert.match(beginSelection, /foregroundHwnd:\s*gesture\?\.source\?\.foregroundHwnd/,
  'background grounding must remain locked to the app active at wiggle time');

const overlayDone = main.slice(
  main.indexOf("ipcMain.on('overlay:done'"),
  main.indexOf("ipcMain.on('stage:submit-selection-command'"),
);
assert.match(overlayDone, /selection_gesture[\s\S]*?beginSelectionSession/,
  'only completed selection gestures may start grounding');

assert.match(overlay, /gestureMode\s*=\s*payload\?\.gestureMode\s*===\s*true/);
assert.match(overlay, /if\s*\(gestureMode\)[\s\S]*?drawSmoothPath/,
  'gesture mode draws only the user stroke');
assert.match(overlay, /gestureLineStyle\s*===\s*'thin'/,
  'thin stroke remains an explicit selectable style');
assert.match(overlay, /demo6_band/,
  'Demo 6 text-row band is the default stroke style');
assert.match(overlay, /if\s*\(!gestureMode\)\s*startPulseLoop\(\)/,
  'armed drawing must not run the full-screen idle animation loop');
assert.match(overlay, /gestureStarted\(gestureToken\)/,
  'pointer down must extend the timeout for an in-progress stroke');
assert.match(overlay, /if\s*\(drawing\)\s*return/,
  'duplicate pointerdown events must not reset an active stroke');
assert.match(overlay, /setPointerCapture\(e\.pointerId\)/,
  'the drawing surface must retain the pointer until release');
assert.match(overlay, /activePointerId/,
  'pointerup must belong to the stroke that started drawing');
assert.match(overlay, /gestureAcceptAt\s*-\s*Date\.now\(\)/,
  'an early held stroke must be retained across the visual grace period');
assert.match(preload, /overlay:gesture-start/);
assert.match(main, /ipcMain\.on\('overlay:gesture-start'/);
assert.match(styles, /body\[data-mode='gesture'\][\s\S]*?cursor:\s*url\([^)]*armed-cursor\.svg[^)]*\)[\s\S]*?!important/,
  'armed drawing uses a preloaded custom cursor without painting a fake pointer');
assert.match(overlayHtml, /rel="preload"[^>]*href="assets\/armed-cursor\.svg"[^>]*as="image"/,
  'overlay startup must warm the custom cursor asset before wiggle activation');

const stage = fs.readFileSync('electron/renderer/stage.js', 'utf8');
const stageShowHandler = stage.slice(
  stage.indexOf('api.onShow((payload) =>'),
  stage.indexOf('api.onUpdate((payload) =>'),
);
assert.doesNotMatch(stageShowHandler, /!payload\.target|!payload\.groundingReady/,
  'a release-point capsule must render immediately while grounding is still pending');
assert.doesNotMatch(stage, /capsule\.style\.display\s*=\s*['"]none['"]/,
  'the cold-start guard must not permanently override the capsule display rule');
assert.match(stage, /session\.capsuleAnchor\s*===\s*'target'/,
  'gesture capsule must be allowed to anchor at release pointer instead of target line');
assert.match(main, /capsuleDelayMs:\s*0/,
  'gesture capsule motion must not wait for a sweep that does not exist');
assert.match(immediateGestureStage, /groundingReady:\s*false/,
  'release capsule must stay visually ready while background grounding is pending');
assert.match(beginSelection, /groundingReady:\s*true/,
  'completed grounding must explicitly unlock voice input');
const stageCss = fs.readFileSync('electron/renderer/stage.css', 'utf8');
assert.match(stageCss, /--stage-capsule-delay/);
assert.match(stageCss, /\.stage-root\[hidden\]\s*\{\s*display:\s*none/,
  'cold-start invisibility belongs to the DOM/CSS initial state, not the stage payload gate');

console.log('gesture activation integration test ok');

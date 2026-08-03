'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const styles = fs.readFileSync('electron/renderer/styles.css', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const dashboardHtml = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const overlayHtml = fs.readFileSync('electron/renderer/index.html', 'utf8');
const visualVerifier = fs.readFileSync('scripts/verify_gesture_activation_visual.py', 'utf8');
const { defaultSettings } = require('../electron/settings_store');

const defaults = defaultSettings();
assert.strictEqual(defaults.activation.gesture_arm_delay_ms, 180);
assert.strictEqual(defaults.activation.gesture_timeout_ms, 5000);
assert.strictEqual(defaults.activation.multi_stroke_submit_ms, 2500);
assert.strictEqual(defaults.appearance.gesture_line_style, 'demo6_band');
assert.strictEqual(defaults.appearance.gesture_line_width_dip, 40);
for (const id of ['gesture-arm-delay', 'gesture-timeout', 'multi-stroke-submit', 'gesture-line-style', 'gesture-line-width']) {
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
assert.match(
  gestureArm,
  /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)[\s\S]*?overlayOwnsPointerInput\s*=\s*false/,
  'overlay must always forward mouse events — drawing tracked by main process',
);
assert.doesNotMatch(gestureArm, /setTimeout\(reveal,\s*armDelayMs\)/,

  'input capture must begin immediately so an early held click cannot disappear');
// Physical->DIP conversion: the stroke release point is physical pixels;
// anchoring and display lookup must convert once so the capsule stays next
// to the selection on scaled displays instead of clamping to a corner.
assert(main.includes("screen.screenToDipPoint({ x: releasePoint.x, y: releasePoint.y })"),
  'gesture release point must be converted to DIPs before stage anchoring');

// Manual voice press during grounding must not be dropped silently.
assert(main.includes('Bounded wait for grounding instead of a silent drop'),
  'dictation:start must wait briefly for grounding');
assert(main.includes("safeSurfaceSend(surface, 'dictation:result', { ok: false, surface, error: '目标识别还在进行，请稍候再试语音。' })"),
  'voice must report a friendly error instead of doing nothing');
assert.match(requestActivation, /isSelectionGestureActivation\(reason\)[\s\S]*?armSelectionGesture\(/,
  'wiggle must arm drawing instead of opening a selection session');
assert.match(main, /function isSelectionGestureActivation\(reason\)[\s\S]*?'wiggle'/,
  'the gesture activation predicate must still accept a plain wiggle');
assert.match(main, /function isSelectionGestureActivation\(reason\)[\s\S]*?'episode-continue'/,
  'cross-app continuation must arm drawing without a fresh wiggle');

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
// The capsule used to be forbidden from appearing before the snapshot callback,
// because it would otherwise land inside our own screenshot and UIA probes. That
// cost 4.9s of dead air on a real machine, which makes draw-talk-draw
// impossible. The rule is now narrower but just as hard: the capsule may appear
// early only when it physically cannot enter the capture.
const captureStart = beginSelection.indexOf('runPythonBridge(');
const immediateGestureStage = beginSelection.slice(0, captureStart);
assert.match(immediateGestureStage, /const revealCapsule = \(via\) => \{[\s\S]*?groundingReady: false/,
  'the early capsule must declare itself ungrounded so the snapshot can still backfill it');
assert.match(immediateGestureStage, /if \(gesture && CAPSULE_CONTENT_PROTECTED\) revealCapsule\('immediate'\)/,
  'an immediate capsule is permitted only while the stage is excluded from screen capture');
const revealBody = immediateGestureStage.slice(
  immediateGestureStage.indexOf('const revealCapsule = (via) => {'),
);
assert.match(revealBody, /if \(!gesture\) return;/,
  'only a completed gesture opens a capsule early; the shortcut path keeps its own flow');
assert.match(revealBody, /if \(entry\.capsuleRevealed\) return;/,
  'reveal must be idempotent: the immediate path and the phase marker can both fire');
assert.match(revealBody, /if \(activeSelectionSessionToken !== entry\.token\) return;/,
  'a superseded session must not paint a capsule over the session that replaced it');
assert.match(main, /const CAPSULE_CONTENT_PROTECTED = (true|false);/,
  'the content-protection gate must stay a single reviewable switch');
assert.match(main, /const CAPSULE_REVEAL_PHASE = 'pixels_frozen';/,
  'without content protection the capsule waits for attested pixels, not for OCR');
assert.match(main, /setContentProtection\(true\)/,
  'the immediate capsule is only safe because the stage window is excluded from capture');
assert.match(beginSelection, /onProgress:[\s\S]*?record\?\.phase === CAPSULE_REVEAL_PHASE\) revealCapsule/,
  'the fallback reveal must be driven by the bridge phase marker, not by a guessed delay');
assert.match(beginSelection, /onComplete:[\s\S]*?if \(entry\.capsuleRevealed\)[\s\S]*?updateStage\(groundedPayload\)/,
  'an already-open capsule must be backfilled, never reopened');
const backfillStart = beginSelection.indexOf('if (entry.capsuleRevealed) {');
const backfillEnd = beginSelection.indexOf('showStage(', backfillStart);
assert.ok(backfillStart > 0 && backfillEnd > backfillStart, 'backfill branch must be locatable');
const backfillBranch = beginSelection.slice(backfillStart, backfillEnd);
assert.doesNotMatch(backfillBranch, /type:\s*'OPEN_CAPSULE'/,
  'replaying OPEN_CAPSULE would re-anchor a capsule the user is already typing into');
assert.doesNotMatch(backfillBranch, /showStage\(/,
  'the backfill path must update the open capsule, not raise a second one');
assert.match(beginSelection, /onComplete:[\s\S]*?if\s*\(gesture\)[\s\S]*?showStage\([\s\S]*?OPEN_CAPSULE/,
  'a capsule that was never revealed early must still open on the snapshot callback');
assert.match(beginSelection, /foregroundHwnd:\s*gesture\?\.source\?\.foregroundHwnd/,
  'background grounding must remain locked to the app active at wiggle time');

const overlayDone = main.slice(
  main.indexOf("ipcMain.on('overlay:done'"),
  main.indexOf("ipcMain.on('stage:submit-selection-command'"),
);
assert.match(overlayDone, /selection_gesture[\s\S]*?completeSelectionGesture/,
  'the renderer path must enter the shared completed-gesture gate');
const completeGesture = main.slice(
  main.indexOf('function completeSelectionGesture('),
  main.indexOf('function processPassThroughGestureSample('),
);
assert.match(completeGesture, /summarizeGesture[\s\S]*?beginSelectionSession/,
  'only a validated completed gesture may start grounding');

assert.match(overlay, /gestureMode\s*=\s*payload\?\.gestureMode\s*===\s*true/);
assert.match(overlay, /if\s*\(gestureMode\)[\s\S]*?drawSmoothPath/,
  'gesture mode draws only the user stroke');
const gestureRenderBranch = overlay.slice(
  overlay.indexOf('if (gestureMode) {'),
  overlay.indexOf('if (!captureMode && points.length)'),
);
assert.doesNotMatch(gestureRenderBranch, /drawPointer\(lastPointer\)/,
  'armed mode must not paint a second cursor over the CSS cursor');
assert.match(gestureRenderBranch, /drawHitTestPixel\(lastPointer\)/,
  'the transparent input shield keeps a nearly invisible hit-test pixel');
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
assert.match(overlay, /addPoint\(e,\s*\{\s*force:\s*true\s*\}\)/,
  'exclusive overlay clicks must retain a distinct release timestamp');
assert.match(overlay, /activePointerId/,
  'pointerup must belong to the stroke that started drawing');
assert.match(overlay, /gestureAcceptAt\s*-\s*Date\.now\(\)/,
  'an early held stroke must be retained across the visual grace period');
assert.match(overlay, /gestureChainGapMs\s*=\s*Math\.max\(1500,\s*Math\.min\(30000/,
  'the renderer must accept a bounded configurable multi-stroke inactivity timeout');
assert.match(preload, /overlay:gesture-start/);
assert.match(preload, /overlay:gesture-ready/);
assert.match(preload, /overlay:gesture-input/);
assert.match(main, /ipcMain\.on\('overlay:gesture-start'/);
const exclusiveReady = main.slice(
  main.indexOf("ipcMain.on('overlay:gesture-ready'"),
  main.indexOf("ipcMain.on('stage:renderer-ready'"),
);
assert.match(exclusiveReady, /payload\?\.token[\s\S]*?moveTop\(\)/,
  'overlay must stay click-through; z-order is the only post-reset concern');
assert.match(overlay, /function resetOverlay\(\)[\s\S]*?releasePointerCapture/,
  'every dismissal must release stale DOM pointer ownership before rearming');
assert.match(overlay, /resetOverlay\(\)[\s\S]*?gestureReady\(gestureToken\)/,
  'the renderer readiness acknowledgement must happen after reset');
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
assert.match(beginSelection, /groundingReady:\s*true/,
  'the completed snapshot must explicitly unlock voice input');
const stageCss = fs.readFileSync('electron/renderer/stage.css', 'utf8');
assert.match(stageCss, /--stage-capsule-delay/);
assert.match(stageCss, /\.stage-root\[hidden\]\s*\{\s*display:\s*none/,
  'cold-start invisibility belongs to the DOM/CSS initial state, not the stage payload gate');
assert.match(visualVerifier, /GetForegroundWindow/,
  'desktop gesture verification must sample the real foreground HWND');
assert.match(visualVerifier, /foreground_invariant\s*=\s*all\(/,
  'wiggle, drawing, release, and capsule evidence must preserve source-app focus');
assert.match(visualVerifier, /and foreground_invariant/,
  'foreground stability must be a pass condition, not informational telemetry');
assert.match(visualVerifier, /stage renderer ready[\s\S]*?overlay renderer ready/,
  'the brief physical wiggle must run against the prewarmed production state');

console.log('gesture activation integration test ok');

'use strict';

const assert = require('assert');
const fs = require('fs');
const ts = require('typescript');

function nodes(text, predicate) {
  const tree = ts.createSourceFile('contract.ts', text, ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) {
    if (predicate(node, tree)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return {tree, matches};
}

function handlerText(text, receiver, event) {
  const {tree, matches} = nodes(text, node => ts.isCallExpression(node) &&
    node.expression.getText() === receiver &&
    (event === undefined || (ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event)));
  assert.strictEqual(matches.length, 1, `exactly one ${receiver} ${event || ''} handler must exist`);
  return matches[0].getText(tree);
}

function assertGuard(text, condition, statement, message) {
  const printer = ts.createPrinter({removeComments: true});
  const key = node => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
  const expected = nodes(`if (${condition}) { ${statement} }`, ts.isIfStatement).matches[0];
  const {matches} = nodes(text, ts.isIfStatement);
  assert.ok(matches.some(node => {
    const body = ts.isBlock(node.thenStatement) ? node.thenStatement.statements : [node.thenStatement];
    return key(node.expression) === key(expected.expression) && body.length === 1 &&
      key(body[0]) === key(expected.thenStatement.statements[0]);
  }), message);
}

const main = fs.readFileSync('electron/main.ts', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.ts', 'utf8');
const styles = fs.readFileSync('electron/renderer/styles.css', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const overlayHtml = fs.readFileSync('electron/renderer/index.html', 'utf8');
const { defaultSettings } = require('../electron/settings_store');

const defaults = defaultSettings();
assert.strictEqual(defaults.activation.gesture_arm_delay_ms, 180);
assert.strictEqual(defaults.activation.gesture_timeout_ms, 5000);
assert.strictEqual(defaults.activation.multi_stroke_submit_ms, 2500);
assert.strictEqual(defaults.appearance.gesture_line_style, 'demo6_band');
assert.strictEqual(defaults.appearance.gesture_line_width_dip, 40);

const requestActivation = main.slice(
  main.indexOf('function requestActivation('),
  main.indexOf('function ', main.indexOf('function requestActivation(') + 10),
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
assert.match(gestureArm, /createStageWindow\(\)/,
  'gesture arming must keep a direct handle to the resident stage');
assert.match(gestureArm, /stageReadiness\.whenReady\([\s\S]*?overlayReadiness\.whenReady\([\s\S]*?show/,
  'drawing may become ready only after both resident renderers acknowledge their listeners');
assert.match(gestureArm, /gestureAcceptAt:\s*arm\.readyAt/,
  'the renderer must receive the visual grace deadline');
assert.match(
  gestureArm,
  /const exclusive = arm\.runtime\.interactionMode === 'exclusive_overlay';[\s\S]*?setIgnoreMouseEvents\(!exclusive,\s*\{\s*forward:\s*true\s*\}\)[\s\S]*?overlayOwnsPointerInput\s*=\s*exclusive/,
  'exclusive mode shields input while pass-through mode delegates to the native hook',
);
assert.doesNotMatch(gestureArm, /setTimeout\(reveal,\s*armDelayMs\)/,

  'input capture must begin immediately so an early held click cannot disappear');
assert.match(main, /screen\.screenToDipPoint\(\{\s*x:\s*releasePoint\.x,\s*y:\s*releasePoint\.y\s*\}\)/,
  'gesture release point must be converted to DIPs before stage anchoring');

assert.match(requestActivation, /isSelectionGestureActivation\(reason\)[\s\S]*?armSelectionGesture\(/,
  'wiggle must arm drawing instead of opening a selection session');
assert.match(main, /function isSelectionGestureActivation\(reason[^)]*\)[\s\S]*?'wiggle'/,
  'the gesture activation predicate must still accept a plain wiggle');
assert.match(main, /function isSelectionGestureActivation\(reason[^)]*\)[\s\S]*?'episode-continue'/,
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
const captureStart = beginSelection.indexOf('runRuntimeBridge(');
const immediateGestureStage = beginSelection.slice(0, captureStart);
assert.match(immediateGestureStage, /const revealCapsule = \(via[^)]*\) => \{[\s\S]*?groundingReady: false/,
  'the early capsule must declare itself ungrounded so the snapshot can still backfill it');
assertGuard(immediateGestureStage, 'gesture && CAPSULE_CONTENT_PROTECTED', "revealCapsule('immediate');",
  'an immediate capsule is permitted only while the stage is excluded from screen capture');
const revealBody = immediateGestureStage.slice(
  immediateGestureStage.indexOf('const revealCapsule = (via'),
);
assertGuard(revealBody, '!gesture', 'return;',
  'only a completed gesture opens a capsule early; the shortcut path keeps its own flow');
assertGuard(revealBody, 'entry.capsuleRevealed', 'return;',
  'reveal must be idempotent: the immediate path and the phase marker can both fire');
assertGuard(revealBody, 'activeSelectionSessionToken !== entry.token', 'return;',
  'a superseded session must not paint a capsule over the session that replaced it');
assert.match(main, /const CAPSULE_CONTENT_PROTECTED = (true|false);/,
  'the content-protection gate must stay a single reviewable switch');
assert.match(main, /const CAPSULE_REVEAL_PHASE = 'pixels_frozen';/,
  'without content protection the capsule waits for attested pixels, not for OCR');
assert.match(main, /setContentProtection\(true\)/,
  'the immediate capsule is only safe because the stage window is excluded from capture');
const progressHandler = nodes(beginSelection, node => ts.isPropertyAssignment(node) && node.name.getText() === 'onProgress').matches;
assert.strictEqual(progressHandler.length, 1, 'capture has one progress handler');
assertGuard(progressHandler[0].getText(), 'record?.phase === CAPSULE_REVEAL_PHASE', 'revealCapsule(CAPSULE_REVEAL_PHASE);',
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

const overlayDone = handlerText(main, 'ipcMain.on', 'overlay:done');
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
assert.match(overlay, /if\s*\(gestureMode\)\s*\{\s*stopPulseLoop\(\)/,
  'armed drawing must not run the full-screen idle animation loop');
assert.match(overlay, /function pulseAllowed\(\)\s*\{[^}]*!gestureMode/,
  'the pulse loop must refuse to run while a gesture is armed');
assert.match(overlay, /gestureStarted\(gestureToken\)/,
  'pointer down must extend the timeout for an in-progress stroke');
assertGuard(overlay, 'drawing', 'return;',
  'duplicate pointerdown events must not reset an active stroke');
assert.match(overlay, /setPointerCapture\(e\.pointerId\)/,
  'the drawing surface must retain the pointer until release');
assert.match(overlay, /addPoint\(e,\s*\{\s*force:\s*true\s*\}\)/,
  'exclusive overlay clicks must retain a distinct release timestamp');
assert.match(overlay, /activePointerId/,
  'pointerup must belong to the stroke that started drawing');
assert.match(overlay, /gestureAcceptAt\s*-\s*Date\.now\(\)/,
  'an early held stroke must be retained across the visual grace period');
assert.match(overlay, /gestureChainGapMs\s*=\s*Math\.max\(\s*1500,\s*Math\.min\(\s*30000/,
  'the renderer must accept a bounded configurable multi-stroke inactivity timeout');
assert.match(preload, /overlay:gesture-start/);
assert.match(preload, /overlay:gesture-ready/);
assert.match(preload, /overlay:gesture-input/);
handlerText(main, 'ipcMain.on', 'overlay:gesture-start');
const exclusiveReady = handlerText(main, 'ipcMain.on', 'overlay:gesture-ready');
assert.match(exclusiveReady, /payload\?\.token[\s\S]*?moveTop\(\)/,
  'overlay must stay click-through; z-order is the only post-reset concern');
assert.match(overlay, /function resetOverlay\(\)[\s\S]*?releasePointerCapture/,
  'every dismissal must release stale DOM pointer ownership before rearming');
assert.match(overlay, /resetOverlay\(\)[\s\S]*?gestureReady\(gestureToken\)/,
  'the renderer readiness acknowledgement must happen after reset');
assert.match(styles, /body\[data-mode='gesture'\][\s\S]*?url\('\.\/assets\/armed-cursor\.cur'\) 3 3/,
  'armed drawing must use a native Windows cursor with an exact hotspot');
assert.doesNotMatch(overlayHtml, /id="armed-cursor"/,
  'armed drawing must not render a delayed DOM copy of the OS cursor');
assert.doesNotMatch(overlay, /function updateArmedCursor\(/,
  'cursor movement must not cross the renderer or IPC path');
assert.match(main, /overlayBoundDisplayId[\s\S]*?setBounds\(desired\)/,
  'overlay must only setBounds when the cursor crosses displays — repeated setBounds flickers the cursor');

const stage = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const stageShowHandler = handlerText(stage, 'api.onShow');
assert.doesNotMatch(stageShowHandler, /!payload\.target|!payload\.groundingReady/,
  'a release-point capsule must render immediately while grounding is still pending');
assert.doesNotMatch(stage, /capsule\.style\.display\s*=\s*['"]none['"]/,
  'the cold-start guard must not permanently override the capsule display rule');
assert.match(stage, /session\.capsuleAnchor\s*===\s*'target'/,
  'gesture capsule must be allowed to anchor at release pointer instead of target line');
assert.match(main, /capsuleDelayMs:\s*0/,
  'gesture capsule motion must not wait for a sweep that does not exist');
assert.match(beginSelection, /groundingReady:\s*true/,
  'the completed snapshot must explicitly unlock input');
const stageCss = fs.readFileSync('electron/renderer/stage.css', 'utf8');
assert.match(stageCss, /--stage-composer-width,\s*480px/,
  'gesture activation must reveal the final fixed composer, not a delayed ball expansion');
assert.match(stageCss, /\.stage-root\[hidden\]\s*\{\s*display:\s*none/,
  'cold-start invisibility belongs to the DOM/CSS initial state, not the stage payload gate');
console.log('gesture activation integration test ok');

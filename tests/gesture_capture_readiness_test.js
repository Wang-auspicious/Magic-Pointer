const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.createSourceFile(
  'main.ts',
  fs.readFileSync('electron/main.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const arm = source.statements.find(
  row =>
    ts.isFunctionDeclaration(row) && row.name?.text === 'armSelectionGesture',
);
const javascript = ts.transpileModule(arm.getText(source), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;
async function run(fail = false, excluded = true, mode = 'pass_through') {
  const events = [];
  let ready;
  let failed;
  const capture = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const window = {
    isDestroyed: () => false,
    setBounds() {},
    setFocusable() {},
    setIgnoreMouseEvents(ignore) { events.push(ignore ? 'pass-through' : 'shield'); },
    showInactive() {
      events.push('show');
    },
    webContents: {send(_channel, payload) { events.push(payload?.captureState); }},
  };
  const context = {
    selectionGestureArm: null,
    overlayWindow: window,
    pointerInputState: {
      foregroundApp: 'witness',
      foregroundHwnd: 42,
      foregroundProcessId: 7,
    },
    fabricSettings: {},
    selectionGestureExpiryTimer: null,
    overlayBoundDisplayId: null,
    overlayOwnsPointerInput: false,
    overlayCaptureExcluded: excluded,
    crypto: {randomUUID: () => 'one'},
    Date,
    screen: {
      getCursorScreenPoint: () => ({x: 1, y: 1}),
      getDisplayNearestPoint: () => ({
        id: 1,
        bounds: {x: 0, y: 0, width: 100, height: 100},
        scaleFactor: 1,
      }),
    },
    cancelSelectionGesture: reason => events.push(`cancel:${reason}`),
    ensureFreshGestureOverlay() {},
    gestureRuntimeContract: () => ({
      armDelayMs: 180,
      timeoutMs: 5000,
      chainGapMs: 1000,
      interactionMode: mode,
    }),
    getCaptureCommitCoordinator: () => ({arm: () => capture}),
    physicalDisplayBounds: () => [0, 0, 100, 100],
    passThroughGestureCapture: {arm() {}},
    sendPointerInputCommand() {},
    createStageWindow() {},
    armTemporaryDismissShortcut() {},
    stageReadiness: {whenReady: callback => callback()},
    overlayReadiness: {whenReady: callback => callback()},
    reportFrameCommitFailure: () => events.push('failure'),
    log() {},
    setTimeout: () => 1,
    clearTimeout() {},
  };
  vm.runInNewContext(`${javascript}\narmSelectionGesture();`, context);
  if (!excluded) {
    assert.equal(events.includes('show'), false);
    assert.equal(events.includes('failure'), true,
      'capture exclusion failure must reject preparation without exposing an overlay');
    return;
  }
  assert.equal(
    events.includes('preparing'),
    true,
    'wake must display preparation feedback before the first frame is available',
  );
  assert.equal(events.includes('ready'), false);
  if (mode === 'exclusive_overlay') {
    assert.equal(events.includes('shield'), true,
      'default exclusive mode must shield the target during frame preparation');
    assert.equal(context.overlayOwnsPointerInput, true);
  }
  if (fail) failed(new Error('capture_unavailable'));
  else ready('one');
  await new Promise(resolve => setImmediate(resolve));
  if (fail) {
    assert.equal(
      events.includes('failure'),
      true,
      'native capture initialization failure must be visible',
    );
  } else {
    assert.equal(events.includes('show'), true);
    assert.equal(events.includes('ready'), true);
    assert.equal(context.selectionGestureArm.captureReady, true);
  }
}
function earlyRelease() {
  const functions = [
    'processPassThroughGestureSample',
    'completeSelectionGesture',
  ]
    .map(name => {
      const row = source.statements.find(
        item => ts.isFunctionDeclaration(item) && item.name?.text === name,
      );
      return ts.transpileModule(row.getText(source), {
        compilerOptions: {target: ts.ScriptTarget.ES2022},
      }).outputText;
    })
    .join('\n');
  const events = [];
  const context = {
    selectionGestureArm: {
      token: 'early',
      captureReady: false,
      runtime: {interactionMode: 'pass_through'},
    },
    pointerInputState: {buttons: 1},
    cancelSelectionGesture: reason => {
      events.push(reason);
      context.selectionGestureArm = null;
    },
    reportFrameCommitFailure: () => events.push('failure'),
  };
  vm.runInNewContext(functions, context);
  context.processPassThroughGestureSample(1, {x: 1, y: 1});
  context.pointerInputState.buttons = 0;
  context.processPassThroughGestureSample(2, {x: 2, y: 2});
  assert.deepEqual(
    events,
    ['capture_not_ready', 'failure'],
    'a complete early press/release must cancel rather than leave a stale gesture',
  );
  context.selectionGestureArm = {token: 'event', captureReady: false};
  assert.equal(
    context.completeSelectionGesture({selectionGestureToken: 'event'}),
    false,
    'early renderer completion must not wait for later pixels',
  );
  context.selectionGestureArm = {token: 'late-ipc', captureReady: true};
  assert.equal(context.completeSelectionGesture({
    selectionGestureToken: 'late-ipc', captureState: 'preparing',
  }), false, 'an early release remains invalid even if its IPC arrives after the first frame');
  const replacement = {token: 'replacement', captureReady: true};
  context.selectionGestureArm = replacement;
  assert.equal(context.completeSelectionGesture({selectionGestureToken: 'old'}), false);
  assert.equal(context.selectionGestureArm, replacement,
    'completion queued before Esc must not cancel a newly awakened gesture');
  replacement.committing = true;
  assert.equal(context.completeSelectionGesture({selectionGestureToken: 'replacement'}), false);
  assert.equal(context.selectionGestureArm, replacement,
    'a duplicate completion must not cancel the frame already committing');
}
function queuedRendererCompletion() {
  const overlay = ts.createSourceFile('overlay.ts', fs.readFileSync('electron/renderer/overlay.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const submit = overlay.statements.find(row => ts.isFunctionDeclaration(row) && row.name?.text === 'submitGesture');
  const queued = [];
  const sent = [];
  const context = {
    submitting: false, strokes: [{}], gestureToken: 'old', currentWorkflow: 'selection_gesture',
    computeSelectionPayload: () => ({selectionGestureToken: context.gestureToken}),
    hideVisualsForCapture() {},
    requestAnimationFrame: callback => queued.push(callback),
    window: {magicPointer: {done: payload => sent.push(payload)}},
  };
  vm.runInNewContext(ts.transpileModule(submit.getText(overlay), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText, context);
  context.submitGesture();
  context.submitting = false;
  context.gestureToken = 'replacement';
  context.submitGesture();
  queued[0]();
  assert.equal(sent.length, 0, 'a frame callback queued before Esc must not send the old gesture after rearming');
  queued[1]();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].selectionGestureToken, 'replacement');
}
Promise.resolve()
  .then(() => run())
  .then(() => run(true))
  .then(() => run(false, false))
  .then(() => run(false, true, 'exclusive_overlay'))
  .then(earlyRelease)
  .then(queuedRendererCompletion)
  .then(() => console.log('gesture capture readiness passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

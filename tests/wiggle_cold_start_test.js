const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {WiggleDetector} = require('../electron/wiggle_detector');
const {MouseActivationDetector} = require('../electron/mouse_activation');
const {pointerPollingPolicy} = require('../electron/pointer_polling_policy');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const source = ts.createSourceFile(
  'main.ts',
  main,
  ts.ScriptTarget.Latest,
  true,
);
const polling = source.statements.find(
  statement =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'startMouseShakePolling',
);
assert.ok(polling, 'exercise the actual main-process wake loop');
const code = ts.transpileModule(polling.getText(source), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;

function replay({
  overlay,
  temporary = false,
  enabled = true,
  buttons = 0,
} = {}) {
  const activations = [];
  let tick;
  let now = 0;
  let cursor = {x: 500, y: 400};
  const context = {
    mousePollTimer: null,
    wiggleDetector: new WiggleDetector(),
    mouseActivationDetector: new MouseActivationDetector(),
    pointerInputState: {buttons, scrollDelta: 0, foregroundApp: 'notepad.exe'},
    overlayWindow: overlay,
    stageWindow: null,
    overlayOwnsPointerInput: false,
    temporarySurfaceButtons: buttons,
    fabricSettings: {activation: {}},
    Date: {now: () => now},
    screen: {getCursorScreenPoint: () => cursor},
    process: {env: {}},
    setInterval: callback => {
      tick = callback;
      return 1;
    },
    hasVisibleTemporarySurface: () => temporary,
    shouldDismissFromGlobalPointer: () => false,
    processPassThroughGestureSample: () => {},
    sendCursorToOverlay: () => {},
    currentPointerPollingPolicy: () =>
      pointerPollingPolicy({
        wakeMode: enabled ? 'wiggle' : 'hotkey',
        wiggleEnabled: enabled,
      }),
    requestActivation: reason => activations.push(reason),
    log: () => {},
  };
  vm.runInNewContext(`${code}\nstartMouseShakePolling();`, context);
  for (const [t, x, y] of [
    [0, 500, 400],
    [55, 468, 386],
    [125, 526, 412],
    [205, 474, 389],
  ]) {
    now = t;
    cursor = {x, y};
    tick();
  }
  return activations;
}

assert.deepEqual(
  replay(),
  ['wiggle'],
  'first launch must wake before an overlay has ever been created',
);
assert.deepEqual(
  replay({overlay: {isDestroyed: () => true}}),
  ['wiggle'],
  'disposed overlays must not disable subsequent wake',
);
assert.deepEqual(
  replay({overlay: {isDestroyed: () => false, isVisible: () => false}}),
  ['wiggle'],
);
assert.deepEqual(
  replay({overlay: {isDestroyed: () => false, isVisible: () => true}}),
  [],
  'drawing must not wake again',
);
assert.deepEqual(replay({temporary: true}), []);
assert.deepEqual(replay({enabled: false}), []);
assert.deepEqual(
  replay({buttons: 1}),
  [],
  'a normal drag must not trigger a wake',
);
console.log('wiggle cold-start main-loop regression passed');

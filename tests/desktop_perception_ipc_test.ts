import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile(
  'main.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  'desktopPerceptionStatus',
  'activateDesktopPerception',
  'isSelectionGestureActivation',
];
const functions = names.map(name => {
  const node = ast.statements.find(
    node => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(node, `Desktop pointing needs a real ${name} implementation`);
  return node.getText(ast);
});
const handlers = new Map<string, (...args: any[]) => any>();
const channels = ['desktop-perception:status', 'desktop-perception:activate', 'desktop-perception:set-paused'];
const registrations = channels.map(channel => {
  const node = ast.statements.find(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.arguments.some(
        arg => ts.isStringLiteral(arg) && arg.text === channel,
      ),
  );
  assert.ok(
    node,
    `${channel} must be connected to the production main process`,
  );
  return node.getText(ast);
});
let hidden = 0;
let restored = 0;
let activation = '';
let ticks = 0;
let changeTarget = true;
const context = vm.createContext({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      handlers.set(channel, handler),
  },
  isDashboardSender: (event: any) => event.trusted === true,
  inputPaused: false,
  onboardingRequired: false,
  isQuitting: false,
  desktopPerceptionActivating: false,
  pointerStateReceived: true,
  pointerStateSequence: 1,
  pointerStateError: '',
  pointerStateChild: {killed: false},
  pointerInputState: {foregroundHwnd: 10, foregroundProcessId: 123},
  mousePollTimer: {},
  process: {pid: 123},
  fabricSettings: {
    activation: {wake_mode: 'wiggle'},
    shortcuts: {wake: 'Control+Alt+M', text_mode: 'Control+Alt+T'},
  },
  globalShortcut: {isRegistered: (key: string) => key === 'Control+Alt+M'},
  currentPointerPollingPolicy: () => ({
    detectWiggle: true,
    detectMouseButton: false,
  }),
  dashboardWindow: {
    isDestroyed: () => false,
    hide: () => {
      hidden++;
    },
    show: () => {
      restored++;
    },
    focus: () => {},
  },
  startPointerInputStateStream: () => {},
  applyConfiguredWakeState: () => {},
  refreshTrayMenu: () => {},
  dismissTemporarySurfaces: () => {},
  requestActivation: (reason: string) => {
    activation = reason;
    return 'renderer_warming';
  },
  setTimeout: (callback: () => void) => {
    ticks++;
    if (changeTarget) {
      context.pointerStateSequence++;
      context.pointerInputState = {
        foregroundHwnd: 99,
        foregroundProcessId: 456,
      };
    }
    callback();
  },
});
vm.runInContext(
  ts.transpileModule([...functions, ...registrations].join('\n'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText,
  context,
);

void (async () => {
  await assert.rejects(
    () => handlers.get(channels[0])!({trusted: false}),
    /unauthorized/,
  );
  assert.equal((await handlers.get(channels[1])!({trusted: false})).ok, false);
  assert.equal(hidden, 0);
  const status = await handlers.get(channels[0])!({trusted: true});
  assert.equal(status.detectWiggle, true);
  assert.equal(status.pointerStateFresh, true);
  assert.equal(
    status.hotkeys.find((key: any) => key.name === 'wake').registered,
    true,
  );
  assert.equal(
    status.hotkeys.find((key: any) => key.name === 'text_mode').registered,
    false,
  );
  context.pointerStateReceived = false;
  assert.equal(
    (await handlers.get(channels[0])!({trusted: true})).pointerStateFresh,
    false,
  );
  context.pointerStateReceived = true;
  context.inputPaused = true;
  assert.equal((await handlers.get(channels[1])!({trusted: true})).ok, false);
  assert.equal(hidden, 0, 'Paused pointing must not hide Studio');
  context.inputPaused = false;
  const result = await handlers.get(channels[1])!({trusted: true});
  assert.equal(result.ok, true);
  assert.equal(hidden, 1);
  assert.equal(ticks, 1);
  assert.equal(activation, 'studio-perception');
  assert.equal(
    vm.runInContext(
      'isSelectionGestureActivation("studio-perception")',
      context,
    ),
    true,
    'The button must arm a gesture, not read the Studio button as the selected object',
  );
  changeTarget = false;
  activation = '';
  context.pointerInputState = {foregroundHwnd: 10, foregroundProcessId: 123};
  assert.equal((await handlers.get(channels[1])!({trusted: true})).ok, false);
  assert.equal(activation, '');
  assert.equal((await handlers.get(channels[2])!({trusted: false}, {paused: true})).ok, false);
  assert.equal((await handlers.get(channels[2])!({trusted: true}, {paused: 'false'})).ok, false);
  assert.equal((await handlers.get(channels[2])!({trusted: true}, {paused: true})).ok, true);
  assert.equal(context.inputPaused, true);
  assert.equal((await handlers.get(channels[2])!({trusted: true}, {paused: false})).ok, true);
  assert.equal(context.inputPaused, false);
  assert.equal(
    restored,
    1,
    'Failed target acquisition must return the user to Studio',
  );
  assert.equal(context.desktopPerceptionActivating, false);
  context.pointerInputState = {foregroundHwnd: 99, foregroundProcessId: 456};
  assert.equal(
    (await handlers.get(channels[1])!({trusted: true})).ok,
    false,
    'An old external-window sample must not be treated as the foreground after hiding Studio',
  );
  assert.equal(activation, '');
  console.log(
    'Desktop perception IPC: status, sender, pause, target transition and recovery passed',
  );
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

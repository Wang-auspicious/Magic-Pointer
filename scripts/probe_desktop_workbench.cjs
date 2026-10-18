const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/desktop-workbench-ui');
const fixture = path.join(out, `fixture-${Date.now()}`);
const plugins = path.join(fixture, 'data/plugins');
fs.mkdirSync(plugins, {recursive: true});
for (const id of ['enabled', 'disabled', 'invalid']) {
  const directory = path.join(plugins, id);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'plugin.json'),
    JSON.stringify({
      name: `ui-${id}`,
      main: 'plugin.cjs',
      description: 'Isolated acceptance plugin',
    }),
  );
  if (id !== 'invalid') {
    fs.writeFileSync(
      path.join(directory, 'plugin.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(fixture, 'plugin-executed'))},'unexpected');module.exports={name:'ui-${id}',apply(){}};`,
    );
  }
}
const patchPath = path.join(fixture, 'data/harness.patch.json');
fs.writeFileSync(
  patchPath,
  JSON.stringify({
    schemaVersion: 1,
    patch: {},
    disabledPluginDirectories: ['disabled'],
  }),
);
app.setPath('userData', path.join(fixture, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(2), 60000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      offscreen: true,
      backgroundThrottling: false,
      preload: path.join(root, 'build/electron/preload.js'),
    },
  });
  const errors = [];
  const calls = [];
  win.webContents.on('preload-error', (_event, _path, error) =>
    errors.push(error.message),
  );
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(String(message));
  });
  const taskContext = {
    taskId: 'fixture-task',
    referenceRevision: 1,
    sources: [
      {
        sourceId: 'screen-source',
        taskId: 'fixture-task',
        kind: 'capture',
        title: 'Acceptance window',
        identity: {},
        revision: {},
        origin: 'user-pointed',
        capabilities: ['read'],
        parentSourceId: null,
      },
    ],
    references: [
      {
        referenceId: 'a',
        sourceId: 'screen-source',
        label: 'A',
        role: 'target',
        locator: {kind: 'visual-region', value: {bbox: [0, 0, 200, 100]}},
        frameLeaseId: 'fixture-frame',
        active: true,
        ordinal: 1,
        capturedAtMs: Date.now(),
      },
    ],
  };
  const conversation = {
    id: 'desktop-fixture',
    title: 'Pointed screen task',
    updatedAt: Date.now(),
    taskContext,
    workspaceRoot: '',
    projectId: '',
    object: {
      app: 'Acceptance',
      label: 'Acceptance window',
      frameLeaseId: 'fixture-frame',
      capturedAt: new Date().toISOString(),
      source: {
        perceptionTrace: {
          selectedAdapter: 'uia',
          attempts: [
            {adapter: 'uia', status: 'ok', usedBackend: 'fixture.native.uia'},
          ],
        },
      },
    },
    turns: [
      {
        at: Date.now(),
        question: 'Read the selected report',
        answer: 'Isolated GUI fixture; no model call.',
        taskContext,
      },
    ],
  };
  const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
  const ast = ts.createSourceFile(
    'main.ts',
    main,
    ts.ScriptTarget.Latest,
    true,
  );
  const channels = [
    'desktop-perception:status',
    'desktop-perception:activate',
    'desktop-perception:set-paused',
    'extensions:inventory',
    'extensions:set-enabled',
  ];
  const functions = [
    'desktopPerceptionStatus',
    'activateDesktopPerception',
    'isSelectionGestureActivation',
  ].map(name => {
    const node = ast.statements.find(
      node => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert(node, name);
    return node.getText(ast);
  });
  const registrations = channels.map(channel => {
    const node = ast.statements.find(
      node =>
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.arguments.some(
          arg => ts.isStringLiteral(arg) && arg.text === channel,
        ),
    );
    assert(node, channel);
    return node.getText(ast);
  });
  const {handleFabric} = require(
    path.join(root, 'build/electron/runtime/fabric_api.js'),
  );
  let hides = 0;
  const context = vm.createContext({
    ipcMain: {
      handle(channel, handler) {
        ipcMain.handle(channel, (...args) => {
          calls.push(channel);
          return handler(...args);
        });
      },
    },
    isDashboardSender: event => event.sender === win.webContents,
    runRuntimeBridgePromise: payload =>
      handleFabric(payload, {root: fixture, userDataDir: fixture}),
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
      activation: {wake_mode: 'wiggle_hotkey'},
      shortcuts: {wake: 'Control+Alt+M', text_mode: 'Control+Alt+T'},
    },
    globalShortcut: {isRegistered: key => key === 'Control+Alt+M'},
    currentPointerPollingPolicy: () => ({
      detectWiggle: true,
      detectMouseButton: false,
    }),
    dashboardWindow: {
      isDestroyed: () => false,
      hide: () => hides++,
      show() {},
      focus() {},
    },
    startPointerInputStateStream() {},
    dismissTemporarySurfaces() {},
    applyConfiguredWakeState() {},
    refreshTrayMenu() {},
    requestActivation: reason => {
      calls.push(reason);
      return 'renderer_warming';
    },
    setTimeout: callback => {
      context.pointerStateSequence++;
      context.pointerInputState = {
        foregroundHwnd: 99,
        foregroundProcessId: 456,
      };
      callback();
    },
  });
  vm.runInContext(
    ts.transpileModule([...functions, ...registrations].join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  const fixtures = {
    'conversations:list': () => [conversation],
    'conversations:get': () => conversation,
    'conversations:stats': () => null,
    'conversations:recovery': () => ({ok: true, pending: []}),
    'conversations:subagents': () => ({ok: true, tasks: []}),
    'dashboard:settings:get': () => ({
      ok: true,
      settings: {appearance: {theme: 'light'}},
      modelStatus: {},
    }),
    'models:catalog': () => ({
      ok: true,
      catalog: {current: 'fixture', groups: []},
    }),
    'models:quota': () => ({
      ok: false,
      error: 'No model for this UI acceptance',
    }),
    'slash:directory': () => ({items: [], commands: [], skills: []}),
    'updates:status': () => ({state: 'idle'}),
    'figma:status': () => ({ok: true, connected: false}),
    'projects:environment': () => ({ok: true, isGit: false}),
    'window:command': () => ({ok: true}),
  };
  const preload = fs.readFileSync(
    path.join(root, 'electron/preload.ts'),
    'utf8',
  );
  for (const match of preload.matchAll(
    /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g,
  )) {
    const channel = match[1];
    if (channels.includes(channel)) continue;
    channels.push(channel);
    ipcMain.handle(channel, () => fixtures[channel]?.() ?? []);
  }
  const checks = [];
  const check = (condition, name) => {
    assert(condition, name);
    checks.push(name);
  };
  async function waitFor(expression) {
    for (let index = 0; index < 100; index++) {
      if (
        await win.webContents.executeJavaScript(expression).catch(() => false)
      )
        return;
      await delay(40);
    }
    throw Error(`Timed out: ${expression}`);
  }
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(root, 'build/electron/renderer/studio.html'));
    await waitFor(
      "document.querySelector('.mp-perception-state')?.textContent === 'Ready to point'",
    );
    check(
      calls.includes('desktop-perception:status'),
      'whole Studio uses production preload and main status handler',
    );
    await js("document.querySelector('.mp-desktop-perception').open=true");
    await js("document.querySelector('.mp-perception-action').click()");
    await waitFor("!document.querySelector('.mp-perception-action').disabled");
    check(
      hides === 1 && calls.includes('studio-perception'),
      'whole Studio activates through production target-transition handler',
    );
    await js("document.querySelector('[data-perception-pause]').click()");
    await waitFor(
      "document.querySelector('.mp-perception-state').textContent === 'Paused'",
    );
    check(
      context.inputPaused === true,
      'pause uses the real main runtime variable',
    );
    await js("document.querySelector('[data-perception-pause]').click()");
    await waitFor(
      "document.querySelector('.mp-perception-state').textContent === 'Ready to point'",
    );
    check(
      context.inputPaused === false,
      'resume re-enables real desktop activation state',
    );
    await js("document.querySelector('[data-perception-settings]').click()");
    await waitFor("document.querySelector('[data-page=interaction]') !== null");
    check(true, 'wake settings opens real interaction settings page');
    await js(
      "document.querySelector('[data-settings-close]').click();openConversation('desktop-fixture')",
    );
    await waitFor(
      "document.querySelector('[data-source-id=screen-source]') !== null",
    );
    await js(
      "document.querySelector('[data-source-id=screen-source]').click()",
    );
    await waitFor(
      "document.getElementById('task-material-detail')?.textContent.includes('Acceptance window')",
    );
    check(true, 'saved source opens production material inspector');
    await js("setInspector(false);openSettingsPage('plugins')");
    await waitFor(
      "document.querySelectorAll('.mp-settings-plugin-row').length === 3",
    );
    check(
      await js("document.querySelectorAll('[data-plugin-toggle]').length===2"),
      'real inventory shows configured, disabled and invalid without fake toggle',
    );
    check(
      !fs.existsSync(path.join(fixture, 'plugin-executed')),
      'inventory does not execute plugin code',
    );
    await js("document.querySelector('[data-plugin-toggle=enabled]').click()");
    await waitFor(
      "document.querySelector('[data-plugin-toggle=enabled]')?.getAttribute('aria-checked') === 'false' && !document.querySelector('[data-plugin-toggle=enabled]').disabled",
    );
    check(
      JSON.parse(
        fs.readFileSync(patchPath, 'utf8'),
      ).disabledPluginDirectories.includes('enabled'),
      'toggle persists via real extension handler and Runtime storage',
    );
    const saved = fs.readFileSync(patchPath, 'utf8');
    fs.writeFileSync(patchPath, '{invalid');
    await js("document.querySelector('[data-plugin-toggle=enabled]').click()");
    await waitFor(
      "document.getElementById('settings-save-status')?.dataset.state === 'error'",
    );
    check(
      await js(
        "document.querySelector('[data-plugin-toggle=enabled]')?.getAttribute('aria-checked') === 'false'",
      ),
      'failed save preserves disabled state and visible error',
    );
    fs.writeFileSync(patchPath, saved);
    await js("document.querySelector('[data-plugin-toggle=enabled]').click()");
    await waitFor(
      "document.querySelector('[data-plugin-toggle=enabled]')?.getAttribute('aria-checked') === 'true'",
    );
    check(
      true,
      'failed toggle can retry after correcting actual storage error',
    );
    await js(
      "const f=document.querySelector('[data-plugin-filter]');f.value='disabled';f.dispatchEvent(new Event('change',{bubbles:true}))",
    );
    check(
      await js(
        "document.querySelectorAll('.mp-settings-plugin-row').length === 1",
      ),
      'disabled filter reflects real configuration',
    );
    await js(
      "document.querySelector('[data-plugin-filter]').value='all';document.querySelector('[data-plugin-filter]').dispatchEvent(new Event('change',{bubbles:true}));applyStudioLanguage('zh-CN');window.dispatchEvent(new Event('mp:language-change'));renderSettings()",
    );
    check(
      await js(
        "document.querySelector('.mp-settings-plugins').textContent.includes('更改对新任务生效')",
      ),
      'plugin state and next-task effect are localized',
    );
    for (const [theme, width] of [
      ['light', 1280],
      ['dark', 1280],
      ['dark', 760],
    ]) {
      win.setContentSize(width, 900);
      await js(
        `document.documentElement.dataset.theme='${theme}';document.body.toggleAttribute('data-ds-dark-theme','${theme}'==='dark')`,
      );
      await js(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      win.webContents.invalidate();
      await delay(250);
      check(
        await js('document.documentElement.scrollWidth<=innerWidth'),
        `plugin settings ${theme} ${width} has no horizontal overflow`,
      );
      fs.writeFileSync(
        path.join(out, `plugins-${theme}-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    await js(
      "document.querySelector('[data-settings-close]').click();document.querySelector('.mp-desktop-perception').open=true",
    );
    await waitFor("document.getElementById('view-settings').hidden");
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    win.webContents.invalidate();
    await delay(350);
    fs.writeFileSync(
      path.join(out, 'perception-dark-760.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    check(
      !fs.existsSync(path.join(fixture, 'plugin-executed')),
      'no user or acceptance plugin was executed during settings inspection',
    );
    check(
      errors.length === 0,
      `renderer and preload errors: ${JSON.stringify(errors)}`,
    );
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(
        {
          checks,
          calls,
          errors,
          fixture,
          backend:
            'production Studio/preload/main handler/handleFabric; isolated native window callbacks and unrelated app data',
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({checks: checks.length, errors, out}));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'failure.json'),
      JSON.stringify({checks, calls, errors, error: String(error)}, null, 2),
    );
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});

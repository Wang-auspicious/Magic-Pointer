import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runAgent, type ModelRequest} from '../electron/runtime/agent';
import {
  DesktopActionSession,
  isWindowProcessAlive,
  registerDesktopTools,
  type DesktopWindow,
} from '../electron/runtime/desktop';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';

function makeWindow(overrides: Partial<DesktopWindow> = {}): DesktopWindow {
  return {
    hwnd: 1001,
    pid: process.pid,
    process_name: 'notepad.exe',
    title: 'Untitled - Notepad',
    bbox: [100, 100, 900, 700],
    focused: true,
    ...overrides,
  };
}

test('CU-V2-W1-Red: dynamic per-turn Autopilot & GuidedSteps reach the model even when session already froze a Turn-1 Learn prompt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-cuv2-turn-'));
  try {
    const session = await EventSession.open(root, 'cuv2-frozen');
    const registry = new ToolRegistry();
    const seenRequests: ModelRequest[] = [];

    // Turn 1: ordinary Learn chat without computerUseMode -> freezes Learn system prompt
    await runAgent({
      root,
      userDataDir: root,
      workMode: 'learn',
      instruction: '讲一下橙星动效怎么做的',
      session,
      registry,
      model: async request => {
        seenRequests.push(request);
        return {text: '就是用 keyframes 做脉冲光效。', tool_calls: []};
      },
    });

    // Turn 2: user clicks Autopilot with guidedTourSteps in the SAME frozen session
    await runAgent({
      root,
      userDataDir: root,
      workMode: 'learn',
      instruction: 'Run guided steps (2)',
      computerUseMode: 'autopilot',
      guidedTourSteps: [
        {label: '打开记事本'},
        {label: '输入橙星动效原理'},
      ],
      cuDesktopStatus: {
        active: true,
        desktopName: 'MagicPointer_AgentDesktop',
        windows: [{hwnd: 202, title: 'Notepad'}],
      },
      session,
      registry,
      model: async request => {
        seenRequests.push(request);
        return {text: '已完成操作', tool_calls: []};
      },
    });

    const turn2 = seenRequests[1]!;
    const turn2AllText = [
      turn2.system,
      ...turn2.messages.map(m => String(m.content || '')),
    ].join('\n');
    assert.match(turn2AllText, /Computer Use Autopilot Mode/);
    assert.match(turn2AllText, /打开记事本/);
    assert.match(turn2AllText, /输入橙星动效原理/);
    assert.match(turn2AllText, /DesktopWorkspace\./);
    assert.match(turn2AllText, /list_windows/);

    // Turn 3: normal question without computerUseMode -> must NOT stay stuck in Autopilot
    await runAgent({
      root,
      userDataDir: root,
      workMode: 'learn',
      instruction: '谢谢，继续聊聊原理',
      session,
      registry,
      model: async request => {
        seenRequests.push(request);
        return {text: '好，接着聊。', tool_calls: []};
      },
    });
    const turn3 = seenRequests[2]!;
    const turn3AllText = [
      turn3.system,
      ...turn3.messages.map(m => String(m.content || '')),
    ].join('\n');
    assert.doesNotMatch(turn3AllText, /Computer Use Autopilot Mode/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('CU-V2-W1-Red: list_windows & window_manage are registered, eager in CU mode, and resolveWindow includes available windows on miss', async () => {
  const desktop = new DesktopActionSession('eager-test');
  const fakeWindows: DesktopWindow[] = [
    makeWindow({hwnd: 5001, pid: 1111, process_name: 'notepad.exe', title: 'Notes.txt - Notepad'}),
    makeWindow({hwnd: 5002, pid: 2222, process_name: 'calc.exe', title: 'Calculator'}),
  ];
  desktop.observation.windows = async () => fakeWindows;

  const registry = new ToolRegistry();
  registerDesktopTools(
    registry,
    desktop,
    undefined,
    undefined,
    undefined,
    {eagerDesktopTools: true},
  );

  for (const name of [
    'list_windows',
    'list_apps',
    'window_manage',
    'get_app_state',
    'observe_ui',
    'launch_app',
    'activate_window',
    'click',
    'type_text',
    'press_key',
    'scroll',
  ]) {
    const spec = registry.get(name);
    assert.equal(
      spec.deferred,
      false,
      `Tool ${name} must have deferred=false when eagerDesktopTools=true`,
    );
  }

  const listed = (await registry
    .get('list_windows')
    .execute(
      {},
      {signal: new AbortController().signal, tool_call_id: 'test-list'},
    )) as {
    windows: DesktopWindow[];
  };
  assert.equal(listed.windows.length, 2);
  assert.equal(listed.windows[0]!.window_id, 'w-5001');

  await assert.rejects(
    desktop.resolveWindow({app: 'NonExistentApp'}),
    (error: Error) => {
      assert.match(error.message, /Notes\.txt - Notepad/);
      assert.match(error.message, /Calculator/);
      return true;
    },
  );
});

test('CU-V2-W1-Red: press_key(enter) is reversible_write on normal apps and external_send only on messaging apps or explicit send intent', () => {
  const desktop = new DesktopActionSession('effect-test');
  desktop.snapshots.set('snap-notepad', {
    snapshot_id: 'snap-notepad',
    state_id: 'snap-notepad',
    window: makeWindow({hwnd: 7001, process_name: 'notepad.exe', title: 'Notepad'}),
    windows: [],
    elements: [],
    root_ref: '@r1',
    mode: 'ax',
  });
  desktop.snapshots.set('snap-wechat', {
    snapshot_id: 'snap-wechat',
    state_id: 'snap-wechat',
    window: makeWindow({hwnd: 7002, process_name: 'WeChat.exe', title: 'WeChat'}),
    windows: [],
    elements: [],
    root_ref: '@r2',
    mode: 'ax',
  });

  const registry = new ToolRegistry();
  registerDesktopTools(registry, desktop);

  assert.equal(
    registry.effect('press_key', {state_id: 'snap-notepad', keys: 'enter'}),
    'reversible_write',
  );
  assert.equal(
    registry.effect('press_key', {keys: 'enter'}),
    'reversible_write',
  );
  assert.equal(
    registry.effect('press_key', {
      state_id: 'snap-notepad',
      keys: 'enter',
      intent: 'send',
    }),
    'external_send',
  );
  assert.equal(
    registry.effect('press_key', {state_id: 'snap-wechat', keys: 'enter'}),
    'external_send',
  );
});

test('CU-V2-W1-Red: cuAutoGrant auto-binds ungranted windows in auto/autopilot mode while preserving safe-mode boundary', async () => {
  const desktop = new DesktopActionSession('grant-test');
  const win = makeWindow({hwnd: 8001, pid: 3333, title: 'Calculator'});
  desktop.observation.windows = async () => [win];
  desktop.observation.elements = async () => [
    {
      index: 1,
      hwnd: 8001,
      name: 'Equals',
      role: 'button',
      rect: [200, 200, 260, 240],
      runtime_id: [1, 2],
      patterns: ['Invoke'],
    },
  ];

  const grants = new Set<string>();
  const authorizeAccess = (req: {windowIds?: string[]}) => {
    const missing = (req.windowIds || []).find(id => !grants.has(id));
    return missing
      ? {allowed: false, reason: `window_not_granted:${missing}`}
      : {allowed: true, reason: 'ok'};
  };

  // Strict safe mode still blocks ungranted windows
  const safeRegistry = new ToolRegistry();
  registerDesktopTools(
    safeRegistry,
    desktop,
    authorizeAccess,
    undefined,
    undefined,
    {
      autoBindWindows: false,
    },
  );
  await assert.rejects(
    async () =>
      safeRegistry.get('get_app_state').execute(
        {hwnd: 8001},
        {signal: new AbortController().signal, tool_call_id: 'test-safe'},
      ),
    /window_not_granted:w-8001/,
  );

  // cuAutoGrant mode automatically acquires the target window before reading/acting
  const autoRegistry = new ToolRegistry();
  registerDesktopTools(
    autoRegistry,
    desktop,
    authorizeAccess,
    w => {
      grants.add(`w-${w.hwnd}`);
    },
    undefined,
    {autoBindWindows: true},
  );
  const state = (await autoRegistry.get('get_app_state').execute(
    {hwnd: 8001, pixels: false},
    {signal: new AbortController().signal, tool_call_id: 'test-auto'},
  )) as {
    state_id: string;
    window: DesktopWindow;
  };
  assert.equal(state.window.hwnd, 8001);
  assert.ok(grants.has('w-8001'));
});

test('CU-V2-W1-Red: isWindowProcessAlive distinguishes live pids from exited dead pids', () => {
  assert.equal(isWindowProcessAlive(process.pid), true);
  assert.equal(isWindowProcessAlive(999999), false);
  assert.equal(isWindowProcessAlive(0), false);
  assert.equal(isWindowProcessAlive(undefined), false);
});

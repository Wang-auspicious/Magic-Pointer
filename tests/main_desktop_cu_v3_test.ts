import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildSystemPrompt} from '../electron/runtime/agent';
import {desktopSession, registerDesktopTools} from '../electron/runtime/desktop';
import {egoBrowserModule} from '../electron/runtime/ego_browser_module';
import {ToolRegistry} from '../electron/runtime/tools';
import {CuOverlayController} from '../electron/cu_live_overlay';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('CU-V3-Red: main.ts never minimizes Studio inside cu-overlay:autopilot-start', () => {
  const mainSrc = readRepo('electron/main.ts');
  const idx = mainSrc.indexOf("'cu-overlay:autopilot-start'");
  assert.ok(idx > 0, 'cu-overlay:autopilot-start handler must exist');
  const handlerSlice = mainSrc.slice(idx, idx + 1500);
  const nextHandlerIdx = handlerSlice.indexOf('ipcMain.handle(', 20);
  const body = nextHandlerIdx > 0 ? handlerSlice.slice(0, nextHandlerIdx) : handlerSlice;
  assert.doesNotMatch(
    body,
    /dashboardWindow\.minimize\s*\(/,
    'cu-overlay:autopilot-start must never minimize Studio window automatically',
  );
});

test('CU-V3-Red: CuOverlayController tracks nextStep + thinking phase and cu_live_overlay.html renders them', () => {
  const ctrl = new CuOverlayController();
  const state = ctrl.startAutopilot({
    windowTitle: 'Chrome',
    actionLabel: '点击搜索框',
    nextStep: '输入关键词并按回车',
    phase: 'thinking',
  } as unknown as Parameters<CuOverlayController['startAutopilot']>[0]);
  assert.equal((state as unknown as {nextStep?: string}).nextStep, '输入关键词并按回车');
  assert.equal((state as unknown as {phase?: string}).phase, 'thinking');

  const html = readRepo('electron/renderer/cu_live_overlay.html');
  assert.match(html, /state\.nextStep/, 'HUD overlay must render nextStep');
  assert.match(html, /state\.phase/, 'HUD overlay must distinguish thinking vs acting phase');
});

test('CU-V3-Red: registerDesktopTools exposes eager desktop_batch & zoom_screen and emits live cursor events; Main Desktop leads Autopilot prompt', async () => {
  const registry = new ToolRegistry();
  const cursorEvents: Array<Record<string, unknown>> = [];
  const session = desktopSession(`cu-v3-${Date.now()}`);
  registerDesktopTools(
    registry,
    session,
    undefined,
    undefined,
    undefined,
    {
      eagerDesktopTools: true,
      autoBindWindows: true,
      onCursorEvent: ev => {
        cursorEvents.push(ev as unknown as Record<string, unknown>);
      },
    },
  );

  const batchTool = registry.get('desktop_batch');
  const zoomTool = registry.get('zoom_screen');
  assert.equal(batchTool.deferred, false, 'desktop_batch must be eager in CU mode');
  assert.equal(zoomTool.deferred, false, 'zoom_screen must be eager in CU mode');

  // Verify resolveWindow rehydrates restarted window handle via prior snapshot process_name + title
  const oldWin = {
    hwnd: 11111,
    pid: 22222,
    process_name: 'chrome.exe',
    class_name: 'Chrome_WidgetWin_1',
    title: 'GitHub - Google Chrome',
    bbox: [100, 100, 1100, 800] as [number, number, number, number],
    focused: true,
    desktop: 'default' as const,
  };
  session.snapshots.set('snap-old', {
    snapshot_id: 'snap-old',
    state_id: 'snap-old',
    window: oldWin,
    windows: [oldWin],
    elements: [
      {
        index: 1,
        hwnd: 11111,
        name: 'Search',
        role: 'button',
        rect: [200, 200, 300, 240],
        runtime_id: [1, 1],
        patterns: ['Invoke'],
      },
    ],
    root_ref: '@r1',
    mode: 'ax',
  });
  const restartedWin = {
    ...oldWin,
    hwnd: 33333,
    pid: process.pid,
  };
  session.observation.windows = async () => [restartedWin];
  const resolved = await session.resolveWindow({hwnd: 11111});
  assert.equal(resolved.hwnd, 33333, 'resolveWindow must rehydrate restarted HWND');

  // Verify live get_app_state emits thinking agent_cursor event automatically
  session.observation.elements = async () => [
    {
      index: 1,
      hwnd: 33333,
      name: 'Search',
      role: 'button',
      rect: [200, 200, 300, 240],
      runtime_id: [1, 1],
      patterns: ['Invoke'],
    },
  ];
  await registry.get('get_app_state').execute(
    {hwnd: 33333, pixels: false, label: '查看浏览器', next_step: '点击搜索栏'},
    {signal: new AbortController().signal, tool_call_id: 'test-cursor-observe'},
  );
  assert.ok(
    cursorEvents.some(
      e =>
        e.action === 'move' &&
        e.phase === 'thinking' &&
        e.caption === '查看浏览器' &&
        e.nextStep === '点击搜索栏',
    ),
    `Expected live cursor event with caption+nextStep, got ${JSON.stringify(cursorEvents)}`,
  );

  const prompt = await buildSystemPrompt({
    userDataDir: os.tmpdir(),
    workMode: 'code',
    instruction: '在浏览器里帮我操作当前页面',
    computerUseMode: 'autopilot',
  });
  const mainDesktopIdx = prompt.indexOf('list_windows');
  const secondDesktopIdx = prompt.indexOf('DesktopWorkspace.');
  assert.ok(
    mainDesktopIdx > 0 && (secondDesktopIdx < 0 || mainDesktopIdx < secondDesktopIdx),
    'Autopilot prompt must prioritize Main Desktop over Isolated Second Desktop',
  );
});

test('CU-V3-Red: EgoBrowser.act uses smart effect_for (reversible_write for click/fill, external_send/destructive only on real send/delete)', () => {
  const mod = egoBrowserModule('cu-v3-browser');
  const actSpec = (mod.commands || []).find(c => c.tool.name === 'EgoBrowser.act')?.tool;
  assert.ok(actSpec, 'EgoBrowser.act must exist');
  assert.equal(typeof actSpec.effect_for, 'function', 'EgoBrowser.act must define dynamic effect_for');

  const benignEffect = actSpec.effect_for!(
    {
      actions: [
        {action: 'click', selector: 'button#search'},
        {action: 'fill', selector: 'input[name="q"]', value: 'transformer'},
      ],
    },
  );
  assert.equal(benignEffect, 'reversible_write');

  const sendEffect = actSpec.effect_for!(
    {
      actions: [{action: 'click', selector: 'button[type="submit"].send-email'}],
    },
  );
  assert.equal(sendEffect, 'external_send');

  const deleteEffect = actSpec.effect_for!(
    {
      actions: [{action: 'click', selector: 'button[data-action="delete-account"]'}],
    },
  );
  assert.equal(deleteEffect, 'destructive');
});

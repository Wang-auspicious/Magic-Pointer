import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {buildSystemPrompt, runAgent, type ModelReply} from '../electron/runtime/agent';
import {initialToolNames} from '../electron/runtime/agent_services';
import * as desktopMod from '../electron/runtime/desktop';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('CU-V4-Red: runAgent never appends 任务尚未全部完成/已执行，待核对 spam and chat_view strips legacy dumps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-cu-clean-'));
  const session = await EventSession.open(root, 'clean-answer');
  const registry = new ToolRegistry();
  registry.register({
    name: 'click',
    description: 'mock unverified desktop click',
    input_schema: {type: 'object', properties: {}, required: [], additionalProperties: true},
    effect: 'reversible_write',
    execute: () => ({ok: true, verification: {matched: false, status: 'unavailable'}}),
  });
  let round = 0;
  const result = await runAgent({
    root,
    userDataDir: root,
    session,
    registry,
    permissionMode: 'bypass',
    model: async (): Promise<ModelReply> =>
      ++round === 1
        ? {text: '', tool_calls: [{id: 'c1', name: 'click', arguments: {x: 10, y: 10}}]}
        : {text: '已为你完成点击。', tool_calls: []},
  });
  assert.equal(result.receipt.status, 'unverified');
  assert.equal(result.message, '已为你完成点击。');
  assert.doesNotMatch(result.message, /任务尚未全部完成|已执行，待核对|执行失败/);

  const chatViewSrc = readRepo('electron/renderer/chat_view.ts');
  assert.match(
    chatViewSrc,
    /已执行，待核对\|执行失败\|结果未知/,
    'chat_view legacy cleaner must strip unfinished tool status lines',
  );
  assert.match(
    chatViewSrc,
    /desktop:\\S\+|Target|目标/,
    'chat_view legacy cleaner must also match desktop:<uuid> targets and summary lines',
  );
});

test('CU-V4-Red: desktop CU defaults to visible foreground mouse, registers eager inspect_tray, and allows direct screen clicks', async () => {
  const desktopSrc = readRepo('electron/runtime/desktop.ts');
  assert.match(
    desktopSrc,
    /const delivery = String\(params\.delivery \|\| 'foreground'\)/,
    'sendDesktopInput must default delivery to foreground so real mouse movement is visible',
  );

  const registry = new ToolRegistry();
  const cursorEvents: Array<Record<string, unknown>> = [];
  const session = desktopMod.desktopSession(`cu-v4-${Date.now()}`);
  desktopMod.registerDesktopTools(
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
  const trayTool = registry.get('inspect_tray');
  assert.ok(trayTool, 'inspect_tray tool must be registered');
  assert.equal(trayTool?.deferred, false, 'inspect_tray must be eager in desktop CU mode');

  const autopilotTools = initialToolNames({
    workMode: 'code',
    permissionMode: 'default',
    computerUseMode: 'autopilot',
    cuDaemonAvailable: true,
    liveBrowserAvailable: true,
  });
  assert.ok(
    autopilotTools.includes('inspect_tray'),
    'initialToolNames in autopilot mode must expose inspect_tray immediately',
  );

  if (process.platform === 'win32') {
    try {
      const cur = await desktopMod.nativeRequest<{
        x: number;
        y: number;
        foreground: number;
      }>('cursor');
      try {
        const moved = await session.call('move', {
          coordinate_space: 'screen',
          x: cur.x,
          y: cur.y,
          label: '测试屏幕直达移动',
        });
        assert.equal(moved.ok, true);
        assert.equal(moved.usedBackend, 'win32_send_input');
      } catch (err) {
        if (cur.foreground === 0) {
          assert.match(String(err), /cursor_position_failed/);
        } else {
          throw err;
        }
      }
      assert.ok(
        cursorEvents.some(e => e.action === 'move' && e.x === cur.x && e.y === cur.y),
        'screen_direct move must emit cursor overlay event',
      );
    } finally {
      desktopMod.closeDesktop();
    }
  }
});

test(
  'CU-V4-Red: desktop_host implements smooth GlideCursor, keeps cursor at target by default, and supports live read-only tray_icons',
  {skip: process.platform !== 'win32', timeout: 30000},
  async () => {
    const csSrc = readRepo('scripts/desktop_host.cs');
    assert.match(csSrc, /GlideCursor/, 'desktop_host.cs must implement GlideCursor');
    assert.match(
      csSrc,
      /Get\(a,\s*"restore_cursor",\s*false\)\.Equals\(true\)/,
      'desktop_host.cs must NOT snap cursor back unless restore_cursor is explicitly true',
    );
    assert.match(csSrc, /method=="tray_icons"/, 'desktop_host.cs must dispatch tray_icons');

    const inspectTrayIcons = (
      desktopMod as unknown as {
        inspectTrayIcons?: () => Promise<{
          ok: boolean;
          taskbar?: {
            hwnd?: number;
            bbox?: number[];
            autoHide?: boolean;
            screen?: {width?: number; height?: number};
            revealPoint?: {x?: number; y?: number};
          };
          chevron?: {name?: string; x: number; y: number} | null;
          icons?: Array<{name: string; x: number; y: number; container?: string}>;
          menuItems?: Array<{name: string; x: number; y: number}>;
          usedBackend?: string;
        }>;
      }
    ).inspectTrayIcons;
    assert.equal(typeof inspectTrayIcons, 'function', 'desktop.ts must export inspectTrayIcons');

    try {
      const tray = await inspectTrayIcons!();
      assert.equal(tray.ok, true);
      assert.equal(tray.usedBackend, 'win32_tray_uia');
      assert.ok(
        Number(tray.taskbar?.screen?.width) > 0 &&
          Number.isFinite(Number(tray.taskbar?.revealPoint?.x)),
        'tray_icons must report live screen dimensions and revealPoint',
      );
      if (Number(tray.taskbar?.hwnd) > 0) {
        assert.ok(
          Array.isArray(tray.taskbar?.bbox) &&
            tray.taskbar!.bbox![2] - tray.taskbar!.bbox![0] > 100,
          'tray_icons must report live Shell_TrayWnd bbox width > 100 when Shell_TrayWnd is attached',
        );
      }
      assert.ok(Array.isArray(tray.icons), 'tray_icons must return icons array');
      assert.ok(Array.isArray(tray.menuItems), 'tray_icons must return menuItems array');
    } finally {
      desktopMod.closeDesktop();
    }
  },
);

test('CU-V4-Red: Autopilot prompt teaches inspect_tray tray-exit workflow and avoids elevated Task Manager', async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-prompt-'));
  const prompt = await buildSystemPrompt({
    userDataDir,
    workMode: 'code',
    permissionMode: 'default',
    computerUseMode: 'autopilot',
  });
  assert.match(prompt, /inspect_tray/, 'Autopilot prompt must teach inspect_tray');
  assert.match(prompt, /Quit|退出/, 'Autopilot prompt must mention Quit/退出 menu path');
  assert.match(
    prompt,
    /target_elevated|Task Manager|任务管理器/,
    'Autopilot prompt must warn against opening elevated Task Manager',
  );
  assert.match(
    prompt,
    /foreground|实屏|真实鼠标/,
    'Autopilot prompt must describe visible foreground mouse control',
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {buildSystemPrompt} from '../electron/runtime/agent';
import {initialToolNames} from '../electron/runtime/agent_services';
import * as desktopMod from '../electron/runtime/desktop';
import {ToolRegistry} from '../electron/runtime/tools';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('GLOBAL-CU-Red: see_screen & inspect_at are registered eagerly and exposed on first turn in Autopilot/Code while Learn stays lightweight', () => {
  const registry = new ToolRegistry();
  const session = desktopMod.desktopSession(`global-cu-${Date.now()}`);
  desktopMod.registerDesktopTools(
    registry,
    session,
    undefined,
    undefined,
    undefined,
    {
      eagerDesktopTools: true,
      autoBindWindows: true,
    },
  );
  const seeScreen = registry.get('see_screen');
  assert.ok(seeScreen, 'see_screen tool must be registered');
  assert.equal(seeScreen?.deferred, false, 'see_screen must be eager');
  assert.equal(seeScreen?.effect, 'read');

  const inspectAt = registry.get('inspect_at');
  assert.ok(inspectAt, 'inspect_at tool must be registered');
  assert.equal(inspectAt?.deferred, false, 'inspect_at must be eager');
  assert.equal(inspectAt?.effect, 'read');

  const autopilotTools = initialToolNames({
    workMode: 'code',
    permissionMode: 'default',
    computerUseMode: 'autopilot',
    cuDaemonAvailable: true,
  });
  assert.ok(autopilotTools.includes('see_screen'));
  assert.ok(autopilotTools.includes('inspect_at'));

  const codeCuTools = initialToolNames({
    workMode: 'code',
    permissionMode: 'accept_reversible',
    cuDaemonAvailable: true,
  });
  assert.ok(codeCuTools.includes('see_screen'));
  assert.ok(codeCuTools.includes('inspect_at'));

  const learnTools = initialToolNames({
    workMode: 'learn',
    permissionMode: 'default',
    cuDaemonAvailable: true,
  });
  assert.equal(
    learnTools.includes('see_screen'),
    false,
    'Learn default tool list must stay lightweight without desktop see_screen',
  );
});

test(
  'GLOBAL-CU-Red: desktop_host implements desktop_overview, element_at, EnumDisplayMonitors, and universal screen_direct',
  {skip: process.platform !== 'win32', timeout: 30000},
  async () => {
    const csSrc = readRepo('scripts/desktop_host.cs');
    assert.match(csSrc, /method=="desktop_overview"/);
    assert.match(csSrc, /method=="element_at"/);
    assert.match(csSrc, /EnumDisplayMonitors/);
    assert.match(csSrc, /ReadClipboardSummary/);
    assert.match(csSrc, /!pointer&&screenDirect/);

    const desktopOverview = (
      desktopMod as unknown as {
        desktopOverview?: (
          options?: {includeClipboard?: boolean},
          signal?: AbortSignal,
        ) => Promise<{
          ok: boolean;
          monitors?: Array<{bbox: number[]}>;
          virtualScreen?: number[];
          windows?: unknown[];
          activeOverlays?: unknown[];
          cursor?: {x: number; y: number};
          usedBackend?: string;
        }>;
      }
    ).desktopOverview;
    const inspectAtPoint = (
      desktopMod as unknown as {
        inspectAtPoint?: (
          x: number,
          y: number,
          signal?: AbortSignal,
        ) => Promise<{
          ok: boolean;
          siblings?: unknown[];
          usedBackend?: string;
        }>;
      }
    ).inspectAtPoint;

    assert.equal(typeof desktopOverview, 'function', 'desktop.ts must export desktopOverview');
    assert.equal(typeof inspectAtPoint, 'function', 'desktop.ts must export inspectAtPoint');

    try {
      const overview = await desktopOverview!({includeClipboard: false});
      assert.equal(overview.ok, true);
      assert.equal(overview.usedBackend, 'win32_desktop_overview');
      assert.ok(Array.isArray(overview.monitors) && overview.monitors.length >= 1);
      assert.ok(Array.isArray(overview.virtualScreen) && overview.virtualScreen.length === 4);
      assert.ok(Array.isArray(overview.windows));
      assert.ok(Array.isArray(overview.activeOverlays));
      assert.equal(typeof overview.cursor?.x, 'number');

      const probe = await inspectAtPoint!(10, 10);
      assert.equal(probe.ok, true);
      assert.equal(probe.usedBackend, 'win32_element_at');
      assert.ok(Array.isArray(probe.siblings));
    } finally {
      desktopMod.closeDesktop();
    }
  },
);

test('GLOBAL-CU-Red: DesktopActionSession maps 0..1000 normalized screen coords and supports direct drag/type_text/press_key', () => {
  const session = desktopMod.desktopSession(`global-norm-${Date.now()}`) as desktopMod.DesktopActionSession & {
    lastScreenBounds?: [number, number, number, number];
    resolveScreenPoint?: (
      args: Record<string, unknown>,
      keys?: [string, string],
    ) => {x: number; y: number};
  };
  assert.equal(
    typeof session.resolveScreenPoint,
    'function',
    'DesktopActionSession must expose resolveScreenPoint',
  );
  session.lastScreenBounds = [0, 0, 3120, 2080];
  const pt = session.resolveScreenPoint!({
    coordinate_space: 'normalized',
    x: 500,
    y: 500,
  });
  assert.deepEqual(pt, {x: 1560, y: 1040});

  const desktopSrc = readRepo('electron/runtime/desktop.ts');
  assert.match(desktopSrc, /\['click', 'move', 'scroll', 'drag'\]\.includes\(name\)/);
  assert.match(desktopSrc, /\['type_text', 'press_key'\]\.includes\(name\)/);
});

test('GLOBAL-CU-Red: Autopilot and Code prompts teach universal see_screen -> inspect_at -> screen-space control loop', async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-global-cu-'));
  const autopilotPrompt = await buildSystemPrompt({
    userDataDir,
    workMode: 'code',
    permissionMode: 'default',
    computerUseMode: 'autopilot',
  });
  assert.match(autopilotPrompt, /see_screen/);
  assert.match(autopilotPrompt, /inspect_at/);

  const codePrompt = await buildSystemPrompt({
    userDataDir,
    workMode: 'code',
    permissionMode: 'accept_reversible',
  });
  assert.match(codePrompt, /see_screen/);
  assert.match(codePrompt, /inspect_at/);
});

import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  CuDesktopHostClient,
  registerCuDesktopTools,
} from '../electron/runtime/cu_desktop_tools';
import {
  isWindowProcessAlive,
  nativeRequest,
  closeDesktop,
} from '../electron/runtime/desktop';
import {ToolRegistry} from '../electron/runtime/tools';

test(
  'CU-V2-W2-Red: isolated Win32 Second Desktop runs real Notepad, captures non-blank JPEG, types/clicks without moving physical cursor, and cleans up process',
  {skip: process.platform !== 'win32', timeout: 45000},
  async () => {
    const client = new CuDesktopHostClient();
    let launchedPid = 0;
    try {
      const opened = await client.open({
        width: 1280,
        height: 720,
        name: `MP_TestDesk_${process.pid}`,
      });
      assert.equal(opened.ok, true);
      assert.match(String(opened.desktopName || ''), /MP_TestDesk_/);

      const cursorBefore = await nativeRequest<{x: number; y: number}>('cursor');

      const launched = await client.launch({app: 'notepad'});
      assert.equal(launched.ok, true);
      launchedPid = Number(launched.pid || 0);
      assert.ok(launchedPid > 0, 'Notepad pid must be positive');
      assert.ok(launched.window?.hwnd, 'Notepad window must appear on Second Desktop');
      assert.equal(launched.window?.desktop, 'agent');

      const frame1 = await client.capture({quality: 80});
      assert.equal(frame1.ok, true);
      assert.equal(frame1.mimeType, 'image/jpeg');
      assert.equal(frame1.width, 1280);
      assert.equal(frame1.height, 720);
      const buf1 = Buffer.from(String(frame1.image || ''), 'base64');
      assert.ok(
        buf1.length > 5000,
        `Captured Second Desktop JPEG should be > 5KB, got ${buf1.length}`,
      );
      const raw1 = await sharp(buf1)
        .resize(160, 90, {fit: 'fill'})
        .raw()
        .toBuffer();
      const uniqueBytes = new Set(raw1.subarray(0, 600));
      assert.ok(uniqueBytes.size > 8, 'Captured frame must not be uniform/blank');

      // Click near center of launched Notepad window and type text completely inside hDesktop
      const bbox = launched.window!.bbox as [number, number, number, number];
      const cx = Math.round((bbox[0] + bbox[2]) / 2);
      const cy = Math.round((bbox[1] + bbox[3]) / 2);

      const clicked = await client.act({
        action: 'click',
        x: cx,
        y: cy,
        hwnd: launched.window!.hwnd,
      });
      assert.equal(clicked.ok, true);

      const sampleText = 'SecondDesktop_Hello_123';
      const typed = await client.act({
        action: 'type_text',
        text: sampleText,
        hwnd: launched.window!.hwnd,
      });
      assert.equal(typed.ok, true);

      // Physical OS cursor must remain completely untouched
      const cursorAfter = await nativeRequest<{x: number; y: number}>('cursor');
      assert.deepEqual(
        {x: cursorAfter.x, y: cursorAfter.y},
        {x: cursorBefore.x, y: cursorBefore.y},
        'OS physical cursor must not move when acting on the Second Desktop',
      );

      // Verify Notepad UIA / elements reflect typed text (or frame pixels changed)
      const elements = await client.elements(launched.window!.hwnd);
      const combinedText = elements
        .map(el => `${el.name || ''} ${el.value || ''} ${el.text || ''}`)
        .join('\n');
      assert.ok(
        combinedText.includes(sampleText),
        `Expected Notepad UIA text to include "${sampleText}", got: ${combinedText.slice(0, 300)}`,
      );
    } finally {
      await client.close().catch(() => {});
      closeDesktop();
    }
    if (launchedPid > 0) {
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(
        isWindowProcessAlive(launchedPid),
        false,
        'Closing Second Desktop must terminate spawned apps cleanly without orphans',
      );
    }
  },
);

test(
  'CU-V2-W2-Red: desktop_host supports non-disruptive bg_input and window_manage without moving physical cursor',
  {skip: process.platform !== 'win32', timeout: 30000},
  async () => {
    try {
      const before = await nativeRequest<{x: number; y: number}>('cursor');
      const windows = await nativeRequest<Array<{hwnd: number}>>('windows');
      assert.ok(Array.isArray(windows));
      const bgProbe = await nativeRequest<{ok: boolean; method?: string}>('bg_input', {
        action: 'noop',
      });
      assert.equal(bgProbe.ok, true);
      const after = await nativeRequest<{x: number; y: number}>('cursor');
      assert.equal(after.x, before.x);
      assert.equal(after.y, before.y);
    } finally {
      closeDesktop();
    }
  },
);

test('CU-V2-W2-Red: registerCuDesktopTools exposes omnipotent non-deferred DesktopWorkspace.* toolset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-cu-tools-'));
  try {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    registerCuDesktopTools(
      registry,
      {
        eager: true,
        callDaemon: async (method, params) => {
          calls.push(`${method}:${JSON.stringify(params)}`);
          if (method === 'open') {
            return {ok: true, desktopName: 'MP_AgentDesktop', width: 1280, height: 720};
          }
          if (method === 'list_windows' || method === 'windows') {
            return {windows: [{hwnd: 99, title: 'Notepad', process_name: 'notepad.exe', bbox: [40, 40, 800, 600], desktop: 'agent'}]};
          }
          if (method === 'screenshot' || method === 'capture') {
            return {ok: true, mimeType: 'image/jpeg', image: '', width: 1280, height: 720, windows: []};
          }
          if (method === 'act') {
            return {ok: true, visualDelta: {screenChanged: true}};
          }
          if (method === 'close') {
            return {ok: true};
          }
          return {ok: true, pid: 4321};
        },
      },
    );

    for (const toolName of [
      'DesktopWorkspace.open',
      'DesktopWorkspace.launch',
      'DesktopWorkspace.list_windows',
      'DesktopWorkspace.screenshot',
      'DesktopWorkspace.act',
      'DesktopWorkspace.close',
    ]) {
      const spec = registry.get(toolName);
      assert.equal(spec.deferred, false, `${toolName} should be eager`);
    }

    const resOpen = (await registry.get('DesktopWorkspace.open').execute(
      {},
      {signal: new AbortController().signal, tool_call_id: 'test-open'},
    )) as {ok: boolean};
    assert.equal(resOpen.ok, true);

    const resAct = (await registry.get('DesktopWorkspace.act').execute(
      {action: 'type_text', text: 'hello', hwnd: 99},
      {signal: new AbortController().signal, tool_call_id: 'test-act'},
    )) as {ok: boolean};
    assert.equal(resAct.ok, true);
    assert.ok(calls.some(c => c.startsWith('open:')));
    assert.ok(calls.some(c => c.startsWith('act:')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test(
  'CU-V2-P1-Red: Second Desktop supports live resize, inspect_ax UIA tree, and DesktopWorkspace.inspect_ui + batch',
  {skip: process.platform !== 'win32', timeout: 45000},
  async () => {
    const client = new CuDesktopHostClient();
    try {
      const opened = await client.open({
        width: 1280,
        height: 720,
        name: `MP_P1Desk_${process.pid}`,
      });
      assert.equal(opened.ok, true);

      // 1. Live resize must reshape virtual desktop & JPEG capture dimensions
      const resized = await (
        client as unknown as {
          resize: (w: number, h: number) => Promise<{ok: boolean; width: number; height: number}>;
        }
      ).resize(720, 900);
      assert.equal(resized.ok, true);
      assert.equal(resized.width, 720);
      assert.equal(resized.height, 900);

      const frame = await client.capture({quality: 75});
      assert.equal(frame.width, 720);
      assert.equal(frame.height, 900);

      // 2. Launch Notepad & inspect indexed UIA tree on Second Desktop
      const launched = await client.launch({app: 'notepad'});
      assert.equal(launched.ok, true);
      assert.ok(launched.window?.hwnd, 'Notepad window must appear');
      const [x1, y1, x2, y2] = launched.window!.bbox;
      assert.ok(
        x2 - x1 <= 720 && y2 - y1 <= 900,
        `Auto-fitted window ${x2 - x1}x${y2 - y1} should fit inside 720x900`,
      );

      const ax = await (
        client as unknown as {
          inspectAx: (hwnd?: number) => Promise<{
            ok: boolean;
            hwnd: number;
            elements: Array<{index: number; role: string; name: string; x: number; y: number}>;
            treeText: string;
          }>;
        }
      ).inspectAx(launched.window!.hwnd);
      assert.equal(ax.ok, true);
      assert.ok(Array.isArray(ax.elements) && ax.elements.length > 0, 'inspectAx must return elements');
      assert.ok(String(ax.treeText || '').includes('[e1]'), 'treeText must contain indexed refs');
    } finally {
      await client.close().catch(() => {});
      closeDesktop();
    }

    // 3. ToolRegistry exposes non-deferred DesktopWorkspace.inspect_ui and DesktopWorkspace.batch
    const registry = new ToolRegistry();
    const rpcCalls: Array<{method: string; params: Record<string, unknown>}> = [];
    registerCuDesktopTools(
      registry,
      {
        eager: true,
        callDaemon: async (method, params) => {
          rpcCalls.push({method, params});
          if (method === 'inspect_ax') {
            return {
              ok: true,
              hwnd: 99,
              title: 'Notepad',
              elements: [{index: 1, role: 'Edit', name: 'Text Editor', x: 300, y: 200}],
              treeText: '[e1] Edit "Text Editor" (300, 200)',
            };
          }
          if (method === 'batch_act') {
            return {
              ok: true,
              results: [{index: 0, ok: true}, {index: 1, ok: true}],
              screenshot: {ok: true, mimeType: 'image/jpeg', image: '', width: 640, height: 800},
            };
          }
          return {ok: true};
        },
      },
    );

    const inspectTool = registry.get('DesktopWorkspace.inspect_ui');
    assert.equal(inspectTool.deferred, false);
    const batchTool = registry.get('DesktopWorkspace.batch');
    assert.equal(batchTool.deferred, false);

    const inspectRes = (await inspectTool.execute(
      {hwnd: 99},
      {signal: new AbortController().signal, tool_call_id: 'test-inspect'},
    )) as {ok: boolean; treeText: string};
    assert.equal(inspectRes.ok, true);
    assert.match(inspectRes.treeText, /\[e1\]/);

    const batchRes = (await batchTool.execute(
      {
        steps: [
          {action: 'click', x: 300, y: 200, hwnd: 99},
          {action: 'type_text', text: 'Batch works', hwnd: 99},
        ],
        includeScreenshot: true,
      },
      {signal: new AbortController().signal, tool_call_id: 'test-batch'},
    )) as {ok: boolean; completedCount?: number};
    assert.equal(batchRes.ok, true);
    assert.ok(rpcCalls.some(c => c.method === 'batch_act'));
  },
);

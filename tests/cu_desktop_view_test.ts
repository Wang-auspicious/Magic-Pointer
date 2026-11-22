import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {CuDesktopDaemon} from '../electron/cu_desktop_daemon';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('CU-V2-W3-Red: CuDesktopDaemon enforces token-authenticated loopback RPC and yields cleanly when paused by user', async () => {
  const daemon = new CuDesktopDaemon();
  try {
    const {url, token} = await daemon.startRpcServer();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(token.length >= 32);

    // Reject missing/invalid token
    const unauth = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({method: 'status', params: {}}),
    });
    assert.equal(unauth.status, 401);

    // Accept valid token
    const okRes = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mp-cu-token': token,
      },
      body: JSON.stringify({method: 'status', params: {}}),
    });
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as {
      result: {active: boolean; paused: boolean};
    };
    assert.equal(body.result.active, false);
    assert.equal(body.result.paused, false);

    // Paused state toggles cleanly and exposes rpcEnv
    const pausedStatus = daemon.setPaused(true);
    assert.equal(pausedStatus.paused, true);
    const env = daemon.rpcEnv();
    assert.equal(env.MAGIC_POINTER_CU_DAEMON_URL, url);
    assert.equal(env.MAGIC_POINTER_CU_DAEMON_TOKEN, token);
  } finally {
    await daemon.shutdown();
  }
});

test('CU-V2-W3-Red: electron/renderer/cu_desktop_view.ts is a clean browser-global IIFE with accurate contain coordinate mapping and dual-cursor stepping', () => {
  const srcPath = path.join(ROOT, 'electron', 'renderer', 'cu_desktop_view.ts');
  assert.ok(fs.existsSync(srcPath), 'cu_desktop_view.ts must exist');
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(
    src,
    /^\s*export\s+/m,
    'cu_desktop_view.ts must NOT contain top-level ES exports (loaded via <script defer>)',
  );
  assert.match(src, /globalThis\.CuDesktopView\s*=/);

  const api = require('../electron/renderer/cu_desktop_view');
  assert.equal(typeof api.mapCanvasPointToDesktop, 'function');
  assert.equal(typeof api.stepCursorLerp, 'function');
  assert.equal(typeof api.normalizeKeyboardEvent, 'function');

  // 1280x720 desktop inside a 640x480 letterboxed canvas:
  // Fitted height = 360px centered vertically (offsetY = 60px, scale = 0.5)
  const center = api.mapCanvasPointToDesktop(320, 240, 640, 480, 1280, 720);
  assert.deepEqual(center, {x: 640, y: 360, inside: true});

  const topLeft = api.mapCanvasPointToDesktop(0, 60, 640, 480, 1280, 720);
  assert.deepEqual(topLeft, {x: 0, y: 0, inside: true});

  const outsideTopBar = api.mapCanvasPointToDesktop(320, 10, 640, 480, 1280, 720);
  assert.equal(outsideTopBar.inside, false);

  // Dual-cursor smooth step moves toward target monotonically
  const stepped = api.stepCursorLerp({x: 100, y: 100}, {x: 500, y: 300}, 0.25);
  assert.equal(stepped.x, 200);
  assert.equal(stepped.y, 150);

  // Keyboard normalization maps Ctrl+A and plain chars properly
  assert.deepEqual(
    api.normalizeKeyboardEvent({
      key: 'a',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    }),
    {kind: 'keydown', keys: 'ctrl+a'},
  );
  assert.deepEqual(
    api.normalizeKeyboardEvent({
      key: 'Enter',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }),
    {kind: 'keydown', keys: 'enter'},
  );
  assert.deepEqual(
    api.normalizeKeyboardEvent({
      key: 'H',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }),
    {kind: 'type_text', text: 'H'},
  );
});

test('CU-V2-W3-Red: Studio HTML, Studio TS, Preload, and Main wire Live Agent Desktop viewport & Dual-Cursor IPC without minimizing Studio', () => {
  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /id="header-cu-desktop-toggle"/);
  assert.match(html, /data-inspector-tab="cu-desktop"/);
  assert.match(html, /id="inspector-cu-desktop"/);
  assert.match(html, /id="cu-desktop-host"/);
  assert.match(html, /cu_desktop_view\.js/);

  const preload = readRepo('electron/preload.ts');
  assert.match(preload, /cuDesktop:\s*\{/);
  assert.match(preload, /cu-desktop:human-input/);
  assert.match(preload, /cu-desktop:frame/);

  const main = readRepo('electron/main.ts');
  assert.match(main, /CuDesktopDaemon/);
  assert.match(main, /cu-desktop:open/);
  assert.match(main, /cu-desktop:human-input/);
  assert.match(main, /cuDesktopDaemon\.rpcEnv\(\)/);

  const studio = readRepo('electron/renderer/studio.ts');
  assert.match(studio, /CuDesktopView/);
  assert.match(studio, /'cu-desktop'/);
});

test('CU-V2-P1-Red: adaptive viewport computes panel-filling dimensions and wires ResizeObserver + Fit toggle + Empty Stage', () => {
  const api = require('../electron/renderer/cu_desktop_view') as {
    computeAdaptiveDesktopSize?: (panelW: number, panelH: number) => {width: number; height: number};
  };
  assert.equal(
    typeof api.computeAdaptiveDesktopSize,
    'function',
    'CuDesktopView must export computeAdaptiveDesktopSize',
  );
  const portrait = api.computeAdaptiveDesktopSize!(410, 620);
  assert.ok(
    portrait.width >= 640 && portrait.width <= 1440,
    `portrait width out of range: ${portrait.width}`,
  );
  assert.ok(
    portrait.height >= 520 && portrait.height <= 1080,
    `portrait height out of range: ${portrait.height}`,
  );
  assert.ok(
    portrait.height > portrait.width,
    `portrait panel 410x620 must yield portrait virtual desktop, got ${portrait.width}x${portrait.height}`,
  );
  assert.equal(portrait.width % 2, 0);
  assert.equal(portrait.height % 2, 0);

  const src = readRepo('electron/renderer/cu_desktop_view.ts');
  assert.match(src, /ResizeObserver/);
  assert.match(src, /mp-cu-stage-empty/);
  assert.match(src, /16:9/);

  const preload = readRepo('electron/preload.ts');
  assert.match(preload, /cu-desktop:resize/);

  const main = readRepo('electron/main.ts');
  assert.match(main, /cu-desktop:resize/);
});

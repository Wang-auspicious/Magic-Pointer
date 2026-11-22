import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {initialToolNames} from '../electron/runtime/agent_services';
import {buildSystemPrompt} from '../electron/runtime/agent';
import * as desktopMod from '../electron/runtime/desktop';
import {ToolRegistry} from '../electron/runtime/tools';
import {registerLearnCaptureTool} from '../electron/runtime/learn_capture_tool';
import {ensureRoadshowCs336Course, getLearnCourse} from '../electron/learn_course_store';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('CODEX-CU-Red: DesktopActionSession registers screenshot_id cache, seeds pointer_frozen_frame, and maps scaled crop/window pixels to screen coords', () => {
  const session = desktopMod.desktopSession(
    `codex-shot-${Date.now()}`,
  ) as desktopMod.DesktopActionSession & {
    registerScreenshot?: (meta: {
      id?: string;
      bounds: [number, number, number, number];
      width: number;
      height: number;
      scale?: number;
      hwnd?: number;
      kind: 'screen' | 'zoom' | 'window' | 'frozen_frame';
    }) => string;
    seedFrozenFrame?: (snapshot: Record<string, unknown>) => string | null;
    resolveScreenshotPoint?: (
      screenshotId: string,
      x: number,
      y: number,
    ) => {x: number; y: number; bounds: [number, number, number, number]; hwnd?: number};
  };

  assert.equal(typeof session.registerScreenshot, 'function');
  assert.equal(typeof session.seedFrozenFrame, 'function');
  assert.equal(typeof session.resolveScreenshotPoint, 'function');

  const zoomId = session.registerScreenshot!({
    bounds: [400, 300, 800, 600],
    width: 400,
    height: 300,
    scale: 1,
    kind: 'zoom',
  });
  assert.ok(zoomId.startsWith('shot-'));
  const mappedZoom = session.resolveScreenshotPoint!(zoomId, 100, 50);
  assert.deepEqual(
    {x: mappedZoom.x, y: mappedZoom.y},
    {x: 500, y: 350},
  );

  // Scaled 2:1 (e.g. 2000x1000 screen bounds rendered into 1000x500 image)
  const scaledId = session.registerScreenshot!({
    bounds: [100, 200, 2100, 1200],
    width: 1000,
    height: 500,
    scale: 0.5,
    kind: 'screen',
  });
  const mappedScaled = session.resolveScreenshotPoint!(scaledId, 250, 100);
  assert.deepEqual(
    {x: mappedScaled.x, y: mappedScaled.y},
    {x: 600, y: 400},
  );

  // Pre-seed pointer_frozen_frame from Magic Pointer wake snapshot
  const seeded = session.seedFrozenFrame!({
    selection_crop_path: path.join(os.tmpdir(), 'fake-crop.png'),
    selection_crop_bounds: [320, 180, 920, 580],
    target_window: {hwnd: 4242, bbox: [100, 100, 1300, 900]},
  });
  assert.equal(seeded, 'pointer_frozen_frame');
  const mappedFrozen = session.resolveScreenshotPoint!('pointer_frozen_frame', 100, 80);
  assert.equal(mappedFrozen.x, 420);
  assert.equal(mappedFrozen.y, 260);
  assert.equal(mappedFrozen.hwnd, 4242);
});

test('CODEX-CU-Red: DesktopActionSession tolerates self-drawn pixel drift without throwing stale_snapshot and submits Enter when element is absent', async () => {
  const desktopSrc = readRepo('electron/runtime/desktop.ts');
  assert.match(desktopSrc, /strict_pixel_guard/);
  assert.match(desktopSrc, /args\.submit\s*&&\s*\(matched\s*\|\|\s*!element\)/);
  assert.match(desktopSrc, /computer_use_escape_stop/);

  const registry = new ToolRegistry();
  const session = desktopMod.desktopSession(`codex-tools-${Date.now()}`);
  desktopMod.registerDesktopTools(registry, session, undefined, undefined, undefined, {
    eagerDesktopTools: true,
    autoBindWindows: true,
  });

  const moveTool = registry.get('move');
  assert.ok(moveTool, 'move tool must be registered');
  assert.equal(moveTool?.deferred, false);

  const pasteTool = registry.get('paste');
  assert.ok(pasteTool, 'paste tool must be registered');
  assert.equal(pasteTool?.deferred, false);
  const pasteProps = (pasteTool?.input_schema?.properties || {}) as Record<string, unknown>;
  assert.ok('format' in pasteProps);
  assert.ok('screenshot_id' in pasteProps);

  const clickTool = registry.get('click');
  const clickProps = (clickTool?.input_schema?.properties || {}) as Record<string, unknown>;
  assert.ok('screenshot_id' in clickProps, 'click must accept screenshot_id');

  const batchTool = registry.get('desktop_batch');
  const batchSchema = batchTool?.input_schema?.properties as
    | {steps?: {items?: {properties?: {action?: {enum?: string[]}}}}}
    | undefined;
  const batchStepsProp = batchSchema?.steps?.items?.properties?.action?.enum || [];
  assert.ok(batchStepsProp.includes('paste'), 'desktop_batch must support paste step');
  assert.ok(batchStepsProp.includes('move'), 'desktop_batch must support move step');
});

test('CODEX-CU-Red: scripts/desktop_host.cs implements CF_HTML verified paste, VK_ESCAPE emergency stop, and ReleaseInput safety', () => {
  const csSrc = readRepo('scripts/desktop_host.cs');
  assert.match(csSrc, /SetClipboardRich/);
  assert.match(csSrc, /HTML Format/);
  assert.match(csSrc, /RegisterClipboardFormatW/);
  assert.match(csSrc, /action=="paste"/);
  assert.match(csSrc, /computer_use_escape_stop/);
  assert.match(csSrc, /GetAsyncKeyState\(0x1B\)/);
  assert.match(csSrc, /target_obscured:/);
});

test('CODEX-CU-Red: Global pointer_stage wake exposes CU + Learn tools even in Learn mode and injects pointer guidance', async () => {
  const tools = initialToolNames({
    source: 'pointer_stage',
    workMode: 'learn',
    permissionMode: 'default',
    selectionSnapshot: {snapshot_id: 'snap-1'},
    cuDaemonAvailable: false,
  });

  for (const name of [
    'see_screen',
    'inspect_at',
    'zoom_screen',
    'click',
    'move',
    'paste',
    'drag',
    'desktop_batch',
    'Learn.capture_to_course',
  ]) {
    assert.ok(tools.includes(name), `pointer_stage tools must include ${name}`);
  }

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'mp-pointer-wake-'));
  const prompt = await buildSystemPrompt({
    userDataDir,
    workMode: 'learn',
    permissionMode: 'default',
    hasSelection: true,
    instruction: '帮我操作这个自绘播放器',
    metadata: {source: 'pointer_stage', selectionSnapshotId: 'snap-1'},
  });
  assert.match(prompt, /pointer_frozen_frame/);
  assert.match(prompt, /Learn\.capture_to_course/);
});

test('CODEX-CU-Red: Learn.capture_to_course persists annotations to active course cleanly', async () => {
  const tmpUserData = await mkdtemp(path.join(os.tmpdir(), 'mp-learn-cap-'));
  const persistenceDir = await mkdtemp(path.join(os.tmpdir(), 'mp-persist-'));
  const athenaeumDir = await mkdtemp(path.join(os.tmpdir(), 'mp-athenaeum-'));
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'mp-vault-'));

  const course = ensureRoadshowCs336Course(tmpUserData, {
    persistenceDir,
    athenaeumDir,
  });

  const registry = new ToolRegistry();
  registerLearnCaptureTool(registry, {
    userDataDir: tmpUserData,
    vaultDir,
    storeOpts: {persistenceDir, athenaeumDir},
  });

  const capTool = registry.get('Learn.capture_to_course');
  assert.ok(capTool, 'Learn.capture_to_course must be registered');
  const res = (await capTool!.execute(
    {
      courseId: course.id,
      quote: '64 multiples avoid tail latency',
      note: '就像快递装箱凑整箱，避免半车空跑',
      section: 'SwiGLU 对齐',
      feedback: 'confused',
      saveToVault: true,
      addTodo: '用 4 维具体数字再验算一遍 SwiGLU',
    },
    {signal: new AbortController().signal, callId: 'c1', turn: 1} as never,
  )) as Record<string, unknown>;

  assert.equal(res.ok, true);
  const updated = getLearnCourse(tmpUserData, course.id, {
    persistenceDir,
    athenaeumDir,
  });
  assert.ok(
    updated?.livingArtifact.annotations.some(a =>
      a.quote.includes('64 multiples avoid tail latency'),
    ),
  );
  assert.equal(
    fs.existsSync(path.join(vaultDir, 'LEARNING_TODOS.md')),
    true,
    'Todo must be persisted to Obsidian vault LEARNING_TODOS.md',
  );
});

test('CODEX-CU-Red: StageChipsPolicy enables smart chips on lasso/sweep/stroke selections and main/preload/stage wire Learn handoff + click-through yield', () => {
  const chipsPolicy = require('../electron/stage_chips_policy');
  assert.equal(
    chipsPolicy.shouldShowChips({selectionSource: 'lasso', capsuleText: ''}),
    true,
  );
  assert.equal(
    chipsPolicy.shouldShowChips({selectionSource: 'stroke', capsuleText: ' '}),
    true,
  );
  // Keep drag false per stage_chips_policy_test.ts contract
  assert.equal(
    chipsPolicy.shouldShowChips({selectionSource: 'drag', capsuleText: ''}),
    false,
  );
  assert.equal(chipsPolicy.commandForChip('learn_explain') !== null, true);

  const mainSrc = readRepo('electron/main.ts');
  assert.match(mainSrc, /'stage:handoff-to-learn'/);
  assert.match(mainSrc, /'stage:save-to-learn-note'/);
  assert.match(mainSrc, /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);

  const stageHtml = readRepo('electron/renderer/stage.html');
  assert.match(stageHtml, /id="thread-save-learn"/);
  assert.match(stageHtml, /id="thread-handoff-learn"/);
});

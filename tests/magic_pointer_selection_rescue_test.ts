import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

test('W4-Red: captureEligibility accepts TS sovereign runtime captures (status=ok/empty_confirmed, pixel-ocr/uia) while keeping invalid rejections', () => {
  const {captureEligibility} = require('../electron/result_surface_policy');

  const okOcr = captureEligibility({
    snapshot: {
      status: 'ok',
      source_kind: 'pixel-ocr',
      capture_path: 'C:\\tmp\\frame-1.png',
      source_window: {title: 'Google Chrome', hwnd: 1001, pid: 2002},
      target_point: {x: 400, y: 300},
    },
    summary: {state: 'ready', app: 'chrome.exe', hasContent: true, hasVisual: true},
  });
  assert.equal(okOcr.commandReady, true, 'TS runtime status=ok + hasContent=true must be commandReady');

  const okVisualOnly = captureEligibility({
    snapshot: {
      status: 'empty_confirmed',
      source_kind: 'pixel-ocr',
      capture_path: 'C:\\tmp\\frame-2.png',
      frame_lease: {localArtifact: {path: 'C:\\tmp\\frame-2.png'}},
      source_window: {title: 'Diagram', hwnd: 1002, pid: 2003},
    },
    summary: {state: 'visual', app: 'desktop', hasContent: false, hasVisual: true},
  });
  assert.equal(okVisualOnly.commandReady, true, 'Visual capture with empty OCR must still be commandReady');
  assert.equal(okVisualOnly.state, 'visual-ready');

  // Existing rejections remain enforced:
  const mismatch = captureEligibility({
    snapshot: {status: 'target_mismatch', source_window: {title: 'Other'}},
    summary: {state: 'target_mismatch', hasContent: false, hasVisual: false},
  });
  assert.equal(mismatch.commandReady, false);

  const emptyNoVisual = captureEligibility({
    snapshot: {status: 'empty', source_window: {title: 'App'}},
    summary: {state: 'empty', hasContent: false, hasVisual: false},
  });
  assert.equal(emptyNoVisual.commandReady, false);
});

test('W4-Red: selection_target_policy excludes selfPid (Magic Pointer.exe) and resolves real snapshot image path & early gesture queueing', () => {
  const policy = require('../electron/selection_target_policy');

  const selfFallback = policy.resolveSelectionTargetSource({
    live: {
      foregroundApp: 'Magic Pointer.exe',
      foregroundHwnd: 999,
      foregroundProcessId: 4242,
    },
    lastStable: {
      app: 'Weixin.exe',
      hwnd: 888,
      process_id: 3131,
    },
    selfPid: 4242,
    isTransient: (name: string) => /magic ?pointer|electron/i.test(name),
  });
  assert.equal(selfFallback.foregroundApp, 'Weixin.exe');
  assert.equal(selfFallback.foregroundProcessId, 3131);

  const desktopFallback = policy.resolveSelectionTargetSource({
    live: {
      foregroundApp: 'Magic Pointer.exe',
      foregroundHwnd: 999,
      foregroundProcessId: 4242,
    },
    lastStable: {app: 'Magic Pointer.exe', hwnd: 999, process_id: 4242},
    selfPid: 4242,
    isTransient: (name: string) => /magic ?pointer|electron/i.test(name),
  });
  assert.equal(desktopFallback.foregroundApp, 'desktop');
  assert.equal(desktopFallback.foregroundHwnd, 0);
  assert.equal(desktopFallback.foregroundProcessId, 0);

  const extracted = policy.extractSnapshotImagePath({
    frame_lease: {localArtifact: {path: 'C:\\tmp\\lease.png'}},
  });
  assert.equal(extracted, 'C:\\tmp\\lease.png');

  assert.equal(policy.shouldQueueEarlyGesture(false, {points: [{x: 1, y: 1}]}), true);
  assert.equal(policy.shouldQueueEarlyGesture(true, {points: [{x: 1, y: 1}]}), false);
});

test('W4-Red: perceiveFrozenFrame handles display-level capture (hwnd=0/pid=0) and registerLookTool uses fallbackImagePaths', async () => {
  const {perceiveFrozenFrame, registerLookTool} = require('../electron/runtime/desktop_perception');
  const {ToolRegistry} = require('../electron/runtime/tools');
  const sharp = require('sharp');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-w4-'));
  try {
    const imgPath = path.join(tmpDir, 'frame.png');
    await sharp({
      create: {
        width: 320,
        height: 200,
        channels: 4,
        background: {r: 255, g: 255, b: 255, alpha: 1},
      },
    })
      .png()
      .toFile(imgPath);

    const frame = {
      frameLeaseId: 'lease-display-1',
      capturedAtUtc: new Date().toISOString(),
      source: 'gdi-display',
      surfaceBoundsPx: [0, 0, 320, 200],
      targetWindow: {
        hwnd: 0,
        processId: 0,
        processName: 'desktop',
        title: '',
        bbox: [0, 0, 320, 200],
      },
      localArtifact: {path: imgPath, width: 320, height: 200},
    };

    const result = await perceiveFrozenFrame(
      frame,
      {cursor: [100, 100]},
      undefined,
      {resolve: async () => []},
      {
        ocr: async () => ({blocks: [], usedBackend: 'mock-ocr'}),
        selection: async () => [],
      },
    );
    assert.equal(result.capture_path, imgPath);
    assert.equal(result.source_window.title, 'Screen');

    // registerLookTool with no frame_lease but fallbackImagePaths must inspect fallback screenshot rather than failing frozen_frame_unavailable
    const registry = new ToolRegistry();
    registerLookTool(registry, {
      snapshot: {},
      fallbackImagePaths: [imgPath],
      vision: Object.assign(
        async () => ({text: 'Inspected screen screenshot', usedBackend: 'vision-test'}),
        {[Symbol.for('magic-pointer.vision.agent-model')]: true},
      ),
    });
    const callResult = await registry.execute({
      id: 'look-1',
      name: 'look',
      arguments: {question: 'What is on screen?'},
    });
    assert.equal(callResult.is_error, false, `look tool must succeed: ${JSON.stringify(callResult)}`);
    const out = callResult.value as Record<string, unknown>;
    assert.notEqual(out.note, 'frozen_frame_unavailable', 'look must fall back to captured attachment image when frame_lease is absent');
    assert.ok(out.image || out.text, 'look must return pixels/image from fallbackImagePaths');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('W4-Red: stage.css supports compact height on single-error/short turns instead of 600px white void', () => {
  const stageSrc = fs.readFileSync(path.join(ROOT, 'electron/renderer/stage.ts'), 'utf8');
  const stageCss = fs.readFileSync(path.join(ROOT, 'electron/renderer/stage.css'), 'utf8');
  assert.match(stageCss, /\.stage-thread\[data-compact='true'\]/, 'stage.css must style compact single-error Stage threads');
  assert.match(stageSrc, /dataset\.compact/, 'stage.ts must mark single-error / compact threads data-compact="true"');
});

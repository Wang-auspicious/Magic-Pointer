import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

test('W1-1 desktop_capture commit sanitizes empty/zero bbox and blank processName', async () => {
  const mod = (await import('../electron/runtime/desktop_capture')) as Record<string, unknown>;
  assert.equal(
    typeof mod.resolveCommitTargetWindow,
    'function',
    'desktop_capture.ts should export resolveCommitTargetWindow helper',
  );
  const resolveCommitTargetWindow = mod.resolveCommitTargetWindow as (
    targetWindow: {
      hwnd: number;
      processId: number;
      processName: string;
      title: string;
      bbox?: [number, number, number, number];
      processStartTime?: string;
    } | null,
    resolved: {
      hwnd: number;
      pid: number;
      processName?: string;
      processStartTime?: string;
      title?: string;
      bbox?: [number, number, number, number];
    } | null,
    fallbackBounds?: [number, number, number, number],
  ) => {
    hwnd: number;
    processId: number;
    processName: string;
    title: string;
    bbox: [number, number, number, number];
  };

  const zeroBboxResult = resolveCommitTargetWindow(
    { hwnd: 101, processId: 202, processName: '', title: '' },
    { hwnd: 101, pid: 202, bbox: [0, 0, 0, 0], title: 'Bilibili' },
    [0, 0, 1920, 1080],
  );
  assert.ok(
    zeroBboxResult.bbox[2] > zeroBboxResult.bbox[0] &&
      zeroBboxResult.bbox[3] > zeroBboxResult.bbox[1],
    'zero-area bbox must fall back to positive-area bounds',
  );
  assert.ok(zeroBboxResult.processName.trim().length > 0, 'processName must be non-empty');

  const invertedBboxResult = resolveCommitTargetWindow(
    { hwnd: 101, processId: 202, processName: 'chrome.exe', title: 'Chrome' },
    { hwnd: 101, pid: 202, bbox: [500, 400, 100, 200] },
    [0, 0, 1920, 1080],
  );
  assert.ok(
    invertedBboxResult.bbox[2] > invertedBboxResult.bbox[0] &&
      invertedBboxResult.bbox[3] > invertedBboxResult.bbox[1],
    'inverted bbox must fall back to positive-area bounds',
  );
});

test('W1-1 activateDesktopPerception never hard-fails when hiding Studio leaves no external foreground window', () => {
  const mainSource = readRepoFile('electron/main.ts');
  const start = mainSource.indexOf('async function activateDesktopPerception(');
  assert.ok(start >= 0, 'activateDesktopPerception must exist in electron/main.ts');
  const body = mainSource.slice(start, start + 2600);
  assert.equal(
    body.includes("error: 'No target window is ready. Open the target app, then use the wake shortcut.'"),
    false,
    'activateDesktopPerception should fall back to display/last external target instead of bailing with No target window is ready',
  );
});

test('W1-2 desktop_perception popover uses fixed positioning hugging composer trigger without clipping', () => {
  const css = readRepoFile('electron/renderer/desktop_perception.css');
  assert.match(css, /\.mp-perception-popover\s*\{[\s\S]*?position:\s*fixed;/);
  assert.equal(
    /\.mp-perception-popover\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*8px\)/s.test(css),
    false,
    '.mp-perception-popover must not anchor bottom: calc(100% + 8px) above composer stack',
  );

  const studio = readRepoFile('electron/renderer/studio.ts');
  assert.match(
    studio,
    /STUDIO_POPOVERS\s*=\s*\[[\s\S]*\['desktop-perception',\s*'composer-perception-toggle'\]/,
    'STUDIO_POPOVERS must register desktop-perception anchored to composer-perception-toggle',
  );
});

test('W1-3 Stage prevents tofu icons and unguarded require in chat_view', () => {
  const typography = readRepoFile('electron/renderer/typography.css');
  assert.equal(
    /html\s*\*[\s\S]*?font-family:\s*var\(--mp-font-ui\)\s*!important/.test(
      typography.replace(/:not\(\.cds-icon\)/g, '__REMOVED__'),
    ) && !typography.includes(':not(.cds-icon)'),
    false,
    'typography.css must exclude .cds-icon (or avoid !important override on html *) so icon font glyphs do not render as tofu boxes',
  );

  const stageHtml = readRepoFile('electron/renderer/stage.html');
  const chatViewIdx = stageHtml.indexOf('<script src="chat_view.js"></script>');
  assert.ok(chatViewIdx > 0, 'stage.html must load chat_view.js');
  for (const scriptName of ['cds_icons.js', 'workflow_card.js', 'stream_smoother.js']) {
    const idx = stageHtml.indexOf(`<script src="${scriptName}"></script>`);
    assert.ok(
      idx > 0 && idx < chatViewIdx,
      `stage.html must load ${scriptName} before chat_view.js`,
    );
  }

  const chatView = readRepoFile('electron/renderer/chat_view.ts');
  const unguardedRequire = chatView.match(/(?<!typeof\s)require\(['"]/g) ?? [];
  const safeRequire =
    chatView.match(/typeof require === 'function'\s*\?\s*(?:\(\s*)?require\(/g) ??
    [];
  assert.ok(
    safeRequire.length >= unguardedRequire.length,
    'Every CommonJS fallback require() in chat_view.ts must be guarded by typeof require === \'function\'',
  );
});

test('W1-4 Stage keeps thread hidden and renders compact FailedRow card on zero-turn error', () => {
  const stageCss = readRepoFile('electron/renderer/stage.css');
  const stageTs = readRepoFile('electron/renderer/stage.ts');
  assert.match(stageCss, /\.mp-stage-failed-row|\.stage-error-card|\.stage-error/);
  assert.match(
    stageTs,
    /showZeroTurnError|renderFailedRow|state\.phase === 'error'[\s\S]*?threadContainer\.hidden = true/,
    'Zero-turn errors must keep threadContainer hidden instead of showing a 440x533 blank panel',
  );
});

test('W2-1 StageSurfacePolicy exposes 520x600 workbench size while preserving WORK_PANEL_SIZE', async () => {
  const mod = (await import('../electron/stage_surface_policy')) as Record<string, unknown>;
  const policy = (mod.default ?? mod) as Record<string, unknown>;
  const workPanelSize = policy.WORK_PANEL_SIZE as { width: number; height: number };
  assert.deepEqual(
    workPanelSize,
    { width: 440, height: 533 },
    'WORK_PANEL_SIZE must remain 440x533 for existing contract compatibility',
  );
  const workbenchSize = policy.WORKBENCH_SIZE as { width: number; height: number } | undefined;
  assert.deepEqual(
    workbenchSize,
    { width: 520, height: 600 },
    'WORKBENCH_SIZE must match Vida FloatingChatWorkbenchTransition 520x600 geometry',
  );
  const surfaceSize = policy.surfaceSize as (
    role: string,
    viewport?: { width: number; height: number },
  ) => { width: number; height: number };
  assert.deepEqual(
    surfaceSize('workbench', { width: 1920, height: 1080 }),
    { width: 520, height: 600 },
  );
});

test('W2-1 StageAnchor exposes transformOrigin for Vida outer-edge panel docking', async () => {
  const mod = (await import('../electron/stage_anchor')) as Record<string, unknown>;
  const anchorMod = (mod.default ?? mod) as Record<string, unknown>;
  assert.equal(
    typeof anchorMod.chooseAdaptivePanelTransformOrigin,
    'function',
    'stage_anchor.ts should export chooseAdaptivePanelTransformOrigin',
  );
  const fn = anchorMod.chooseAdaptivePanelTransformOrigin as (
    source: { x: number; y: number; width: number; height: number } | null | undefined,
    panel: { x: number; y: number; width: number; height: number },
  ) => string;
  const originRight = fn(
    { x: 400, y: 200, width: 320, height: 180 },
    { x: 734, y: 120, width: 520, height: 600 },
  );
  assert.match(originRight, /left|0%/, 'Docking to outer right should originate morph from left edge');
  const originLeft = fn(
    { x: 900, y: 200, width: 320, height: 180 },
    { x: 366, y: 120, width: 520, height: 600 },
  );
  assert.match(originLeft, /right|100%/, 'Docking to outer left should originate morph from right edge');
});

test('W2-1 pointer dismiss policy respects command vs workbench phase', async () => {
  const dismissMod = (await import('../electron/pointer_dismiss_policy')) as Record<string, unknown>;
  assert.equal(
    typeof dismissMod.shouldDismissStageOnOutsideClick,
    'function',
    'pointer_dismiss_policy.ts must export shouldDismissStageOnOutsideClick(phase)',
  );
  const guard = dismissMod.shouldDismissStageOnOutsideClick as (phase: string) => boolean;
  assert.equal(guard('capsule-text'), true, 'Command bar should auto-dismiss on outside click');
  assert.equal(guard('processing'), false, 'Processing workbench must stay open on outside click');
  assert.equal(guard('result'), false, 'Result workbench must stay open on outside click');
  assert.equal(guard('error'), false, 'Error card must wait for Esc or explicit close');
});

test('W2-1 & W2-2 Stage HTML/TS/CSS implement multiline BubbleShell, Workbench resize/expand, and Vida narration shimmer', () => {
  const stageHtml = readRepoFile('electron/renderer/stage.html');
  assert.match(stageHtml, /<textarea[^>]*id="capsule-input"/, 'capsule-input must be multiline textarea');
  assert.match(stageHtml, /id="capsule-refs"/, 'capsule-refs context strip must exist inside capsule');
  assert.match(stageHtml, /id="thread-expand-studio"/, 'Workbench header must include Expand to Studio button');
  assert.match(stageHtml, /data-resize-edge=/, 'Workbench must include 4-edge resize handles');

  const stageCss = readRepoFile('electron/renderer/stage.css');
  assert.match(stageCss, /\.mp-narration-shimmer/);
  assert.match(stageCss, /\.mp-narration-brush/);

  const chatStyles = readRepoFile('electron/renderer/chat_styles.css');
  assert.match(chatStyles, /\.mp-narration-shimmer/);
  assert.match(chatStyles, /\.mp-narration-brush/);
});

test('W3-1..W3-4 Magic Pointer + Clicky + Pointer.guide are surfaced and wired', () => {
  const dpTs = readRepoFile('electron/renderer/desktop_perception.ts');
  assert.match(dpTs, /Ctrl\+Alt\+M/);
  assert.match(dpTs, /Ctrl\+Alt\+G/);
  assert.match(dpTs, /Clicky/);

  const agentServices = readRepoFile('electron/runtime/agent_services.ts');
  const desktopTs = readRepoFile('electron/runtime/desktop.ts');
  assert.ok(
    agentServices.includes('Pointer.guide') || desktopTs.includes('Pointer.guide'),
    'Runtime must register Pointer.guide tool',
  );

  const mainTs = readRepoFile('electron/main.ts');
  assert.match(mainTs, /teach-execute/, 'cu-overlay:action must handle teach-execute single-step execution');
});

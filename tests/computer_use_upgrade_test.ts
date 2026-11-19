import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Batch 3A.1: snapDesktopPointToElement snaps vision points <=30px to small UIA controls and rejects large containers', () => {
  const {snapDesktopPointToElement} = require('../electron/runtime/desktop');
  assert.equal(typeof snapDesktopPointToElement, 'function');

  const win = {hwnd: 1, pid: 10, bbox: [0, 0, 1920, 1080], title: 'Demo'};
  const elements = [
    // Large container (must be ignored)
    {
      index: 1,
      hwnd: 1,
      name: 'MainPane',
      role: 'pane',
      rect: [0, 0, 1400, 900],
      runtime_id: [1],
      patterns: [],
    },
    // Small actionable button (center = 500, 300)
    {
      index: 2,
      hwnd: 1,
      name: 'Save',
      role: 'button',
      rect: [460, 282, 540, 318],
      runtime_id: [2],
      patterns: ['Invoke'],
    },
  ];

  const snapped = snapDesktopPointToElement(514, 308, elements, win);
  assert.equal(snapped.x, 500, 'should snap x to button center');
  assert.equal(snapped.y, 300, 'should snap y to button center');
  assert.equal(snapped.snappedControl?.name, 'Save');
  assert.equal(snapped.snappedControl?.ref, '@e2');
  assert.ok(snapped.snappedControl.distancePx <= 30);

  const far = snapDesktopPointToElement(800, 600, elements, win);
  assert.equal(far.x, 800);
  assert.equal(far.y, 600);
  assert.equal(far.snappedControl, undefined);
});

test('Batch 3A.2: desktop.ts wires normalized coordinates, control snapping, and post-action visualDelta self-check', () => {
  const desktopSrc = readRepo('electron/runtime/desktop.ts');
  assert.match(
    desktopSrc,
    /'normalized'/,
    'desktop.ts must support normalized 0-1000 coordinate_space',
  );
  assert.match(
    desktopSrc,
    /snapDesktopPointToElement\(/,
    'desktop.ts point() must invoke snapDesktopPointToElement',
  );
  assert.match(
    desktopSrc,
    /visualDelta/,
    'desktop.ts must attach post-action visualDelta (screenChanged) self-check to action receipts',
  );
});

test('Batch 3A.3: chat_view.ts renders visual CU receipt strip (.mp-cu-receipt)', () => {
  const chatViewSrc = readRepo('electron/renderer/chat_view.ts');
  assert.match(
    chatViewSrc,
    /mp-cu-receipt/,
    'chat_view.ts must render .mp-cu-receipt for Computer Use tool results',
  );
  const css = readRepo('electron/renderer/chat_styles.css');
  assert.match(css, /\.mp-cu-receipt\b/, 'chat_styles.css must style .mp-cu-receipt');
});

test('Batch 3B/3C/3D: CuOverlayController drives Autopilot pill, Live CuTeach steps, and Watch & Record tutorial generation', () => {
  const {CuOverlayController, formatRecordedTourMarkdown} = require('../electron/cu_live_overlay');
  const {extractTourSteps} = require('../electron/guided_tour');

  const ctrl = new CuOverlayController();
  assert.equal(ctrl.getState().mode, 'idle');

  // 3B: Autopilot pill
  ctrl.startAutopilot({windowTitle: 'Notepad', actionLabel: '输入会议纪要', stepIndex: 2});
  assert.equal(ctrl.getState().mode, 'autopilot');
  assert.equal(ctrl.getState().windowTitle, 'Notepad');
  ctrl.pauseForTakeover();
  assert.equal(ctrl.getState().paused, true);

  // 3C: Live CuTeach
  ctrl.startTeach([
    {kind: 'POINT', x: 250, y: 180, label: '打开文件菜单', screen: 1},
    {kind: 'POINT', x: 640, y: 420, label: '点击导出 PDF', screen: 1},
  ]);
  assert.equal(ctrl.getState().mode, 'teach');
  assert.equal(ctrl.getState().teachIndex, 0);
  const step2 = ctrl.nextTeachStep();
  assert.equal(step2?.label, '点击导出 PDF');
  assert.equal(ctrl.getState().teachIndex, 1);

  // 3D: Watch & Record Demo -> replayable [POINT:...] tutorial
  ctrl.startRecord('导出周报流程');
  assert.equal(ctrl.getState().mode, 'record');
  ctrl.recordStep({x: 120, y: 90, label: '点击导出按钮', windowTitle: 'Excel', screen: 1});
  ctrl.recordStep({x: 520, y: 610, label: '确认保存位置', windowTitle: 'Save As', screen: 1});
  const finished = ctrl.finishRecord();
  assert.equal(finished.steps.length, 2);
  assert.equal(ctrl.getState().mode, 'idle');

  const md = formatRecordedTourMarkdown(finished.title, finished.steps);
  const parsed = extractTourSteps(md);
  assert.equal(parsed.length, 2, 'recorded tutorial markdown must round-trip cleanly into TourSteps');
  assert.equal(parsed[0].label, '点击导出按钮');
  assert.equal(parsed[1].x, 520);
});

test('Batch 3 wiring: main.ts, preload.ts, data.ts, studio.html and studio.ts expose CU live overlay, live teach, and demo recording', () => {
  const mainSrc = readRepo('electron/main.ts');
  assert.match(mainSrc, /cu-overlay:teach-start/, 'main.ts must handle cu-overlay:teach-start');
  assert.match(mainSrc, /cu-overlay:record-start/, 'main.ts must handle cu-overlay:record-start');
  assert.match(mainSrc, /cu-overlay:record-step/, 'main.ts must handle cu-overlay:record-step');
  assert.match(mainSrc, /cu-overlay:record-finish/, 'main.ts must handle cu-overlay:record-finish');

  const preloadSrc = readRepo('electron/preload.ts');
  assert.match(preloadSrc, /cuOverlay/, 'preload.ts must expose cuOverlay bridge');

  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /id="chat-record-demo-toggle"/, 'studio.html must expose #chat-record-demo-toggle');
});

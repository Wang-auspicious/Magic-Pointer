import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Phase 3.1: guided_tour parser extracts [POINT]/[CIRCLE]/[ARROW]/[LABEL] and strips raw markers', () => {
  const tourModPath = path.join(ROOT, 'electron/guided_tour.ts');
  assert.ok(fs.existsSync(tourModPath), 'electron/guided_tour.ts must exist');
  const tour = require(tourModPath) as {
    extractTourSteps(text: string): Array<{
      index: number;
      x: number;
      y: number;
      screen: number;
      label: string;
      sentence: string;
      normalized: boolean;
    }>;
    stripTourMarkers(text: string): string;
    snapPointToControl(
      point: {x: number; y: number},
      controls: Array<{name: string; left: number; top: number; right: number; bottom: number}>,
      maxSnapPx?: number,
    ): {x: number; y: number; snapped: boolean; name?: string};
    denormalizeTourPoint(
      step: {x: number; y: number; screen?: number; normalized?: boolean},
      displays: Array<{x: number; y: number; width: number; height: number}>,
    ): {x: number; y: number} | null;
  };

  const sample =
    '[POINT:240,180:Export按钮:screen1] 先点击右上角的 Export 按钮打开导出面板。\n' +
    '[CIRCLE:240,180,32:导出入口]\n' +
    '[POINT:520,640:Format下拉框] 然后把格式切换为 PNG 2x。';
  const steps = tour.extractTourSteps(sample);
  assert.equal(steps.length, 2, 'must extract both POINT steps');
  assert.equal(steps[0].x, 240);
  assert.equal(steps[0].y, 180);
  assert.equal(steps[0].label, 'Export按钮');
  assert.equal(steps[0].screen, 1);
  assert.match(steps[0].sentence, /Export 按钮/);
  assert.equal(steps[1].label, 'Format下拉框');

  const stripped = tour.stripTourMarkers(sample);
  assert.doesNotMatch(stripped, /\[(?:POINT|CIRCLE|ARROW|LABEL):/);
  assert.match(stripped, /先点击右上角的 Export 按钮/);

  // Small-control snapping (<= 30px) and big-container rejection (w > 600)
  const snapped = tour.snapPointToControl(
    {x: 112, y: 54},
    [
      {name: 'BigPanel', left: 0, top: 0, right: 900, bottom: 700},
      {name: 'Export', left: 90, top: 40, right: 150, bottom: 72},
    ],
    30,
  );
  assert.equal(snapped.snapped, true);
  assert.equal(snapped.x, 120);
  assert.equal(snapped.y, 56);
  assert.equal(snapped.name, 'Export');

  const displayPt = tour.denormalizeTourPoint(
    {x: 500, y: 250, screen: 1, normalized: true},
    [{x: 0, y: 0, width: 1920, height: 1080}],
  );
  assert.deepEqual(displayPt, {x: 960, y: 270});
});

test('Phase 3.2: ChatMarkdown renders interactive .mp-tour-card and strips raw [POINT] markers', () => {
  const md = require(path.join(ROOT, 'build/electron/renderer/chat_markdown.js')) as {
    render(src: string): {outerHTML: string};
  };
  const out = md.render(
    '[POINT:240,180:导出按钮:screen1] 先点击导出按钮。\n[POINT:500,600:确认保存] 最后确认保存。',
  ).outerHTML;
  assert.doesNotMatch(out, /\[POINT:/, 'raw [POINT:] markers must be stripped from prose');
  assert.match(out, /class="mp-tour-card"/, 'must emit interactive .mp-tour-card');
  assert.match(out, /data-tour-label="导出按钮"/, 'must expose step target metadata');
  assert.match(out, /data-tour-act="autopilot"/, 'must offer Coach -> Autopilot switch');
});

test('Phase 3.3: main.ts & preload.ts expose guided-tour:point and guided-tour:clear over AgentCursorSurfaces', () => {
  const preload = readRepo('electron/preload.ts');
  const main = readRepo('electron/main.ts');
  assert.match(preload, /guidedTour:\s*\{/);
  assert.match(preload, /guided-tour:point/);
  assert.match(preload, /guided-tour:clear/);
  assert.match(main, /ipcMain\.handle\(\s*'guided-tour:point'/);
  assert.match(main, /ipcMain\.handle\(\s*'guided-tour:clear'/);
});

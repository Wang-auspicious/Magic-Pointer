import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('W2-Red: Studio never leaks [Coach Screen Tour Mode:...] into user question and wires coachMode metadata cleanly', () => {
  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.doesNotMatch(
    studioSrc,
    /\[Coach Screen Tour Mode:/,
    'studio.ts must never inject raw [Coach Screen Tour Mode:...] text into user messages',
  );
  assert.match(studioSrc, /coachMode:\s*guidedTourCoachActive/);
});

test('W2-Red: Clicking [data-tour-act="autopilot"] launches real Computer Use Autopilot instead of pasting English prompt into composer', () => {
  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.doesNotMatch(
    studioSrc,
    /Switch to Autopilot and execute these guided tour steps for me:/,
    'Autopilot button must not paste a manual prompt string into composer',
  );
  assert.match(studioSrc, /startRealComputerUseAutopilot/);
  assert.match(studioSrc, /computerUseMode:\s*'autopilot'/);

  const preloadSrc = readRepo('electron/preload.ts');
  const mainSrc = readRepo('electron/main.ts');
  assert.match(preloadSrc, /startAutopilot/);
  assert.match(mainSrc, /cu-overlay:autopilot-start/);
});

test('W2-Red: initialToolNames exposes desktop GUI tools on computerUseMode=autopilot and perception tools on coachMode', () => {
  const {initialToolNames} = require('../electron/runtime/agent_services');
  const autopilotTools = initialToolNames({
    workMode: 'code',
    computerUseMode: 'autopilot',
  }) as string[];
  for (const requiredTool of [
    'list_windows',
    'activate_window',
    'get_app_state',
    'observe_ui',
    'search_ui',
    'click',
    'type_text',
    'press_key',
    'scroll',
  ]) {
    assert.ok(
      autopilotTools.includes(requiredTool),
      `Autopilot initialToolNames must include ${requiredTool}`,
    );
  }

  const coachTools = initialToolNames({
    workMode: 'learn',
    coachMode: true,
  }) as string[];
  for (const requiredTool of ['list_windows', 'get_app_state', 'observe_ui']) {
    assert.ok(
      coachTools.includes(requiredTool),
      `Coach initialToolNames must include ${requiredTool}`,
    );
  }
});

test('W2-Red: buildSystemPrompt injects hidden Coach / Autopilot directives rather than user bubble text', async () => {
  const {buildSystemPrompt} = require('../electron/runtime/agent');
  const coachPrompt = await buildSystemPrompt({
    userDataDir: os.tmpdir(),
    workMode: 'learn',
    instruction: '怎么导出高清图',
    coachMode: true,
  });
  assert.match(coachPrompt, /\[POINT:x,y:/);
  assert.match(coachPrompt, /list_windows|observe_ui/);

  const cuPrompt = await buildSystemPrompt({
    userDataDir: os.tmpdir(),
    workMode: 'code',
    instruction: '帮我点导出',
    computerUseMode: 'autopilot',
    guidedTourSteps: [{label: '点击 Export', caption: '点击右上角 Export 按钮'}],
  });
  assert.match(cuPrompt, /Autopilot|Computer Use|点击 Export/);
  assert.match(cuPrompt, /observe_ui|click/);
});

test('W2-Red: Guided tour helpers clamp captions concisely and prevent auto-flying cursor over Studio itself', () => {
  const tour = require('../electron/guided_tour');
  assert.equal(typeof tour.formatCursorCaption, 'function');
  const short = tour.formatCursorCaption(
    '再往下看第 117-120 行的 cds-anim-loop：它让 --cds-anim2 在 50% 处跳动',
    18,
  );
  assert.ok(short.length <= 19, `Expected concise <=18 char caption + ellipsis, got "${short}"`);

  assert.equal(typeof tour.shouldAutoLaunchTourCursor, 'function');
  assert.equal(
    tour.shouldAutoLaunchTourCursor(
      [{x: 500, y: 500, screen: 1, label: '第 117 行循环'}],
      {studioForeground: true},
    ),
    false,
    'Must not auto-fly cursor over Studio itself when user did not explicitly click a step',
  );
  assert.equal(
    tour.shouldAutoLaunchTourCursor(
      [{x: 500, y: 500, screen: 1, label: 'Export 按钮'}],
      {studioForeground: false},
    ),
    true,
  );

  const overlaySrc = readRepo('electron/renderer/overlay.ts');
  const ringMatch = /const\s+AGENT_RING_BASE_RADIUS\s*=\s*(\d+)/.exec(overlaySrc);
  assert.ok(ringMatch && Number(ringMatch[1]) <= 16, 'Cursor ring radius must be compact (<=16px)');
});

'use strict';


const assert = require('assert');
const { MAX_PHASES_PER_SESSION, SessionTimeline } = require('../electron/session_timeline');

function fakeClock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

{
  const clock = fakeClock();
  const timeline = new SessionTimeline({ now: clock.now });
  timeline.begin('session-1', { reason: 'wiggle' });
  clock.advance(12873);
  timeline.phase('session-1', { script: 'scripts/selection_snapshot_bridge.py', phase: 'structured_read', ms: 12873 });
  clock.advance(760);
  timeline.phase('session-1', { script: 'scripts/selection_snapshot_bridge.py', phase: 'total', ms: 13633 });
  timeline.finish('session-1', { outcome: 'result', tier: 'L1' });

  const [session] = timeline.snapshot();
  assert.strictEqual(session.id, 'session-1');
  assert.strictEqual(session.reason, 'wiggle');
  assert.strictEqual(session.totalMs, 13633);
  assert.strictEqual(session.tier, 'L1');
  const read = session.headline.find((item) => item.phase === 'structured_read');
  assert.strictEqual(read.ms, 12873);
  assert.strictEqual(read.label, '读取结构');
}

{
  const timeline = new SessionTimeline();
  timeline.begin('old');
  timeline.begin('new');
  assert.deepStrictEqual(timeline.snapshot().map((item) => item.id), ['new', 'old']);
}

{
  const timeline = new SessionTimeline({ maxSessions: 3 });
  for (let index = 0; index < 10; index += 1) timeline.begin(`session-${index}`);
  assert.strictEqual(timeline.snapshot().length, 3);
  assert.strictEqual(timeline.snapshot()[0].id, 'session-9');

  timeline.begin('busy');
  for (let index = 0; index < MAX_PHASES_PER_SESSION + 20; index += 1) {
    timeline.phase('busy', { phase: `p${index}`, ms: index });
  }
  assert.strictEqual(timeline.snapshot()[0].phases.length, MAX_PHASES_PER_SESSION);
}

{
  const timeline = new SessionTimeline();
  timeline.begin('running');
  assert.strictEqual(timeline.snapshot()[0].totalMs, null);
}

{
  const timeline = new SessionTimeline();
  timeline.begin('same', { reason: 'wiggle' });
  timeline.begin('same', { reason: 'hotkey' });
  assert.strictEqual(timeline.snapshot().length, 1);
  assert.strictEqual(timeline.snapshot()[0].reason, 'wiggle');
}

{
  const timeline = new SessionTimeline();
  timeline.phase('never-began', { phase: 'total', ms: 100 });
  timeline.finish('never-began', { outcome: 'result' });
  assert.deepStrictEqual(timeline.snapshot(), []);
}

{
  const timeline = new SessionTimeline();
  timeline.begin('privacy', { reason: 'wiggle' });
  timeline.phase('privacy', {
    script: 'scripts/selection_snapshot_bridge.py',
    phase: 'structured_read',
    ms: 120,
    detail: 'layer=uia',
  });
  timeline.finish('privacy', { outcome: 'result' });
  const text = JSON.stringify(timeline.snapshot());
  for (const forbidden of ['title', 'content', 'capture_path', 'excerpt', 'text']) {
    assert(!text.includes(forbidden), `时间线里出现了 ${forbidden}`);
  }
}

{
  const timeline = new SessionTimeline();
  timeline.begin('failed');
  timeline.finish('failed', { outcome: 'error', error: '这次处理超时了，没有改动任何东西。' });
  const [session] = timeline.snapshot();
  assert(session.error.includes('超时'));
  assert(!/^[a-z]+_[a-z_]+$/.test(session.error), '错误码原样进了诊断页');
}

{
  const timeline = new SessionTimeline();
  assert.strictEqual(timeline.begin(''), null);
  assert.strictEqual(timeline.begin(null), null);
  timeline.begin('ok');
  timeline.phase('ok', { phase: 'x', ms: NaN });
  assert.strictEqual(timeline.snapshot()[0].phases[0].ms, 0);
  timeline.clear();
  assert.deepStrictEqual(timeline.snapshot(), []);
}

console.log('session_timeline_test: all assertions passed');

{
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');

  assert(main.includes("sessionTimeline.begin(entry.token, { reason: String(reason || '') })"), 'sessions never begin');
  assert(main.includes('timelineToken: entry.token'), 'the snapshot bridge does not report phases');
  assert(main.includes('timelineToken: selectionSessionToken'), 'the command bridge does not report phases');
  assert(main.includes('sessionTimeline.finish(payload.selectionSessionToken'), 'sessions never finish');

  assert(main.includes("ipcMain.handle('dashboard:session-timeline'"), 'no IPC handler');
  assert(preload.includes("sessionTimeline: () => ipcRenderer.invoke('dashboard:session-timeline')"), 'not exposed to the renderer');
}
console.log('session timeline wiring test ok');

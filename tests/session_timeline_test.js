'use strict';

// 诊断页要能替代"手翻 electron.log"。
//
// 2026-08-04 那次排查完全靠肉眼对时间戳，而所有数字其实早就在打点了——只是
// 只写进了日志文件。这里钉两件事：时间线要准，而且**不能**把用户屏幕上的内容
// 变成第二份留存。

const assert = require('assert');
const { MAX_PHASES_PER_SESSION, SessionTimeline } = require('../electron/session_timeline');

function fakeClock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

// 一次会话的相位按顺序记下，总耗时从激活算到结束（用户关心的是从手势到答案）。
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
  // 这一行就是当时需要一眼看到的东西。
  const read = session.headline.find((item) => item.phase === 'structured_read');
  assert.strictEqual(read.ms, 12873);
  assert.strictEqual(read.label, '读取结构');
}

// 最新的在最前面——排查的总是刚发生的那次。
{
  const timeline = new SessionTimeline();
  timeline.begin('old');
  timeline.begin('new');
  assert.deepStrictEqual(timeline.snapshot().map((item) => item.id), ['new', 'old']);
}

// 有界：一个会越长越大的诊断本身就成了问题。
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

// 未结束的会话总耗时是 null，不是 0——"还在跑"和"零毫秒完成"不是一回事。
{
  const timeline = new SessionTimeline();
  timeline.begin('running');
  assert.strictEqual(timeline.snapshot()[0].totalMs, null);
}

// 相同 token 重复 begin 不制造第二条记录。
{
  const timeline = new SessionTimeline();
  timeline.begin('same', { reason: 'wiggle' });
  timeline.begin('same', { reason: 'hotkey' });
  assert.strictEqual(timeline.snapshot().length, 1);
  assert.strictEqual(timeline.snapshot()[0].reason, 'wiggle');
}

// 未知 token 的相位被丢掉，而不是凭空造一条会话。
{
  const timeline = new SessionTimeline();
  timeline.phase('never-began', { phase: 'total', ms: 100 });
  timeline.finish('never-began', { outcome: 'result' });
  assert.deepStrictEqual(timeline.snapshot(), []);
}

// 最关键的一条：时间线里不能出现屏幕内容。只有时长、脚本名、相位名。
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

// 失败原因必须是人话，而不是桥的错误码——这页是给人看的。
{
  const timeline = new SessionTimeline();
  timeline.begin('failed');
  timeline.finish('failed', { outcome: 'error', error: '这次处理超时了，没有改动任何东西。' });
  const [session] = timeline.snapshot();
  assert(session.error.includes('超时'));
  assert(!/^[a-z]+_[a-z_]+$/.test(session.error), '错误码原样进了诊断页');
}

// 畸形输入不产生假数据。
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

// --- Wiring ---------------------------------------------------------------
// The timeline is only worth having if it is actually fed and actually shown.
{
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.js'), 'utf8');

  // Fed: activation opens a session, bridges report phases into it, outcomes close it.
  assert(main.includes("sessionTimeline.begin(entry.token, { reason: String(reason || '') })"), 'sessions never begin');
  assert(main.includes('timelineToken: entry.token'), 'the snapshot bridge does not report phases');
  assert(main.includes('timelineToken: selectionSessionToken'), 'the command bridge does not report phases');
  assert(main.includes('sessionTimeline.finish(payload.selectionSessionToken'), 'sessions never finish');

  // Shown: exposed over IPC and rendered.
  assert(main.includes("ipcMain.handle('dashboard:session-timeline'"), 'no IPC handler');
  assert(preload.includes("sessionTimeline: () => ipcRenderer.invoke('dashboard:session-timeline')"), 'not exposed to the renderer');
  assert(html.includes('id="session-timeline"'), 'no container on the diagnostics page');
  assert(js.includes('function renderSessionTimeline('), 'never rendered');
  assert(js.includes('requestSessionTimeline()'), 'never requested');

  // A slow step must be pointed at, not left for the reader to spot by comparing
  // numbers — that is exactly the manual work this page replaces.
  assert(js.includes('SLOW_PHASE_MS'), 'slow phases are not marked');
  assert(js.includes("chip.dataset.slow = '1'"));

  // "Still running" must not render as a duration.
  assert(js.includes("session.totalMs === null ? '进行中…'"));
}
console.log('session timeline wiring test ok');

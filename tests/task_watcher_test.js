'use strict';

// 后台任务观察器。底层（app/fabric/task_store.py）早就能跑任务、能查状态，
// 缺的一环是 Electron 这边没人在看——任务起来之后卡就静止了。这份测试钉住
// 那一环：轮询会退避、状态变成卡片补丁、终态就停、查询失败不当成任务失败。

const assert = require('node:assert');
const watcher = require('../electron/task_watcher');
const CardModel = require('../electron/cards');

// ---------------------------------------------------------------------------
// 退避：刚起来的任务变化快，跑久了的变化慢
// ---------------------------------------------------------------------------
assert.strictEqual(watcher.pollDelayMs(0), 1000, '头 10 秒最可能出错，看得勤一点');
assert.strictEqual(watcher.pollDelayMs(9_000), 1000);
assert.strictEqual(watcher.pollDelayMs(11_000), 2000);
assert.strictEqual(watcher.pollDelayMs(2 * 60_000), 4000);
assert.strictEqual(watcher.pollDelayMs(30 * 60_000), 8000,
  '再慢用户就会觉得界面卡住了，所以有上限');

// ---------------------------------------------------------------------------
// 状态翻译：诚实是这里唯一的要求
// ---------------------------------------------------------------------------
assert.strictEqual(watcher.cardPatchFromTask({ status: 'queued' }).state, 'running');
assert.strictEqual(watcher.cardPatchFromTask({ status: 'queued' }).stage, '排队中');
assert.strictEqual(watcher.cardPatchFromTask({ status: 'running' }).state, 'running');
assert.strictEqual(watcher.cardPatchFromTask({ status: 'succeeded' }).state, 'done');

// 只知道「在跑」时不能编一个百分比出来
assert.strictEqual(watcher.cardPatchFromTask({ status: 'running' }).progress, undefined,
  '任务没报进度就不要凭空给一个数字');

// 取消和中断都是失败，但要说清区别——用户要判断有没有东西被改了
const cancelled = watcher.cardPatchFromTask({ status: 'cancelled' });
assert.strictEqual(cancelled.state, 'failed');
assert.match(cancelled.error, /没有改动任何东西/);
const interrupted = watcher.cardPatchFromTask({ status: 'interrupted' });
assert.match(interrupted.error, /已完成的部分保留/);

// 目标窗口被切走：既不是失败也不是还在跑，归到任何一头都会让用户误判
const paused = watcher.cardPatchFromTask({ status: 'paused_target_mismatch' });
assert.strictEqual(paused.state, 'running');
assert.strictEqual(paused.needsConfirm, true);
assert.match(paused.stage, /等你确认/);

// 任务自己报的阶段要带过去
const withSteps = watcher.cardPatchFromTask({
  status: 'running',
  result: { steps: [{ phase: 'render', label: '正在出第 3 帧', ms: 812 }], progress: 0.6 },
});
assert.strictEqual(withSteps.steps.length, 1);
assert.strictEqual(withSteps.steps[0].label, '正在出第 3 帧');
assert.strictEqual(withSteps.progress, 0.6);

// 出图完成 → 这张卡就地变成图，路径转成能加载的形式
const done = watcher.cardPatchFromTask({
  status: 'succeeded',
  summary: '去掉了背景',
  result: { imagePath: 'C:\\Users\\a\\out.png', width: 1024, height: 640 },
}, CardModel);
assert.strictEqual(done.state, 'done');
assert.strictEqual(done.kind, 'image');
assert.strictEqual(done.src, 'file:///C:/Users/a/out.png', 'Windows 路径要转成 file:// 才加载得出来');

// 盘符长得像 URL scheme——用 /^[a-z]+:/ 判断会让 Windows 上每张出好的图都加载不出来
assert.strictEqual(watcher.toDisplaySrc('C:\\x\\y.png'), 'file:///C:/x/y.png');
assert.strictEqual(watcher.toDisplaySrc('/tmp/out.png'), 'file:///tmp/out.png');
assert.strictEqual(watcher.toDisplaySrc('https://x/a.png'), 'https://x/a.png', '已经是 URL 的原样放过');
assert.strictEqual(watcher.toDisplaySrc('data:image/png;base64,AA'), 'data:image/png;base64,AA');
assert.strictEqual(watcher.toDisplaySrc(''), '');
assert.strictEqual(done.w, 1024);
assert.strictEqual(done.caption, '去掉了背景');

// ---------------------------------------------------------------------------
// 端到端：queued → running → succeeded，一张卡从头走到尾
// ---------------------------------------------------------------------------
(async () => {
  const sequence = [
    { status: 'queued' },
    { status: 'running', result: { steps: [{ phase: 'a', label: '读了原图' }] } },
    { status: 'running', result: { steps: [{ phase: 'a', label: '读了原图' }, { phase: 'b', label: '抠出了主体' }], progress: 0.5 } },
    { status: 'succeeded', summary: '去掉了背景', result: { imagePath: '/tmp/out.png' } },
  ];
  let index = 0;
  const patches = [];
  const pending = [];
  let clock = 0;

  const w = watcher.createTaskWatcher({
    probe: async () => sequence[Math.min(index++, sequence.length - 1)],
    onPatch: (p) => patches.push(p),
    now: () => clock,
    // 手动驱动时钟，测试才不用真的等
    schedule: (fn) => { pending.push(fn); return { unref() {} }; },
    cancelSchedule: () => {},
    CardModel,
  });

  w.watch({ taskId: 'task-1', cardId: 'card-1', selectionSessionToken: 'tok' });
  // tick 是 async：probe 落在微任务里，schedule 又要等 probe 回来才被调用。
  // 所以每推进一步都要把微任务队列彻底放空，否则 pending 还是空的。
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  await flush();
  for (let i = 0; i < 8 && pending.length; i += 1) {
    clock += 1500;
    pending.shift()();
    await flush();
  }

  assert.ok(patches.length >= 4, `一路应当推出多次补丁，实际 ${patches.length}`);
  assert.strictEqual(patches[0].cardId, 'card-1', '补丁要认得回是哪张卡');
  assert.strictEqual(patches[0].selectionSessionToken, 'tok');
  const last = patches[patches.length - 1];
  assert.strictEqual(last.patch.state, 'done');
  assert.strictEqual(last.patch.kind, 'image');
  assert.deepStrictEqual(w.watching(), [], '终态之后必须停止轮询');

  // 同一张卡按契约走一遍：进度只增不减、终态锁死
  let card = CardModel.normalizeCard({ id: 'card-1', kind: 'image', state: 'running' });
  for (const p of patches) card = CardModel.applyPatch(card, p.patch);
  assert.strictEqual(card.id, 'card-1', '始终是同一张卡');
  assert.strictEqual(card.state, 'done');
  assert.strictEqual(card.progress, 1);
  assert.strictEqual(card.steps.length, 2, '同一阶段报两次不出两行');

  // ---- 查询失败不算任务失败 ----
  const flaky = [];
  let calls = 0;
  const w2 = watcher.createTaskWatcher({
    probe: async () => {
      calls += 1;
      if (calls === 1) throw new Error('spawn_failed');
      return { status: 'succeeded' };
    },
    onPatch: (p) => flaky.push(p),
    now: () => 0,
    schedule: (fn) => { setTimeout(fn, 0); return { unref() {} }; },
    CardModel,
  });
  w2.watch({ taskId: 'task-2', cardId: 'card-2' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(flaky.length >= 1, '第一次查询挂了要继续看，不能把任务判死');
  assert.strictEqual(flaky[flaky.length - 1].patch.state, 'done');

  // ---- 同一个任务不重复观察 ----
  const w3 = watcher.createTaskWatcher({
    probe: async () => ({ status: 'running' }),
    now: () => 0,
    schedule: () => ({ unref() {} }),
  });
  assert.strictEqual(w3.watch({ taskId: 'x', cardId: 'c' }), true);
  assert.strictEqual(w3.watch({ taskId: 'x', cardId: 'c' }), false, '同一个任务只看一次');
  assert.strictEqual(w3.watch({ taskId: '', cardId: 'c' }), false);
  w3.stopAll();
  assert.deepStrictEqual(w3.watching(), []);

  console.log('task watcher test ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

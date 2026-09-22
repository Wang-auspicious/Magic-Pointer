'use strict';


const assert = require('node:assert');
const watcher = require('../electron/task_watcher');
const CardModel = require('../electron/cards');

assert.strictEqual(watcher.pollDelayMs(0), 1000, '头 10 秒最可能出错，看得勤一点');
assert.strictEqual(watcher.pollDelayMs(9_000), 1000);
assert.strictEqual(watcher.pollDelayMs(11_000), 2000);
assert.strictEqual(watcher.pollDelayMs(2 * 60_000), 4000);
assert.strictEqual(watcher.pollDelayMs(30 * 60_000), 8000,
  '再慢用户就会觉得界面卡住了，所以有上限');

assert.strictEqual(watcher.cardPatchFromTask({ status: 'queued' }).state, 'running');
assert.strictEqual(watcher.cardPatchFromTask({ status: 'queued' }).stage, '排队中');
assert.strictEqual(watcher.cardPatchFromTask({ status: 'running' }).state, 'running');
assert.strictEqual(watcher.cardPatchFromTask({ status: 'succeeded' }).state, 'done');

assert.strictEqual(watcher.cardPatchFromTask({ status: 'running' }).progress, undefined,
  '任务没报进度就不要凭空给一个数字');

const cancelled = watcher.cardPatchFromTask({ status: 'cancelled' });
assert.strictEqual(cancelled.state, 'failed');
assert.match(cancelled.error, /记录在会话里/);
assert.match(cancelled.error, /不会再有新动作/);
const interrupted = watcher.cardPatchFromTask({ status: 'interrupted' });
assert.match(interrupted.error, /已完成的部分保留/);

const paused = watcher.cardPatchFromTask({ status: 'paused_target_mismatch' });
assert.strictEqual(paused.state, 'running');
assert.strictEqual(paused.needsConfirm, true);
assert.match(paused.stage, /等你确认/);

const withSteps = watcher.cardPatchFromTask({
  status: 'running',
  result: { steps: [{ phase: 'render', label: '正在出第 3 帧', ms: 812 }], progress: 0.6 },
});
assert.strictEqual(withSteps.steps.length, 1);
assert.strictEqual(withSteps.steps[0].label, '正在出第 3 帧');
assert.strictEqual(withSteps.progress, 0.6);

const done = watcher.cardPatchFromTask({
  status: 'succeeded',
  summary: '去掉了背景',
  result: { imagePath: 'C:\\Users\\a\\out.png', width: 1024, height: 640 },
}, CardModel);
assert.strictEqual(done.state, 'done');
assert.strictEqual(done.kind, 'image');
assert.strictEqual(done.src, 'file:///C:/Users/a/out.png', 'Windows 路径要转成 file:// 才加载得出来');

assert.strictEqual(watcher.toDisplaySrc('C:\\x\\y.png'), 'file:///C:/x/y.png');
assert.strictEqual(watcher.toDisplaySrc('/tmp/out.png'), 'file:///tmp/out.png');
assert.strictEqual(watcher.toDisplaySrc('https://x/a.png'), 'https://x/a.png', '已经是 URL 的原样放过');
assert.strictEqual(watcher.toDisplaySrc('data:image/png;base64,AA'), 'data:image/png;base64,AA');
assert.strictEqual(watcher.toDisplaySrc(''), '');
assert.strictEqual(done.w, 1024);
assert.strictEqual(done.caption, '去掉了背景');

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
    schedule: (fn) => { pending.push(fn); return { unref() {} }; },
    cancelSchedule: () => {},
    CardModel,
  });

  w.watch({ taskId: 'task-1', cardId: 'card-1', selectionSessionToken: 'tok' });
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

  let card = CardModel.normalizeCard({ id: 'card-1', kind: 'image', state: 'running' });
  for (const p of patches) card = CardModel.applyPatch(card, p.patch);
  assert.strictEqual(card.id, 'card-1', '始终是同一张卡');
  assert.strictEqual(card.state, 'done');
  assert.strictEqual(card.progress, 1);
  assert.strictEqual(card.steps.length, 2, '同一阶段报两次不出两行');

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

  {
    let visible = false;
    let probes = 0;
    let status = 'running';
    const gatedPatches = [];
    const pending = [];
    let clock = 0;

    const w = watcher.createTaskWatcher({
      probe: async () => { probes += 1; return { status }; },
      probeEnabled: () => visible,
      idleDelayMs: 15_000,
      onPatch: (p) => gatedPatches.push(p),
      now: () => clock,
      schedule: (fn, ms) => { pending.push({ fn, ms }); return { unref() {} }; },
      cancelSchedule: () => {},
      CardModel,
    });
    const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

    w.watch({ taskId: 'gated-1', cardId: 'card-g' });
    await flush();
    assert.strictEqual(probes, 0, '卡片不可见时一次 probe 都不该发生');
    assert.deepStrictEqual(w.watching(), ['gated-1'], '跳过 probe 不等于放弃这条 watch');
    assert.strictEqual(pending.length, 1, '闸门关闭时要排下一次，不能停摆');
    assert.strictEqual(pending[0].ms, 15_000, '闸门关闭时用 idle 间隔重排');

    status = 'succeeded';
    clock += 20_000;
    pending.shift().fn();
    await flush();
    assert.strictEqual(probes, 0, '闸门仍然关着，还是不该 probe');
    assert.strictEqual(gatedPatches.length, 0);

    visible = true;
    w.kick();
    await flush();
    assert.strictEqual(probes, 1, 'kick 必须立刻放行一次 probe');
    assert.strictEqual(gatedPatches.length, 1, 'kick 之后积压的终态必须马上变成补丁');
    assert.strictEqual(gatedPatches[0].patch.state, 'done');
    assert.deepStrictEqual(w.watching(), [], '终态之后照常停止轮询');
  }

  {
    const pending = [];
    let probes = 0;
    const w = watcher.createTaskWatcher({
      probe: async () => { probes += 1; return { status: 'running' }; },
      now: () => 0,
      schedule: (fn, ms) => { pending.push(ms); return { unref() {} }; },
      cancelSchedule: () => {},
    });
    for (const id of ['a', 'b', 'c']) w.watch({ taskId: id, cardId: `card-${id}` });
    await Promise.resolve();
    assert.strictEqual(probes, 3, 'watch() 会立刻看一次');
    assert.deepStrictEqual(pending, [1000, 1000, 1000], '回到退避节奏');
    pending.length = 0;
    w.kick();
    assert.deepStrictEqual(pending, [200, 400], 'kick 要错峰：第一个立刻、后面依次排开');
    assert.strictEqual(probes, 4, '错开的是排期，不是少看一次');
  }

  console.log('task watcher test ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

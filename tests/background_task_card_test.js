'use strict';

// 「进度条一直到 100% 以后就返图」这条路径的接线。
//
// 底层早就齐了：任务落盘、状态可查、进程存活可验（app/fabric/task_store.py）。
// 一直缺的是 Electron 这边没人在看——任务起来之后卡就静止，直到用户重新打开
// 界面。这份测试钉住整条线，任何一段断掉都会红。

const assert = require('assert');
const fs = require('fs');
const CardModel = require('../electron/cards');
const watcher = require('../electron/task_watcher');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const live = fs.readFileSync('electron/renderer/live_cards.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const companion = fs.readFileSync('electron/renderer/companion.ts', 'utf8');
const studioHtml = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const companionHtml = fs.readFileSync('electron/renderer/companion.html', 'utf8');

// ---- 主进程：受理了就开始看 ----
assert(main.includes('function watchTaskFromEvent('),
  '结果里带了 taskId 就要开始盯着它，「已受理」不是「已完成」');
assert(main.includes('watchTaskFromEvent(payload)'), '必须真的在 updateStage 里调用');
assert(main.includes("require('./task_watcher')"));
assert(main.includes("'scripts/agent_bridge.py'"), '状态查询走 agent_bridge status');
// 三个界面收同一份补丁，否则「他们俩应该是完全同步的才对」又会重演
assert(main.includes("safeSurfaceSend('stage', 'stage:card-patch'"));
assert(/for \(const window of \[companionWindow, dashboardWindow\]\)/.test(main),
  '随行窗和工作室看的是同一次会话，补丁要一起送');

// ---- preload：两条桥都要暴露 ----
assert(preload.includes('onCardPatch'), 'dashboard 和 companion 都要能收补丁');
assert((preload.match(/stage:card-patch/g) || []).length >= 3,
  'stage / dashboard / companion 三处都要挂上');

// ---- 渲染层：就地更新，不重建 ----
assert(live.includes('existing.replaceWith('), '就地换掉那一张，不重建整条流');
assert(live.includes('CardModel.applyPatch('), '补丁走契约：进度只增不减、终态锁死');
assert(live.includes('clearInterval'), '终态之后要停掉计时器，不能一直空转');
assert(live.includes('CSS.escape('), 'cardId 来自任务，拼进选择器之前必须转义');
for (const [name, source, html] of [
  ['studio', studio, studioHtml],
  ['companion', companion, companionHtml],
]) {
  assert(source.includes('LiveCards.track('), `${name} 要登记卡片，否则补丁找不到它`);
  assert(source.includes('LiveCards.patch('), `${name} 要接补丁`);
  assert(source.includes('LiveCards.reset()'), `${name} 换对话时要清掉旧卡的计时器`);
  assert(html.includes('live_cards.js'), `${name}.html 要加载它`);
}

// ---- 端到端：一次出图从受理走到出图 ----
let card = CardModel.normalizeCard({ id: 'gen1', kind: 'image', state: 'running', w: 1024, h: 640 });
const feed = [
  { status: 'queued' },
  { status: 'running', result: { steps: [{ phase: 'read', label: '读了原图' }] } },
  { status: 'running', result: { steps: [{ phase: 'cut', label: '抠出了主体' }], progress: 0.55 } },
  { status: 'succeeded', summary: '去掉了背景', result: { imagePath: 'C:\\out\\a.png', width: 1024, height: 640 } },
];
const seen = [];
for (const task of feed) {
  card = CardModel.applyPatch(card, watcher.cardPatchFromTask(task, CardModel));
  seen.push(card.progress);
}
assert.strictEqual(card.id, 'gen1', '始终是同一张卡——这就是「就地变成图」');
assert.strictEqual(card.state, 'done');
assert.strictEqual(card.src, 'file:///C:/out/a.png');
assert.strictEqual(card.progress, 1);
// 进度一路不许回头
for (let i = 1; i < seen.length; i += 1) {
  const prev = seen[i - 1] ?? 0;
  assert.ok((seen[i] ?? 0) >= prev, `进度不能回头：${prev} → ${seen[i]}`);
}

// 中途失败要停在断掉的地方，并且说清有没有东西被改了
const broken = CardModel.applyPatch(
  CardModel.applyPatch(
    CardModel.normalizeCard({ id: 'gen2', kind: 'image', state: 'running' }),
    watcher.cardPatchFromTask({ status: 'running', result: { progress: 0.4 } }),
  ),
  watcher.cardPatchFromTask({ status: 'cancelled' }),
);
assert.strictEqual(broken.state, 'failed');
assert.strictEqual(broken.progress, 0.4, '失败停在断掉的地方，不归零也不补满');
assert.match(broken.error, /没有改动任何东西/);

console.log('background task card test ok');

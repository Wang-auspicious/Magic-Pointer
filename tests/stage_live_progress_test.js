'use strict';

// 「小窗转半天没结果然后消失」——桥其实一直在报它走到哪一步了
// （`@@mp phase=…`），只是主进程挑走一个用来揭示胶囊，其余全丢掉。
// 这份测试钉住那条线：桥 → 主进程 → preload → 胶囊上正在等的那张卡。

const assert = require('assert');
const fs = require('fs');
const CardModel = require('../electron/cards');

const main = fs.readFileSync('electron/main.js', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const stage = fs.readFileSync('electron/renderer/stage.js', 'utf8');

// ---- 主进程：答案桥的阶段要发出去，不能只喂给 timeline ----
assert(main.includes("safeSurfaceSend('stage', 'stage:card-patch'"),
  '桥的阶段必须送到舞台，否则界面上只剩一个跳动的秒数');
assert(main.includes('CardModel.phaseStep(record)'),
  '阶段行要经过 cards.js 翻译成人话，不能把 phase=pixels_frozen 直接摆给用户看');
assert(main.includes("require('./cards')"), '主进程和界面必须用同一份卡片契约');
// 过期的那一轮不能往当前这张卡上打补丁
assert(/onProgress: \(record\) => \{\s*\n\s*if \(!selectionSessions\.isCurrentRequest\(/.test(main),
  '只有当前这一轮的阶段才算数，迟到的那一轮不能往新卡上写');

// ---- preload ----
assert(preload.includes("onCardPatch:"), 'preload 要把这条通道暴露出来');
assert(preload.includes("onPayload('stage:card-patch'"));

// ---- 胶囊 ----
assert(stage.includes('function patchRunningCard('));
assert(stage.includes('api.onCardPatch('));
assert(stage.includes('CardModel.applyPatch('), '补丁要走契约，进度只增不减的规矩在那里');
// 等待中的那张卡和最终那张必须是同一张：同 id、同 kind、同版式
assert(stage.includes('function runningCardFor('));
assert(stage.includes("renderCard(card, { density: 'capsule' })"));
assert(!stage.includes('tplTurnWait'),
  '通用的转圈模板已经被会说话的卡取代，不该还留着第二条渲染路径');
// 秒数仍然要有：只靠步骤行分不出「两秒」和「卡死两分钟」
assert(stage.includes('[data-elapsed]'));

// ---- 端到端跑一遍契约：桥报三步 → 卡上就该有三步和一个真进度 ----
let card = CardModel.normalizeCard({ id: 't1', kind: 'prose', state: 'running' });
for (const phase of ['payload_read', 'pixels_frozen', 'structured_read']) {
  card = CardModel.applyPatch(card, { steps: [CardModel.phaseStep({ phase, ms: 40 })] });
}
assert.strictEqual(card.steps.length, 3);
assert.ok(card.progress > 0 && card.progress < 1, '走了三步就该有进度，且还没走完');
// 三步都已经打勾了，所以现在说的不该是「读窗口里的文字」——那句话就在下面
// 列着并且打着勾。说清在等什么才是有信息量的。
assert.strictEqual(CardModel.runningLabel(card), '在等模型回话');

// 结果到了：同一张卡，就地长出身子
card = CardModel.applyPatch(card, { state: 'done', answer: '这是 UIA 探针的硬超时兜底。' });
assert.strictEqual(card.id, 't1', '不是换一张卡，是这张卡自己走完了');
assert.strictEqual(card.progress, 1);

console.log('stage live progress test ok');

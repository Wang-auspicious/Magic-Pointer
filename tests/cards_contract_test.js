'use strict';

const assert = require('node:assert');
const cards = require('../electron/cards');

// ---- 认不出来的 kind 要退成一段话，绝不留白屏 ----
assert.strictEqual(cards.normalizeKind('image'), 'image');
assert.strictEqual(cards.normalizeKind('inline'), 'prose', '旧名字要能翻译过来');
assert.strictEqual(cards.normalizeKind('text-draft'), 'diff');
assert.strictEqual(cards.normalizeKind('table-compare'), 'table');
assert.strictEqual(cards.normalizeKind('agent-prompt-draft'), 'prompt');
assert.strictEqual(cards.normalizeKind('未来某种新卡'), 'prose');
assert.strictEqual(cards.normalizeKind(undefined), 'prose');

// ---- 桥的阶段行变成人话 ----
const step = cards.phaseStep({ phase: 'pixels_frozen', ms: 412, fields: { w: '2950', h: '1200' } });
assert.strictEqual(step.label, '冻住了这块画面');
assert.strictEqual(step.note, '2950×1200', '阶段自带的事实比阶段名更能说明它真看见了东西');
assert.strictEqual(step.ms, 412);
assert.strictEqual(cards.phaseStep({}), null);
assert.strictEqual(
  cards.phaseStep({ phase: 'some_new_phase' }).label,
  'some new phase',
  '没见过的阶段也要有个能看的名字，不能整行消失',
);

// ---- 进度不许编 ----
assert.strictEqual(cards.progressFromSteps([]), null, '一步都还没走完时没有进度可言');
assert.ok(cards.progressFromSteps(new Array(3).fill({ state: 'done' })) > 0);
assert.ok(
  cards.progressFromSteps(new Array(50).fill({ state: 'done' })) <= 0.92,
  '走满估计值也要留一段给真正的终态，不能出现「条到头了却还没结果」',
);

// ---- 归一化 ----
const fresh = cards.normalizeCard({ kind: 'image', state: 'running' });
assert.ok(fresh.id, '每张卡都要有稳定标识，补丁按它找');
assert.strictEqual(fresh.progress, null, '没有已知阶段时进度是 null，渲染成不定量条');
assert.strictEqual(cards.normalizeCard({ state: 'done' }).progress, 1);
assert.strictEqual(cards.normalizeCard({}).state, 'done', '不说状态就当它是现成的结果');

// ---- 打补丁：进度只增不减 ----
let card = cards.normalizeCard({ kind: 'image', state: 'running', id: 'k1' });
card = cards.applyPatch(card, { progress: 0.4 });
assert.strictEqual(card.progress, 0.4);
card = cards.applyPatch(card, { progress: 0.2 });
assert.strictEqual(card.progress, 0.4, '一条往回缩的进度条会让人以为出错了');
assert.strictEqual(card.id, 'k1', '打补丁不能换掉标识');

// ---- 打补丁：steps 按阶段合并，同一阶段报两次不出两行 ----
card = cards.applyPatch(card, { steps: [cards.phaseStep({ phase: 'structured_read' })] });
card = cards.applyPatch(card, { steps: [cards.phaseStep({ phase: 'structured_read', ms: 90 })] });
assert.strictEqual(card.steps.length, 1);
assert.strictEqual(card.steps[0].ms, 90, '后到的同一阶段要覆盖前一条');
card = cards.applyPatch(card, { steps: [cards.phaseStep({ phase: 'route_recipe' })] });
assert.strictEqual(card.steps.length, 2);

// ---- 打补丁：kind 从第一帧就定下来，中途不该被换掉…… ----
// ……但结果字段可以随时补上，这正是「进度条走到 100% 然后就地变成图」
card = cards.applyPatch(card, { state: 'done', src: 'file:///x/out.png', title: '改好了' });
assert.strictEqual(card.kind, 'image');
assert.strictEqual(card.state, 'done');
assert.strictEqual(card.progress, 1, '到了终态进度就是满的');
assert.strictEqual(card.src, 'file:///x/out.png');

// ---- 终态锁死：迟到的补丁不能把一张卡改活 ----
const late = cards.applyPatch(card, { state: 'running', progress: 0.1, src: '' });
assert.strictEqual(late.state, 'done');
assert.strictEqual(late.src, 'file:///x/out.png');

const broken = cards.applyPatch(
  cards.applyPatch(cards.normalizeCard({ kind: 'image', state: 'running' }), { progress: 0.6 }),
  { state: 'failed', error: '模型没返回' },
);
assert.strictEqual(broken.state, 'failed');
assert.strictEqual(broken.progress, 0.6, '失败要停在断掉的地方，别归零也别补满');
assert.strictEqual(cards.applyPatch(broken, { state: 'done' }).state, 'failed');

// ---- 等待时说什么：宁可具体，也不要「正在处理」 ----
assert.strictEqual(cards.runningLabel({ kind: 'image' }), '正在出图');
assert.strictEqual(cards.runningLabel({ kind: 'proposal' }), '正在想该怎么改');
assert.strictEqual(
  cards.runningLabel({ kind: 'image', steps: [{ label: '读窗口里的文字' }] }),
  '读窗口里的文字',
  '有真实阶段可说就说阶段，别退回泛泛的一句',
);
assert.strictEqual(cards.runningLabel({ kind: 'image', stage: '第 3 帧 / 共 5 帧' }), '第 3 帧 / 共 5 帧');
assert.strictEqual(cards.runningLabel({}), '正在想');

// ---- 终态判定 ----
assert.ok(!cards.isSettled({ state: 'running' }));
assert.ok(cards.isSettled({ state: 'done' }));
assert.ok(cards.isSettled({ state: 'failed' }));

console.log('cards contract test ok');

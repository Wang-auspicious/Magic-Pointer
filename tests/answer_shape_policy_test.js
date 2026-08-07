'use strict';

// 两种回答框的分界线。钉的是那条唯一的判据——**产物要不要送出去**——
// 以及它拿不准时必须偏向哪一边。

const assert = require('assert');
const { answerShape } = require('../electron/answer_shape_policy');

// --- 要送出去的 -------------------------------------------------------------
// 回微信、回邮件这类：对面读到的是字，所以不许带 markdown，写之前要点头。
for (const command of ['帮我回复一下他', '这段润色一下', '改写得客气点', '语气委婉一点', '扩写到长一点']) {
  const shape = answerShape({ command });
  assert.strictEqual(shape.shape, 'deliver', `「${command}」是要发出去的：${shape.reason}`);
  assert.strictEqual(shape.allowMarkdown, false, '发出去的东西不许带 markdown');
  assert.strictEqual(shape.needsConsent, true, '往别人窗口里写必须先点头');
}

// 桥排了一个会写回用户文档的动作，那这次就是要送出去的——不用去猜命令。
assert.strictEqual(answerShape({
  command: '随便什么',
  result: { actionProposals: [{ action_type: 'office_replace_selection' }] },
}).shape, 'deliver');

// 长度目标（扩写/压缩）改的是用户自己那段字，改完是要落回去的。
assert.strictEqual(answerShape({ result: { intentKind: 'length_target' } }).shape, 'deliver');

// --- 自己看的 ---------------------------------------------------------------
// 生图、工具界面、日程、对比表：没有「把它发给对方」这回事。
for (const kind of ['image', 'slot', 'table', 'calendar', 'metric', 'prompt', 'proposal', 'steps']) {
  const shape = answerShape({ kind, result: { kind }, command: '帮我回复一下' });
  assert.strictEqual(shape.shape, 'inspect', `${kind} 卡是给人看的`);
  assert.strictEqual(shape.allowMarkdown, true, '自己看的东西要能渲染 markdown 和图');
  assert.strictEqual(shape.needsConsent, false, '不往外写就没有什么需要点头');
}

for (const command of ['这是什么', '解释一下这段', '为什么会这样', '帮我画一张图', '这个是干嘛的']) {
  assert.strictEqual(answerShape({ command }).shape, 'inspect', `「${command}」是讲给我听的`);
}

// 两类动词撞车时，「讲给我听」优先：问的是解释，不是要一段能直接发出去的话。
assert.strictEqual(answerShape({ command: '解释一下这段该怎么润色' }).shape, 'inspect',
  '同时命中两类动词时必须偏向不写');

// --- 拿不准时 ---------------------------------------------------------------
// 判错成 inspect，用户少一个按钮；判错成 deliver，我们会剥掉格式并准备往别人的
// 窗口里塞字。代价不对等，所以默认永远是 inspect。
assert.strictEqual(answerShape({}).shape, 'inspect');
assert.strictEqual(answerShape({ command: 'asdfgh' }).shape, 'inspect');
assert.strictEqual(answerShape({ command: '', result: null }).shape, 'inspect');

// --- 桥说了算 ---------------------------------------------------------------
// 桥知道自己走的是哪条 recipe，比我们猜命令准。它明说了就照办，两个方向都是。
assert.strictEqual(answerShape({ command: '这是什么', result: { answerShape: 'deliver' } }).shape, 'deliver');
assert.strictEqual(answerShape({ command: '帮我回复', result: { answerShape: 'inspect' } }).shape, 'inspect');
// 但卡的形态优先于桥的字段：一张图不可能是要发出去的纯文本。
assert.strictEqual(answerShape({ result: { kind: 'image', answerShape: 'deliver' } }).shape, 'inspect');

console.log('answer shape policy test ok');

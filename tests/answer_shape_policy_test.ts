'use strict';

// 两种回答框的分界线。钉的是那条唯一的判据——**产物要不要送出去**——
// 以及它拿不准时必须偏向哪一边。

const assert = require('assert');
const { answerShape } = require('../electron/answer_shape_policy');

// --- 要送出去的 -------------------------------------------------------------
// --- 意图由模型/证据判定，问题文本永不触发（8·29 教训）---------------------
// 「帮我回复一下他」这类命令本身不再分类：写回条只在模型真的产出交付物时
// 出现（调了交付能力 → actionProposals / 桥显式声明）。用户不点关键词，
// 模型理解意图——它判断这次该交付，就会调用交付能力，证据自然出现。
for (const command of ['帮我回复一下他', '这段润色一下', '改写得客气点', '语气委婉一点', '扩写到长一点']) {
  const shape = answerShape({ command });
  assert.strictEqual(shape.shape, 'inspect', `裸命令不分类：deliver 等证据（${command} → ${shape.reason}）`);
}

// 证据一：模型生成了写回类执行方案 → 要送出去，禁 markdown，要点头。
{
  const shape = answerShape({
    command: '帮我回复一下他',
    result: { actionProposals: [{ action_type: 'office_replace_selection' }] },
  });
  assert.strictEqual(shape.shape, 'deliver');
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
for (const kind of ['image', 'slot', 'table', 'calendar', 'metric', 'prompt', 'steps']) {
  const shape = answerShape({ kind, result: { kind }, command: '帮我回复一下' });
  assert.strictEqual(shape.shape, 'inspect', `${kind} 卡是给人看的`);
  assert.strictEqual(shape.allowMarkdown, true, '自己看的东西要能渲染 markdown 和图');
  assert.strictEqual(shape.needsConsent, false, '不往外写就没有什么需要点头');
}

// 提案不是「给人看」——它是「同意后执行动作」，默认必须能确认。
// 判成无确认的 inspect 会让人没法批准，比多一个按钮严重。
const proposalShape = answerShape({ result: { kind: 'proposal' }, command: '随便' });
assert.strictEqual(proposalShape.shape, 'deliver', '提案要点头，不能当纯查看');
assert.strictEqual(proposalShape.needsConsent, true, '提案必须能确认');

for (const command of ['这是什么', '解释一下这段', '为什么会这样', '帮我画一张图', '这个是干嘛的']) {
  assert.strictEqual(answerShape({ command }).shape, 'inspect', `「${command}」是讲给我听的`);
}

// 元话语误触发回归钉（8·29 真机）：追问里出现「回复/润色」等词，绝不产生写回条。
{
  const meta = answerShape({
    command: '你刚刚在回复这段话的过程中，发生了什么，调用工具了吗，还是只传入input到API服务商那边返回了答案呢？',
  });
  assert.strictEqual(meta.needsConsent, false, 'meta-discussion must not trigger the write-back bar');
  const metaQ = answerShape({ command: '这个软件帮我润色一下会更好吗' });
  assert.strictEqual(metaQ.needsConsent, false, 'a question about polishing is not a deliver command');
}

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

// 8·29 真机：追问「你刚刚在回复这段话的过程中，发生了什么」——句中的
// 「回复」是元话语，不是交付指令。deliver 动词必须落在祈使位置（句首），
// 否则写回条凭空出现，用户被迫面对一个莫名其妙的「拒绝/同意」。
{
  const meta = answerShape({
    result: { answerShape: 'inspect' },
    command: '你刚刚在回复这段话的过程中，发生了什么，调用工具了吗，还是只传入input到API服务商那边返回了答案呢？',
  });
  assert.strictEqual(meta.needsConsent, false, 'meta-discussion must not trigger the write-back bar');

  // 「回复 你好」这类真交付：模型理解后会调交付能力 → 证据出现才 deliver。
  const imperative = answerShape({ command: '回复 你好', result: { actionProposals: [{ action_type: 'capsule_delivery' }] } });
  assert.strictEqual(imperative.needsConsent, true, 'delivery evidence still delivers');

  const midSentence = answerShape({ command: '这个软件帮我润色一下会更好吗' });
  assert.strictEqual(midSentence.needsConsent, false, 'embedded 润色 in a question is not a deliver command');
}

'use strict';


const assert = require('assert');
const { answerShape } = require('../electron/answer_shape_policy');

for (const command of ['帮我回复一下他', '这段润色一下', '改写得客气点', '语气委婉一点', '扩写到长一点']) {
  const shape = answerShape({ command });
  assert.strictEqual(shape.shape, 'inspect', `裸命令不分类：deliver 等证据（${command} → ${shape.reason}）`);
}

{
  const shape = answerShape({
    command: '帮我回复一下他',
    result: { actionProposals: [{ action_type: 'office_replace_selection' }] },
  });
  assert.strictEqual(shape.shape, 'deliver');
  assert.strictEqual(shape.allowMarkdown, false, '发出去的东西不许带 markdown');
  assert.strictEqual(shape.needsConsent, true, '往别人窗口里写必须先点头');
}

assert.strictEqual(answerShape({
  command: '随便什么',
  result: { actionProposals: [{ action_type: 'office_replace_selection' }] },
}).shape, 'deliver');

assert.strictEqual(answerShape({ result: { intentKind: 'length_target' } }).shape, 'deliver');

for (const kind of ['image', 'slot', 'table', 'metric', 'prompt', 'steps']) {
  const shape = answerShape({ kind, result: { kind }, command: '帮我回复一下' });
  assert.strictEqual(shape.shape, 'inspect', `${kind} 卡是给人看的`);
  assert.strictEqual(shape.allowMarkdown, true, '自己看的东西要能渲染 markdown 和图');
  assert.strictEqual(shape.needsConsent, false, '不往外写就没有什么需要点头');
}

const proposalShape = answerShape({ result: { kind: 'proposal' }, command: '随便' });
assert.strictEqual(proposalShape.shape, 'deliver', '提案要点头，不能当纯查看');
assert.strictEqual(proposalShape.needsConsent, true, '提案必须能确认');

for (const command of ['这是什么', '解释一下这段', '为什么会这样', '帮我画一张图', '这个是干嘛的']) {
  assert.strictEqual(answerShape({ command }).shape, 'inspect', `「${command}」是讲给我听的`);
}

{
  const meta = answerShape({
    command: '你刚刚在回复这段话的过程中，发生了什么，调用工具了吗，还是只传入input到API服务商那边返回了答案呢？',
  });
  assert.strictEqual(meta.needsConsent, false, 'meta-discussion must not trigger the write-back bar');
  const metaQ = answerShape({ command: '这个软件帮我润色一下会更好吗' });
  assert.strictEqual(metaQ.needsConsent, false, 'a question about polishing is not a deliver command');
}

assert.strictEqual(answerShape({}).shape, 'inspect');
assert.strictEqual(answerShape({ command: 'asdfgh' }).shape, 'inspect');
assert.strictEqual(answerShape({ command: '', result: null }).shape, 'inspect');

assert.strictEqual(answerShape({ command: '这是什么', result: { answerShape: 'deliver' } }).shape, 'deliver');
assert.strictEqual(answerShape({ command: '帮我回复', result: { answerShape: 'inspect' } }).shape, 'inspect');
assert.strictEqual(answerShape({ result: { kind: 'image', answerShape: 'deliver' } }).shape, 'inspect');

console.log('answer shape policy test ok');

{
  const meta = answerShape({
    result: { answerShape: 'inspect' },
    command: '你刚刚在回复这段话的过程中，发生了什么，调用工具了吗，还是只传入input到API服务商那边返回了答案呢？',
  });
  assert.strictEqual(meta.needsConsent, false, 'meta-discussion must not trigger the write-back bar');

  const imperative = answerShape({ command: '回复 你好', result: { actionProposals: [{ action_type: 'capsule_delivery' }] } });
  assert.strictEqual(imperative.needsConsent, true, 'delivery evidence still delivers');

  const midSentence = answerShape({ command: '这个软件帮我润色一下会更好吗' });
  assert.strictEqual(midSentence.needsConsent, false, 'embedded 润色 in a question is not a deliver command');
}

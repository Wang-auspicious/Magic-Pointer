'use strict';

// 流式回合：一句话里边说边画，而不是画完统一回车。
//
// 用户原话是现在"画完→统一回车→一条消息"太死板：选了什么在提交前看不见，
// 说话和画线像两件事。所以这里钉的是——顺序必须是用户做事的顺序，代词绑到
// 它前面最近的那一笔，而且光画一笔不能自己提交。

const assert = require('assert');
const {
  ENTRY_STROKE,
  ENTRY_WORD,
  PHRASE_GAP_MS,
  composedCommand,
  composerChips,
  hasPointingWord,
  orderedEntries,
  strokeForWordAt,
  submitReadiness,
} = require('../electron/stage_turn_stream');

const word = (text: string, at: number) => ({ kind: ENTRY_WORD, text, at });
const stroke = (strokeIndex: number, at: number, label = '') => ({
  kind: ENTRY_STROKE,
  strokeIndex,
  at,
  label,
});

// 说到"把"时画一笔，输入流当场变成 "把 ①"。
{
  const entries = [word('把', 1000), stroke(0, 1200)];
  assert.strictEqual(composedCommand(entries), '把 ①');
  const chips = composerChips(entries);
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(chips[0].ordinal, 1);
}

// 顺序 = 用户做事的顺序，不是"文字在前、笔画在后"。
{
  const entries = [word('把', 1000), stroke(0, 1200), word('改成正式的', 1500)];
  assert.strictEqual(composedCommand(entries), '把 ① 改成正式的');
}

// 乱序送进来也要按时间戳排好——事件到达顺序不等于发生顺序。
{
  const entries = [word('改成正式的', 1500), stroke(0, 1200), word('把', 1000)];
  assert.strictEqual(composedCommand(entries), '把 ① 改成正式的');
  const kinds = orderedEntries(entries).map((entry: { kind: string }) => entry.kind);
  assert.deepStrictEqual(kinds, [ENTRY_WORD, ENTRY_STROKE, ENTRY_WORD]);
}

// 多笔画各自成为独立引用，编号从 1 开始（用户是从 1 数的）。
{
  const entries = [
    word('比较', 1000),
    stroke(0, 1100, '第一段'),
    word('和', 1200),
    stroke(1, 1300, '第二段'),
  ];
  assert.strictEqual(composedCommand(entries), '比较 ① 和 ②');
}

// 代词绑到它前面最近的一笔；句子说完之后才画的那一笔不能反过来变成主语。
{
  const entries = [stroke(0, 1000), word('这个', 1100), stroke(1, 5000)];
  assert.strictEqual(strokeForWordAt(entries, 1100).strokeIndex, 0);
  // 第二笔在词之后，不该被这个词绑走。
  assert.strictEqual(strokeForWordAt(entries, 1100).strokeIndex, 0);
  // 更晚的词绑到更晚的那一笔。
  assert.strictEqual(strokeForWordAt(entries, 5200).strokeIndex, 1);
  // 第一笔之前的词没有可绑的对象。
  assert.strictEqual(strokeForWordAt(entries, 500), null);
}

// 光画一笔不提交：一条线没有指令，提交只会让模型去猜。
{
  const onlyStroke = submitReadiness({ entries: [stroke(0, 1000)], silenceMs: 9999 });
  assert.strictEqual(onlyStroke.ready, false);
  assert.strictEqual(onlyStroke.reason, 'selection_without_instruction');

  // 回车也不行——没有指令就是没有指令。
  assert.strictEqual(
    submitReadiness({ entries: [stroke(0, 1000)], pressedEnter: true }).ready,
    false,
  );
  assert.strictEqual(submitReadiness({ entries: [] }).reason, 'empty');
}

// 有指令时：回车立刻提交，沉默到阈值也提交，中间还在说就不提交。
{
  const entries = [word('把这段改正式', 1000), stroke(0, 1100)];
  assert.strictEqual(submitReadiness({ entries, pressedEnter: true }).ready, true);
  assert.strictEqual(submitReadiness({ entries, silenceMs: PHRASE_GAP_MS }).ready, true);
  const composing = submitReadiness({ entries, silenceMs: 300 });
  assert.strictEqual(composing.ready, false);
  assert.strictEqual(composing.reason, 'still_composing');
}

// 指代词识别：用来判断一笔孤零零的画需不需要补主语。
{
  assert(hasPointingWord('把这段改一下'));
  assert(hasPointingWord('translate this'));
  assert(!hasPointingWord('总结一下要点'));
}

// 空白词条不进流（ASR 的空 partial 很常见）。
{
  const entries = [word('   ', 1000), word('', 1100), stroke(0, 1200), word('改写', 1300)];
  assert.strictEqual(composedCommand(entries), '① 改写');
}

// 畸形输入不能产出假内容。
{
  assert.strictEqual(composedCommand(null), '');
  assert.strictEqual(composedCommand([{ kind: 'stroke' }]), '');
  assert.deepStrictEqual(composerChips(undefined), []);
  assert.strictEqual(strokeForWordAt([stroke(0, 1000)], NaN), null);
}

console.log('stage_turn_stream_test: all assertions passed');

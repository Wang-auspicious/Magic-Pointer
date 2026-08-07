'use strict';

// Dragging an edge changes how long the text is.
//
// Two surfaces, one gesture: the bottom of an answer card, and a pair of handles
// above and below a selection. Pull apart for more, push together for less. They
// share this module precisely so a given drag distance cannot come to mean two
// different things depending on what you grabbed. The engine side lives in
// app/text_actions/length_target.py; this decides what to ask for.
//
// Pure: a drag in pixels and the answer's current size go in, a command and a
// live hint come out. No DOM, no state, no model.

// One line of an answer at the stage's 13px/1.55 type scale. Rounding a drag to
// lines rather than pixels is what makes the gesture legible: the hint can say
// "5 行" and mean it.
const LINE_HEIGHT_PX = 20;

// Below this the drag is a twitch, not an instruction. Without a threshold,
// clicking the edge would fire a rewrite.
const MIN_DRAG_PX = 12;

// A single drag may not ask for more than this much change. Someone flicking
// 600px down is not asking for thirty extra lines of invented detail.
const MAX_DELTA_LINES = 12;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * @param {object} input
 * @param {number} input.dragPx        vertical drag; positive is downward
 * @param {number} input.currentLines  lines the selection occupies on screen
 * @param {number} [input.currentChars] characters in the selected text
 */
function stretchIntent(input) {
  const dragPx = Number(input?.dragPx);
  const currentLines = Number(input?.currentLines);
  const currentChars = Number(input?.currentChars);
  if (!Number.isFinite(dragPx) || !Number.isFinite(currentLines) || currentLines < 1) {
    return { direction: 'none', deltaLines: 0, targetLines: 0, targetChars: 0, hint: '' };
  }
  if (Math.abs(dragPx) < MIN_DRAG_PX) {
    return {
      direction: 'none', deltaLines: 0, targetLines: Math.round(currentLines), targetChars: 0, hint: '',
    };
  }

  const rawDelta = Math.round(dragPx / LINE_HEIGHT_PX);
  const deltaLines = clamp(rawDelta, -MAX_DELTA_LINES, MAX_DELTA_LINES);
  const lines = Math.round(currentLines);
  // Never target zero: an answer of no lines is not an answer.
  const targetLines = Math.max(1, lines + deltaLines);

  if (targetLines === lines) {
    return { direction: 'none', deltaLines: 0, targetLines, targetChars: 0, hint: '' };
  }
  const direction = targetLines > lines ? 'expand' : 'condense';
  const verb = direction === 'expand' ? '更详细' : '更简洁';
  // 手势量到的是**屏幕上的行**——一段没有换行的中文，在选区里占 4 行，在文本
  // 里是 1 行。引擎数的是后者。同一个数字在两边指两件事，比值因此凭空翻几倍，
  // 于是「扩写到 6 行」在一句话上必定被判成「四倍以上只能靠编造」。
  //
  // 字数是两边唯一同意的单位。手势按行拉，落地按字说，换算就用这段自己的
  // 每行字数——它是精确的，不是估的。
  const targetChars = Number.isFinite(currentChars) && currentChars > 0
    ? Math.max(1, Math.round((currentChars * targetLines) / lines))
    : 0;
  return {
    direction,
    deltaLines: targetLines - lines,
    targetLines,
    targetChars,
    hint: `${verb} · 目标 ${targetLines} 行（现在 ${lines} 行）`,
  };
}

// The command the intent submits. It goes through the ordinary composer path, so
// it is visible in the thread as an ask like any other — the user can see what
// their gesture asked for, and the router handles it as a normal length target
// (target_from_command parses these exact shapes).
// `target` names what is being stretched. The wording has to differ because the
// consequences do: stretching an answer rewrites a bubble, stretching a
// selection rewrites the user's own document.
function stretchCommand(intent, target = 'answer') {
  if (!intent || intent.direction === 'none') return '';
  const verb = intent.direction === 'expand' ? '扩写' : '压缩';
  const subject = target === 'selection' ? '选中的这段' : '这个回答';
  // 知道字数就说字数：那是引擎能如实核对的单位。拿不到才退回说行。
  const size = intent.targetChars > 0 ? `${intent.targetChars} 字` : `${intent.targetLines} 行`;
  return `把${subject}${verb}到 ${size}`;
}

const StageStretchPolicy = {
  LINE_HEIGHT_PX,
  MAX_DELTA_LINES,
  MIN_DRAG_PX,
  stretchCommand,
  stretchIntent,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StageStretchPolicy;
}
if (typeof globalThis !== 'undefined') {
  globalThis.StageStretchPolicy = StageStretchPolicy;
}

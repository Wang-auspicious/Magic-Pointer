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
 * @param {number} input.currentLines  lines the answer occupies now
 */
function stretchIntent(input) {
  const dragPx = Number(input?.dragPx);
  const currentLines = Number(input?.currentLines);
  if (!Number.isFinite(dragPx) || !Number.isFinite(currentLines) || currentLines < 1) {
    return { direction: 'none', deltaLines: 0, targetLines: 0, hint: '' };
  }
  if (Math.abs(dragPx) < MIN_DRAG_PX) {
    return { direction: 'none', deltaLines: 0, targetLines: Math.round(currentLines), hint: '' };
  }

  const rawDelta = Math.round(dragPx / LINE_HEIGHT_PX);
  const deltaLines = clamp(rawDelta, -MAX_DELTA_LINES, MAX_DELTA_LINES);
  const lines = Math.round(currentLines);
  // Never target zero: an answer of no lines is not an answer.
  const targetLines = Math.max(1, lines + deltaLines);

  if (targetLines === lines) {
    return { direction: 'none', deltaLines: 0, targetLines, hint: '' };
  }
  const direction = targetLines > lines ? 'expand' : 'condense';
  const verb = direction === 'expand' ? '更详细' : '更简洁';
  return {
    direction,
    deltaLines: targetLines - lines,
    targetLines,
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
  return `把${subject}${verb}到 ${intent.targetLines} 行`;
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

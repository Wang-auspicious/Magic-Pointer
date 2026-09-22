'use strict';


(() => {
type StretchDirection = 'condense' | 'expand' | 'none';
type UnknownRecord = Record<string, unknown>;

interface StretchIntent {
  deltaLines: number;
  direction: StretchDirection;
  hint: string;
  targetChars: number;
  targetLines: number;
}

const LINE_HEIGHT_PX = 20;

const MIN_DRAG_PX = 12;

const MAX_DELTA_LINES = 12;

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function stretchIntent(input: unknown): StretchIntent {
  const candidate = recordOf(input);
  const dragPx = Number(candidate?.dragPx);
  const currentLines = Number(candidate?.currentLines);
  const currentChars = Number(candidate?.currentChars);
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
  const targetLines = Math.max(1, lines + deltaLines);

  if (targetLines === lines) {
    return { direction: 'none', deltaLines: 0, targetLines, targetChars: 0, hint: '' };
  }
  const direction: StretchDirection = targetLines > lines ? 'expand' : 'condense';
  const verb = direction === 'expand' ? '更详细' : '更简洁';
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

function stretchCommand(intent: unknown, target: unknown = 'answer'): string {
  const candidate = recordOf(intent);
  if (candidate === null || candidate.direction === 'none') return '';
  const verb = candidate.direction === 'expand' ? '扩写' : '压缩';
  const subject = target === 'selection' ? '选中的这段' : '这个回答';
  const size = Number(candidate.targetChars) > 0
    ? `${candidate.targetChars} 字`
    : `${candidate.targetLines} 行`;
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
  (globalThis as typeof globalThis & { StageStretchPolicy?: typeof StageStretchPolicy })
    .StageStretchPolicy = StageStretchPolicy;
}
})();

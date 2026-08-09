// Contextual chips policy (pure, no Electron imports).
//
// Decides whether contextual suggestion chips are visible and which chips a
// selected object kind offers. Chips appear only for a click-selected object
// while the capsule is idle: the moment the user types the first keystroke
// (capsuleText becomes non-empty) or starts speaking (inputMode === 'voice'),
// `shouldShowChips` returns false and the chips disappear. Callers re-evaluate
// on every input change; there is no internal state here.
//
// Loaded both from node tests (CommonJS) and from the stage renderer via a
// plain <script> tag (globalThis.StageChipsPolicy).

(() => {
type Chip = Readonly<{ id: string; label: string }>;
type UnknownRecord = Record<string, unknown>;

const MAX_CHIPS = 3;
const COMMAND_BY_CHIP: Readonly<Record<string, string>> = Object.freeze({
  compare: '对比这个和上一个对象',
  tidy: '整理这个对象',
  rewrite: '改写这段文字',
  translate: '把这段文字翻译成中文',
  summarize: '总结这段文字',
  'add-to-calendar': '添加到日历',
});

const CHIPS_BY_KIND: Readonly<Record<string, readonly Chip[]>> = Object.freeze({
  image: Object.freeze([
    Object.freeze({ id: 'compare', label: '对比' }),
    Object.freeze({ id: 'tidy', label: '整理' }),
  ]),
  text: Object.freeze([
    Object.freeze({ id: 'rewrite', label: '改写' }),
    Object.freeze({ id: 'translate', label: '翻译' }),
    Object.freeze({ id: 'summarize', label: '摘要' }),
  ]),
  date: Object.freeze([
    Object.freeze({ id: 'add-to-calendar', label: '加入日历' }),
  ]),
});

// True ONLY when the object was click-selected, the input mode is not voice,
// and the capsule text is empty/whitespace. Defensive: any missing or
// malformed input yields false.
function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function shouldShowChips(input?: unknown): boolean {
  const candidate = recordOf(input);
  if (candidate === null) return false;
  const { selectionSource, inputMode, capsuleText } = candidate;
  if (selectionSource !== 'click') return false;
  if (inputMode === 'voice') return false;
  // Absent capsule text means nothing typed yet — treat as empty. Any other
  // non-string value is malformed input.
  if (capsuleText == null) return true;
  if (typeof capsuleText !== 'string') return false;
  return capsuleText.trim() === '';
}

// Returns at most MAX_CHIPS chips ({ id, label }) for a known objectKind;
// unknown kinds get [] — never guess.
function deriveChips(input: unknown): Array<{ id: string; label: string }> {
  const candidate = recordOf(input);
  if (candidate === null) return [];
  const objectKind = typeof candidate.objectKind === 'string' ? candidate.objectKind : '';
  const chips = CHIPS_BY_KIND[objectKind];
  if (!chips) return [];
  return chips.slice(0, MAX_CHIPS).map((chip) => ({ id: chip.id, label: chip.label }));
}

function commandForChip(chipId: unknown): string | null {
  return COMMAND_BY_CHIP[String(chipId || '')] || null;
}

const StageChipsPolicy = {
  MAX_CHIPS,
  shouldShowChips,
  deriveChips,
  commandForChip,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StageChipsPolicy;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { StageChipsPolicy?: typeof StageChipsPolicy })
    .StageChipsPolicy = StageChipsPolicy;
}
})();

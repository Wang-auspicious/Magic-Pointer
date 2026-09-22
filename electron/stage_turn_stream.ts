'use strict';

(() => {
type UnknownRecord = Record<string, unknown>;

interface WordEntry {
  at: number;
  kind: 'word';
  text: string;
}

interface StrokeEntry {
  at: number;
  kind: 'stroke';
  label: string;
  referenceId: string | null;
  strokeIndex: number;
}

type StreamEntry = StrokeEntry | WordEntry;

interface ComposerChip {
  at: number;
  label: string;
  ordinal: number;
  referenceId: string | null;
  strokeIndex: number;
}

interface StrokeReference {
  label?: string;
  referenceId?: string | null;
  strokeIndex: number;
}

interface SubmitResult {
  ready: boolean;
  reason: 'empty' | 'explicit_submit' | 'selection_without_instruction' | 'silence' | 'still_composing';
}


const SAME_MOMENT_MS = 90;

const PHRASE_GAP_MS = 2500;

const ENTRY_WORD = 'word';
const ENTRY_STROKE = 'stroke';

const POINTING_WORDS = ['这个', '这段', '这张', '这里', '这些', '那个', '它', 'this', 'these', 'that', 'it'];

const ORDINAL_MARKS = Object.freeze(['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']);

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function normalizeEntry(value: unknown, index: number): StreamEntry | null {
  const entry = recordOf(value);
  if (entry === null) return null;
  const at = Number(entry.at);
  if (!Number.isFinite(at)) return null;
  if (entry.kind === ENTRY_STROKE) {
    const strokeIndex = Number(entry.strokeIndex);
    return {
      kind: ENTRY_STROKE,
      at,
      strokeIndex: Number.isFinite(strokeIndex) ? strokeIndex : index,
      label: String(entry.label || ''),
      referenceId: String(entry.referenceId || '').trim() || null,
    };
  }
  if (entry.kind === ENTRY_WORD) {
    const text = String(entry.text == null ? '' : entry.text);
    if (!text.trim()) return null;
    return { kind: ENTRY_WORD, at, text };
  }
  return null;
}

function orderedEntries(entries: unknown): StreamEntry[] {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter((entry: StreamEntry | null): entry is StreamEntry => entry !== null)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.at - b.entry.at) || (a.index - b.index))
    .map((item) => item.entry);
}

function composerChips(entries: unknown): ComposerChip[] {
  const chips: ComposerChip[] = [];
  for (const entry of orderedEntries(entries)) {
    if (entry.kind !== ENTRY_STROKE) continue;
    chips.push({
      strokeIndex: entry.strokeIndex,
      ordinal: chips.length + 1,
      label: entry.label,
      at: entry.at,
      referenceId: entry.referenceId,
    });
  }
  return chips;
}

function normalizeStrokeReferences(value: unknown): StrokeReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const ref = recordOf(candidate);
    const strokeIndex = Number(ref?.strokeIndex);
    if (!Number.isInteger(strokeIndex) || strokeIndex < 0) return [];
    return [{
      strokeIndex,
      label: String(ref?.label || ''),
      referenceId: String(ref?.referenceId || '').trim() || null,
    }];
  });
}

function keptStrokeIndexes(refs: unknown): number[] {
  return normalizeStrokeReferences(refs).map((ref) => ref.strokeIndex);
}

function removeStrokeReference(refs: unknown, strokeIndex: unknown): StrokeReference[] {
  const removedIndex = Number(strokeIndex);
  return normalizeStrokeReferences(refs).filter((ref) => ref.strokeIndex !== removedIndex);
}

function referenceMark(strokeIndex: unknown): string {
  const ordinal = Number(strokeIndex) + 1;
  if (!Number.isInteger(ordinal) || ordinal < 1) return '';
  return ORDINAL_MARKS[ordinal - 1] || `[${ordinal}]`;
}

function withKeptStrokes(snapshotValue: unknown, keptStrokeIndexesValue: unknown): unknown {
  const snapshot = recordOf(snapshotValue);
  if (snapshot === null || !Array.isArray(keptStrokeIndexesValue) || keptStrokeIndexesValue.length === 0) {
    return snapshotValue;
  }
  const gesture = recordOf(snapshot.selection_gesture);
  const strokes = gesture?.strokes;
  if (!Array.isArray(strokes) || strokes.length <= 1) return snapshotValue;
  const keep = new Set(
    keptStrokeIndexesValue
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0),
  );
  const kept = strokes.filter((_stroke, index) => keep.has(index));
  if (kept.length === 0 || kept.length === strokes.length) return snapshotValue;
  const narrowed: UnknownRecord = {
    ...snapshot,
    selection_gesture: { ...gesture, strokes: kept },
    selection_bbox: null,
  };
  const materials = snapshot.selection_materials;
  if (Array.isArray(materials)) {
    narrowed.selection_materials = strokes
      .map((_stroke, index) => index)
      .filter((index) => keep.has(index))
      .map((originalIndex, position) => ({
        ...(recordOf(materials[originalIndex]) || {}),
        stroke_index: position,
      }));
  }
  return narrowed;
}

function composedCommand(entries: unknown): string {
  const ordered = orderedEntries(entries);
  const parts: string[] = [];
  let strokeOrdinal = 0;
  for (const entry of ordered) {
    if (entry.kind === ENTRY_STROKE) {
      strokeOrdinal += 1;
      parts.push(ORDINAL_MARKS[strokeOrdinal - 1] || `[${strokeOrdinal}]`);
      continue;
    }
    parts.push(entry.text.trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function strokeForWordAt(entries: unknown, wordAt: unknown): StrokeEntry | null {
  const at = Number(wordAt);
  if (!Number.isFinite(at)) return null;
  let best: StrokeEntry | null = null;
  for (const entry of orderedEntries(entries)) {
    if (entry.kind !== ENTRY_STROKE) continue;
    if (entry.at > at + SAME_MOMENT_MS) break;
    best = entry;
  }
  return best;
}

function hasPointingWord(text: unknown): boolean {
  const value = String(text || '').toLowerCase();
  return POINTING_WORDS.some((token) => value.includes(token));
}

function submitReadiness(input: unknown): SubmitResult {
  const candidate = recordOf(input);
  const entries = orderedEntries(candidate?.entries);
  const words = entries.filter((entry) => entry.kind === ENTRY_WORD);
  const strokes = entries.filter((entry) => entry.kind === ENTRY_STROKE);
  const hasInstruction = words.length > 0;
  const silenceMs = Number(candidate?.silenceMs);
  const pressedEnter = candidate?.pressedEnter === true;

  if (!hasInstruction) {
    return {
      ready: false,
      reason: strokes.length ? 'selection_without_instruction' : 'empty',
    };
  }
  if (pressedEnter) return { ready: true, reason: 'explicit_submit' };
  if (Number.isFinite(silenceMs) && silenceMs >= PHRASE_GAP_MS) {
    return { ready: true, reason: 'silence' };
  }
  return { ready: false, reason: 'still_composing' };
}

const StageTurnStream = {
  ENTRY_STROKE,
  ORDINAL_MARKS,
  ENTRY_WORD,
  PHRASE_GAP_MS,
  SAME_MOMENT_MS,
  composedCommand,
  composerChips,
  hasPointingWord,
  keptStrokeIndexes,
  orderedEntries,
  referenceMark,
  removeStrokeReference,
  strokeForWordAt,
  submitReadiness,
  withKeptStrokes,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StageTurnStream;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { StageTurnStream?: typeof StageTurnStream })
    .StageTurnStream = StageTurnStream;
}
})();

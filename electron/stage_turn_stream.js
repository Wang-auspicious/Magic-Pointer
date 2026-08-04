'use strict';

// A turn is a stream, not a form you submit.
//
// The old shape: draw every stroke, then press Enter, and one message goes out.
// The user's complaint about it was exact — you cannot see what you have picked
// until it is too late to change, and typing and drawing feel like two separate
// acts rather than one sentence.
//
// The new shape is one timestamped stream. Every stroke and every word is an
// entry with a time, in the order they happened, so:
//
//   type "把"        -> [word 把]
//   draw a line      -> [word 把] [chip ①]
//   type "改成正式的" -> [word 把] [chip ①] [word 改成正式的]
//
// and a pronoun binds to the stroke nearest *before* it, which is what the user
// meant by pointing while talking. AGENT.md already confirmed the multi-object
// binding exists in InteractionEpisode; what was missing was this bookkeeping.
//
// Pure: entries in, composed command and chip list out. No DOM, no IPC, no AI.

// Two entries closer together than this are the same gesture, not a sequence.
// Below it, a stroke that lands mid-word would split the word around it.
const SAME_MOMENT_MS = 90;

// A stroke this long after the last word starts a new phrase rather than
// attaching to what was said before it.
const PHRASE_GAP_MS = 2500;

const ENTRY_WORD = 'word';
const ENTRY_STROKE = 'stroke';

// Chinese pronouns that point at something. A pronoun in the text is the signal
// that a stroke belongs where it stands.
const POINTING_WORDS = ['这个', '这段', '这张', '这里', '这些', '那个', '它', 'this', 'these', 'that', 'it'];

// Inline reference marks. The chip the user sees says ①, so the command the
// model receives says ① too — the same symbol on both sides of the boundary
// means the user can read what was sent and recognise it.
const ORDINAL_MARKS = Object.freeze(['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']);

function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  const at = Number(entry.at);
  if (!Number.isFinite(at)) return null;
  if (entry.kind === ENTRY_STROKE) {
    const strokeIndex = Number(entry.strokeIndex);
    return {
      kind: ENTRY_STROKE,
      at,
      strokeIndex: Number.isFinite(strokeIndex) ? strokeIndex : index,
      label: String(entry.label || ''),
    };
  }
  if (entry.kind === ENTRY_WORD) {
    const text = String(entry.text == null ? '' : entry.text);
    if (!text.trim()) return null;
    return { kind: ENTRY_WORD, at, text };
  }
  return null;
}

// Oldest first. Ties keep insertion order, so a stroke and a word stamped in the
// same millisecond stay in the order they were recorded.
function orderedEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter(Boolean)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.at - b.entry.at) || (a.index - b.index))
    .map((item) => item.entry);
}

/**
 * The chips to show in the composer, in stream order.
 *
 * A chip is what makes the selection visible before submitting — the third thing
 * this has over the Google demo (the others being that it works muted and that
 * what you picked stays on screen).
 */
function composerChips(entries) {
  const chips = [];
  for (const entry of orderedEntries(entries)) {
    if (entry.kind !== ENTRY_STROKE) continue;
    chips.push({
      strokeIndex: entry.strokeIndex,
      // Numbered from one, because the user counts from one.
      ordinal: chips.length + 1,
      label: entry.label,
      at: entry.at,
    });
  }
  return chips;
}

/**
 * The command text the stream composes.
 *
 * Strokes become numbered references inline, at the position they were drawn, so
 * the model sees the same order the user performed. A stroke drawn immediately
 * after a pointing word attaches to it; a stroke drawn out of the blue still
 * appears where it happened rather than being appended at the end.
 */
function composedCommand(entries) {
  const ordered = orderedEntries(entries);
  const parts = [];
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

/**
 * Which stroke does a pointing word refer to?
 *
 * The nearest stroke at or before the word. "把 <draw> 改成正式的" means the
 * thing just drawn, and a stroke drawn after the sentence finished does not
 * retroactively become its subject.
 */
function strokeForWordAt(entries, wordAt) {
  const at = Number(wordAt);
  if (!Number.isFinite(at)) return null;
  let best = null;
  for (const entry of orderedEntries(entries)) {
    if (entry.kind !== ENTRY_STROKE) continue;
    if (entry.at > at + SAME_MOMENT_MS) break;
    best = entry;
  }
  return best;
}

// Does the text contain a word that points at something? Used to decide whether
// a lone stroke needs a pronoun supplied for it.
function hasPointingWord(text) {
  const value = String(text || '').toLowerCase();
  return POINTING_WORDS.some((token) => value.includes(token));
}

/**
 * Is this stream ready to submit?
 *
 * Never on a stroke alone: a drawn line with no instruction is a selection, not
 * a request, and submitting it would produce a guess. Enter always submits;
 * silence submits only once there is something to act on.
 */
function submitReadiness(input) {
  const entries = orderedEntries(input?.entries);
  const words = entries.filter((entry) => entry.kind === ENTRY_WORD);
  const strokes = entries.filter((entry) => entry.kind === ENTRY_STROKE);
  const hasInstruction = words.length > 0;
  const silenceMs = Number(input?.silenceMs);
  const pressedEnter = input?.pressedEnter === true;

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
  orderedEntries,
  strokeForWordAt,
  submitReadiness,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StageTurnStream;
}
if (typeof globalThis !== 'undefined') {
  globalThis.StageTurnStream = StageTurnStream;
}

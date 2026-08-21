// Clarification option chips (pure, no Electron imports).
//
// Maps an awaiting turn's pendingInput.options onto clickable chips. Idle
// canned suggestions stay in StageChipsPolicy; this helper never consults it.
// Clicking a chip submits the option TEXT as the follow-up command.
// Loaded both from node tests (CommonJS) and from the stage renderer via a
// plain <script> tag (globalThis.ClarificationChips).

(() => {
type Chip = Readonly<{ command: string; id: string; label: string }>;
type UnknownRecord = Record<string, unknown>;

const MAX_CHIPS = 4;

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function optionTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const item of value) {
    const text = String(item ?? '').trim().slice(0, 200);
    if (text) texts.push(text);
    if (texts.length >= MAX_CHIPS) break;
  }
  return texts;
}

function pendingOptions(input: unknown): string[] {
  const candidate = recordOf(input);
  if (candidate === null || candidate.status !== 'awaiting') return [];
  const result = recordOf(candidate.result);
  const pending = recordOf(candidate.pendingInput) || (result ? recordOf(result.pendingInput) : null);
  if (pending === null) return [];
  const options = optionTexts(pending.options);
  return options.length >= 2 ? options : [];
}

function clarificationChips(input?: unknown): Chip[] {
  return pendingOptions(input).map((text, index) => ({
    id: `clarify-${index}`,
    label: text,
    command: text,
  }));
}

function commandForClarificationChip(chip: unknown): string | null {
  const candidate = recordOf(chip);
  if (candidate === null) return null;
  const command = typeof candidate.command === 'string' ? candidate.command.trim() : '';
  return command || null;
}

const ClarificationChips = {
  MAX_CHIPS,
  clarificationChips,
  commandForClarificationChip,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ClarificationChips;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { ClarificationChips?: typeof ClarificationChips })
    .ClarificationChips = ClarificationChips;
}
})();

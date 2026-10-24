/* exported InputHistory */

const InputHistory = (() => {
  // Trim, drop empties, and keep the LAST occurrence of each entry: a prompt
  // resubmitted later should recall exactly once, from its newest position.
  function normalizeHistory(entries: readonly unknown[]): string[] {
    const positions = new Map<string, number>();
    const kept: string[] = [];
    for (const entry of entries) {
      const text = String(entry ?? '').trim();
      if (!text) {
        continue;
      }
      const previous = positions.get(text);
      if (previous !== undefined) {
        kept[previous] = '';
      }
      positions.set(text, kept.length);
      kept.push(text);
    }
    return kept.filter(Boolean);
  }

  // The navigation cursor over the history list. -1 is the fresh draft slot;
  // 0..total-1 addresses entries oldest-first. ArrowUp recalls, so from the
  // draft it lands on the newest entry, and past the newest ArrowDown
  // returns to the draft.
  function stepHistory(
    index: number,
    direction: 'older' | 'newer',
    total: number,
  ): number {
    if (total <= 0) {
      return -1;
    }
    if (direction === 'older') {
      return index < 0 ? total - 1 : Math.max(0, index - 1);
    }
    return index < 0 ? -1 : index + 1 >= total ? -1 : index + 1;
  }

  function historyLabel(index: number, total: number): string | null {
    if (index < 0 || total <= 0 || index >= total) {
      return null;
    }
    return `历史记录 ${index + 1}/${total}`;
  }

  // ArrowUp/ArrowDown may only drive history when the caret is at the very
  // start/end of the text (or the box is empty); anywhere else the key must
  // keep moving the caret.
  function historyKeyAction(
    key: string,
    value: string,
    selectionStart: number,
    selectionEnd: number,
  ): 'older' | 'newer' | null {
    if (key === 'ArrowUp') {
      return selectionStart === 0 && selectionEnd === 0 ? 'older' : null;
    }
    if (key === 'ArrowDown') {
      const end = value.length;
      return selectionStart === end && selectionEnd === end ? 'newer' : null;
    }
    return null;
  }

  return {
    normalizeHistory,
    stepHistory,
    historyLabel,
    historyKeyAction,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = InputHistory;
}
if (typeof globalThis !== 'undefined') {
  (
    globalThis as typeof globalThis & {InputHistory?: typeof InputHistory}
  ).InputHistory = InputHistory;
}

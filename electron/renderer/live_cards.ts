/* exported LiveCards */

// classic-script 全局 API（stage/studio 以 global 方式消费 LiveCards）。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LiveCards = (() => {
  const cards = new Map<string, MagicPointerCard>();      
  let timer: ReturnType<typeof setInterval> | null = null;

  function anyRunning() {
    for (const card of cards.values()) if (card.state === 'running') return true;
    return false;
  }

  function paintElapsed() {
    const now = Date.now();
    for (const [id, card] of cards) {
      const node = document.querySelector(`[data-card-id="${CSS.escape(id)}"] [data-elapsed]`);
      if (node) node.textContent = cardElapsedText(card, now);
    }
    if (!anyRunning() && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function ensureTimer() {
    if (timer || !anyRunning()) return;
    timer = setInterval(paintElapsed, 500);
  }

  function repaint(id: string) {
    const card = cards.get(id);
    if (!card) return;
    const existing = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
    if (!existing) return;
    card.runningLabel = CardModel.runningLabel(card);
    const density = existing.dataset.density || 'full';
    existing.replaceWith(renderCard(card, { density }));
    paintElapsed();
  }

  return {
    track(card: MagicPointerCard) {
      const normalized = CardModel.normalizeCard(card, { id: card.id });
      cards.set(normalized.id, normalized);
      ensureTimer();
      return normalized;
    },

    patch(cardId: string, patch: Record<string, unknown>) {
      const id = String(cardId || '');
      const current = cards.get(id);
      if (!current) return null;
      const next = CardModel.applyPatch(current, patch);
      cards.set(id, next);
      repaint(id);
      if (CardModel.isSettled(next)) ensureTimer();
      return next;
    },

    get(cardId: string) {
      return cards.get(String(cardId || '')) || null;
    },

    reset() {
      cards.clear();
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
})();

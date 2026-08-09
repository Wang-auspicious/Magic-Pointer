// @ts-nocheck -- legacy classic-script globals are preserved during the extension migration.
/* exported LiveCards */
/* ============================================================================
   活着的卡
   ----------------------------------------------------------------------------
   一张卡从出现到有结果，中间会收到很多条补丁（桥报的阶段、后台任务报的进度）。
   随行窗和工作室都要接这些补丁，逻辑一样，所以放这一份。

   两条规矩，都来自 cards.js 的契约，这里只是把它们落到 DOM 上：

   1. **就地更新，不重建。** 结果到了不是换一张卡，是这张卡自己长出身子。
      重建会闪掉用户正在读的东西，也会丢掉滚动位置。
   2. **终态之后停止计时。** 卡已经结束了还在跑一个 setInterval，是在白烧电。
   ============================================================================ */

const LiveCards = (() => {
  const cards = new Map();     // cardId -> card
  let timer = null;

  function anyRunning() {
    for (const card of cards.values()) if (card.state === 'running') return true;
    return false;
  }

  // 秒数。只靠步骤行分不出「两秒」和「卡死两分钟」，所以它一直要走。
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

  function repaint(id) {
    const card = cards.get(id);
    if (!card) return;
    const existing = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
    if (!existing) return;
    card.runningLabel = CardModel.runningLabel(card);
    const density = existing.dataset.density || 'full';
    existing.replaceWith(renderCard(card, { density }));
    paintElapsed();
  }

  return {
    // 记住一张已经在页面上的卡，从此它可以被补丁更新
    track(card) {
      const normalized = CardModel.normalizeCard(card, { id: card.id });
      cards.set(normalized.id, normalized);
      ensureTimer();
      return normalized;
    },

    patch(cardId, patch) {
      const id = String(cardId || '');
      const current = cards.get(id);
      if (!current) return null;
      const next = CardModel.applyPatch(current, patch);
      cards.set(id, next);
      repaint(id);
      if (CardModel.isSettled(next)) ensureTimer();
      return next;
    },

    get(cardId) {
      return cards.get(String(cardId || '')) || null;
    },

    // 换了一条对话就全清掉，否则旧卡的计时器会一直陪着新页面跑
    reset() {
      cards.clear();
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
})();

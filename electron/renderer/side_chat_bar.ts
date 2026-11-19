'use strict';

interface SideChatSelectionPayload {
  quote: string;
  rect: {left: number; right: number; top: number; bottom: number};
  anchorNode: Node | null;
}

interface SideChatBarHooks {
  isSideChatOpen?: () => boolean;
  onStartSideChat: (payload: SideChatSelectionPayload) => void;
  onReply: (payload: SideChatSelectionPayload) => void;
}

interface SideChatBarApi {
  init(hooks: SideChatBarHooks): void;
  hide(): void;
  isVisible(): boolean;
}

declare global {
  var SideChatBar: SideChatBarApi | undefined;
}

(() => {
  let hooks: SideChatBarHooks | null = null;
  let barEl: HTMLDivElement | null = null;
  let sideChatBtn: HTMLButtonElement | null = null;
  let replyBtn: HTMLButtonElement | null = null;
  let activePayload: SideChatSelectionPayload | null = null;
  let initialized = false;

  function closestElement(node: Node | null, selector: string): HTMLElement | null {
    if (!node) {
      return null;
    }
    const base =
      node.nodeType === 1 ? (node as Element) : (node.parentElement as Element | null);
    return base ? (base.closest(selector) as HTMLElement | null) : null;
  }

  function cleanSelectionText(range: Range, fallback: string): string {
    try {
      const frag = range.cloneContents();
      const mathmls = frag.querySelectorAll('.katex-mathml');
      for (const el of Array.from(mathmls)) {
        el.remove();
      }
      const text = (frag.textContent || fallback || '')
        .replace(/\s+/g, ' ')
        .trim();
      return text;
    } catch {
      return String(fallback || '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  function ensureBar(): HTMLDivElement {
    if (barEl && barEl.isConnected) {
      return barEl;
    }
    barEl = document.createElement('div');
    barEl.className = 'mp-selection-bar';
    barEl.setAttribute('role', 'toolbar');
    barEl.setAttribute('aria-label', 'Selection actions');
    barEl.hidden = true;

    sideChatBtn = document.createElement('button');
    sideChatBtn.type = 'button';
    sideChatBtn.className = 'mp-selection-bar-btn';
    sideChatBtn.dataset.selectionAction = 'side-chat';
    sideChatBtn.textContent = 'Start a side chat';

    replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'mp-selection-bar-btn';
    replyBtn.dataset.selectionAction = 'reply';
    replyBtn.textContent = 'Reply';

    sideChatBtn.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    replyBtn.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
    });

    sideChatBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const payload = activePayload;
      hide();
      if (payload && hooks) {
        hooks.onStartSideChat(payload);
      }
    });

    replyBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const payload = activePayload;
      hide();
      if (payload && hooks) {
        hooks.onReply(payload);
      }
    });

    barEl.append(sideChatBtn, replyBtn);
    document.body.appendChild(barEl);
    return barEl;
  }

  function hide(): void {
    activePayload = null;
    if (barEl) {
      barEl.hidden = true;
    }
  }

  function show(payload: SideChatSelectionPayload): void {
    const bar = ensureBar();
    activePayload = payload;
    const isStarted = Boolean(hooks?.isSideChatOpen?.());
    if (sideChatBtn) {
      sideChatBtn.textContent = isStarted
        ? 'Send to side chat'
        : 'Start a side chat';
    }
    bar.hidden = false;
    const width = bar.offsetWidth || 200;
    const height = bar.offsetHeight || 34;
    const centerX = (payload.rect.left + payload.rect.right) / 2;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const left = Math.max(12, Math.min(vw - width - 12, Math.round(centerX - width / 2)));
    const top = Math.max(12, Math.round(payload.rect.top - height - 8));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  function init(nextHooks: SideChatBarHooks): void {
    hooks = nextHooks;
    if (initialized || typeof document === 'undefined') {
      return;
    }
    initialized = true;

    document.addEventListener('mouseup', event => {
      if (barEl && event.target && barEl.contains(event.target as Node)) {
        return;
      }
      window.setTimeout(() => {
        const sel =
          typeof window !== 'undefined' && typeof window.getSelection === 'function'
            ? window.getSelection()
            : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          hide();
          return;
        }
        const range = sel.getRangeAt(0);
        const quote = cleanSelectionText(range, sel.toString());
        if (quote.length < 2 || quote.length > 600) {
          hide();
          return;
        }
        const common = range.commonAncestorContainer;
        const mdHost = closestElement(common, '.mp-chat-markdown');
        if (!mdHost) {
          hide();
          return;
        }
        const rangeRect = range.getBoundingClientRect();
        const rect =
          rangeRect.width > 0 || rangeRect.height > 0
            ? {
                left: rangeRect.left,
                right: rangeRect.right,
                top: rangeRect.top,
                bottom: rangeRect.bottom,
              }
            : {left: 160, right: 320, top: 140, bottom: 164};
        show({quote, rect, anchorNode: common});
      }, 15);
    });

    document.addEventListener('mousedown', event => {
      if (barEl && !barEl.hidden && event.target && !barEl.contains(event.target as Node)) {
        hide();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && barEl && !barEl.hidden) {
        hide();
      }
    });
  }

  globalThis.SideChatBar = {
    init,
    hide,
    isVisible: () => Boolean(barEl && !barEl.hidden),
  };
})();

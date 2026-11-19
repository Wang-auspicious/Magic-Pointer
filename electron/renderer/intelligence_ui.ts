'use strict';

declare global {
  interface IntelligenceUiApi {
    hydrate(
      root: Element | null,
      handlers?: {
        onAskMentor?: (prompt: string) => void;
        onSaveToVault?: (title: string, summary: string) => void;
      },
    ): void;
  }

  var IntelligenceUI: IntelligenceUiApi | undefined;
}

(() => {
  let widgetSeq = 0;
  let listenerBound = false;
  const frameById = new Map<string, HTMLIFrameElement>();
  const pendingPayloadByWindow = new WeakMap<
    Window,
    {id: string; themeCss: string; html: string}
  >();
  let activeAskHandler: ((prompt: string) => void) | undefined;

  function themeCssVars(): string {
    const dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? `:root{--bg:#191919;--surface:#20201f;--text:#ecebe6;--muted:#a4a29a;--border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.20);--hover:rgba(255,255,255,.075);--accent:#d97757;--accent-soft:rgba(217,119,87,.18);--blue:#6da7ec;--green:#86efac;--danger:#ec7e7e;}`
      : `:root{--bg:#ffffff;--surface:#f7f7f5;--text:#1f1f1d;--muted:#6e6d68;--border:rgba(11,11,11,.09);--border-strong:rgba(11,11,11,.18);--hover:rgba(11,11,11,.05);--accent:#d97757;--accent-soft:rgba(217,119,87,.14);--blue:#184f95;--green:#166534;--danger:#8e2626;}`;
  }

  function ensureMessageListener(): void {
    if (listenerBound || typeof window === 'undefined') {
      return;
    }
    listenerBound = true;
    window.addEventListener('message', event => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') {
        return;
      }
      if (data.type === 'mp-iui-ready' && event.source) {
        const srcWin = event.source as Window;
        const payload = pendingPayloadByWindow.get(srcWin);
        if (payload) {
          srcWin.postMessage({type: 'mp-iui-init', ...payload}, '*');
        }
        return;
      }
      const id = String(data.id || '');
      if (data.type === 'mp-iui-resize') {
        const frame = frameById.get(id);
        const h = Number(data.height);
        if (frame && Number.isFinite(h) && h >= 100) {
          frame.style.height = `${Math.min(720, Math.round(h) + 6)}px`;
        }
      } else if (data.type === 'mp-iui-ask' && typeof data.prompt === 'string') {
        const prompt = data.prompt.trim();
        if (prompt && activeAskHandler) {
          activeAskHandler(prompt);
        }
      }
    });
  }

  function hydrate(
    root: Element | null,
    handlers?: {
      onAskMentor?: (prompt: string) => void;
      onSaveToVault?: (title: string, summary: string) => void;
    },
  ): void {
    if (!root) {
      return;
    }
    ensureMessageListener();
    if (handlers?.onAskMentor) {
      activeAskHandler = handlers.onAskMentor;
    }
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>('.mp-iui-card[data-iui-src]'),
    );
    for (const card of cards) {
      if (card.dataset.iuiHydrated === 'true') {
        continue;
      }
      card.dataset.iuiHydrated = 'true';
      const rawSrc = card.dataset.iuiSrc || '';
      const title = card.dataset.iuiTitle || '交互式认知微件';
      const widgetId = `iui-${++widgetSeq}`;

      card.replaceChildren();
      const head = document.createElement('header');
      head.className = 'mp-iui-head';

      const left = document.createElement('div');
      left.className = 'mp-iui-title-wrap';
      const icon = document.createElement('span');
      icon.className = 'cds-icon mp-iui-icon';
      icon.dataset.size = 'small';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\uE018';
      const titleEl = document.createElement('strong');
      titleEl.className = 'mp-iui-title';
      titleEl.textContent = title;
      left.append(icon, titleEl);

      const actions = document.createElement('div');
      actions.className = 'mp-iui-actions';

      const askBtn = document.createElement('button');
      askBtn.type = 'button';
      askBtn.className = 'mp-iui-btn';
      askBtn.textContent = '就这个图追问';
      askBtn.addEventListener('click', () => {
        handlers?.onAskMentor?.(`结合「${title}」这个交互演示，我有一个疑问：`);
      });

      const vaultBtn = document.createElement('button');
      vaultBtn.type = 'button';
      vaultBtn.className = 'mp-iui-btn';
      vaultBtn.textContent = '存入知识库';
      vaultBtn.addEventListener('click', () => {
        handlers?.onSaveToVault?.(
          title,
          `交互式学习微件「${title}」笔记：\n\n- [ ] 动手复盘该微件中的关键直觉与边界反例`,
        );
        vaultBtn.textContent = '已存入 ✓';
      });

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'mp-iui-btn';
      expandBtn.textContent = '放大';
      expandBtn.addEventListener('click', () => {
        const expanded = card.classList.toggle('is-expanded');
        expandBtn.textContent = expanded ? '还原' : '放大';
      });

      actions.append(askBtn, vaultBtn, expandBtn);
      head.append(left, actions);

      const frame = document.createElement('iframe');
      frame.className = 'mp-iui-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = title;
      frame.style.height = '260px';
      const payload = {id: widgetId, themeCss: themeCssVars(), html: rawSrc};
      frame.addEventListener('load', () => {
        if (frame.contentWindow) {
          pendingPayloadByWindow.set(frame.contentWindow, payload);
          frame.contentWindow.postMessage({type: 'mp-iui-init', ...payload}, '*');
        }
      });
      frame.src = 'iui_sandbox.html';
      frameById.set(widgetId, frame);
      card.append(head, frame);
      if (frame.contentWindow) {
        pendingPayloadByWindow.set(frame.contentWindow, payload);
      }
    }
  }

  const api: IntelligenceUiApi = {hydrate};
  globalThis.IntelligenceUI = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();

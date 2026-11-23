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
      ? `:root{--bg:#181817;--surface:#222220;--surface-2:#2c2c29;--text:#ecebe6;--ink:#ecebe6;--ink-2:#c7c5bc;--muted:#9b9990;--border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.20);--hover:rgba(255,255,255,.075);--slider-track:rgba(255,255,255,.14);--accent:#6da7ec;--accent-soft:rgba(109,167,236,.16);--blue:#6da7ec;--teal:#5eead4;--purple:#c4b5fd;--amber:#fbbf24;--green:#86efac;--danger:#ec7e7e;--in:#6da7ec;--in-bg:rgba(109,167,236,.15);--out:#6da7ec;--out-bg:rgba(109,167,236,.16);--op:#6ee7b7;--op-bg:rgba(110,231,183,.14);--norm:#fcd34d;--norm-bg:rgba(252,211,77,.14);--loss:#f87171;--loss-bg:rgba(248,113,113,.15);--alt:#c4b5fd;--alt-bg:rgba(196,181,253,.15);--param:#f9a8d4;--wire:#8b8a82;--radius:8px;--radius-lg:12px;}`
      : `:root{--bg:#ffffff;--surface:#f7f7f5;--surface-2:#ffffff;--text:#1f1f1d;--ink:#1f1f1d;--ink-2:#4a4945;--muted:#6e6d68;--border:rgba(11,11,11,.09);--border-strong:rgba(11,11,11,.18);--hover:rgba(11,11,11,.05);--slider-track:rgba(11,11,11,.10);--accent:#2563eb;--accent-soft:rgba(37,99,235,.12);--blue:#2563eb;--teal:#0f766e;--purple:#7c3aed;--amber:#d97706;--green:#16a34a;--danger:#b42318;--in:#2563eb;--in-bg:rgba(37,99,235,.09);--out:#2563eb;--out-bg:rgba(37,99,235,.10);--op:#15803d;--op-bg:rgba(21,128,61,.09);--norm:#b45309;--norm-bg:rgba(180,83,9,.10);--loss:#dc2626;--loss-bg:rgba(220,38,38,.09);--alt:#7c3aed;--alt-bg:rgba(124,58,237,.10);--param:#db2777;--wire:#71717a;--radius:8px;--radius-lg:12px;}`;
  }

  function ensureMessageListener(): void {
    if (
      listenerBound ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
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
        if (frame && Number.isFinite(h) && h >= 80) {
          const next = `${Math.max(88, Math.min(680, Math.ceil(h)))}px`;
          if (frame.style.height !== next) {
            frame.style.height = next;
          }
        }
      } else if (data.type === 'mp-iui-ask' && typeof data.prompt === 'string') {
        const prompt = data.prompt.trim();
        if (prompt && activeAskHandler) {
          activeAskHandler(prompt);
        }
      }
    });
  }

  function portalExpandCard(
    card: HTMLElement,
    frame: HTMLIFrameElement,
    expandBtn: HTMLButtonElement,
  ): void {
    const body = document.body;
    let backdrop: HTMLElement | null = null;
    let placeholder: HTMLElement | null = null;
    let savedHeight = '';
    let keyHandler: ((ev: KeyboardEvent) => void) | null = null;

    const close = () => {
      if (!backdrop) {
        return;
      }
      if (keyHandler) {
        document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
      }
      card.classList.remove('is-expanded');
      frame.setAttribute('scrolling', 'no');
      if (savedHeight) {
        frame.style.height = savedHeight;
      }
      frame.contentWindow?.postMessage({type: 'mp-iui-expanded', expanded: false}, '*');
      if (placeholder && placeholder.parentNode) {
        placeholder.replaceWith(card);
      } else if (backdrop.parentNode) {
        backdrop.remove();
      }
      if (backdrop.parentNode) {
        backdrop.remove();
      }
      backdrop = null;
      placeholder = null;
      expandBtn.title = '放大查看';
      expandBtn.setAttribute('aria-label', '放大查看');
      expandBtn.innerHTML =
        '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE016;</span>';
    };

    const open = () => {
      if (backdrop || !body) {
        return;
      }
      savedHeight = frame.style.height || '180px';
      placeholder = document.createElement('div');
      placeholder.className = 'mp-iui-placeholder';
      const measured = card.offsetHeight;
      if (measured > 0) {
        placeholder.style.height = `${measured}px`;
      }
      if (card.parentNode) {
        card.parentNode.insertBefore(placeholder, card);
      }
      backdrop = document.createElement('div');
      backdrop.className = 'mp-iui-lightbox-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) {
          close();
        }
      });
      keyHandler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          close();
        }
      };
      document.addEventListener('keydown', keyHandler);
      card.classList.add('is-expanded');
      frame.setAttribute('scrolling', 'yes');
      backdrop.appendChild(card);
      body.appendChild(backdrop);
      frame.contentWindow?.postMessage({type: 'mp-iui-expanded', expanded: true}, '*');
      expandBtn.title = '还原';
      expandBtn.setAttribute('aria-label', '还原');
      expandBtn.innerHTML =
        '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE10F;</span>';
    };

    expandBtn.addEventListener('click', () => {
      if (card.classList.contains('is-expanded')) {
        close();
      } else {
        open();
      }
    });
  }

  function hydrateSteppers(root: Element): void {
    const steppers = Array.from(
      root.querySelectorAll<HTMLElement>('.mp-iui-steps'),
    );
    for (const stepper of steppers) {
      if (stepper.dataset.stepsHydrated === 'true') {
        continue;
      }
      stepper.dataset.stepsHydrated = 'true';
      const panels = Array.from(
        stepper.querySelectorAll<HTMLElement>('.mp-iui-step-panel'),
      );
      const dots = Array.from(
        stepper.querySelectorAll<HTMLButtonElement>('.mp-iui-step-dot'),
      );
      const prevBtn = stepper.querySelector<HTMLButtonElement>(
        '.mp-iui-steps-prev',
      );
      const nextBtn = stepper.querySelector<HTMLButtonElement>(
        '.mp-iui-steps-next',
      );
      const allBtn = stepper.querySelector<HTMLButtonElement>(
        '.mp-iui-steps-all-btn',
      );
      let activeIndex = 0;
      let viewAll = false;

      const setElHidden = (el: HTMLElement | null, isHidden: boolean) => {
        if (!el) {
          return;
        }
        el.hidden = isHidden;
        if (isHidden) {
          el.setAttribute?.('hidden', 'true');
        } else {
          el.removeAttribute?.('hidden');
        }
      };

      const sync = () => {
        stepper.classList.toggle('is-all-steps', viewAll);
        panels.forEach((panel, idx) => {
          setElHidden(panel, !viewAll && idx !== activeIndex);
        });
        dots.forEach((dot, idx) => {
          const isCurrent = !viewAll && idx === activeIndex;
          dot.classList.toggle('is-active', isCurrent);
          dot.setAttribute('aria-current', isCurrent ? 'step' : 'false');
        });
        if (allBtn) {
          allBtn.textContent = viewAll ? 'Step-by-step' : 'View all steps';
          allBtn.setAttribute('aria-pressed', String(viewAll));
        }
        setElHidden(prevBtn, viewAll || activeIndex <= 0);
        if (nextBtn) {
          setElHidden(nextBtn, viewAll);
          nextBtn.textContent =
            activeIndex >= panels.length - 1 ? 'Done' : 'Next';
        }
      };

      dots.forEach((dot, idx) => {
        dot.addEventListener('click', () => {
          viewAll = false;
          activeIndex = idx;
          sync();
        });
      });
      prevBtn?.addEventListener('click', () => {
        viewAll = false;
        activeIndex = Math.max(0, activeIndex - 1);
        sync();
      });
      nextBtn?.addEventListener('click', () => {
        viewAll = false;
        activeIndex =
          activeIndex >= panels.length - 1 ? 0 : activeIndex + 1;
        sync();
      });
      allBtn?.addEventListener('click', () => {
        viewAll = !viewAll;
        sync();
      });
      sync();
    }
  }

  function hydrateGalleryLightbox(root: Element): void {
    const imgs = Array.from(
      root.querySelectorAll<HTMLImageElement>('.mp-md-gallery-tile img'),
    );
    for (const img of imgs) {
      if (img.dataset.galleryLightboxBound === 'true') {
        continue;
      }
      img.dataset.galleryLightboxBound = 'true';
      img.addEventListener('click', event => {
        const viewer =
          typeof document.querySelector === 'function'
            ? document.querySelector('.mp-chat-image-viewer')
            : null;
        if (viewer || !document.body) {
          // ChatView's global delegation handles `.mp-chat-image-viewer` inside Studio chat.
          return;
        }
        event.stopPropagation?.();
        const backdrop = document.createElement('div');
        backdrop.className = 'mp-iui-lightbox-backdrop mp-gallery-lightbox';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');
        const full = document.createElement('img');
        full.className = 'mp-gallery-lightbox-img';
        full.src = img.src;
        full.alt = img.alt || '';
        const close = () => {
          document.removeEventListener('keydown', onKey);
          backdrop.remove();
        };
        const onKey = (keyEvent: KeyboardEvent) => {
          if (keyEvent.key === 'Escape') {
            close();
          }
        };
        backdrop.addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        backdrop.append(full);
        document.body.append(backdrop);
      });
    }
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
    hydrateSteppers(root);
    hydrateGalleryLightbox(root);
    if (handlers?.onAskMentor) {
      activeAskHandler = handlers.onAskMentor;
    }
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>('.mp-iui-card[data-iui-src]'),
    );
    for (const card of cards) {
      const complete = card.dataset.iuiComplete !== 'false';
      const rawSrc = (card.dataset.iuiSrc || '').trim();
      if (!complete || !rawSrc) {
        continue;
      }
      if (
        card.dataset.iuiHydrated === 'true' &&
        card.dataset.iuiHydratedSrc === rawSrc
      ) {
        continue;
      }
      card.dataset.iuiHydrated = 'true';
      card.dataset.iuiHydratedSrc = rawSrc;
      const sourceText = (card.dataset.iuiRawSource || rawSrc).trim();
      const title = (card.dataset.iuiTitle || '').trim();
      const kind = (card.dataset.iuiKind || 'html').trim();
      const widgetId = `iui-${++widgetSeq}`;

      card.replaceChildren();
      const head = document.createElement('header');
      head.className = 'mp-iui-head';

      const left = document.createElement('div');
      left.className = 'mp-iui-title-wrap';
      if (title) {
        const titleEl = document.createElement('span');
        titleEl.className = 'mp-iui-title';
        titleEl.textContent = title;
        left.append(titleEl);
      }

      const actions = document.createElement('div');
      actions.className = 'mp-iui-actions';

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'mp-iui-icon-btn';
      reloadBtn.title = '重置演示';
      reloadBtn.setAttribute('aria-label', '重置演示');
      reloadBtn.innerHTML =
        '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE11D;</span>';

      const vaultBtn = document.createElement('button');
      vaultBtn.type = 'button';
      vaultBtn.className = 'mp-iui-icon-btn';
      vaultBtn.title = '存入知识库';
      vaultBtn.setAttribute('aria-label', '存入知识库');
      vaultBtn.innerHTML =
        '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE01E;</span>';
      vaultBtn.addEventListener('click', () => {
        const noteTitle = title || '交互式演示';
        handlers?.onSaveToVault?.(
          noteTitle,
          `交互式演示「${noteTitle}」笔记：\n\n- [ ] 复盘其中的关键直觉与边界情况`,
        );
        vaultBtn.classList.add('is-saved');
        vaultBtn.innerHTML =
          '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE03B;</span>';
      });

      const splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.className = 'mp-iui-icon-btn';
      splitBtn.title = '在右侧面板打开';
      splitBtn.setAttribute('aria-label', '在右侧面板打开');
      splitBtn.innerHTML =
        '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE017;</span>';
      splitBtn.addEventListener('click', () => {
        if (typeof CustomEvent === 'function') {
          card.dispatchEvent(
            new CustomEvent('mp:open-inline-artifact', {
              bubbles: true,
              detail: {
                id: widgetId,
                title: title || (kind.startsWith('svg') ? 'SVG 图解' : '交互式可视化'),
                kind: kind === 'svg-snippet' ? 'svg' : kind,
                content: sourceText,
                previewHtml: rawSrc,
              },
            }),
          );
        }
      });

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'mp-iui-icon-btn';
      expandBtn.title = '放大查看';
      expandBtn.setAttribute('aria-label', '放大查看');
      expandBtn.innerHTML =
        '<span class="cds-icon" data-size="xs" aria-hidden="true">&#xE016;</span>';

      const frame = document.createElement('iframe');
      frame.className = 'mp-iui-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('scrolling', 'no');
      frame.title = title || 'Interactive visual';
      frame.style.height = '180px';
      const sendInit = () => {
        const nextPayload = {
          id: widgetId,
          themeCss: themeCssVars(),
          html: rawSrc,
        };
        if (frame.contentWindow) {
          pendingPayloadByWindow.set(frame.contentWindow, nextPayload);
          frame.contentWindow.postMessage(
            {type: 'mp-iui-init', ...nextPayload},
            '*',
          );
        }
      };
      reloadBtn.addEventListener('click', sendInit);
      frame.addEventListener('load', sendInit);
      frame.src = 'iui_sandbox.html';
      frameById.set(widgetId, frame);
      portalExpandCard(card, frame, expandBtn);

      if (card.dataset.iuiAllowSource === 'true') {
        const sourceBtn = document.createElement('button');
        sourceBtn.type = 'button';
        sourceBtn.className = 'mp-iui-icon-btn mp-iui-code-btn';
        sourceBtn.title = '查看源码';
        sourceBtn.setAttribute('aria-label', '查看源码');
        sourceBtn.textContent = '</>';
        let sourcePre: HTMLPreElement | null = null;
        sourceBtn.addEventListener('click', () => {
          const showingSource = Boolean(sourcePre && !sourcePre.hidden);
          if (!sourcePre) {
            sourcePre = document.createElement('pre');
            sourcePre.className = 'mp-iui-source';
            sourcePre.textContent = sourceText;
            card.appendChild(sourcePre);
          }
          sourcePre.hidden = showingSource;
          frame.hidden = !showingSource;
          sourceBtn.textContent = showingSource ? '</>' : '预览';
          sourceBtn.title = showingSource ? '查看源码' : '返回可视化预览';
          sourceBtn.setAttribute('aria-label', sourceBtn.title);
        });
        actions.append(sourceBtn, reloadBtn, vaultBtn, splitBtn, expandBtn);
      } else {
        actions.append(reloadBtn, vaultBtn, splitBtn, expandBtn);
      }
      head.append(left, actions);
      card.append(head, frame);
      if (frame.contentWindow) {
        pendingPayloadByWindow.set(frame.contentWindow, {
          id: widgetId,
          themeCss: themeCssVars(),
          html: rawSrc,
        });
      }
    }
  }

  const api: IntelligenceUiApi = {hydrate};
  globalThis.IntelligenceUI = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();

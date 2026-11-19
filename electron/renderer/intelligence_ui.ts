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
  let activeAskHandler: ((prompt: string) => void) | undefined;

  function themeCssVars(): string {
    const dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? `:root{--bg:#141413;--surface:#1d1d1b;--text:#ecebe6;--muted:#a4a29a;--border:rgba(255,255,255,.12);--accent:#d97757;--accent-soft:rgba(217,119,87,.18);--blue:#6da7ec;--green:#86efac;--danger:#ec7e7e;}`
      : `:root{--bg:#ffffff;--surface:#f7f7f5;--text:#1f1f1d;--muted:#6e6d68;--border:rgba(15,15,14,.12);--accent:#d97757;--accent-soft:rgba(217,119,87,.14);--blue:#184f95;--green:#166534;--danger:#8e2626;}`;
  }

  function buildSrcdoc(widgetId: string, rawCode: string): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" />
<style>
${themeCssVars()}
*{box-sizing:border-box;}
html,body{margin:0;padding:12px 14px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:13.5px;line-height:1.5;overflow-x:hidden;}
button{font:inherit;font-size:12.5px;padding:5px 11px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;transition:background .15s;}
button:hover{background:var(--accent-soft);border-color:var(--accent);}
button.active,button.primary{background:var(--accent);color:#fff;border-color:var(--accent);}
input[type="range"]{accent-color:var(--accent);cursor:pointer;}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:10px 12px;}
</style>
</head>
<body>
${rawCode}
<script>
(function(){
  var WID = ${JSON.stringify(widgetId)};
  function reportHeight(){
    var h = Math.max(120, Math.min(680, Math.ceil(document.documentElement.scrollHeight)));
    parent.postMessage({type:'mp-iui-resize', id:WID, height:h}, '*');
  }
  window.mpWidget = {
    resize: reportHeight,
    ask: function(text){
      parent.postMessage({type:'mp-iui-ask', id:WID, prompt:String(text || '')}, '*');
    }
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportHeight).observe(document.body);
  }
  window.addEventListener('load', reportHeight);
  setTimeout(reportHeight, 60);
  setTimeout(reportHeight, 260);
})();
</script>
</body>
</html>`;
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
      const badge = document.createElement('span');
      badge.className = 'mp-iui-badge';
      badge.textContent = 'Intelligence UI';
      const titleEl = document.createElement('strong');
      titleEl.className = 'mp-iui-title';
      titleEl.textContent = title;
      left.append(badge, titleEl);

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
      const docHtml = buildSrcdoc(widgetId, rawSrc);
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blobUrl = URL.createObjectURL(
          new Blob([docHtml], {type: 'text/html;charset=utf-8'}),
        );
        frame.src = blobUrl;
        frame.addEventListener('load', () => {
          window.setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        }, {once: true});
      } else {
        frame.srcdoc = docHtml;
      }
      frameById.set(widgetId, frame);

      card.append(head, frame);
    }
  }

  const api: IntelligenceUiApi = {hydrate};
  globalThis.IntelligenceUI = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();

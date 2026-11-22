import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

class FakeElement {
  tagName: string;
  className = '';
  id = '';
  textContent = '';
  title = '';
  src = '';
  hidden = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  listeners: Record<string, Array<(ev: any) => void>> = {};
  contentWindow: {postMessage: (msg: unknown, target: string) => void} | null = null;
  offsetHeight = 180;
  private _innerHTML = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    if (this.tagName === 'IFRAME') {
      this.contentWindow = {postMessage: () => {}};
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
  }

  get classList() {
    const self = this;
    return {
      add(...tokens: string[]) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const t of tokens) {
          set.add(t);
        }
        self.className = [...set].join(' ');
      },
      remove(...tokens: string[]) {
        const drop = new Set(tokens);
        self.className = self.className
          .split(/\s+/)
          .filter(c => c && !drop.has(c))
          .join(' ');
      },
      contains(token: string) {
        return self.className.split(/\s+/).includes(token);
      },
      toggle(token: string, force?: boolean) {
        if (force === true || (force === undefined && !this.contains(token))) {
          this.add(token);
          return true;
        }
        this.remove(token);
        return false;
      },
    };
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === 'class') {
      this.className = String(v);
    } else if (k.startsWith('data-')) {
      const camel = k
        .slice(5)
        .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }

  getAttribute(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, k)
      ? this.attrs[k]
      : null;
  }

  append(...items: Array<FakeElement | string>) {
    for (const item of items) {
      this.appendChild(
        typeof item === 'string'
          ? (() => {
              const t = new FakeElement('#TEXT');
              t.textContent = item;
              return t;
            })()
          : item,
      );
    }
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    if (!this.children.includes(child)) {
      this.children.push(child);
    }
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.removeChild(child);
    }
    const existingIdx = this.children.indexOf(child);
    if (existingIdx >= 0) {
      this.children.splice(existingIdx, 1);
    }
    const idx = ref ? this.children.indexOf(ref) : -1;
    child.parentNode = this;
    if (idx >= 0) {
      this.children.splice(idx, 0, child);
    } else {
      this.children.push(child);
    }
    return child;
  }

  replaceChildren(...nodes: FakeElement[]) {
    for (const c of this.children) {
      c.parentNode = null;
    }
    this.children = [];
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  replaceWith(node: FakeElement) {
    if (!this.parentNode) {
      return;
    }
    const parent = this.parentNode;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  addEventListener(type: string, fn: (ev: any) => void) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type]!.push(fn);
  }

  removeEventListener(type: string, fn: (ev: any) => void) {
    if (!this.listeners[type]) {
      return;
    }
    this.listeners[type] = this.listeners[type]!.filter(item => item !== fn);
  }

  dispatchEvent(ev: any) {
    const event = {
      preventDefault() {},
      stopPropagation() {},
      target: this,
      currentTarget: this,
      ...ev,
    };
    for (const fn of [...(this.listeners[event.type] || [])]) {
      fn(event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({type: 'click', target: this});
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const c of node.children) {
        if (selector.includes('.mp-iui-card[data-iui-src]')) {
          if (c.classList.contains('mp-iui-card') && 'iuiSrc' in c.dataset) {
            out.push(c);
          }
        } else if (selector.startsWith('.')) {
          if (c.classList.contains(selector.slice(1))) {
            out.push(c);
          }
        } else if (c.tagName.toLowerCase() === selector.toLowerCase()) {
          out.push(c);
        }
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
}

test('W1-Red: ChatMarkdown upgrades SVG (static & animated), styled HTML, and standalone <path> snippets while rendering multiple visuals', () => {
  const ChatMarkdown = require('../electron/renderer/chat_markdown');
  const md = [
    '第一段先看动画：',
    '```html',
    '<!doctype html><html><style>.star{width:40px}</style><div class="star"></div><script>console.log(1)</script></html>',
    '```',
    '',
    '第二段看独立 path：',
    '```html',
    '<path d="M12 1 C13.2 8.2 15.8 10.8 23 12 C15.8 13.2 13.2 15.8 12 23 C10.8 15.8 8.2 13.2 1 12 C8.2 10.8 10.8 8.2 12 1 Z"/>',
    '```',
    '',
    '第三段看 SVG 动效图：',
    '```svg',
    '<svg viewBox="0 0 120 40"><style>@keyframes pulse{to{opacity:.3}}</style><circle cx="20" cy="20" r="8"/></svg>',
    '```',
    '',
    '普通 HTML 代码示例保持代码块：',
    '```html',
    '<div class="plain-text">hello</div>',
    '```',
  ].join('\n');

  const out = ChatMarkdown.render(md).outerHTML as string;
  const iuiMatches = out.match(/class="mp-iui-card"/g) || [];
  assert.equal(iuiMatches.length, 3, 'All 3 visual blocks (html, path snippet, svg) must render as .mp-iui-card');
  assert.match(out, /data-iui-kind="svg-snippet"/, 'Standalone <path> snippet must upgrade to svg-snippet visual card');
  assert.match(out, /data-iui-kind="svg"/, '```svg block must upgrade to svg visual card');
  assert.match(out, /data-iui-raw-source=/, 'SVG snippet must retain raw snippet for source view');
  assert.match(out, /class="mp-chat-code" data-lang="html"/, 'Plain HTML markup without styles/scripts/SVG stays a code block');
});

test('W1-Red: IntelligenceUI skips unfinished streaming cards, hydrates on completion, and portals expanded card to document.body lightbox', () => {
  const docListeners: Record<string, Array<(ev: any) => void>> = {};
  const winListeners: Record<string, Array<(ev: any) => void>> = {};
  const body = new FakeElement('body');
  const root = new FakeElement('div');
  body.appendChild(root);

  const card = new FakeElement('section');
  card.className = 'mp-iui-card';
  card.dataset.iuiComplete = 'false';
  card.dataset.iuiSrc = '';
  card.dataset.iuiTitle = 'Streamed Visual';
  root.appendChild(card);

  const prevDoc = (globalThis as Record<string, unknown>).document;
  const prevWin = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).document = {
    body,
    documentElement: {dataset: {theme: 'light'}},
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => {
      const n = new FakeElement('#TEXT');
      n.textContent = text;
      return n;
    },
    addEventListener: (t: string, fn: (ev: any) => void) => {
      docListeners[t] = docListeners[t] || [];
      docListeners[t]!.push(fn);
    },
    removeEventListener: (t: string, fn: (ev: any) => void) => {
      if (docListeners[t]) {
        docListeners[t] = docListeners[t]!.filter(f => f !== fn);
      }
    },
  };
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (t: string, fn: (ev: any) => void) => {
      winListeners[t] = winListeners[t] || [];
      winListeners[t]!.push(fn);
    },
  };

  try {
    const IntelligenceUI = require('../electron/renderer/intelligence_ui');
    // Step 1: unfinished card must NOT lock hydrated
    IntelligenceUI.hydrate(root);
    assert.notEqual(card.dataset.iuiHydrated, 'true', 'Streaming card must not lock hydrated before completion');

    // Step 2: card completes with source -> hydrate mounts iframe
    card.dataset.iuiComplete = 'true';
    card.dataset.iuiSrc = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>';
    IntelligenceUI.hydrate(root);
    assert.equal(card.dataset.iuiHydrated, 'true');
    assert.ok(card.querySelector('.mp-iui-frame'), 'Completed card must mount iframe');

    // Step 3: click Expand -> card must portal into document.body .mp-iui-lightbox-backdrop with placeholder left in root
    const expandBtn = card
      .querySelectorAll('button')
      .find(btn => btn.getAttribute('aria-label') === '放大查看');
    assert.ok(expandBtn, 'Expand button must exist');
    expandBtn.click();

    const backdrop = body.querySelector('.mp-iui-lightbox-backdrop');
    assert.ok(backdrop, 'Expanding must portal card into document.body .mp-iui-lightbox-backdrop');
    assert.equal(card.parentNode, backdrop, 'Expanded card must live inside lightbox backdrop');
    assert.ok(root.querySelector('.mp-iui-placeholder'), 'Original slot must keep a placeholder');

    // Clicking backdrop/restore puts card back
    expandBtn.click();
    assert.equal(card.parentNode, root, 'Restoring must return card to original container');
    assert.equal(body.querySelector('.mp-iui-lightbox-backdrop'), null);
  } finally {
    (globalThis as Record<string, unknown>).document = prevDoc;
    (globalThis as Record<string, unknown>).window = prevWin;
  }

  const chatCss = fs.readFileSync(path.join(ROOT, 'electron/renderer/chat_styles.css'), 'utf8');
  assert.match(chatCss, /\.mp-iui-lightbox-backdrop/);
});

import {randomBytes, timingSafeEqual} from 'node:crypto';
import http from 'node:http';

export interface LiveBrowserActStep {
  action: 'click' | 'fill' | 'select' | 'press_key' | 'scroll' | 'wait';
  ref?: string;
  selector?: string;
  value?: string;
  key?: string;
  dy?: number;
  ms?: number;
  description?: string;
  intent?: 'input' | 'send' | 'submit' | 'delete' | 'purchase';
}

export interface LiveBrowserTabInfo {
  target: 'studio' | 'cdp';
  tabId: string;
  port?: number;
  title: string;
  url: string;
  active?: boolean;
  wsUrl?: string;
}

export interface StudioBrowserAdapter {
  currentTab: () => {url: string; title: string; active: boolean};
  openUrl: (url: string) => Promise<{url: string; title: string}>;
  evalJs: <T = unknown>(script: string) => Promise<T>;
  captureJpeg: () => Promise<{image: string; width: number; height: number} | null>;
  onOpenPanel?: (url?: string) => void;
}

export function buildReadPageScript(
  maxElements = 80,
  includeText = true,
): string {
  const limit = Math.max(10, Math.min(200, Math.round(maxElements || 80)));
  const withText = includeText !== false;
  return `(() => {
    const stale = document.querySelectorAll('[data-mp-ref]');
    for (let i = 0; i < stale.length; i++) {
      stale[i].removeAttribute('data-mp-ref');
    }
    const selector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[contenteditable="true"]'
    ].join(',');
    const nodes = document.querySelectorAll(selector);
    const items = [];
    const lines = [];
    let counter = 1;
    for (let i = 0; i < nodes.length && items.length < ${limit}; i++) {
      const el = nodes[i];
      if (!el || typeof el.getBoundingClientRect !== 'function') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const ref = 'b' + counter++;
      el.setAttribute('data-mp-ref', ref);
      const tag = String(el.tagName || '').toLowerCase();
      const role = String(el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag)).slice(0, 24);
      const rawText = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim();
      const text = rawText.slice(0, 72);
      const placeholder = String(el.getAttribute('placeholder') || '').slice(0, 40);
      const val = tag === 'input' || tag === 'textarea' || tag === 'select' ? String(el.value || '').slice(0, 60) : '';
      const href = tag === 'a' ? String(el.getAttribute('href') || '').slice(0, 120) : '';
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      items.push({
        ref,
        tag,
        role,
        text,
        ...(placeholder ? {placeholder} : {}),
        ...(val ? {value: val} : {}),
        ...(href ? {href} : {}),
        x: cx,
        y: cy,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      const labelPart = text ? ' "' + text.slice(0, 42) + '"' : '';
      const valPart = val ? ' value="' + val.slice(0, 28) + '"' : '';
      lines.push('[' + ref + '] ' + role + labelPart + valPart + ' (' + cx + ', ' + cy + ')');
    }
    const pageText = ${withText}
      ? String(document.body && document.body.innerText ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000)
      : '';
    return {
      ok: true,
      url: location.href,
      title: document.title,
      interactive: items,
      treeText: lines.join('\\n'),
      ...(pageText ? {pageText} : {})
    };
  })()`;
}

export function buildBatchActScript(steps: LiveBrowserActStep[]): string {
  const safeSteps = Array.isArray(steps) ? steps.slice(0, 16) : [];
  return `(async () => {
    const steps = ${JSON.stringify(safeSteps)};
    const results = [];
    const pulseEl = (el) => {
      if (!el || !el.style) return;
      try {
        el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
      } catch {}
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      const prevShadow = el.style.boxShadow;
      el.style.outline = '2.5px solid rgba(217, 119, 87, 0.9)';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 0 4px rgba(217, 119, 87, 0.24)';
      setTimeout(() => {
        try {
          el.style.outline = prevOutline;
          el.style.outlineOffset = prevOffset;
          el.style.boxShadow = prevShadow;
        } catch {}
      }, 550);
    };
    const setReactValue = (el, val) => {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' && window.HTMLInputElement && window.HTMLInputElement.prototype) {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && typeof desc.set === 'function') {
          desc.set.call(el, val);
        } else {
          el.value = val;
        }
      } else if (tag === 'textarea' && window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype) {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (desc && typeof desc.set === 'function') {
          desc.set.call(el, val);
        } else {
          el.value = val;
        }
      } else if (el.isContentEditable) {
        el.textContent = val;
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
    };
    const findTarget = (step) => {
      if (step.ref) {
        const clean = String(step.ref).replace(/^@/, '');
        const byRef = document.querySelector('[data-mp-ref="' + CSS.escape(clean) + '"]');
        if (byRef) return byRef;
      }
      if (step.selector) {
        return document.querySelector(String(step.selector));
      }
      return null;
    };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      const action = String(step.action || '');
      if (action === 'wait') {
        const ms = Math.max(50, Math.min(3000, Number(step.ms) || 350));
        await new Promise((r) => setTimeout(r, ms));
        results.push({index: i, ok: true, action: 'wait', ms});
        continue;
      }
      if (action === 'scroll') {
        const el = findTarget(step);
        const dy = Number.isFinite(Number(step.dy)) ? Number(step.dy) : -480;
        if (el && typeof el.scrollBy === 'function') {
          el.scrollBy({top: -dy, behavior: 'instant'});
        } else {
          window.scrollBy({top: -dy, behavior: 'instant'});
        }
        results.push({index: i, ok: true, action: 'scroll', dy});
        continue;
      }
      const target = findTarget(step) || (action === 'press_key' ? document.activeElement : null);
      if (!target) {
        results.push({index: i, ok: false, action, error: 'element_not_found'});
        break;
      }
      pulseEl(target);
      if (typeof target.focus === 'function') {
        try { target.focus(); } catch {}
      }
      if (action === 'click') {
        target.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
        target.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
        if (typeof target.click === 'function') {
          target.click();
        }
        results.push({index: i, ok: true, action: 'click', ref: step.ref || null});
      } else if (action === 'fill') {
        setReactValue(target, String(step.value ?? ''));
        results.push({index: i, ok: true, action: 'fill', ref: step.ref || null, length: String(step.value ?? '').length});
      } else if (action === 'select') {
        target.value = String(step.value ?? '');
        target.dispatchEvent(new Event('input', {bubbles: true}));
        target.dispatchEvent(new Event('change', {bubbles: true}));
        results.push({index: i, ok: true, action: 'select', value: target.value});
      } else if (action === 'press_key') {
        const key = String(step.key || 'Enter');
        const opts = {key, code: key, bubbles: true, cancelable: true};
        target.dispatchEvent(new KeyboardEvent('keydown', opts));
        target.dispatchEvent(new KeyboardEvent('keypress', opts));
        target.dispatchEvent(new KeyboardEvent('keyup', opts));
        if ((key === 'Enter' || key === 'Return') && target.form) {
          if (typeof target.form.requestSubmit === 'function') {
            target.form.requestSubmit();
          } else if (typeof target.form.submit === 'function') {
            target.form.submit();
          }
        }
        results.push({index: i, ok: true, action: 'press_key', key});
      } else {
        results.push({index: i, ok: false, action, error: 'unsupported_action'});
        break;
      }
    }
    return {
      ok: results.length > 0 && results.every((r) => r.ok !== false),
      results,
      url: location.href,
      title: document.title
    };
  })()`;
}

export async function discoverCdpTabs(
  ports: number[] = [9222, 9229],
): Promise<LiveBrowserTabInfo[]> {
  const tabs: LiveBrowserTabInfo[] = [];
  for (const port of ports) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1100);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        continue;
      }
      const list = (await res.json()) as Array<{
        id?: string;
        type?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
      }>;
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list) {
        if (item.type !== 'page' || !item.webSocketDebuggerUrl) {
          continue;
        }
        const u = String(item.url || '');
        if (/^(devtools|chrome-extension):\/\//i.test(u) || /studio\.html/i.test(u)) {
          continue;
        }
        tabs.push({
          target: 'cdp',
          port,
          tabId: String(item.id || ''),
          title: String(item.title || ''),
          url: u,
          wsUrl: String(item.webSocketDebuggerUrl),
        });
      }
    } catch {
      /* Port not listening — skip silently. */
    } finally {
      clearTimeout(timer);
    }
  }
  return tabs;
}

async function withCdpTab<T>(
  wsUrl: string,
  fn: (
    send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (val: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp_connect_timeout')), 4000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('cdp_connect_error'));
    });
  });

  ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: {message?: string};
      };
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'cdp_command_error'));
        } else {
          entry.resolve(msg.result || {});
        }
      }
    } catch {}
  });

  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`cdp_timeout:${method}`));
      }, 12000);
      pending.set(id, {resolve, reject, timer});
      ws.send(JSON.stringify({id, method, params}));
    });
  };

  try {
    return await fn(send);
  } finally {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('cdp_closed'));
    }
    pending.clear();
    try {
      ws.close();
    } catch {}
  }
}

export class LiveBrowserDaemon {
  private readonly token = randomBytes(24).toString('hex');
  private server?: http.Server;
  private rpcUrl = '';

  constructor(private readonly adapter: StudioBrowserAdapter) {}

  async startRpcServer(): Promise<{url: string; token: string}> {
    if (this.server && this.rpcUrl) {
      return {url: this.rpcUrl, token: this.token};
    }
    const tokenBuf = Buffer.from(this.token, 'utf8');
    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/rpc') {
        res.writeHead(404).end(JSON.stringify({error: 'not_found'}));
        return;
      }
      const presented = Buffer.from(
        String(req.headers['x-mp-browser-token'] || ''),
        'utf8',
      );
      if (
        presented.length !== tokenBuf.length ||
        !timingSafeEqual(presented, tokenBuf)
      ) {
        res.writeHead(401).end(JSON.stringify({error: 'unauthorized'}));
        return;
      }
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += String(chunk);
        if (rawBody.length > 2 * 1024 * 1024) {
          res.writeHead(413).end(JSON.stringify({error: 'payload_too_large'}));
          return;
        }
      }
      try {
        const parsed = JSON.parse(rawBody || '{}') as {
          method?: string;
          params?: Record<string, unknown>;
        };
        const result = await this.handleRpc(
          String(parsed.method || ''),
          parsed.params || {},
        );
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({result}));
      } catch (error) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

    await new Promise<void>(resolve => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.rpcUrl = `http://127.0.0.1:${port}`;
    return {url: this.rpcUrl, token: this.token};
  }

  rpcEnv(): {
    MAGIC_POINTER_BROWSER_DAEMON_URL?: string;
    MAGIC_POINTER_BROWSER_DAEMON_TOKEN?: string;
  } {
    if (!this.rpcUrl) {
      return {};
    }
    return {
      MAGIC_POINTER_BROWSER_DAEMON_URL: this.rpcUrl,
      MAGIC_POINTER_BROWSER_DAEMON_TOKEN: this.token,
    };
  }

  async shutdown(): Promise<void> {
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
      this.rpcUrl = '';
    }
  }

  private async resolveCdpTab(
    params: Record<string, unknown>,
  ): Promise<LiveBrowserTabInfo> {
    const portList = Number(params.cdpPort)
      ? [Number(params.cdpPort)]
      : [9222, 9229];
    const tabs = await discoverCdpTabs(portList);
    if (!tabs.length) {
      throw new Error(
        'No external Chrome/Edge CDP debug tab found on ports 9222/9229; use target:"studio" (default) or launch browser with --remote-debugging-port=9222.',
      );
    }
    const requestedId = String(params.tabId || '').trim();
    const chosen = requestedId
      ? tabs.find(t => t.tabId === requestedId) || tabs[0]!
      : tabs[0]!;
    return chosen;
  }

  private async handleRpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = params.target === 'cdp' ? 'cdp' : 'studio';

    if (method === 'list_tabs') {
      const studio = this.adapter.currentTab();
      const studioTab: LiveBrowserTabInfo = {
        target: 'studio',
        tabId: 'studio-active',
        title: studio.title,
        url: studio.url,
        active: studio.active,
      };
      const cdpTabs =
        params.skipCdp === true ? [] : await discoverCdpTabs([9222, 9229]);
      return {
        ok: true,
        tabs: [studioTab, ...cdpTabs.map(({wsUrl: _ws, ...rest}) => rest)],
        usedBackend: 'live_browser',
      };
    }

    if (method === 'open') {
      const url = String(params.url || '').trim();
      if (!url) {
        throw new Error('url is required');
      }
      if (target === 'cdp') {
        const tab = await this.resolveCdpTab(params);
        await withCdpTab(tab.wsUrl!, async send => {
          await send('Page.enable');
          await send('Page.navigate', {url});
        });
        return {
          ok: true,
          target: 'cdp',
          tabId: tab.tabId,
          url,
          usedBackend: 'live_browser_cdp',
        };
      }
      this.adapter.onOpenPanel?.(url);
      const opened = await this.adapter.openUrl(url);
      let pagePreview: Record<string, unknown> | null = null;
      if (params.readAfterOpen !== false) {
        pagePreview = await this.adapter
          .evalJs<Record<string, unknown>>(buildReadPageScript(60, false))
          .catch(() => null);
      }
      return {
        ok: true,
        target: 'studio',
        url: opened.url,
        title: opened.title,
        ...(pagePreview ? {treeText: pagePreview.treeText, interactive: pagePreview.interactive} : {}),
        usedBackend: 'live_browser_studio',
      };
    }

    if (method === 'read_page') {
      const maxElements = Number(params.maxElements) || 80;
      const includeText = params.includeText !== false;
      const script = buildReadPageScript(maxElements, includeText);
      if (target === 'cdp') {
        const tab = await this.resolveCdpTab(params);
        const evaluated = await withCdpTab(tab.wsUrl!, async send => {
          await send('Runtime.enable');
          return send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true,
          });
        });
        const val = (evaluated.result as {value?: Record<string, unknown>})?.value;
        return {...(val || {}), target: 'cdp', tabId: tab.tabId, usedBackend: 'live_browser_cdp'};
      }
      this.adapter.onOpenPanel?.();
      const val = await this.adapter.evalJs<Record<string, unknown>>(script);
      return {...(val || {}), target: 'studio', usedBackend: 'live_browser_studio'};
    }

    if (method === 'act') {
      const steps = Array.isArray(params.steps)
        ? (params.steps as LiveBrowserActStep[])
        : [];
      if (!steps.length) {
        throw new Error('steps array is required');
      }
      const script = buildBatchActScript(steps);
      let actResult: Record<string, unknown>;
      if (target === 'cdp') {
        const tab = await this.resolveCdpTab(params);
        const evaluated = await withCdpTab(tab.wsUrl!, async send => {
          await send('Runtime.enable');
          return send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true,
          });
        });
        actResult =
          (evaluated.result as {value?: Record<string, unknown>})?.value || {
            ok: true,
          };
      } else {
        this.adapter.onOpenPanel?.();
        actResult = await this.adapter.evalJs<Record<string, unknown>>(script);
      }
      let shot: {image: string; mimeType: string; width: number; height: number} | null = null;
      if (params.includeScreenshot === true && target === 'studio') {
        const cap = await this.adapter.captureJpeg().catch(() => null);
        if (cap?.image) {
          shot = {...cap, mimeType: 'image/jpeg'};
        }
      }
      return {
        ...actResult,
        target,
        ...(shot
          ? {
              image: shot.image,
              mimeType: shot.mimeType,
              imageLabel: `Studio Live Browser (${shot.width}x${shot.height})`,
            }
          : {}),
        usedBackend:
          target === 'cdp' ? 'live_browser_cdp' : 'live_browser_studio',
      };
    }

    if (method === 'screenshot') {
      if (target === 'cdp') {
        const tab = await this.resolveCdpTab(params);
        const cap = await withCdpTab(tab.wsUrl!, async send => {
          await send('Page.enable');
          return send('Page.captureScreenshot', {format: 'jpeg', quality: 80});
        });
        return {
          ok: true,
          target: 'cdp',
          tabId: tab.tabId,
          mimeType: 'image/jpeg',
          image: String(cap.data || ''),
          url: tab.url,
          title: tab.title,
          imageLabel: `CDP Browser Tab (${tab.title || tab.url})`,
          usedBackend: 'live_browser_cdp',
        };
      }
      this.adapter.onOpenPanel?.();
      const cap = await this.adapter.captureJpeg();
      if (!cap || !cap.image) {
        throw new Error('studio_browser_capture_unavailable');
      }
      const studio = this.adapter.currentTab();
      return {
        ok: true,
        target: 'studio',
        mimeType: 'image/jpeg',
        image: cap.image,
        width: cap.width,
        height: cap.height,
        url: studio.url,
        title: studio.title,
        imageLabel: `Studio Live Browser (${cap.width}x${cap.height})`,
        usedBackend: 'live_browser_studio',
      };
    }

    if (method === 'eval') {
      const expression = String(params.expression || '');
      if (!expression) {
        throw new Error('expression is required');
      }
      if (target === 'cdp') {
        const tab = await this.resolveCdpTab(params);
        const evaluated = await withCdpTab(tab.wsUrl!, async send => {
          await send('Runtime.enable');
          return send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
        });
        return {
          ok: true,
          target: 'cdp',
          value: (evaluated.result as {value?: unknown})?.value,
          usedBackend: 'live_browser_cdp',
        };
      }
      this.adapter.onOpenPanel?.();
      const value = await this.adapter.evalJs(expression);
      return {
        ok: true,
        target: 'studio',
        value,
        usedBackend: 'live_browser_studio',
      };
    }

    throw new Error(`unknown_live_browser_method:${method}`);
  }
}

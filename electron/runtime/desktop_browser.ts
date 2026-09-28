import { DesktopActionSession, delay, type DesktopElement, type DesktopSnapshot, type DesktopWindow } from './desktop';
import { ActionFailure, type ToolRegistry } from './tools';

// Browser chrome knowledge belongs to this capability, not to the generic input/effect classifier.
function addressBar(elements: DesktopElement[]): DesktopElement | undefined {
  return elements.find(row => row.role === 'edit' && !row.offscreen &&
    /^(Address and search bar|Search or enter address|地址和搜索栏|地址与搜索栏|搜索或输入网址|搜索或输入地址)$/i.test(row.name));
}
function pageUrl(value: unknown): URL | null {
  try { const text = String(value || '').trim(); return text ? new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`) : null; } catch { return null; }
}
export function navigationVerified(before: DesktopSnapshot, after: DesktopSnapshot, expected: URL): boolean {
  const current = pageUrl(addressBar(after.elements)?.value), previous = pageUrl(addressBar(before.elements)?.value);
  const document = after.elements.find(row => row.role === 'document' && !row.offscreen && row.name.trim());
  const matches = (url: URL | null) => !!url && url.hostname === expected.hostname && url.port === expected.port &&
    (expected.pathname === '/' || url.pathname === expected.pathname) && (!expected.search || url.search === expected.search);
  return matches(current) && !!document && !/^(privacy error|this site can.t be reached|无法访问此网站)/i.test(document.name) &&
    (after.window.title !== before.window.title || matches(previous) && previous?.pathname === expected.pathname &&
      addressBar(before.elements)?.focused !== true && addressBar(after.elements)?.focused !== true);
}

export function registerBrowserTools(registry: ToolRegistry, desktop: DesktopActionSession, acquireTarget?: (window: DesktopWindow) => unknown | Promise<unknown>): void {
  registry.register({ name: 'Browser.navigate',
    description: 'Open an http(s) URL in an existing Edge, Chrome or Firefox window and verify its address plus loaded document. Use list_apps to identify window_id; launch_app first if the requested browser is closed. This capability handles focus, address-bar input and Enter locally, without separate approval for ordinary navigation. It never logs in or submits page forms.',
    input_schema: { type: 'object', properties: { window_id: { type: 'string' }, url: { type: 'string' } }, required: ['window_id', 'url'], additionalProperties: false },
    effect: 'reversible_write', resource_keys: ['desktop:input'], deferred: true, timeout_ms: 65000, used_backend: 'browser_native_input',
    execute: async (args, context) => {
      let url: URL;
      try { url = new URL(String(args.url)); } catch { throw new ActionFailure('tool_error', 'Browser.navigate requires an absolute http(s) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new ActionFailure('tool_error', 'Browser.navigate only opens http(s) URLs.');
      const window = await desktop.resolveWindow({ window_id: args.window_id }, context.signal);
      if (!/^(msedge|chrome|firefox)\.exe$/i.test(String(window.process_name))) throw new ActionFailure('tool_error', 'The selected window is not a supported browser.');
      const activated = await desktop.call('activate_window', { window_id: String(window.hwnd) }, context.signal);
      if (activated.waitingForDesktop) return activated;
      await acquireTarget?.(activated.window || window);
      const observe = () => desktop.observe({ window_id: String(window.hwnd), mode: 'ax', pixels: false }, context.signal);
      const act = async (name: string, args: Record<string, unknown>) => {
        const result = await desktop.call(name, args, context.signal);
        if (result.waitingForDesktop) throw new DOMException('computer_use_interrupted: browser navigation paused after focusing the window', 'AbortError');
        return result;
      };
      const before = await observe();
      await act('press_key', { state_id: before.state_id, keys: 'ctrl+l' });
      const focused = await observe(), field = addressBar(focused.elements);
      if (!field?.focused) throw new ActionFailure('tool_error', 'Browser address bar did not receive focus; no URL was entered.');
      const typed = await act('type_text', { state_id: focused.state_id, index: field.index, text: url.href, clear: true });
      let ready = focused;
      if (typed.verification?.matched !== true) {
        ready = await observe();
        const completion = addressBar(ready.elements);
        // Chromium may select a history suffix while typing. Remove that selection, then read the exact URL back.
        if (completion?.focused && String(completion.value).startsWith(url.href) && String(completion.value).length > url.href.length) {
          await act('press_key', { state_id: ready.state_id, keys: 'backspace' });
          ready = await observe();
        }
        if (addressBar(ready.elements)?.value !== url.href) throw new ActionFailure('tool_error', 'The address bar did not confirm the requested URL; Enter was not sent.');
      }
      await act('press_key', { state_id: ready.state_id, keys: 'enter' });
      const deadline = Date.now() + 12000;
      let after = await observe();
      while (!navigationVerified(before, after, url) && Date.now() < deadline) {
        await delay(250, context.signal); after = await observe();
      }
      return { ok: navigationVerified(before, after, url), requestedUrl: url.href,
        url: pageUrl(addressBar(after.elements)?.value)?.href || '', title: after.window.title,
        documentTitle: after.elements.find(row => row.role === 'document' && !row.offscreen)?.name || '',
        window: after.window, state_id: after.state_id, usedBackend: 'browser_native_input',
        verification: { matched: navigationVerified(before, after, url), method: 'browser_address_and_document', scope: 'application_state' } };
    },
  });
}

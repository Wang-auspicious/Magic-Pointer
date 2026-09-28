import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopActionSession, type DesktopSnapshot } from '../electron/runtime/desktop';
import { navigationVerified, registerBrowserTools } from '../electron/runtime/desktop_browser';
import { ToolRegistry } from '../electron/runtime/tools';

for (const autocomplete of [false, true]) test(`browser navigation verifies the loaded document with autocomplete=${autocomplete}`, async () => {
  const desktop = new DesktopActionSession('browser-nav'), registry = new ToolRegistry();
  const calls: string[] = [];
  let entered = false, reads = 0, typedValue = '';
  const snapshot = (): DesktopSnapshot => ({ snapshot_id: `state-${++reads}`, state_id: `state-${reads}`, root_ref: '@r1', mode: 'ax',
    window: { hwnd: 42, pid: 7, title: entered ? 'GitHub - Edge' : 'New tab - Edge', bbox: [0, 0, 400, 300], process_name: 'msedge.exe' }, windows: [],
    elements: [{ index: 1, hwnd: 42, name: 'Address and search bar', role: 'edit', rect: [5, 5, 395, 40], runtime_id: [1], patterns: ['Value'], focused: !entered, value: entered ? 'https://github.com/' : typedValue },
      { index: 2, hwnd: 42, name: entered ? 'GitHub' : 'New tab', role: 'document', rect: [0, 40, 400, 300], runtime_id: [2], patterns: [] }] });
  Object.assign(desktop, {
    resolveWindow: async () => snapshot().window,
    observe: async () => snapshot(),
    call: async (name: string, args: Record<string, any>) => {
      calls.push(`${name}:${args.keys || ''}`);
      if (name === 'type_text') typedValue = String(args.text) + (autocomplete ? 'previous/repository' : '');
      if (name === 'press_key' && args.keys === 'backspace') typedValue = 'https://github.com/';
      if (name === 'press_key' && args.keys === 'enter') entered = true;
      return { ok: true, window: snapshot().window, verification: { matched: !(name === 'type_text' && autocomplete) } };
    },
  });
  registerBrowserTools(registry, desktop);
  const before = snapshot(), onlyTyped = structuredClone(before);
  onlyTyped.elements[0].value = 'https://github.com/';
  assert.equal(navigationVerified(before, onlyTyped, new URL('https://github.com')), false, 'typed address without a new document is not navigation');
  assert.equal(navigationVerified(onlyTyped, onlyTyped, new URL('https://github.com')), false, 'a retry with the URL already typed is still not a loaded page');
  const priorPage = structuredClone(before), navigatingHome = structuredClone(before);
  priorPage.window.title = navigatingHome.window.title = 'Explore GitHub - Edge';
  priorPage.elements[0].value = 'https://github.com/explore';
  navigatingHome.elements[0].value = 'https://github.com/';
  priorPage.elements[0].focused = navigatingHome.elements[0].focused = false;
  assert.equal(navigationVerified(priorPage, navigatingHome, new URL('https://github.com')), false, 'the old page of the same site cannot verify a new homepage navigation');
  const result = await registry.execute({ id: 'navigate', name: 'Browser.navigate', arguments: { window_id: 'w-42', url: 'https://github.com' } });
  assert.equal(result.is_error, false, result.error_message);
  assert.equal(registry.effect('Browser.navigate', { url: 'https://github.com' }), 'reversible_write');
  const expectedCalls = ['activate_window:', 'press_key:ctrl+l', 'type_text:', ...(autocomplete ? ['press_key:backspace'] : []), 'press_key:enter'];
  assert.deepEqual(calls, expectedCalls);
  assert.equal((result.value as any).verification.matched, true);
  assert.equal((result.value as any).url, 'https://github.com/');
  const script = await registry.execute({ id: 'script', name: 'Browser.navigate', arguments: { window_id: 'w-42', url: 'javascript:alert(1)' } });
  assert.equal(script.is_error, true);
  assert.equal(calls.length, expectedCalls.length, 'unsupported URLs must not send input');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDevtoolsFailures, type CdpEventSource } from '../electron/runtime/desktop_adapters';
import { prepareTaskContext } from '../electron/runtime/context_prepare';
import { taskSources } from '../electron/runtime/context';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

function fakeConnection(events: { method: string; params: Record<string, unknown> }[]): CdpEventSource & { calls: string[] } {
  let listener: ((method: string, params: Record<string, unknown>) => void) | undefined;
  const calls: string[] = [];
  return {
    calls,
    onEvent(handler) { listener = handler; },
    async request(method) {
      calls.push(method);
      if (method === 'Log.enable') for (const event of events) listener?.(event.method, event.params);
      return {};
    },
  };
}

test('DevTools log replay and resource timing become bounded, deduplicated failure evidence', async () => {
  const connection = fakeConnection([
    { method: 'Network.requestWillBeSent', params: { requestId: '7', request: { url: 'https://api.example.com/orders' } } },
    { method: 'Network.loadingFailed', params: { requestId: '7', errorText: 'net::ERR_CONNECTION_REFUSED' } },
    { method: 'Log.entryAdded', params: { entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 500 ()', url: 'https://api.example.com/cart', timestamp: 1790000000000 } } },
    { method: 'Log.entryAdded', params: { entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 500 ()', url: 'https://api.example.com/cart', timestamp: 1790000000001 } } },
    { method: 'Log.entryAdded', params: { entry: { source: 'javascript', level: 'error', text: 'TypeError: cart.items is undefined', url: 'https://shop.example.com/app.js', lineNumber: 41 } } },
    { method: 'Log.entryAdded', params: { entry: { source: 'javascript', level: 'info', text: 'hydrated' } } },
  ]);
  const evidence = await collectDevtoolsFailures(connection, [{ url: 'https://cdn.example.com/logo.png', responseStatus: 404 }], 1);
  assert.deepEqual(connection.calls.slice(0, 2), ['Network.enable', 'Log.enable']);
  assert.deepEqual(evidence.networkFailures.map(item => [item.source, item.url, item.errorText]), [
    ['network.loadingFailed', 'https://api.example.com/orders', 'net::ERR_CONNECTION_REFUSED'],
    ['devtools_log', 'https://api.example.com/cart', 'Failed to load resource: the server responded with a status of 500 ()'],
    ['resource_timing', 'https://cdn.example.com/logo.png', 'HTTP 404'],
  ]);
  assert.deepEqual(evidence.consoleErrors.map(item => item.text), ['TypeError: cart.items is undefined']);
  assert.deepEqual(evidence.uncertainty, []);
});

test('a quiet page says what was not observed instead of claiming health', async () => {
  const evidence = await collectDevtoolsFailures(fakeConnection([]), [], 1);
  assert.deepEqual(evidence.networkFailures, []);
  assert.deepEqual(evidence.uncertainty, ['no_network_failure_observed_in_devtools_log_or_resource_timing']);
});

test('page failures travel with the web source the agent reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-browser-failures-'));
  const window = { hwnd: 9, pid: 4, process_name: 'msedge.exe', title: 'Cart', class_name: 'Chrome_WidgetWin_1', bbox: [0, 0, 800, 600] };
  const context = { adapter: 'browser-devtools', app: 'browser', window, content: 'Checkout failed', method: 'cdp:dom', artifacts: { browser_context: {
    state: 'resolved', networkFailures: [{ url: 'https://api.example.com/cart', errorText: 'HTTP 500', source: 'resource_timing' }],
    consoleErrors: [{ text: 'TypeError: cart.items is undefined', url: 'https://shop.example.com/app.js', line: 41 }],
    provenance: { endpoint: 'http://127.0.0.1:9222', targetId: 'T1', documentEpoch: 'E1', structural: true } } } };
  const session = await EventSession.open(root, 'browser-failures');
  await prepareTaskContext(session, { selectionSnapshot: { snapshot_id: 'web-selection', context, source_window: window } }, { root, userDataDir: root, registry: new ToolRegistry() });
  const source = taskSources(session.events).find(item => item.kind === 'web');
  assert.ok(source);
  assert.match(String(source.identity.content), /Checkout failed/);
  assert.match(String(source.identity.content), /HTTP 500 https:\/\/api\.example\.com\/cart/);
  assert.match(String(source.identity.content), /TypeError: cart\.items is undefined/);
});

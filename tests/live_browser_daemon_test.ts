import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  LiveBrowserDaemon,
  buildBatchActScript,
  buildReadPageScript,
  type StudioBrowserAdapter,
} from '../electron/live_browser_daemon';
import {registerLiveBrowserTools} from '../electron/runtime/live_browser_tools';
import {initialToolNames} from '../electron/runtime/agent_services';
import {ToolRegistry} from '../electron/runtime/tools';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('LIVE-BROWSER-Red: LiveBrowserDaemon enforces loopback token auth and handles read_page, act, open, list_tabs, screenshot, eval', async () => {
  let openedUrl = '';
  const evalHistory: string[] = [];
  const adapter: StudioBrowserAdapter = {
    currentTab: () => ({
      url: openedUrl || 'https://example.com',
      title: 'Example Domain',
      active: Boolean(openedUrl),
    }),
    openUrl: async url => {
      openedUrl = url;
      return {url, title: 'Opened Page'};
    },
    evalJs: async <T = unknown>(script: string): Promise<T> => {
      evalHistory.push(script);
      if (script.includes('treeText')) {
        return {
          url: openedUrl || 'https://example.com',
          title: 'Example Domain',
          interactive: [{ref: 'b1', tag: 'button', role: 'button', text: 'Search', x: 120, y: 80}],
          treeText: '[b1] button "Search" (120, 80)',
          pageText: 'Welcome to Example Domain',
        } as T;
      }
      return {ok: true, url: openedUrl || 'https://example.com', title: 'Example Domain', results: [{index: 0, ok: true}]} as T;
    },
    captureJpeg: async () => ({
      image: Buffer.from('fake-jpeg').toString('base64'),
      width: 800,
      height: 600,
    }),
    onOpenPanel: () => {},
  };

  const daemon = new LiveBrowserDaemon(adapter);
  try {
    const {url, token} = await daemon.startRpcServer();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(token.length >= 32);

    const unauth = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({method: 'list_tabs', params: {skipCdp: true}}),
    });
    assert.equal(unauth.status, 401);

    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await fetch(`${url}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mp-browser-token': token,
        },
        body: JSON.stringify({method, params}),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as {result?: Record<string, unknown>; error?: string};
    };

    const opened = await call('open', {url: 'https://news.ycombinator.com'});
    assert.equal(opened.result?.ok, true);
    assert.equal(openedUrl, 'https://news.ycombinator.com');

    const page = await call('read_page', {});
    assert.match(String(page.result?.treeText || ''), /\[b1\]/);
    assert.equal(page.result?.pageText, 'Welcome to Example Domain');

    const acted = await call('act', {steps: [{action: 'click', ref: 'b1'}]});
    assert.equal(acted.result?.ok, true);

    const shot = await call('screenshot', {});
    assert.equal(shot.result?.mimeType, 'image/jpeg');
    assert.equal(shot.result?.width, 800);

    const env = daemon.rpcEnv();
    assert.equal(env.MAGIC_POINTER_BROWSER_DAEMON_URL, url);
    assert.equal(env.MAGIC_POINTER_BROWSER_DAEMON_TOKEN, token);
  } finally {
    await daemon.shutdown();
  }
});

test('LIVE-BROWSER-Red: buildReadPageScript & buildBatchActScript generate React/Vue-safe DOM scripts with visual pulse', () => {
  const readScript = buildReadPageScript(60, true);
  assert.match(readScript, /data-mp-ref/);
  assert.match(readScript, /button|input|textarea|select/);
  assert.match(readScript, /innerText/);

  const actScript = buildBatchActScript([
    {action: 'fill', ref: 'b1', value: 'attention is all you need'},
    {action: 'click', selector: 'button[type="submit"]'},
  ]);
  assert.match(actScript, /HTMLInputElement\.prototype/);
  assert.match(actScript, /dispatchEvent/);
  assert.match(actScript, /scrollIntoView/);
  assert.match(actScript, /217,\s*119,\s*87/);
});

test('LIVE-BROWSER-Red: registerLiveBrowserTools exposes eager LiveBrowser.* tools with smart effect_for', async () => {
  const registry = new ToolRegistry();
  registerLiveBrowserTools(registry, {
    eager: true,
    callDaemon: async () => ({ok: true}),
  });

  for (const name of [
    'LiveBrowser.open',
    'LiveBrowser.read_page',
    'LiveBrowser.act',
    'LiveBrowser.list_tabs',
    'LiveBrowser.screenshot',
    'LiveBrowser.eval',
  ]) {
    const spec = registry.get(name);
    assert.equal(spec.deferred, false, `${name} must be eager`);
  }

  const actSpec = registry.get('LiveBrowser.act');
  assert.equal(typeof actSpec.effect_for, 'function');
  assert.equal(
    actSpec.effect_for!({
      steps: [
        {action: 'fill', ref: 'b1', value: 'hello'},
        {action: 'click', ref: 'b2', description: 'Search button'},
      ],
    }),
    'reversible_write',
  );
  assert.equal(
    actSpec.effect_for!({
      steps: [{action: 'click', selector: 'button.send-email', intent: 'send'}],
    }),
    'external_send',
  );
  assert.equal(
    actSpec.effect_for!({
      steps: [{action: 'click', selector: 'button.delete-post'}],
    }),
    'destructive',
  );
});

test('LIVE-BROWSER-Red: main, preload, studio, and agent_services wire LiveBrowserDaemon & LiveBrowser.*', () => {
  const mainSrc = readRepo('electron/main.ts');
  assert.match(mainSrc, /LiveBrowserDaemon/);
  assert.match(mainSrc, /liveBrowserDaemon\.rpcEnv\(\)/);
  assert.match(mainSrc, /live-browser:open-panel/);

  const preloadSrc = readRepo('electron/preload.ts');
  assert.match(preloadSrc, /live-browser:open-panel/);

  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(studioSrc, /onLiveBrowserOpenPanel/);

  const autopilotTools = initialToolNames({
    workMode: 'code',
    computerUseMode: 'autopilot',
    liveBrowserAvailable: true,
  } as unknown as Parameters<typeof initialToolNames>[0]);
  assert.ok(autopilotTools.includes('LiveBrowser.open'));
  assert.ok(autopilotTools.includes('LiveBrowser.read_page'));
  assert.ok(autopilotTools.includes('LiveBrowser.act'));

  const learnTools = initialToolNames({
    workMode: 'learn',
    liveBrowserAvailable: true,
  } as unknown as Parameters<typeof initialToolNames>[0]);
  assert.equal(
    learnTools.includes('LiveBrowser.act'),
    false,
    'Learn chat must keep lightweight toolset unless Autopilot/live work needs it',
  );
});

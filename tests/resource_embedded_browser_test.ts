import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {BrowserViewRegistry} from '../electron/browser_view_registry';
import {collectionBrowserPartition} from '../electron/collection_browser';

const source = ts.createSourceFile(
  'main.ts',
  readFileSync('electron/main.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function declaration(name: string): string {
  const node = source.statements.find(
    item => ts.isFunctionDeclaration(item) && item.name?.text === name,
  );
  assert.ok(node, `${name} must own the actual embedded browser path`);
  return ts.transpile(node.getText(source), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  });
}

test('web navigation uses MP WebContentsView and reuses its live page instead of opening external ego', async () => {
  const loads: string[] = [];
  const registry = new BrowserViewRegistry<unknown>();
  let creations = 0;
  const open = runInNewContext(
    `${declaration('openDashboardBrowser')}; openDashboardBrowser`,
    {
      dashboardBrowserRegistry: registry,
      dashboardBrowserBounds: null,
      browserResourceKey: (_root: string, _path: string, url: string) =>
        'browser:' + url,
      createDashboardBrowserView: () => {
        creations++;
        let current = '';
        return {
          setBounds() {},
          webContents: {
            loadURL: async (url: string) => {
              loads.push(url);
              current = url;
            },
            getURL: () => current,
            isDestroyed: () => false,
          },
        };
      },
      normalizedBrowserBounds: (bounds: unknown) => bounds,
      setDashboardBrowserVisibility() {},
      emitBrowserViewState() {},
    },
  );
  const first = await open('https://example.com/session', {
    bounds: {x: 20, y: 80, width: 900, height: 600},
  });
  const second = await open('https://example.com/session', {
    bounds: {x: 20, y: 80, width: 900, height: 600},
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(creations, 1);
  assert.deepEqual(loads, ['https://example.com/session']);
});

test('collection account slots own stable distinct persistent sessions', () => {
  const first = collectionBrowserPartition('xiaohongshu-1');
  const second = collectionBrowserPartition('xiaohongshu-2');
  assert.match(first, /^persist:/);
  assert.notEqual(first, second);
  assert.equal(first, collectionBrowserPartition('xiaohongshu-1'));
  assert.notEqual(first, collectionBrowserPartition('x-1'));
  assert.throws(() => collectionBrowserPartition('../invalid'), /Unknown/);
});

test('two imports in the same account cannot navigate over each other', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const capture = runInNewContext(
    `${declaration('captureCollectionPost')}; captureCollectionPost`,
    {
      collectionCaptureQueues: new Map(),
      releaseCollectionWorkerView() {},
      captureCollectionPostPage: async (url: string) => {
        calls.push('start:' + url);
        if (url === 'first') {
          await gate;
        }
        calls.push('end:' + url);
        return {url};
      },
    },
  );
  const first = capture('first', 'xiaohongshu-1');
  const second = capture('second', 'xiaohongshu-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['start:first']);
  release();
  assert.equal((await first).url, 'first');
  assert.equal((await second).url, 'second');
  assert.deepEqual(calls, [
    'start:first',
    'end:first',
    'start:second',
    'end:second',
  ]);
});

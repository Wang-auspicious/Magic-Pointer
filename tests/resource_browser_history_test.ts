import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  ResourceBrowserHistory,
  type HistoryPage,
} from '../electron/resource_browser_history';

const link = (id: string, token = 'first') => ({
  id,
  url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=${token}`,
  title: id,
});
const page = (links: HistoryPage['links'], atEnd = false): HistoryPage => ({
  links,
  atEnd,
  url: 'https://www.xiaohongshu.com/user/profile/self?tab=fav',
  error: '',
  coverage: 'Visible account list',
  position: links.length,
});

test('hourly checks stop at known bookmarks after a complete initial history and retain new notes', async () => {
  let checking = false;
  const retained: string[] = [];
  let pages = 0;
  const history = new ResourceBrowserHistory({
    folder: mkdtempSync(join(tmpdir(), 'mp-history-incremental-')),
    readPage: async (_account, _list, reset) => {
      pages++;
      return checking
        ? reset
          ? page([link('new123'), link('old123')])
          : page([link('old123')])
        : page([link('old123')], true);
    },
    importLink: async (_account, value) => {
      retained.push(value.id);
      return value.id;
    },
  });
  await history.run('xiaohongshu-1', 'saved');
  checking = true;
  pages = 0;
  await history.run('xiaohongshu-1', 'saved', true);
  assert.deepEqual(retained, ['old123', 'new123']);
  assert.equal(history.snapshot()[0].status, 'complete');
  assert.ok(pages <= 3, 'an hourly check does not rescan the entire old list');
});

test('initialization records the actual list order for bookmarks retained before automatic sync existed', async () => {
  const orders: Array<{id: string; index: number}> = [];
  const history = new ResourceBrowserHistory({
    folder: mkdtempSync(join(tmpdir(), 'mp-history-existing-order-')),
    readPage: async () => page([link('first123'), link('last123')], true),
    importLink: async (_account, value) => value.id,
    retainOrder: (id, order) => {
      orders.push({id, index: order.index});
    },
  });
  await history.run('xiaohongshu-1', 'saved');
  await history.run('xiaohongshu-1', 'saved');
  assert.deepEqual(orders, [
    {id: 'first123', index: 0},
    {id: 'last123', index: 1},
  ]);
});

test('history keeps a durable per-account checkpoint and only claims the end when the page proves it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mp-browser-history-'));
  const imported: string[] = [];
  let fail = true;
  const options = {
    folder,
    readPage: async (_account: string, _list: string, reset: boolean) =>
      reset
        ? page([link('abc123'), link('def456')])
        : page([link('abc123', 'new-token'), link('fed789')], true),
    importLink: async (_account: string, value: {id: string}) => {
      if (value.id === 'def456' && fail) {
        throw new Error('disk failure');
      }
      imported.push(value.id);
      return value.id;
    },
  };
  const first = new ResourceBrowserHistory(options);
  await first.run('xiaohongshu-1', 'saved');
  assert.equal(first.snapshot()[0].status, 'error');
  assert.deepEqual(imported, ['abc123']);
  fail = false;
  const reopened = new ResourceBrowserHistory(options);
  await reopened.run('xiaohongshu-1', 'saved');
  const finished = reopened.snapshot()[0];
  assert.equal(finished.status, 'complete');
  assert.equal(finished.retained, 3);
  assert.deepEqual(imported, ['abc123', 'def456', 'fed789']);
  await reopened.run('xiaohongshu-2', 'saved');
  assert.equal(
    reopened.snapshot().find(job => job.account === 'xiaohongshu-2')!.retained,
    3,
  );
  assert.equal(imported.filter(id => id === 'abc123').length, 2);
});

test('an unchanged list pauses instead of claiming all history was collected', async () => {
  const history = new ResourceBrowserHistory({
    folder: mkdtempSync(join(tmpdir(), 'mp-history-stalled-')),
    readPage: async () => page([link('abc123')]),
    importLink: async () => 'resource-id',
  });
  await history.run('xiaohongshu-1', 'liked');
  assert.equal(history.snapshot()[0].status, 'paused');
  assert.match(history.snapshot()[0].coverage, /not.*end|未.*到底/i);
  assert.equal(history.snapshot()[0].retained, 1);
});

test('pause and login gates stop before importing more links', async () => {
  let release!: (value: HistoryPage) => void;
  let imports = 0;
  const history = new ResourceBrowserHistory({
    folder: mkdtempSync(join(tmpdir(), 'mp-history-pause-')),
    readPage: async () =>
      new Promise<HistoryPage>(resolve => {
        release = resolve;
      }),
    importLink: async () => {
      imports++;
      return 'resource';
    },
  });
  const running = history.run('xiaohongshu-1', 'saved');
  history.pause('xiaohongshu-1', 'saved');
  release(page([link('abc123')]));
  await running;
  assert.equal(imports, 0);
  assert.equal(history.snapshot()[0].status, 'paused');
  const gated = new ResourceBrowserHistory({
    folder: mkdtempSync(join(tmpdir(), 'mp-history-auth-')),
    readPage: async () => ({...page([]), error: 'auth_required'}),
    importLink: async () => {
      throw new Error('must not import');
    },
  });
  await gated.run('xiaohongshu-1', 'saved');
  assert.equal(gated.snapshot()[0].status, 'auth_required');
});

test('resume requested while a page read is finishing starts again from the saved checkpoint', async () => {
  let release!: (value: HistoryPage) => void;
  let reads = 0;
  let imported = 0;
  const history = new ResourceBrowserHistory({
    folder: mkdtempSync(join(tmpdir(), 'mp-history-resume-')),
    readPage: async () =>
      ++reads === 1
        ? new Promise<HistoryPage>(resolve => {
            release = resolve;
          })
        : page([link('abc123')], true),
    importLink: async () => {
      imported++;
      return 'resource';
    },
  });
  const first = history.run('xiaohongshu-1', 'saved');
  history.pause('xiaohongshu-1', 'saved');
  const resumed = history.run('xiaohongshu-1', 'saved');
  release(page([link('abc123')]));
  await Promise.all([first, resumed]);
  assert.equal(history.snapshot()[0].status, 'complete');
  assert.equal(imported, 1);
});

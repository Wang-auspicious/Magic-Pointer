import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {XResourceSource} from '../electron/resource_x_source';

test('X import uses only official read endpoints, persists entries, and suspends on rate limits', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mp-x-source-'));
  const secrets = new Map<string, string>();
  const urls: string[] = [];
  const items: string[] = [];
  let limited = false;
  const source = new XResourceSource({
    folder,
    credentials: {
      get: key => secrets.get(key) || null,
      set: (key, value) => {
        secrets.set(key, value);
      },
    },
    fetch: async url => {
      urls.push(url);
      return limited
        ? new Response('', {status: 429})
        : Response.json(
            url.endsWith('/users/me')
              ? {data: {id: '42', username: 'tester'}}
              : {data: [{id: '101', text: 'A UI reference'}], meta: {}},
          );
    },
    add: async input => {
      items.push(input.url);
    },
    delay: async () => {},
  });
  await source.connect('private-user-token');
  source.configure({enabled: true, likes: false, bookmarks: true});
  await source.sync();
  assert.deepEqual(items, ['https://x.com/i/status/101']);
  assert.ok(urls.every(url => url.startsWith('https://api.x.com/2/')));
  assert.equal(source.snapshot().lastCount, 1);
  limited = true;
  await source.sync(true);
  assert.equal(source.snapshot().status, 'rate_limited');
  assert.ok(source.snapshot().nextRunAt > Date.now());
  assert.ok(!JSON.stringify(source.snapshot()).includes('private-user-token'));
});

test('account connection owns the source operation until its request settles', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let requests = 0;
  const source = new XResourceSource({
    folder: mkdtempSync(join(tmpdir(), 'mp-x-connect-')),
    credentials: {get: () => null, set: () => {}},
    fetch: async () => {
      requests++;
      await gate;
      return Response.json({data: {id: '42', username: 'tester'}});
    },
    add: async () => {},
  });
  const first = source.connect('test-token');
  const second = source.connect('other-test-token');
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(requests, 1);
  await source.connect('test-token');
  assert.equal(requests, 2, 'settling the connection releases the operation');
});

test('an empty source selection is not reported as a successful check', async () => {
  const source = new XResourceSource({
    folder: mkdtempSync(join(tmpdir(), 'mp-x-no-lists-')),
    credentials: {get: () => 'test-token', set: () => {}},
    fetch: async () => Response.json({data: {id: '42', username: 'tester'}}),
    add: async () => {},
  });
  await source.connect('test-token');
  source.configure({likes: false, bookmarks: false});
  await assert.rejects(source.sync(true), /Choose.*(likes|bookmarks)/i);
  assert.equal(source.snapshot().lastSuccess, 0);
  assert.throws(
    () => source.configure({enabled: true}),
    /Choose.*(likes|bookmarks)/i,
  );
  source.configure({enabled: true, bookmarks: true});
  assert.throws(
    () => source.configure({bookmarks: false}),
    /Choose.*(likes|bookmarks)/i,
  );
});

test('switching accounts clears the previous account check history', async () => {
  let accountId = '42';
  const source = new XResourceSource({
    folder: mkdtempSync(join(tmpdir(), 'mp-x-account-history-')),
    credentials: {get: () => 'test-token', set: () => {}},
    fetch: async url =>
      Response.json(
        url.endsWith('/users/me')
          ? {data: {id: accountId, username: 'tester'}}
          : {data: [], meta: {}},
      ),
    add: async () => {},
  });
  await source.connect('test-token');
  await source.sync(true);
  const lastSuccess = source.snapshot().lastSuccess;
  assert.ok(lastSuccess > 0);
  await source.connect('test-token');
  assert.equal(source.snapshot().lastSuccess, lastSuccess);
  accountId = '43';
  await source.connect('other-token');
  assert.equal(source.snapshot().lastSuccess, 0);
  assert.equal(source.snapshot().lastAttempt, 0);
});

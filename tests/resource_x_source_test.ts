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

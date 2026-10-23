import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceBookmarkSync} from '../electron/resource_bookmark_sync';

test('sign-in imports history once, checks hourly, and survives restart without duplicating a check', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mp-bookmark-sync-'));
  let now = 100000;
  const calls: string[] = [];
  const options = {
    folder,
    now: () => now,
    readAccount: async (account: string) =>
      account.endsWith('1') ? {id: 'owner', name: 'My account'} : null,
    sync: async (account: string) => {
      calls.push(account);
    },
  };
  const sync = new ResourceBookmarkSync(options);
  await sync.check();
  assert.deepEqual(calls, ['xiaohongshu-1']);
  assert.equal(sync.snapshot()[0].nextCheckAt, now + 3600000);
  await sync.check();
  assert.equal(calls.length, 1);
  now += 3600000;
  await new ResourceBookmarkSync(options).check();
  assert.equal(calls.length, 2);
  sync.configure('xiaohongshu-1', false);
  now += 3600000;
  await new ResourceBookmarkSync(options).check();
  assert.equal(calls.length, 2, 'user pause survives restart');
});

test('a login observed in the embedded browser starts synchronization without another import button', async () => {
  const calls: string[] = [];
  const sync = new ResourceBookmarkSync({
    folder: mkdtempSync(join(tmpdir(), 'mp-bookmark-login-')),
    readAccount: async () => null,
    sync: async account => {
      calls.push(account);
    },
  });
  await sync.observe('xiaohongshu-2', {id: 'second', name: 'Second'});
  assert.deepEqual(calls, ['xiaohongshu-2']);
  await sync.observe('xiaohongshu-2', {id: 'second', name: 'Second'});
  assert.equal(calls.length, 1);
});

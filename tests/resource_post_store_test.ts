import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourcePostStore} from '../electron/resource_post_store';
import type {ResourcePost} from '../electron/resource_post';

const post: ResourcePost = {
  platform: 'xiaohongshu',
  id: 'abc123',
  url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=access',
  title: 'A retained reference',
  text: 'Full original text',
  author: {name: 'Author'},
  capturedAt: 1,
  media: [
    {kind: 'image', url: 'https://cdn.example/first.png'},
    {kind: 'video', url: 'https://cdn.example/clip.mp4'},
  ],
  links: [],
  coverage: 'Full note; no comments',
  usedBackend: 'fixture.page',
  timingMs: 8,
};

test('post capture survives reopening with original media and retries only missing assets', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mp-post-store-'));
  const requests: string[] = [];
  let fail = true;
  const fetchAsset = async (url: string) => {
    requests.push(url);
    if (url.endsWith('.mp4') && fail) {
      return new Response('Unavailable', {status: 503});
    }
    return new Response(
      Buffer.from(url.endsWith('.png') ? [137, 80, 78, 71] : [0, 0, 0, 24]),
      {
        headers: {
          'content-type': url.endsWith('.png') ? 'image/png' : 'video/mp4',
        },
      },
    );
  };
  const store = new ResourcePostStore(folder, fetchAsset);
  const first = await store.save('resource-1', structuredClone(post));
  assert.match(first.post.media[1].error!, /503/);
  assert.ok(first.post.media[0].localPath);
  const reopened = new ResourcePostStore(folder, fetchAsset);
  const retained = reopened.read(first.path);
  assert.equal(retained.text, post.text);
  assert.equal(retained.author.name, 'Author');
  assert.deepEqual(
    readFileSync(join(folder, retained.media[0].localPath!)),
    Buffer.from([137, 80, 78, 71]),
  );
  fail = false;
  const second = await reopened.save('resource-1', retained);
  assert.ok(second.post.media.every(asset => asset.localPath && !asset.error));
  assert.equal(requests.filter(url => url.endsWith('.png')).length, 1);
  assert.equal(requests.filter(url => url.endsWith('.mp4')).length, 2);
  assert.match(
    readFileSync(join(folder, second.textPath), 'utf8'),
    /Full original text/,
  );
});

test('an HTTP 200 login page is not retained as an image', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mp-post-login-'));
  const store = new ResourcePostStore(
    folder,
    async () =>
      new Response('<html>Sign in</html>', {
        headers: {'content-type': 'text/html'},
      }),
  );
  const saved = await store.save('resource-2', {
    ...structuredClone(post),
    media: [post.media[0]],
  });
  assert.equal(saved.post.media[0].localPath, undefined);
  assert.match(saved.post.media[0].error!, /media|content/i);
  assert.equal(saved.post.text, post.text);
});

test('the source manifest is registered before a media download can be interrupted', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mp-post-interruption-'));
  let registered = '';
  const store = new ResourcePostStore(folder, async () => {
    assert.ok(
      registered,
      'the resource must already point to its durable original',
    );
    assert.equal(store.read(registered).text, post.text);
    return new Response('', {status: 503});
  });
  await store.save('resource-3', structuredClone(post), saved => {
    registered = saved.path;
  });
  assert.ok(registered);
});

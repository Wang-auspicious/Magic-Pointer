import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSharedLinks,
  parseXhsPage,
  parseXPost,
} from '../electron/resource_post';

test('share text preserves access parameters and separates multiple source links', () => {
  const input =
    '这篇值得看看 https://www.xiaohongshu.com/explore/abc123?xsec_token=abc_DEF%3D&xsec_source=pc_feed ，第二个 https://x.com/zaynhao/status/123456 。';
  assert.deepEqual(parseSharedLinks(input), [
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=abc_DEF%3D&xsec_source=pc_feed',
    'https://x.com/zaynhao/status/123456',
  ]);
  assert.deepEqual(parseSharedLinks('想法，没有链接'), []);
});

test('XHS capture retains full text, author, ordered images and observed video URL without executing scripts', () => {
  const note = {
    noteId: 'abc123',
    title: '侧栏交互',
    desc: '第一行\n第二行 undefined 也要原样保留',
    time: 1760000000000,
    user: {nickname: '设计者', userId: 'author42'},
    imageList: [
      {
        urlDefault: 'https://sns-webpic-qc.xhscdn.com/first.webp',
        width: 1200,
        height: 1600,
      },
      {urlDefault: 'https://sns-webpic-qc.xhscdn.com/second.webp'},
    ],
    video: {
      media: {
        stream: {
          h264: [
            {
              masterUrl: 'https://sns-video-bd.xhscdn.com/video.mp4',
              width: 1920,
              height: 1080,
            },
          ],
        },
      },
    },
  };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({note: {noteDetailMap: {abc123: {note}}}}).replace('"time":1760000000000', '"optional":undefined,"time":1760000000000')}; throw new Error('must not execute')</script>`;
  const post = parseXhsPage(
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=keep',
    html,
  );
  assert.equal(post.id, 'abc123');
  assert.equal(post.text, note.desc);
  assert.equal(post.author.name, '设计者');
  assert.deepEqual(
    post.media.map(item => item.url),
    [
      note.imageList[0].urlDefault,
      note.imageList[1].urlDefault,
      'https://sns-video-bd.xhscdn.com/video.mp4',
    ],
  );
  assert.equal(post.media[2].kind, 'video');
  assert.match(post.url, /xsec_token=keep/);
  assert.equal(post.publishedAt, 1760000000000);
});

test('a login or verification page cannot be saved as a complete social post', () => {
  assert.throws(
    () =>
      parseXhsPage(
        'https://www.xiaohongshu.com/explore/abc123',
        '<html>请登录后查看</html>',
      ),
    /auth_required/,
  );
  assert.throws(
    () =>
      parseXhsPage(
        'https://www.xiaohongshu.com/explore/abc123',
        '<html>安全验证 验证码</html>',
      ),
    /verification_required/,
  );
  assert.throws(
    () =>
      parseXhsPage(
        'https://www.xiaohongshu.com/explore/abc123',
        '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"other":{"note":{"noteId":"other","desc":"wrong post"}}}}}</script>',
      ),
    /post_unavailable/,
  );
});

test('XHS search and profile share links keep the requested note identity', () => {
  const html =
    '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123":{"note":{"noteId":"abc123","desc":"原始正文"}}}}}</script>';
  for (const path of [
    '/search_result/abc123',
    '/user/profile/author/abc123',
    '/note/abc123',
  ]) {
    assert.equal(
      parseXhsPage(
        'https://www.xiaohongshu.com' + path + '?xsec_token=keep',
        html,
      ).text,
      '原始正文',
    );
  }
});

test('X metadata preserves a long post and all attachments rather than a thumbnail-only summary', () => {
  const text = '完整正文。'.repeat(300);
  const post = parseXPost('https://x.com/author/status/123456', {
    id: '123456',
    description: text,
    uploader: 'Original author',
    uploader_id: 'author',
    timestamp: 1760000000,
    entries: [
      {
        id: 'v1',
        url: 'https://video.twimg.com/reference.mp4',
        ext: 'mp4',
        thumbnail: 'https://pbs.twimg.com/preview.jpg',
      },
    ],
  });
  assert.equal(post.text, text);
  assert.equal(post.author.name, 'Original author');
  assert.equal(post.publishedAt, 1760000000000);
  assert.equal(post.media[0].url, 'https://video.twimg.com/reference.mp4');
  assert.equal(post.media[0].kind, 'video');
});

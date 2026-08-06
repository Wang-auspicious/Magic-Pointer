'use strict';

// 收藏箱的 IO 层。纯逻辑在 stash_store_test.js 里钉过了，这里只钉接线：
// 谁触发采集、写什么后缀、以及——最要紧的——什么时候绝不能碰剪贴板。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStashRuntime } = require('../electron/stash_runtime');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stash-'));

// ---- 假的 Electron 剪贴板 ----
function fakeImage(seed, w = 800, h = 600) {
  const bitmap = Buffer.alloc(16 * 16 * 4, seed);
  return {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: () => ({ toBitmap: () => bitmap }),
    toBitmap: () => bitmap,
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, seed]),
  };
}

function makeClipboard() {
  const state = { formats: [], image: null, text: '', writes: [] };
  return {
    state,
    availableFormats: () => state.formats.slice(),
    readImage: () => state.image || { isEmpty: () => true },
    readText: () => state.text,
    write: (payload) => {
      state.writes.push(payload);
      if (payload.text !== undefined) state.text = payload.text;
      if (payload.image !== undefined) state.image = payload.image;
    },
    putImage: (img) => { state.formats = ['image/png']; state.image = img; state.text = ''; },
    putText: (t) => { state.formats = ['text/plain']; state.image = null; state.text = t; },
  };
}

function runtimeWith(clipboard, settings) {
  return createStashRuntime({
    clipboard,
    baseDir: dir,
    settings: () => settings,
    focusProbe: async () => ({ app: 'Weixin', windowTitle: '微信', elementName: '' }),
  });
}

// ---------------------------------------------------------------------------
// 位图：落盘 + 回写路径，位图必须一起留着
// ---------------------------------------------------------------------------
(async () => {
  const clip = makeClipboard();
  const rt = runtimeWith(clip, { stash: {} });
  clip.putImage(fakeImage(7));

  const entry = await rt.ingest(clip.readImage(), 'shot');
  assert.ok(entry, '剪贴板里有位图就应当收下来');
  assert.strictEqual(entry.media, 'image');
  assert.match(entry.relPath, /\.png$/);
  assert.strictEqual(entry.app, 'Weixin', '来源必须来自前台探针，不能空着');
  assert.ok(fs.existsSync(path.join(dir, entry.relPath)), '文件要真的落在盘上');

  assert.strictEqual(clip.state.writes.length, 1, '位图采集之后要回写一次剪贴板');
  const written = clip.state.writes[0];
  assert.ok(written.text.includes(entry.relPath.split('/').pop()), '回写的是本地路径');
  assert.ok(written.image, '位图必须一起留着，否则图片编辑器里粘不出图');

  // ---------------------------------------------------------------------------
  // 文本：默认不收
  // ---------------------------------------------------------------------------
  const clip2 = makeClipboard();
  const rt2 = runtimeWith(clip2, { stash: {} });
  clip2.putText('这一段讲的是怎么把渐变做出方向感，值得收着');
  rt2.start();
  await new Promise((r) => setTimeout(r, 900));
  rt2.stop();
  assert.strictEqual(clip2.state.writes.length, 0, '文本采集默认关，不该有任何动作');

  // ---------------------------------------------------------------------------
  // 文本：打开之后收，但绝不回写剪贴板
  // ---------------------------------------------------------------------------
  const clip3 = makeClipboard();
  const rt3 = runtimeWith(clip3, { stash: { text: true } });
  const note = await rt3.ingestText('这一段讲的是怎么把渐变做出方向感，值得收着');
  assert.ok(note, '打开之后应当收下来');
  assert.strictEqual(note.media, 'text');
  assert.match(note.relPath, /\.txt$/, '文本发 .png 会得到一个打不开的文件');
  assert.strictEqual(
    fs.readFileSync(path.join(dir, note.relPath), 'utf8'),
    '这一段讲的是怎么把渐变做出方向感，值得收着',
  );
  assert.strictEqual(
    clip3.state.writes.length, 0,
    '对文本回写会盖掉用户刚复制的内容，毁掉他接下来的 Ctrl+V',
  );

  // 密码不落盘
  assert.strictEqual(await rt3.ingestText('password: hunter2hunter2'), null);
  // 同一段文字再来一次 → 指纹相同，直接退
  assert.strictEqual(await rt3.ingestText('这一段讲的是怎么把渐变做出方向感，值得收着'), null);

  // ---------------------------------------------------------------------------
  // 回写的那条路径，下一轮不能被当成一段新文字收进来
  // ---------------------------------------------------------------------------
  const clip4 = makeClipboard();
  const rt4 = runtimeWith(clip4, { stash: { text: true } });
  clip4.putImage(fakeImage(11));
  const shot = await rt4.ingest(clip4.readImage(), 'shot');
  const backPath = path.join(dir, shot.relPath);
  assert.strictEqual(
    await rt4.ingestText(backPath), null,
    '我们自己写回去的路径不能再收一遍，否则每张截图都会多出一条文本条目',
  );

  // ---------------------------------------------------------------------------
  // tick：位图优先。回写之后剪贴板里图和文本同时在，先看图才不会收错
  // ---------------------------------------------------------------------------
  const clip5 = makeClipboard();
  const rt5 = runtimeWith(clip5, { stash: { text: true } });
  clip5.state.formats = ['image/png', 'text/plain'];
  clip5.state.image = fakeImage(23);
  clip5.state.text = '某个之前留在剪贴板里的路径 C:\\x\\y.png';
  rt5.start();
  await new Promise((r) => setTimeout(r, 900));
  rt5.stop();
  const media = rt5.list().flatMap((b) => b.items).map((e) => e.media);
  assert.ok(media.includes('image'), '同时有图和文本时应当收图');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('stash runtime test ok');
})().catch((error) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

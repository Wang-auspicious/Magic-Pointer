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
  const rt = runtimeWith(clip, { stash: { clipboard: true } });
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

  const explicitClip = makeClipboard();
  const explicitRuntime = runtimeWith(explicitClip, { stash: {} });
  explicitClip.putImage(fakeImage(8));
  const explicitEntry = await explicitRuntime.ingest(explicitClip.readImage(), 'shot');
  assert.ok(explicitEntry, 'explicit ingest works even when continuous monitoring is disabled');
  assert.strictEqual(explicitClip.state.writes.length, 0, 'disabled monitoring does not write back to clipboard');

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
  const rt4 = runtimeWith(clip4, { stash: { clipboard: true, text: true } });
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
  const rt5 = runtimeWith(clip5, { stash: { clipboard: true, text: true } });
  clip5.state.formats = ['image/png', 'text/plain'];
  clip5.state.image = fakeImage(23);
  clip5.state.text = '某个之前留在剪贴板里的路径 C:\\x\\y.png';
  rt5.start();
  await new Promise((r) => setTimeout(r, 900));
  rt5.stop();
  const media = rt5.list().flatMap((b) => b.items).map((e) => e.media);
  assert.ok(media.includes('image'), '同时有图和文本时应当收图');

  // ---------------------------------------------------------------------------
  // 图片采集关掉后，轮询不能继续偷收图片；文本开关仍可独立工作
  // ---------------------------------------------------------------------------
  const clip6 = makeClipboard();
  const rt6 = runtimeWith(clip6, { stash: { clipboard: false, text: true } });
  const beforeDisabledImage = rt6.list().flatMap((b) => b.items).length;
  rt6.start();
  await new Promise((r) => setTimeout(r, 100));
  clip6.putImage(fakeImage(31));
  await new Promise((r) => setTimeout(r, 900));
  rt6.stop();
  const afterDisabledImage = rt6.list().flatMap((b) => b.items).length;
  assert.strictEqual(afterDisabledImage, beforeDisabledImage, '关闭图片收藏后轮询不能再落盘图片');

  const clip7 = makeClipboard();
  const rt7 = runtimeWith(clip7, { stash: {} });
  const beforeOptIn = rt7.list().flatMap((b) => b.items).length;
  rt7.start();
  clip7.putImage(fakeImage(37));
  await new Promise((r) => setTimeout(r, 900));
  rt7.stop();
  assert.strictEqual(
    rt7.list().flatMap((b) => b.items).length,
    beforeOptIn,
    'missing clipboard settings must not silently enable continuous collection',
  );

  // ---------------------------------------------------------------------------
  // 显式收藏：监控关闭时仍可加笔记/文件，并可搜索、改分类、打开来源、删除。
  // 显式操作本身绝不能偷偷启动剪贴板轮询。
  // ---------------------------------------------------------------------------
  const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stash-explicit-'));
  const explicitClip2 = makeClipboard();
  const explicit = createStashRuntime({
    clipboard: explicitClip2,
    baseDir: explicitDir,
    settings: () => ({ stash: { clipboard: false, text: false } }),
  });
  const addedNote = await explicit.addText({
    text: '报价以 PDF 里的含税总额为准',
    sourceId: 'source:quote-message',
    locator: { kind: 'message', value: { messageId: 'm-42' } },
    summary: '报价口径',
    userCategory: '报价',
    sourceTimeMs: 1_770_000_000_000,
  });
  assert.ok(addedNote);
  assert.strictEqual(explicit.running(), false, '显式收藏不能启动持续轮询');
  assert.strictEqual(addedNote.userCategory, '报价');
  assert.strictEqual(addedNote.sourceId, 'source:quote-message');

  const originalFile = path.join(explicitDir, '..', `报价-${Date.now()}.pdf`);
  fs.writeFileSync(originalFile, Buffer.from('%PDF-real-source'));
  const addedFile = await explicit.addFile(originalFile, {
    summary: '供应商报价附件',
    userCategory: '附件',
    sourceId: 'source:quote-pdf',
    locator: { kind: 'pdf-region', value: { page: 2 } },
    sourceTimeMs: 1_770_000_010_000,
  });
  assert.ok(addedFile);
  assert.strictEqual(addedFile.originalArtifactPath, originalFile);
  assert.ok(fs.existsSync(path.join(explicitDir, addedFile.relPath)), '收藏副本必须可打开');

  const found = explicit.search('报价', { limit: 10 });
  assert.deepStrictEqual(new Set(found.map((entry) => entry.id)), new Set([addedNote.id, addedFile.id]));
  assert.strictEqual(explicit.get(addedNote.id).summary, '报价口径');
  assert.strictEqual(explicit.updateCategory(addedNote.id, '合同').userCategory, '合同');
  assert.strictEqual(explicit.search('', { category: '合同' })[0].id, addedNote.id);

  const storedCopy = path.join(explicitDir, addedFile.relPath);
  const removed = explicit.remove(addedFile.id);
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(explicit.get(addedFile.id), null);
  assert.strictEqual(fs.existsSync(storedCopy), false, '删除收藏要删除派生副本');
  assert.strictEqual(fs.existsSync(originalFile), true, '删除收藏绝不能删除权威原文件');
  fs.rmSync(originalFile, { force: true });
  fs.rmSync(explicitDir, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('stash runtime test ok');
})().catch((error) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

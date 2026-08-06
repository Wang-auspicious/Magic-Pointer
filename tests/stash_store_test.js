'use strict';

const assert = require('node:assert');
const stash = require('../electron/stash_store');

// ---- 指纹：同图同指纹，改一个像素就变 ----
const bmA = { width: 800, height: 600, samples: [1, 2, 3, 4] };
const bmB = { width: 800, height: 600, samples: [1, 2, 3, 5] };
assert.strictEqual(stash.fingerprint(bmA), stash.fingerprint({ ...bmA }));
assert.notStrictEqual(stash.fingerprint(bmA), stash.fingerprint(bmB));
assert.notStrictEqual(stash.fingerprint(bmA), stash.fingerprint({ ...bmA, width: 801 }));
assert.strictEqual(stash.fingerprint(null), null);

// ---- 归类：结构化线索优先于内容形态 ----
assert.strictEqual(stash.classify({ app: 'Alipay', text: '订单号 8842-1109 ¥348' }), '凭证');
assert.strictEqual(stash.classify({ app: 'chrome.exe', text: '到期 2027-03-11' }), '凭证');
assert.strictEqual(stash.classify({ app: 'WindowsTerminal.exe', text: 'ls -la' }), '交接');
assert.strictEqual(stash.classify({ app: 'chrome.exe', text: 'Traceback (most recent call last)' }), '交接');
assert.strictEqual(stash.classify({ app: 'chrome.exe', text: '' }), '素材');
assert.strictEqual(stash.classify({ app: 'chrome.exe', text: '短' }), '素材');
assert.strictEqual(stash.classify({ app: 'chrome.exe', text: '这一段讲的是怎么把渐变做出方向感' }), '灵感');
assert.strictEqual(stash.classify({ app: 'chrome.exe', kind: 'clip' }), '片段');
// 凭证判据必须压过终端来源，否则终端里贴的收据会被误归交接
assert.strictEqual(stash.classify({ app: 'WindowsTerminal.exe', text: '发票 ¥1,240' }), '凭证');

// ---- 描述：UIA 元素名优先，长了要截断 ----
assert.strictEqual(stash.describe({ elementName: '导出为 PDF', text: '别用这个' }), '导出为 PDF');
assert.strictEqual(stash.describe({ windowTitle: '2026Q3.xlsx' }), '2026Q3.xlsx');
assert.strictEqual(stash.describe({ app: 'Figma' }), '来自 Figma 的一张图');
const long = stash.describe({ text: 'x'.repeat(80) });
assert.ok(long.length <= 40 && long.endsWith('…'), '过长描述必须截断并加省略号');

// ---- 成簇：同来源 + 窗口内 = 同簇 ----
const t0 = 1_770_000_000_000;
const prev = { burstId: 'b1', app: 'chrome.exe', capturedAt: t0 };
assert.strictEqual(stash.assignBurst(prev, { app: 'chrome.exe', capturedAt: t0 + 30_000 }).burstId, 'b1');
assert.strictEqual(stash.assignBurst(prev, { app: 'chrome.exe', capturedAt: t0 + 30_000 }).isNew, false);
// 换了来源就断簇，哪怕时间很近
assert.strictEqual(stash.assignBurst(prev, { app: 'Excel.exe', capturedAt: t0 + 1_000 }).isNew, true);
// 超出窗口也断簇
assert.strictEqual(stash.assignBurst(prev, { app: 'chrome.exe', capturedAt: t0 + 200_000 }).isNew, true);
// 第一条永远起新簇
assert.strictEqual(stash.assignBurst(null, { app: 'x', capturedAt: t0 }).isNew, true);

// ---- 去重：同指纹且在窗口内 ----
assert.ok(stash.shouldDedupe({ fingerprint: 'f1', capturedAt: t0 }, { fingerprint: 'f1', capturedAt: t0 + 2000 }));
assert.ok(!stash.shouldDedupe({ fingerprint: 'f1', capturedAt: t0 }, { fingerprint: 'f1', capturedAt: t0 + 9000 }),
  '超过去重窗口的同图应当重新收，用户可能是刻意再截一次');
assert.ok(!stash.shouldDedupe({ fingerprint: 'f1', capturedAt: t0 }, { fingerprint: 'f2', capturedAt: t0 + 100 }));
assert.ok(!stash.shouldDedupe(null, { fingerprint: 'f1', capturedAt: t0 }));

// ---- 落点：按月分目录，文件名可排序 ----
const rel = stash.relativePath({ capturedAt: new Date(2026, 7, 6, 14, 22, 9).getTime(), fingerprint: '800x600-abcdef' });
assert.match(rel, /^2026-08\/0806-142209-[a-z0-9]{1,6}\.png$/, `落点格式不对：${rel}`);
assert.match(
  stash.relativePath({ capturedAt: t0, fingerprint: 'x-yy', kind: 'clip' }),
  /\.gif$/,
  '片段落成 gif',
);
// 文本发 .png 会得到一个打不开的文件
assert.match(
  stash.relativePath({ capturedAt: t0, fingerprint: 't12-abc', kind: 'text' }),
  /\.txt$/,
  '文本必须落成 txt',
);
assert.match(
  stash.relativePath({ capturedAt: t0, fingerprint: 't12-abc', media: 'text' }),
  /\.txt$/,
  'media 与 kind 两种写法都要认',
);

// ---- 文本指纹 ----
assert.strictEqual(stash.textFingerprint('同一段话'), stash.textFingerprint('同一段话'));
assert.notStrictEqual(stash.textFingerprint('同一段话'), stash.textFingerprint('同一段化'));
assert.strictEqual(stash.textFingerprint(''), null);
assert.match(stash.textFingerprint('abcd'), /^t4-/, '指纹前缀带长度，不同长度永不相撞');

// ---- 来源应用：外壳进程不算来源 ----
// 按下 Win+Shift+S 的那一瞬间前台是截图工具，照抄就会把每张截图都记成它
assert.ok(stash.isTransientShell('ScreenClippingHost'));
assert.ok(stash.isTransientShell('SnippingTool.exe'));
assert.ok(stash.isTransientShell('Magic Pointer'));
assert.ok(stash.isTransientShell(''), '拿不到就是拿不到，不能当成一个来源');
assert.ok(!stash.isTransientShell('Weixin'));
assert.ok(!stash.isTransientShell('WindowsTerminal'));

// ---- 归类要认得住不带 .exe 的进程名 ----
// 前台探针给的是进程名。原来写 `code\.exe`，真实输入永远匹配不上
assert.strictEqual(stash.classify({ app: 'Code', text: '普通的一段说明文字在这里' }), '交接');
assert.strictEqual(stash.classify({ app: 'WindowsTerminal', text: '普通的一段说明文字在这里' }), '交接');
assert.strictEqual(stash.classify({ app: 'Weixin', text: '这一段讲的是怎么把渐变做出方向感' }), '灵感');

// ---- 文本准入：不是每一次 Ctrl+C 都该被收进来 ----
assert.ok(stash.shouldStashText('这一段讲的是怎么把渐变做出方向感').ok);
assert.strictEqual(stash.shouldStashText('').reason, 'empty');
assert.strictEqual(stash.shouldStashText('短短几个字').reason, 'too_short');
// 密码管理器里复制出来的那一次，绝不能落盘
assert.strictEqual(stash.shouldStashText('password: hunter2hunter2').reason, 'secret');
assert.strictEqual(stash.shouldStashText('sk-abcdefghijklmnopqrstuvwxyz012345').reason, 'secret');
assert.strictEqual(stash.shouldStashText('ghp_abcdefghijklmnopqrstuvwxyz0123').reason, 'secret');
assert.strictEqual(stash.shouldStashText('验证码：884211').reason, 'secret');
assert.strictEqual(
  stash.shouldStashText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==').reason,
  'secret',
);
// 一次性 token：复制它是为了立刻粘贴，不是为了收藏
assert.strictEqual(stash.shouldStashText('a1b2c3d4e5f6g7h8').reason, 'one_shot_token');
// 我们自己回写的那条路径，不能再当成新采集收一遍
assert.strictEqual(
  stash.shouldStashText('C:\\stash\\2026-08\\x.png', { ownPaths: ['C:\\stash\\2026-08\\x.png'] }).reason,
  'own_writeback',
);
assert.strictEqual(
  stash.shouldStashText('"C:\\Magic Pointer\\x.png"', { ownPaths: ['C:\\Magic Pointer\\x.png'] }).reason,
  'own_writeback',
  '带引号的回写形式也要认出来',
);

// ---- 回写只对位图成立 ----
assert.ok(stash.writeBackAllowed('image'));
assert.ok(stash.writeBackAllowed('clip'));
assert.ok(!stash.writeBackAllowed('text'), '对文本回写会毁掉用户刚复制的内容');

// ---- 端到端：一条文本采集 ----
const note = stash.buildEntry(
  { capturedAt: t0, kind: 'text', app: 'Chrome', text: '这一段讲的是怎么把渐变做出方向感' },
  null,
);
assert.strictEqual(note.skipped, false);
assert.strictEqual(note.entry.media, 'text');
assert.strictEqual(note.entry.kind, '灵感');
assert.match(note.entry.relPath, /\.txt$/);
assert.strictEqual(note.entry.width, 0, '文本没有尺寸，别编一个出来');
// 同一段文字紧接着再复制一次 → 跳过
const noteDup = stash.buildEntry(
  { capturedAt: t0 + 1200, kind: 'text', app: 'Chrome', text: '这一段讲的是怎么把渐变做出方向感' },
  note.entry,
);
assert.strictEqual(noteDup.skipped, true);

// ---- 端到端：一条采集 ----
const first = stash.buildEntry(
  { capturedAt: t0, app: 'chrome.exe', elementName: '进度条拆成五段', text: '看这个通知卡的做法', bitmap: bmA },
  null,
);
assert.strictEqual(first.skipped, false);
assert.strictEqual(first.entry.kind, '灵感');
assert.strictEqual(first.entry.desc, '进度条拆成五段');
assert.strictEqual(first.entry.burstIsNew, true);
assert.strictEqual(first.entry.width, 800);

// 紧接着同一张图 → 跳过
const dup = stash.buildEntry({ capturedAt: t0 + 1500, app: 'chrome.exe', bitmap: bmA }, first.entry);
assert.strictEqual(dup.skipped, true);
assert.strictEqual(dup.reason, 'duplicate');

// 换一张图、同来源、窗口内 → 进同一簇
const second = stash.buildEntry({ capturedAt: t0 + 20_000, app: 'chrome.exe', bitmap: bmB }, first.entry);
assert.strictEqual(second.skipped, false);
assert.strictEqual(second.entry.burstId, first.entry.burstId);
assert.strictEqual(second.entry.burstIsNew, false);

// ---- 剪贴板回写：路径 + 保留图片 ----
const plain = stash.clipboardPayload('C:\\Users\\a\\stash\\2026-08\\x.png');
assert.strictEqual(plain.text, 'C:\\Users\\a\\stash\\2026-08\\x.png');
assert.strictEqual(plain.keepImage, true, '必须同时保留位图，否则图片编辑器里粘不出图');
const spaced = stash.clipboardPayload('C:\\Magic Pointer\\stash\\x.png');
assert.strictEqual(spaced.text, '"C:\\Magic Pointer\\stash\\x.png"', '带空格的路径要加引号，终端里才能直接用');

// ---- 折成簇 ----
const bursts = stash.groupIntoBursts([first.entry, second.entry]);
assert.strictEqual(bursts.length, 1);
assert.strictEqual(bursts[0].items.length, 2);
assert.strictEqual(bursts[0].app, 'chrome.exe');

console.log('stash store test ok');

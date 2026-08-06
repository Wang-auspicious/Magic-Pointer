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

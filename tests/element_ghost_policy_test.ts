import assert from 'node:assert';
const { buildElementGhosts } = require('../electron/element_ghost_policy');

const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };

const handles = [
  { ref: 'A#copy-btn', role: 'Button', name: '复制', rect: [100, 200, 48, 32] },
  { ref: 'LNK-hide', role: 'Hyperlink', name: 'hide', rect: [300, 220, 30, 16] },
  // 太小 → 丢弃
  { ref: 'TXT-dot', role: 'Text', name: '·', rect: [500, 220, 2, 2] },
  // 在别的显示器 → 丢弃
  { ref: 'LNK-far', role: 'Hyperlink', name: 'far', rect: [4000, 220, 60, 16] },
];

const result = buildElementGhosts({ handles, displayBounds: display.bounds, scaleFactor: display.scaleFactor });

assert.strictEqual(result.holdMs, 1000, 'ghost must hold about one second before fading');
assert.strictEqual(result.fadeMs, 600);
assert.strictEqual(result.ghosts.length, 2, 'tiny and off-display rects must be dropped');

const first = result.ghosts[0];
assert.strictEqual(first.ref, 'A#copy-btn');
assert.strictEqual(first.label, '复制');
assert.deepStrictEqual(first.rect, { x: 50, y: 100, width: 24, height: 16 },
  'physical px must map to display-local DIP');
assert.strictEqual(result.ghosts[1].delayMs, 45, 'stagger matches the proof-band rhythm');

// 封顶：再多也只画 18 个（屏幕回放不需要全量）
const many = Array.from({ length: 40 }, (_, i) => ({
  ref: `TXT-${i}`, role: 'Text', name: `行${i}`, rect: [10, i * 40, 200, 30],
}));
const capped = buildElementGhosts({ handles: many, displayBounds: display.bounds, scaleFactor: 1 });
assert.strictEqual(capped.ghosts.length, 18);

// 无句柄 → 空回放（自绘应用不造假框）
const empty = buildElementGhosts({ handles: [], displayBounds: display.bounds, scaleFactor: 1 });
assert.strictEqual(empty.ghosts.length, 0);

// 整窗容器（RootWebArea 之类）不回放——全屏罩子没有信息量。
{
  const huge = [{ ref: 'A#RootWebArea', role: 'Document', name: 'page', rect: [0, 0, 3120, 1984] }];
  const result = buildElementGhosts({ handles: huge, displayBounds: display.bounds, scaleFactor: 2 });
  assert.strictEqual(result.ghosts.length, 0, 'a near-fullscreen container must not become a ghost');
}

console.log('element ghost policy test ok');

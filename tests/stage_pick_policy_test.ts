'use strict';

// 点选高亮：指到哪，整块亮起来。
//
// 三件事必须成立，否则这个效果看起来就是坏的：
//   1. 嵌套时选最小的那一块（帖子里有段落，段落里有链接）
//   2. 不能把整个窗口当成"一个元素"亮起来
//   3. 在同一个元素里移动鼠标时不能重画，否则动画反复重启 = 闪
const assert = require('assert');
const {
  MIN_PICK_EDGE_PX,
  isSameTarget,
  pickTarget,
} = require('../electron/stage_pick_policy');

const WINDOW = { x: 0, y: 0, width: 1000, height: 800 };

// 嵌套：取最小的那个包含点的矩形。
{
  const rectangles = [
    { x: 100, y: 100, width: 600, height: 400, label: '帖子' },
    { x: 120, y: 140, width: 400, height: 120, label: '正文段落' },
    { x: 130, y: 150, width: 90, height: 24, label: '链接' },
  ];
  assert.strictEqual(pickTarget({ rectangles, x: 160, y: 160, windowRect: WINDOW }).label, '链接');
  assert.strictEqual(pickTarget({ rectangles, x: 400, y: 200, windowRect: WINDOW }).label, '正文段落');
  assert.strictEqual(pickTarget({ rectangles, x: 650, y: 450, windowRect: WINDOW }).label, '帖子');
}

// 整窗口大小的矩形不算元素：把整个窗口框起来等于什么都没说。
{
  const rectangles = [
    { x: 0, y: 0, width: 1000, height: 800, label: '根面板' },
    { x: 200, y: 200, width: 300, height: 100, label: '卡片' },
  ];
  assert.strictEqual(pickTarget({ rectangles, x: 250, y: 250, windowRect: WINDOW }).label, '卡片');
  // 指在只有根面板覆盖的位置 → 没有可用目标，而不是退回整窗口。
  assert.strictEqual(pickTarget({ rectangles, x: 900, y: 700, windowRect: WINDOW }), null);
}

// 太小的矩形不是瞄准目标：给 4px 的间隔条描边看起来像渲染 bug。
{
  const rectangles = [
    { x: 100, y: 100, width: 4, height: 4, label: '间隔' },
    { x: 90, y: 90, width: 200, height: 60, label: '真正的行' },
  ];
  assert.strictEqual(pickTarget({ rectangles, x: 101, y: 101, windowRect: WINDOW }).label, '真正的行');
  const tiny = [{ x: 100, y: 100, width: MIN_PICK_EDGE_PX - 1, height: 40 }];
  assert.strictEqual(pickTarget({ rectangles: tiny, x: 102, y: 110, windowRect: WINDOW }), null);
}

// 同一元素内移动不算换目标——否则动画反复重启，看起来就是闪。
{
  const rectangles = [{ x: 100, y: 100, width: 300, height: 80, label: '一行' }];
  const first = pickTarget({ rectangles, x: 120, y: 120, windowRect: WINDOW });
  const second = pickTarget({ rectangles, x: 380, y: 170, windowRect: WINDOW });
  assert(isSameTarget(first, second), '在同一个元素里移动被判成了换目标');

  const other = pickTarget({
    rectangles: [{ x: 100, y: 300, width: 300, height: 80 }],
    x: 120,
    y: 320,
    windowRect: WINDOW,
  });
  assert(!isSameTarget(first, other));
  assert(!isSameTarget(first, null));
  assert(isSameTarget(null, null));
}

// 边界容差：正好压在边上不该闪。
{
  const rectangles = [{ x: 100, y: 100, width: 200, height: 50, label: '行' }];
  assert(pickTarget({ rectangles, x: 100, y: 100, windowRect: WINDOW }));
  assert(pickTarget({ rectangles, x: 300, y: 150, windowRect: WINDOW }));
  assert.strictEqual(pickTarget({ rectangles, x: 320, y: 150, windowRect: WINDOW }), null);
}

// 没有窗口尺寸时仍然可用（不能因为缺一个可选参数就整个失效）。
{
  const rectangles = [{ x: 10, y: 10, width: 100, height: 40, label: '行' }];
  assert.strictEqual(pickTarget({ rectangles, x: 20, y: 20 }).label, '行');
}

// 畸形输入返回 null，而不是造一个假矩形。
{
  assert.strictEqual(pickTarget(null), null);
  assert.strictEqual(pickTarget({}), null);
  assert.strictEqual(pickTarget({ rectangles: [], x: 1, y: 1 }), null);
  assert.strictEqual(pickTarget({ rectangles: [{ x: NaN, y: 0, width: 50, height: 50 }], x: 1, y: 1 }), null);
  assert.strictEqual(pickTarget({ rectangles: [{ x: 0, y: 0, width: 50, height: 50 }], x: NaN, y: 1 }), null);
}

console.log('stage_pick_policy_test: all assertions passed');

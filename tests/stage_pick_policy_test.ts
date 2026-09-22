'use strict';

const assert = require('assert');
const {
  MIN_PICK_EDGE_PX,
  isSameTarget,
  pickTarget,
} = require('../electron/stage_pick_policy');

const WINDOW = { x: 0, y: 0, width: 1000, height: 800 };

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

{
  const rectangles = [
    { x: 0, y: 0, width: 1000, height: 800, label: '根面板' },
    { x: 200, y: 200, width: 300, height: 100, label: '卡片' },
  ];
  assert.strictEqual(pickTarget({ rectangles, x: 250, y: 250, windowRect: WINDOW }).label, '卡片');
  assert.strictEqual(pickTarget({ rectangles, x: 900, y: 700, windowRect: WINDOW }), null);
}

{
  const rectangles = [
    { x: 100, y: 100, width: 4, height: 4, label: '间隔' },
    { x: 90, y: 90, width: 200, height: 60, label: '真正的行' },
  ];
  assert.strictEqual(pickTarget({ rectangles, x: 101, y: 101, windowRect: WINDOW }).label, '真正的行');
  const tiny = [{ x: 100, y: 100, width: MIN_PICK_EDGE_PX - 1, height: 40 }];
  assert.strictEqual(pickTarget({ rectangles: tiny, x: 102, y: 110, windowRect: WINDOW }), null);
}

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

{
  const rectangles = [{ x: 100, y: 100, width: 200, height: 50, label: '行' }];
  assert(pickTarget({ rectangles, x: 100, y: 100, windowRect: WINDOW }));
  assert(pickTarget({ rectangles, x: 300, y: 150, windowRect: WINDOW }));
  assert.strictEqual(pickTarget({ rectangles, x: 320, y: 150, windowRect: WINDOW }), null);
}

{
  const rectangles = [{ x: 10, y: 10, width: 100, height: 40, label: '行' }];
  assert.strictEqual(pickTarget({ rectangles, x: 20, y: 20 }).label, '行');
}

{
  assert.strictEqual(pickTarget(null), null);
  assert.strictEqual(pickTarget({}), null);
  assert.strictEqual(pickTarget({ rectangles: [], x: 1, y: 1 }), null);
  assert.strictEqual(pickTarget({ rectangles: [{ x: NaN, y: 0, width: 50, height: 50 }], x: 1, y: 1 }), null);
  assert.strictEqual(pickTarget({ rectangles: [{ x: 0, y: 0, width: 50, height: 50 }], x: NaN, y: 1 }), null);
}

console.log('stage_pick_policy_test: all assertions passed');

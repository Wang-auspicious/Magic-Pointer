const assert = require('assert');
const {
  computeInlineRailWidth,
  computePanelPlacement,
  intersectionArea,
  normalizeNativeSelectionRectangles,
} = require('../electron/panel_position');

function assertInside(bounds, workArea) {
  assert(bounds.x >= workArea.x);
  assert(bounds.y >= workArea.y);
  assert(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert(bounds.y + bounds.height <= workArea.y + workArea.height);
}

function assertAvoids(bounds, rectangles) {
  rectangles.forEach((rect) => {
    assert.strictEqual(intersectionArea(bounds, rect), 0);
  });
}

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const panelSize = { width: 420, height: 188 };
assert.strictEqual(typeof computeInlineRailWidth, 'function');
assert.strictEqual(computeInlineRailWidth(''), 88);
assert.strictEqual(computeInlineRailWidth('Add this'), 132);
assert.strictEqual(computeInlineRailWidth('把这个加入右侧的购物清单'), 236);
assert.strictEqual(computeInlineRailWidth('x'.repeat(100)), 360);

const inlineRailSize = { width: computeInlineRailWidth('Add this'), height: 44 };

const centeredRects = [
  { x: 900, y: 500, width: 180, height: 40 },
];
const centered = computePanelPlacement({
  workArea,
  panelSize,
  cursor: { x: 1060, y: 530 },
  selectionRects: centeredRects,
});
assertInside(centered.bounds, workArea);
assertAvoids(centered.bounds, centeredRects);

const centeredRail = computePanelPlacement({
  workArea,
  panelSize: inlineRailSize,
  cursor: { x: 1060, y: 530 },
  selectionRects: centeredRects,
});
assertInside(centeredRail.bounds, workArea);
assertAvoids(centeredRail.bounds, centeredRects);
assert.strictEqual(centeredRail.bounds.height, 44);
assert.strictEqual(centeredRail.bounds.width, 132);

const rightEdgeRects = [
  { x: 1760, y: 500, width: 120, height: 36 },
];
const rightEdge = computePanelPlacement({
  workArea,
  panelSize,
  cursor: { x: 1860, y: 520 },
  selectionRects: rightEdgeRects,
});
assertInside(rightEdge.bounds, workArea);
assertAvoids(rightEdge.bounds, rightEdgeRects);

const bottomEdgeRects = [
  { x: 900, y: 990, width: 180, height: 32 },
];
const bottomEdge = computePanelPlacement({
  workArea,
  panelSize,
  cursor: { x: 1040, y: 1005 },
  selectionRects: bottomEdgeRects,
});
assertInside(bottomEdge.bounds, workArea);
assertAvoids(bottomEdge.bounds, bottomEdgeRects);
assert(bottomEdge.bounds.y < bottomEdgeRects[0].y);

const negativeWorkArea = { x: -1920, y: 0, width: 1920, height: 1040 };
const negativeRects = [
  { x: -1800, y: 300, width: 220, height: 44 },
];
const negativeDisplay = computePanelPlacement({
  workArea: negativeWorkArea,
  panelSize,
  cursor: { x: -1600, y: 330 },
  selectionRects: negativeRects,
});
assertInside(negativeDisplay.bounds, negativeWorkArea);
assertAvoids(negativeDisplay.bounds, negativeRects);

const multiLineRects = [
  { x: 100, y: 100, width: 300, height: 24 },
  { x: 100, y: 128, width: 240, height: 24 },
  { x: 100, y: 156, width: 180, height: 24 },
];
const multiLine = computePanelPlacement({
  workArea,
  panelSize,
  cursor: { x: 278, y: 174 },
  selectionRects: multiLineRects,
});
assertInside(multiLine.bounds, workArea);
assertAvoids(multiLine.bounds, multiLineRects);

const resized = computePanelPlacement({
  workArea,
  panelSize: { width: 420, height: 380 },
  cursor: { x: 278, y: 174 },
  selectionRects: multiLineRects,
  preferredMode: multiLine.mode,
});
assertInside(resized.bounds, workArea);
assertAvoids(resized.bounds, multiLineRects);

const cursorFallback = computePanelPlacement({
  workArea,
  panelSize,
  cursor: { x: 400, y: 300 },
  selectionRects: [],
});
assertInside(cursorFallback.bounds, workArea);
assert(cursorFallback.distanceToCursor <= 42);

const converted = normalizeNativeSelectionRectangles(
  [
    [-2880, 150, 600, 60],
    [0, 0, 0, 40],
    ['bad', 1, 2, 3],
  ],
  (rect) => ({
    x: rect.x / 1.5,
    y: rect.y / 1.5,
    width: rect.width / 1.5,
    height: rect.height / 1.5,
  }),
);
assert.deepStrictEqual(converted, [
  { x: -1920, y: 100, width: 400, height: 40 },
]);

console.log('panel position test ok');

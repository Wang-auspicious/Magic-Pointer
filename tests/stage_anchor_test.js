const assert = require('assert');
const { choosePointerAnchor, chooseTargetInlineAnchor } = require('../electron/stage_anchor');

assert.deepStrictEqual(
  choosePointerAnchor({ x: 500, y: 400 }, { width: 200, height: 44 }, { width: 1200, height: 800 }),
  { x: 518, y: 338, quadrant: 'top-right' },
);
assert.deepStrictEqual(
  choosePointerAnchor({ x: 1180, y: 790 }, { width: 200, height: 44 }, { width: 1200, height: 800 }),
  { x: 962, y: 728, quadrant: 'top-left' },
);
assert.deepStrictEqual(
  choosePointerAnchor({ x: 4, y: 6 }, { width: 200, height: 44 }, { width: 1200, height: 800 }),
  { x: 22, y: 24, quadrant: 'bottom-right' },
);
assert.deepStrictEqual(
  choosePointerAnchor({ x: 100, y: 100 }, { width: 9999, height: 9999 }, { width: 500, height: 400 }),
  { x: 12, y: 12, quadrant: 'bottom-right' },
);

assert.deepStrictEqual(
  chooseTargetInlineAnchor(
    { x: 100, y: 200, width: 300, height: 54 },
    { width: 144, height: 40 },
    { width: 1200, height: 800 },
  ),
  { x: 418, y: 207, quadrant: 'inline-right' },
  'a resolved text-line capsule must share the line center',
);
assert.deepStrictEqual(
  chooseTargetInlineAnchor(
    { x: 920, y: 200, width: 250, height: 54 },
    { width: 144, height: 40 },
    { width: 1200, height: 800 },
  ),
  { x: 758, y: 207, quadrant: 'inline-left' },
  'the capsule must flip inline before it falls off the right edge',
);

console.log('stage anchor test ok');

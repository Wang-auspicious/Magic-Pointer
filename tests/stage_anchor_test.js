const assert = require('assert');
const { choosePointerAnchor } = require('../electron/stage_anchor');

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

console.log('stage anchor test ok');

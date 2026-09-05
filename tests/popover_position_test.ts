const assert = require('node:assert');
const { placePopover } = require('../electron/renderer/popover_position');

assert.deepStrictEqual(placePopover(
  { left: 900, right: 980, top: 700, bottom: 728 },
  { width: 280, height: 260 },
  { width: 1024, height: 768 },
), { left: 700, top: 436 });

assert.deepStrictEqual(placePopover(
  { left: 4, right: 44, top: 300, bottom: 328 },
  { width: 280, height: 120 },
  { width: 1024, height: 768 },
), { left: 12, top: 176 });

assert.deepStrictEqual(placePopover(
  { left: 400, right: 460, top: 70, bottom: 98 },
  { width: 220, height: 180 },
  { width: 800, height: 500 },
), { left: 240, top: 102 });

console.log('popover placement contract ok');

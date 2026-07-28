const assert = require('assert');
const { MouseActivationDetector } = require('../electron/mouse_activation');

const x1 = new MouseActivationDetector();
assert.strictEqual(x1.push({ t: 0, buttons: 0, mode: 'xbutton1' }), null);
assert.strictEqual(x1.push({ t: 10, buttons: 8, mode: 'xbutton1' }), 'mouse-button-xbutton1');
assert.strictEqual(x1.push({ t: 20, buttons: 8, mode: 'xbutton1' }), null);
assert.strictEqual(x1.push({ t: 30, buttons: 0, mode: 'xbutton1' }), null);
assert.strictEqual(x1.push({ t: 40, buttons: 8, mode: 'xbutton1' }), 'mouse-button-xbutton1');

const x2 = new MouseActivationDetector();
assert.strictEqual(x2.push({ t: 10, buttons: 16, mode: 'xbutton2' }), 'mouse-button-xbutton2');

const middle = new MouseActivationDetector({ middleHoldMs: 450 });
assert.strictEqual(middle.push({ t: 0, buttons: 4, mode: 'middle_hold' }), null);
assert.strictEqual(middle.push({ t: 449, buttons: 4, mode: 'middle_hold' }), null);
assert.strictEqual(middle.push({ t: 450, buttons: 4, mode: 'middle_hold' }), 'mouse-button-middle-hold');
assert.strictEqual(middle.push({ t: 900, buttons: 4, mode: 'middle_hold' }), null);
assert.strictEqual(middle.push({ t: 910, buttons: 0, mode: 'middle_hold' }), null);
assert.strictEqual(middle.push({ t: 920, buttons: 4, mode: 'middle_hold' }), null);
assert.strictEqual(middle.push({ t: 1370, buttons: 4, mode: 'middle_hold' }), 'mouse-button-middle-hold');

const disabled = new MouseActivationDetector();
assert.strictEqual(disabled.push({ t: 0, buttons: 8, mode: 'none' }), null);
assert.strictEqual(disabled.push({ t: 10, buttons: 8, mode: 'xbutton1' }), null);
assert.strictEqual(disabled.push({ t: 20, buttons: 0, mode: 'xbutton1' }), null);
assert.strictEqual(disabled.push({ t: 30, buttons: 8, mode: 'xbutton1' }), 'mouse-button-xbutton1');

console.log('mouse activation test ok');

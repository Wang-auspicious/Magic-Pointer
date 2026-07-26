const assert = require('assert');
const policy = require('../electron/stage_chips_policy');
const {
  shouldShowChips,
  deriveChips,
  commandForChip,
  MAX_CHIPS,
} = policy;

// --- dual-export shape ------------------------------------------------------
assert.strictEqual(typeof shouldShowChips, 'function');
assert.strictEqual(typeof deriveChips, 'function');
assert.strictEqual(MAX_CHIPS, 3);
assert.strictEqual(globalThis.StageChipsPolicy, policy, 'globalThis export mirrors module.exports');
assert.strictEqual(globalThis.StageChipsPolicy.shouldShowChips, shouldShowChips);
assert.strictEqual(globalThis.StageChipsPolicy.deriveChips, deriveChips);
assert.strictEqual(globalThis.StageChipsPolicy.commandForChip, commandForChip);

assert.strictEqual(commandForChip('rewrite'), '改写这段文字');
assert.strictEqual(commandForChip('add-to-calendar'), '添加到日历');
assert.strictEqual(commandForChip('unknown'), null);

// --- deriveChips: objectKind mappings --------------------------------------
assert.deepStrictEqual(deriveChips({ objectKind: 'image' }), [
  { id: 'compare', label: '对比' },
  { id: 'tidy', label: '整理' },
]);

assert.deepStrictEqual(deriveChips({ objectKind: 'text' }), [
  { id: 'rewrite', label: '改写' },
  { id: 'translate', label: '翻译' },
  { id: 'summarize', label: '摘要' },
]);

assert.deepStrictEqual(deriveChips({ objectKind: 'date' }), [
  { id: 'add-to-calendar', label: '加入日历' },
]);

// Unknown kinds never guess.
assert.deepStrictEqual(deriveChips({ objectKind: 'window' }), []);
assert.deepStrictEqual(deriveChips({ objectKind: '' }), []);
assert.deepStrictEqual(deriveChips({ objectKind: null }), []);
assert.deepStrictEqual(deriveChips({}), []);
assert.deepStrictEqual(deriveChips(null), []);
assert.deepStrictEqual(deriveChips(undefined), []);
assert.deepStrictEqual(deriveChips('text'), []);

// <=3 cap holds for every mapping.
for (const kind of ['image', 'text', 'date']) {
  const chips = deriveChips({ objectKind: kind });
  assert.ok(chips.length <= 3, `${kind} yields at most 3 chips`);
  for (const chip of chips) {
    assert.strictEqual(typeof chip.id, 'string');
    assert.strictEqual(typeof chip.label, 'string');
    assert.ok(chip.label.length > 0);
  }
}

// Returned arrays are fresh copies, not shared mutable state.
const a = deriveChips({ objectKind: 'image' });
const b = deriveChips({ objectKind: 'image' });
assert.notStrictEqual(a, b);
a[0].label = 'mutated';
assert.strictEqual(deriveChips({ objectKind: 'image' })[0].label, '对比');

// --- shouldShowChips: visibility gating ------------------------------------
// Click-selected + non-voice + empty capsule -> visible.
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: 'text', capsuleText: '' }), true);
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: null, capsuleText: '' }), true);
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: 'text', capsuleText: '   ' }), true, 'whitespace-only counts as empty');
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: 'text' }), true, 'absent capsuleText means nothing typed yet');

// First keystroke hides chips.
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: 'text', capsuleText: '翻' }), false);
// Speech hides chips.
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: 'voice', capsuleText: '' }), false);
// Non-click selection never shows chips.
assert.strictEqual(shouldShowChips({ selectionSource: 'drag', inputMode: 'text', capsuleText: '' }), false);
assert.strictEqual(shouldShowChips({ selectionSource: 'voice-wake', inputMode: 'text', capsuleText: '' }), false);
assert.strictEqual(shouldShowChips({ selectionSource: null, inputMode: 'text', capsuleText: '' }), false);
assert.strictEqual(shouldShowChips({ inputMode: 'text', capsuleText: '' }), false);

// Garbage input is defensively false.
assert.strictEqual(shouldShowChips(), false);
assert.strictEqual(shouldShowChips(null), false);
assert.strictEqual(shouldShowChips('click'), false);
assert.strictEqual(shouldShowChips(42), false);
assert.strictEqual(shouldShowChips({}), false);
assert.strictEqual(shouldShowChips({ selectionSource: 'click', inputMode: 'text', capsuleText: 123 }), false, 'non-string capsuleText is malformed');

console.log('stage_chips_policy_test: all assertions passed');

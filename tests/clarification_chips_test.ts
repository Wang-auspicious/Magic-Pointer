const assert = require('assert');
const policy = require('../electron/clarification_chips');
const idlePolicy = require('../electron/stage_chips_policy');
const {
  clarificationChips,
  commandForClarificationChip,
  MAX_CHIPS,
} = policy;
const stageGlobal = globalThis as typeof globalThis & { ClarificationChips: typeof policy };

assert.strictEqual(typeof clarificationChips, 'function');
assert.strictEqual(typeof commandForClarificationChip, 'function');
assert.strictEqual(MAX_CHIPS, 4);
assert.strictEqual(stageGlobal.ClarificationChips, policy);
assert.strictEqual(stageGlobal.ClarificationChips.clarificationChips, clarificationChips);

const awaiting = {
  status: 'awaiting',
  result: {
    awaitingUserInput: true,
    pendingInput: { question: '选哪一个？', options: ['记事本', 'Word'] },
  },
};

assert.deepStrictEqual(clarificationChips(awaiting), [
  { id: 'clarify-0', label: '记事本', command: '记事本' },
  { id: 'clarify-1', label: 'Word', command: 'Word' },
]);
assert.strictEqual(
  clarificationChips(awaiting)[0].command,
  '记事本',
  'click submits the option text, not a canned idle command',
);
assert.strictEqual(commandForClarificationChip(clarificationChips(awaiting)[0]), '记事本');
assert.strictEqual(commandForClarificationChip({ id: 'rewrite', label: '改写' }), null);

const colliding = clarificationChips({
  status: 'awaiting',
  result: { pendingInput: { options: ['rewrite', 'translate'] } },
});
assert.strictEqual(colliding[0].command, 'rewrite');
assert.strictEqual(idlePolicy.commandForChip(colliding[0].id), null);
assert.notStrictEqual(idlePolicy.commandForChip('rewrite'), colliding[0].command);

assert.deepStrictEqual(
  clarificationChips({
    status: 'awaiting',
    result: { pendingInput: { options: ['A', 'B', 'C', 'D', 'E'] } },
  }).map((chip: { label: string }) => chip.label),
  ['A', 'B', 'C', 'D'],
  'ask_user_question already caps at 4; the chips follow',
);

assert.deepStrictEqual(clarificationChips({
  status: 'done',
  result: { pendingInput: { options: ['A', 'B'] } },
}), [], 'only awaiting turns render option chips');

assert.deepStrictEqual(clarificationChips({
  status: 'awaiting',
  result: { pendingInput: { options: ['only-one'] } },
}), [], 'a single option is not a choice');

assert.deepStrictEqual(clarificationChips({
  status: 'awaiting',
  result: { pendingInput: { options: ['A'] } },
}), []);

assert.deepStrictEqual(clarificationChips({ status: 'awaiting', result: {} }), []);
assert.deepStrictEqual(clarificationChips({ status: 'awaiting' }), []);
assert.deepStrictEqual(clarificationChips({
  status: 'awaiting',
  result: { pendingInput: { options: [1, null, ''] } },
}), []);
assert.deepStrictEqual(clarificationChips(null), []);
assert.deepStrictEqual(clarificationChips(undefined), []);
assert.deepStrictEqual(clarificationChips('awaiting'), []);

const first = clarificationChips(awaiting);
const second = clarificationChips(awaiting);
assert.notStrictEqual(first, second);
first[0].label = 'mutated';
assert.strictEqual(clarificationChips(awaiting)[0].label, '记事本');

console.log('clarification_chips_test: all assertions passed');

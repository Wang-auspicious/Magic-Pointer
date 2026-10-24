'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const InputHistory = require('../electron/renderer/input_history.ts');

assert.strictEqual(typeof InputHistory.normalizeHistory, 'function');
assert.strictEqual(typeof InputHistory.stepHistory, 'function');
assert.strictEqual(typeof InputHistory.historyLabel, 'function');
assert.strictEqual(typeof InputHistory.historyKeyAction, 'function');

{
  // Empty, whitespace-only and non-string entries are dropped; duplicates
  // keep their LAST occurrence so a prompt resubmitted later recalls once,
  // from its newest position.
  assert.deepStrictEqual(InputHistory.normalizeHistory([]), []);
  assert.deepStrictEqual(
    InputHistory.normalizeHistory(['  ', '', null, undefined]),
    [],
  );
  assert.deepStrictEqual(
    InputHistory.normalizeHistory(['a', ' b ', 'b', 'a', 'c']),
    ['b', 'a', 'c'],
  );
  assert.deepStrictEqual(InputHistory.normalizeHistory([42, ' x ']), [
    '42',
    'x',
  ]);
}

{
  const total = 3;
  // Draft is -1; ArrowUp from draft lands on the newest entry.
  assert.strictEqual(InputHistory.stepHistory(-1, 'older', total), 2);
  // Older walks down to the oldest entry and clamps there.
  assert.strictEqual(InputHistory.stepHistory(2, 'older', total), 1);
  assert.strictEqual(InputHistory.stepHistory(1, 'older', total), 0);
  assert.strictEqual(InputHistory.stepHistory(0, 'older', total), 0);
  // Newer walks up and past the newest back to the draft slot.
  assert.strictEqual(InputHistory.stepHistory(0, 'newer', total), 1);
  assert.strictEqual(InputHistory.stepHistory(2, 'newer', total), -1);
  assert.strictEqual(InputHistory.stepHistory(-1, 'newer', total), -1);
  // Empty history never leaves the draft slot.
  assert.strictEqual(InputHistory.stepHistory(-1, 'older', 0), -1);
  assert.strictEqual(InputHistory.stepHistory(0, 'older', 0), -1);
}

{
  assert.strictEqual(InputHistory.historyLabel(-1, 3), null);
  assert.strictEqual(InputHistory.historyLabel(0, 0), null);
  assert.strictEqual(InputHistory.historyLabel(3, 3), null);
  assert.strictEqual(InputHistory.historyLabel(0, 3), '历史记录 1/3');
  assert.strictEqual(InputHistory.historyLabel(2, 3), '历史记录 3/3');
}

{
  // ArrowUp only recalls when the caret sits at the very start (or the box
  // is empty); ArrowDown only when it sits at the very end. Anywhere else
  // the key must keep moving the caret.
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowUp', '', 0, 0),
    'older',
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowUp', 'abc', 0, 0),
    'older',
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowUp', 'abc', 1, 1),
    null,
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowUp', 'abc', 2, 3),
    null,
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowDown', '', 0, 0),
    'newer',
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowDown', 'abc', 3, 3),
    'newer',
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('ArrowDown', 'abc', 1, 1),
    null,
  );
  assert.strictEqual(
    InputHistory.historyKeyAction('Enter', 'abc', 3, 3),
    null,
  );
}

{
  // Wiring regression guards (same source-assertion style as
  // composer_surface_test): the form keydown drives history through the
  // pure module, the counter chip exists, and submit resets navigation.
  const studioSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'renderer', 'studio.ts'),
    'utf8',
  );
  const studioHtml = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'renderer', 'studio.html'),
    'utf8',
  );
  assert.match(studioSource, /inputHistory\.historyKeyAction\(/);
  assert.match(studioSource, /syncComposerHistoryChip\(\);[\s\S]*?if \(question\) \{\s*\n\s*composerSessionHistory\.push\(question\);/);
  assert.match(studioHtml, /id="composer-history"/);
  assert.match(studioHtml, /input_history\.js/);
}

console.log('input_history_test PASS');

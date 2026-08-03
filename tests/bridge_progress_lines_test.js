'use strict';

const assert = require('assert');
const {
  PROGRESS_PREFIX,
  parseProgressLine,
  createProgressLineSplitter,
} = require('../electron/bridge_progress_lines');

assert.strictEqual(PROGRESS_PREFIX, '@@mp ');

// --- parseProgressLine ---
assert.deepStrictEqual(
  parseProgressLine('@@mp phase=pixels_frozen ms=412 d=90 scope=selection_snapshot w=2950'),
  {
    phase: 'pixels_frozen',
    ms: 412,
    fields: { phase: 'pixels_frozen', ms: '412', d: '90', scope: 'selection_snapshot', w: '2950' },
  },
);

assert.strictEqual(parseProgressLine('ordinary stderr noise'), null, 'plain stderr is not progress');
assert.strictEqual(parseProgressLine('@@mp ms=12'), null, 'a record without a phase is not usable');
assert.strictEqual(parseProgressLine('@@mp '), null);
assert.strictEqual(parseProgressLine(null), null);
assert.strictEqual(
  parseProgressLine('@@mp phase=total ms=notanumber').ms,
  null,
  'a non-numeric ms degrades to null rather than NaN',
);

// --- createProgressLineSplitter ---
{
  const seen = [];
  const feed = createProgressLineSplitter(record => seen.push(record.phase));
  // A record split across two stream chunks must still arrive exactly once.
  feed('@@mp phase=payload_read ms=3 scope=s\n@@mp phase=win');
  assert.deepStrictEqual(seen, ['payload_read'], 'a partial line must not fire early');
  feed('dows_enumerated ms=40 scope=s\n');
  assert.deepStrictEqual(seen, ['payload_read', 'windows_enumerated']);
}

{
  const seen = [];
  const feed = createProgressLineSplitter(record => seen.push(record.phase));
  feed('Traceback (most recent call last):\n  File "x.py"\n@@mp phase=total ms=9 scope=s\r\n');
  assert.deepStrictEqual(seen, ['total'], 'interleaved real stderr must be ignored, CRLF accepted');
}

{
  // A consumer that throws is a caller bug and must not propagate into the
  // bridge's stderr handler, which would kill an in-flight capture.
  const feed = createProgressLineSplitter(() => { throw new Error('consumer exploded'); });
  assert.doesNotThrow(() => feed('@@mp phase=a ms=1 scope=s\n'));
}

{
  // A writer that never emits a newline must not grow the pending buffer without
  // bound; after the cap is passed the buffer resets instead of accumulating.
  const seen = [];
  const feed = createProgressLineSplitter(record => seen.push(record.phase));
  feed('x'.repeat(20000));
  feed('\n@@mp phase=after_flood ms=1 scope=s\n');
  assert.deepStrictEqual(seen, ['after_flood'], 'recovers on the next newline');
}

console.log('bridge_progress_lines_test ok');

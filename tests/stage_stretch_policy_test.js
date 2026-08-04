'use strict';

// The stretch gesture has to be legible and safe: what the hint promises is
// what gets asked for, a twitch does nothing, and a flick cannot demand thirty
// lines of invented detail.

const assert = require('assert');
const {
  MAX_DELTA_LINES,
  MIN_DRAG_PX,
  stretchCommand,
  stretchIntent,
} = require('../electron/stage_stretch_policy');

// Pulling down asks for more, pushing up asks for less.
{
  const down = stretchIntent({ dragPx: 60, currentLines: 3 });
  assert.strictEqual(down.direction, 'expand');
  assert.strictEqual(down.targetLines, 6);
  assert(down.hint.includes('6 行'));
  assert(down.hint.includes('3 行'));

  const up = stretchIntent({ dragPx: -40, currentLines: 8 });
  assert.strictEqual(up.direction, 'condense');
  assert.strictEqual(up.targetLines, 6);
  assert(up.hint.includes('更简洁'));
}

// A twitch is not an instruction — clicking the edge must not fire a rewrite.
{
  for (const dragPx of [0, 3, -5, MIN_DRAG_PX - 1]) {
    const intent = stretchIntent({ dragPx, currentLines: 5 });
    assert.strictEqual(intent.direction, 'none', `${dragPx}px was treated as a drag`);
    assert.strictEqual(stretchCommand(intent), '');
    assert.strictEqual(intent.hint, '');
  }
}

// A flick is capped. 600px is not a request for thirty invented lines.
{
  const intent = stretchIntent({ dragPx: 600, currentLines: 4 });
  assert.strictEqual(intent.deltaLines, MAX_DELTA_LINES);
  assert.strictEqual(intent.targetLines, 4 + MAX_DELTA_LINES);
}

// Never target zero lines: an answer of no lines is not an answer.
{
  const intent = stretchIntent({ dragPx: -600, currentLines: 3 });
  assert.strictEqual(intent.targetLines, 1);
  assert.strictEqual(intent.direction, 'condense');
}

// A drag that rounds back to the current size is a no-op, not a pointless
// round-trip to the model.
{
  const intent = stretchIntent({ dragPx: 13, currentLines: 5 });
  assert.strictEqual(intent.targetLines, 6);
  assert.strictEqual(intent.direction, 'expand');
  const noop = stretchIntent({ dragPx: -600, currentLines: 1 });
  assert.strictEqual(noop.direction, 'none');
}

// The hint and the command must agree, or the gesture lies about what it did.
{
  for (const [dragPx, currentLines] of [[80, 2], [-60, 9], [200, 5]]) {
    const intent = stretchIntent({ dragPx, currentLines });
    const command = stretchCommand(intent);
    assert(command.includes(`${intent.targetLines} 行`), `${command} vs hint ${intent.hint}`);
    assert(intent.hint.includes(`${intent.targetLines} 行`));
    // The command must be one the Python length engine already parses:
    // target_from_command matches 扩写/压缩 to N 行.
    assert(/(扩写|压缩)到 \d+ 行$/.test(command), command);
  }
}

// Malformed input yields a no-op rather than a wild target.
{
  for (const input of [null, {}, { dragPx: NaN, currentLines: 4 }, { dragPx: 50, currentLines: 0 }]) {
    assert.strictEqual(stretchIntent(input).direction, 'none');
  }
  assert.strictEqual(stretchCommand(null), '');
}

console.log('stage_stretch_policy_test: all assertions passed');

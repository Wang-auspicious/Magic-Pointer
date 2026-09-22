'use strict';


const assert = require('assert');
const {
  MAX_DELTA_LINES,
  MIN_DRAG_PX,
  stretchCommand,
  stretchIntent,
} = require('../electron/stage_stretch_policy');

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

{
  for (const dragPx of [0, 3, -5, MIN_DRAG_PX - 1]) {
    const intent = stretchIntent({ dragPx, currentLines: 5 });
    assert.strictEqual(intent.direction, 'none', `${dragPx}px was treated as a drag`);
    assert.strictEqual(stretchCommand(intent), '');
    assert.strictEqual(intent.hint, '');
  }
}

{
  const intent = stretchIntent({ dragPx: 600, currentLines: 4 });
  assert.strictEqual(intent.deltaLines, MAX_DELTA_LINES);
  assert.strictEqual(intent.targetLines, 4 + MAX_DELTA_LINES);
}

{
  const intent = stretchIntent({ dragPx: -600, currentLines: 3 });
  assert.strictEqual(intent.targetLines, 1);
  assert.strictEqual(intent.direction, 'condense');
}

{
  const intent = stretchIntent({ dragPx: 13, currentLines: 5 });
  assert.strictEqual(intent.targetLines, 6);
  assert.strictEqual(intent.direction, 'expand');
  const noop = stretchIntent({ dragPx: -600, currentLines: 1 });
  assert.strictEqual(noop.direction, 'none');
}

{
  for (const [dragPx, currentLines] of [[80, 2], [-60, 9], [200, 5]]) {
    const intent = stretchIntent({ dragPx, currentLines });
    const command = stretchCommand(intent);
    assert(command.includes(`${intent.targetLines} 行`), `${command} vs hint ${intent.hint}`);
    assert(intent.hint.includes(`${intent.targetLines} 行`));
    assert(/(扩写|压缩)到 \d+ 行$/.test(command), command);
  }
}

{
  for (const input of [null, {}, { dragPx: NaN, currentLines: 4 }, { dragPx: 50, currentLines: 0 }]) {
    assert.strictEqual(stretchIntent(input).direction, 'none');
  }
  assert.strictEqual(stretchCommand(null), '');
}

console.log('stage_stretch_policy_test: all assertions passed');

{
  const { stretchCommand, stretchIntent } = require('../electron/stage_stretch_policy');
  const intent = stretchIntent({ dragPx: 60, currentLines: 2 });
  assert.strictEqual(intent.direction, 'expand');

  const answer = stretchCommand(intent, 'answer');
  const selection = stretchCommand(intent, 'selection');
  assert.ok(answer.includes('这个回答'), answer);
  assert.ok(selection.includes('选中的这段'), selection);
  assert.notStrictEqual(answer, selection);

  const lines = /到 (\d+) 行/;
  const answerMatch = lines.exec(answer);
  const selectionMatch = lines.exec(selection);
  if (answerMatch === null || selectionMatch === null) {
    throw new Error(`stretch command did not include a line target: ${answer} / ${selection}`);
  }
  assert.strictEqual(answerMatch[1], selectionMatch[1]);

  assert.strictEqual(stretchCommand(intent), answer);

  const shrink = stretchIntent({ dragPx: -60, currentLines: 8 });
  assert.ok(stretchCommand(shrink, 'selection').includes('压缩'));

  assert.strictEqual(stretchCommand(null, 'selection'), '');
}
console.log('stage_stretch_policy_test: selection-side assertions passed');

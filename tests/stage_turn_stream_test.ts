'use strict';


const assert = require('assert');
const {
  ENTRY_STROKE,
  ENTRY_WORD,
  PHRASE_GAP_MS,
  composedCommand,
  composerChips,
  hasPointingWord,
  keptStrokeIndexes,
  orderedEntries,
  referenceMark,
  removeStrokeReference,
  strokeForWordAt,
  submitReadiness,
  withKeptStrokes,
} = require('../electron/stage_turn_stream');

const word = (text: string, at: number) => ({ kind: ENTRY_WORD, text, at });
const stroke = (strokeIndex: number, at: number, label = '', referenceId = `ref-${strokeIndex}`) => ({
  kind: ENTRY_STROKE,
  strokeIndex,
  at,
  label,
  referenceId,
});

{
  const entries = [word('把', 1000), stroke(0, 1200)];
  assert.strictEqual(composedCommand(entries), '把 ①');
  const chips = composerChips(entries);
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(chips[0].ordinal, 1);
  assert.strictEqual(chips[0].referenceId, 'ref-0');
}

{
  const entries = [word('把', 1000), stroke(0, 1200), word('改成正式的', 1500)];
  assert.strictEqual(composedCommand(entries), '把 ① 改成正式的');
}

{
  const entries = [word('改成正式的', 1500), stroke(0, 1200), word('把', 1000)];
  assert.strictEqual(composedCommand(entries), '把 ① 改成正式的');
  const kinds = orderedEntries(entries).map((entry: { kind: string }) => entry.kind);
  assert.deepStrictEqual(kinds, [ENTRY_WORD, ENTRY_STROKE, ENTRY_WORD]);
}

{
  const entries = [
    word('比较', 1000),
    stroke(0, 1100, '第一段'),
    word('和', 1200),
    stroke(1, 1300, '第二段'),
  ];
  assert.strictEqual(composedCommand(entries), '比较 ① 和 ②');
}

{
  const refs = [
    { strokeIndex: 0, label: '第一段', referenceId: 'ref-a' },
    { strokeIndex: 1, label: '第二段', referenceId: 'ref-b' },
    { strokeIndex: 2, label: '第三段', referenceId: 'ref-c' },
  ];
  const kept = removeStrokeReference(refs, 1);
  assert.deepStrictEqual(keptStrokeIndexes(kept), [0, 2]);
  assert.strictEqual(referenceMark(kept[0].strokeIndex), '①');
  assert.strictEqual(referenceMark(kept[1].strokeIndex), '③');
  assert.deepStrictEqual(kept.map((ref: { referenceId: string }) => ref.referenceId), ['ref-a', 'ref-c']);
  assert.deepStrictEqual(refs.map((ref) => ref.strokeIndex), [0, 1, 2], 'input stays immutable');

  const snapshot = {
    selection_bbox: [10, 20, 300, 80],
    selection_gesture: { strokes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
    untouched: true,
  };
  const narrowed = withKeptStrokes(snapshot, keptStrokeIndexes(kept));
  assert.deepStrictEqual(narrowed.selection_gesture.strokes, [{ id: 'A' }, { id: 'C' }]);
  assert.strictEqual(narrowed.selection_bbox, null, 'combined bbox is invalid after narrowing');
  assert.strictEqual(narrowed.untouched, true);
  assert.strictEqual(snapshot.selection_gesture.strokes.length, 3, 'snapshot stays immutable');
}

{
  const snapshot = {
    selection_gesture: { strokes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] },
    selection_materials: [
      { stroke_index: 0, source_window: { hwnd: 11 }, perception_trace: { readState: 'resolved' } },
      { stroke_index: 1, source_window: { hwnd: 22 }, perception_trace: { readState: 'unread' } },
      { stroke_index: 2, source_window: { hwnd: 33 }, perception_trace: { readState: 'resolved' } },
    ],
    selection_bbox: [0, 0, 10, 10],
  };
  const narrowed = withKeptStrokes(snapshot, [0, 2]);
  assert.deepStrictEqual(
    narrowed.selection_materials.map((material: { source_window: { hwnd: number } }) => material.source_window.hwnd),
    [11, 33],
    'the removed stroke material is gone, the others keep their windows',
  );
  assert.deepStrictEqual(
    narrowed.selection_materials.map((material: { stroke_index: number }) => material.stroke_index),
    [0, 1],
    'materials are addressed by position, so indexes follow the kept order',
  );
  assert.strictEqual(narrowed.selection_materials.length, narrowed.selection_gesture.strokes.length);
  assert.strictEqual(snapshot.selection_materials.length, 3, 'snapshot stays immutable');

  const single = { selection_gesture: { strokes: [{ id: 'A' }] } };
  assert.strictEqual(withKeptStrokes(single, [0]), single);
}

{
  const entries = [stroke(0, 1000), word('这个', 1100), stroke(1, 5000)];
  assert.strictEqual(strokeForWordAt(entries, 1100).strokeIndex, 0);
  assert.strictEqual(strokeForWordAt(entries, 1100).strokeIndex, 0);
  assert.strictEqual(strokeForWordAt(entries, 5200).strokeIndex, 1);
  assert.strictEqual(strokeForWordAt(entries, 500), null);
}

{
  const onlyStroke = submitReadiness({ entries: [stroke(0, 1000)], silenceMs: 9999 });
  assert.strictEqual(onlyStroke.ready, false);
  assert.strictEqual(onlyStroke.reason, 'selection_without_instruction');

  assert.strictEqual(
    submitReadiness({ entries: [stroke(0, 1000)], pressedEnter: true }).ready,
    false,
  );
  assert.strictEqual(submitReadiness({ entries: [] }).reason, 'empty');
}

{
  const entries = [word('把这段改正式', 1000), stroke(0, 1100)];
  assert.strictEqual(submitReadiness({ entries, pressedEnter: true }).ready, true);
  assert.strictEqual(submitReadiness({ entries, silenceMs: PHRASE_GAP_MS }).ready, true);
  const composing = submitReadiness({ entries, silenceMs: 300 });
  assert.strictEqual(composing.ready, false);
  assert.strictEqual(composing.reason, 'still_composing');
}

{
  assert(hasPointingWord('把这段改一下'));
  assert(hasPointingWord('translate this'));
  assert(!hasPointingWord('总结一下要点'));
}

{
  const entries = [word('   ', 1000), word('', 1100), stroke(0, 1200), word('改写', 1300)];
  assert.strictEqual(composedCommand(entries), '① 改写');
}

{
  assert.strictEqual(composedCommand(null), '');
  assert.strictEqual(composedCommand([{ kind: 'stroke' }]), '');
  assert.deepStrictEqual(composerChips(undefined), []);
  assert.strictEqual(strokeForWordAt([stroke(0, 1000)], NaN), null);
}

console.log('stage_turn_stream_test: all assertions passed');

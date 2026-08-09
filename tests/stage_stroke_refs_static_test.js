'use strict';

// Removing a chip must remove the stroke from the request.
//
// The failure mode this guards is specific: chips render, the user drops one,
// the display updates, and the command still carries all three strokes. That
// makes the chip a decoration that lies about what was sent — worse than having
// no chips at all.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

// The whole chain has to exist, or one end silently does nothing.
assert(html.includes('id="capsule-refs"'), 'no chip container in the capsule');
assert(html.includes('stage_turn_stream.js'), 'turn stream policy is not loaded');
assert(js.includes('function renderStrokeRefs('), 'chips are never rendered');
assert(js.includes('const keptStrokeIndexes = strokeRefs.map('), 'kept refs are not read at submit');
assert(js.includes('keptStrokeIndexes,'), 'kept refs never reach the IPC payload');
assert(preload.includes('keptStrokeIndexes: Array.isArray(payload?.keptStrokeIndexes)'), 'preload drops the field');
assert(preload.includes('.slice(0, 12)'), 'preload does not bound the list');
assert(main.includes('function withKeptStrokes('), 'main never narrows the snapshot');
assert(main.includes('withKeptStrokes(session.snapshot, payload?.keptStrokeIndexes)'), 'narrowing is not applied to the request');
assert(css.includes('.capsule-ref'), 'chips have no styling');

// A chip is removable, and says so — a chip you cannot act on is just a badge.
assert(js.includes("chip.title = '点击移除这一处'"));
assert(js.includes('strokeRefs.filter((item) => item !== ref)'));

// The number on the chip must be the number in the command, or the user cannot
// tell which reference is which.
assert(js.includes('marks[index]'), 'chips do not use the shared ordinal marks');
const stream = require('../electron/stage_turn_stream');
assert.strictEqual(stream.ORDINAL_MARKS[0], '①');
assert.strictEqual(stream.composedCommand([
  { kind: 'word', text: '比较', at: 1 },
  { kind: 'stroke', strokeIndex: 0, at: 2 },
  { kind: 'word', text: '和', at: 3 },
  { kind: 'stroke', strokeIndex: 1, at: 4 },
]), '比较 ① 和 ②');

// A re-render must not resurrect a chip the user removed.
assert(
  js.includes('if (session.selectionCount !== strokeRefs.length && session.selectionCount > 1)'),
  'chips are rebuilt unconditionally, so removing one would not stick',
);

// The bare "N 处" badge is redundant once chips exist; showing both is noise.
assert(js.includes('const showCount = session.selectionCount > 1 && strokeRefs.length === 0;'));

// Chips are inside the capsule, which is a drag handle — they must opt out or
// clicking one would move the capsule instead of removing the reference.
assert(js.includes("chip.dataset.noDrag = '1'"));

console.log('stage stroke refs static test ok');

// --- Accent tokens --------------------------------------------------------
// The stage floats over other people's windows, so it keeps its own palette —
// but it must derive every accent from one set of channels. Repeating
// rgba(38, 115, 235, ...) is how a theme setting silently stops working.
{
  assert(css.includes('--stage-accent-rgb: 38, 115, 235;'), 'no accent channels defined');
  assert(!/rgba\(38, 115, 235/.test(css), 'a literal accent colour crept back into stage.css');
  assert(css.includes('rgba(var(--stage-accent-rgb)'), 'alphas are not composed from the channels');
  // The renderer must be able to retint at runtime, or the tokens are decoration.
  assert(js.includes("stageRoot.style.setProperty('--stage-accent-rgb'"), 'accent is never applied');
  assert(main.includes('accentRgb: String(fabricSettings.appearance?.accent_rgb'), 'accent never leaves settings');
  // A settings file must not be able to inject CSS through this field.
  assert(/session\.accentRgb = \/\^/.test(js), 'accent shape is not validated in the renderer');
}
console.log('stage accent token test ok');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { defaultSettings, validate } = require('../electron/settings_store');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const defaults = defaultSettings();
assert.strictEqual(
  defaults.appearance.selection_visual,
  'sweep_band',
  'the Google demo 6 sweep band must be the default selection visual',
);
assert.strictEqual(validate(defaults).appearance.selection_visual, 'sweep_band');
assert.strictEqual(defaults.appearance.sweep_height_ratio, 0.52);
assert.strictEqual(defaults.appearance.sweep_min_height_dip, 10);
assert.strictEqual(defaults.appearance.sweep_max_height_dip, 24);
assert.strictEqual(defaults.appearance.sweep_duration_ms, 292);
assert.strictEqual(defaults.appearance.sweep_fade_ms, 96);
assert.strictEqual(defaults.appearance.capsule_spawn_ms, 80);
assert.strictEqual(defaults.appearance.capsule_expand_ms, 125);
assert.strictEqual(defaults.appearance.capsule_voice_width_dip, 40);
assert.strictEqual(defaults.appearance.capsule_text_width_dip, 144);
assert.strictEqual(defaults.appearance.capsule_max_width_dip, 440);
assert.strictEqual(defaults.appearance.capsule_inline_gap_dip, 18);

const outline = defaultSettings();
outline.appearance.selection_visual = 'outline';
assert.strictEqual(validate(outline).appearance.selection_visual, 'outline');

const unsupported = defaultSettings();
unsupported.appearance.selection_visual = 'neon_box';
assert.throws(() => validate(unsupported), /selection_visual is unsupported/);

const main = read('electron/main.ts');
assert.match(
  main,
  /selectionVisual:\s*selectionVisualForStage\(\)/,
  'main must inject the trusted persisted visual into every stage reveal',
);
assert.match(
  main,
  /visualTuning:\s*stageVisualTuningForStage\(\)/,
  'main must inject only validated Stage tuning values',
);

const stageJs = read('electron/renderer/stage.ts');
const stageCss = read('electron/renderer/stage.css');
assert.match(
  stageJs,
  /stageRoot\.dataset\.selectionVisual\s*=\s*session\.selectionVisual/,
  'Stage must apply the trusted visual mode to its root',
);
assert.match(
  stageJs,
  /stageRoot\.dataset\.targetGeometryKind\s*=\s*session\.targetGeometryKind/,
  'Stage must expose resolved versus pointer-only geometry to CSS',
);
assert.match(
  stageJs,
  /function\s+sweepBandRect\(/,
  'Stage must derive a thin sweep band from the resolved text line',
);
assert.match(
  stageJs,
  /session\.visualTuning\.sweepHeightRatio/,
  'the sweep body must use the persisted ratio',
);
assert.match(
  stageJs,
  /session\.visualTuning\.sweepMaxHeightDip/,
  'the sweep body must stay near one third of the rejected 72 DIP band',
);
assert.match(
  stageCss,
  /\[data-selection-visual='sweep_band'\][\s\S]*?border:\s*none/,
  'the default sweep band must not render a rectangle border',
);
assert.match(
  stageCss,
  /\[data-selection-visual='sweep_band'\][\s\S]*?linear-gradient/,
  'the default sweep band must use a directional gradient',
);
const sweepCss = stageCss.slice(
  stageCss.indexOf(".stage-root[data-selection-visual='sweep_band']"),
  stageCss.indexOf('@keyframes stage-breathe'),
);
assert.doesNotMatch(
  sweepCss,
  /(?:^|\s)(?:filter|box-shadow)\s*:\s*(?!none\b)/m,
  'the sweep compositor must not create rectangular blur/filter layers',
);
assert.match(
  sweepCss,
  /clip-path:\s*inset\(/,
  'the sweep must reveal progressively instead of scaling a finished rectangle',
);
assert.match(
  sweepCss,
  /radial-gradient\(/,
  'all soft sweep edges must be alpha-tapered gradients',
);
assert.match(
  sweepCss,
  /calc\(var\(--stage-sweep-duration\) - var\(--stage-sweep-fade\)\)/,
  'fade must finish inside the sweep duration instead of leaving a ghost strip',
);
const finalCapsuleCss = stageCss.slice(stageCss.lastIndexOf('.stage-capsule {'));
assert.match(
  finalCapsuleCss,
  /box-shadow:\s*none/,
  'the product capsule must not leak a rectangular shadow backing',
);
assert.match(
  stageCss,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?selection-visual/,
  'the sweep animation must have a reduced-motion fallback',
);
assert.match(
  stageJs,
  /if\s*\(session\.targetGeometryKind\s*!==\s*'resolved'\)\s*return null/,
  'unresolved and pointer-only geometry must render no target feedback',
);
assert.match(
  stageJs,
  /function\s+isUsableTargetRect\(/,
  'Stage must reject malformed or off-display target rectangles',
);
assert.match(
  stageJs,
  /anchorCapsuleToTarget\(capsuleWidth\);[\s\S]{0,260}?capsule\.hidden\s*=\s*false/,
  'a capsule must be anchored before it becomes paintable',
);
assert.match(
  stageCss,
  /\[data-target-geometry-kind='pointer_only'\][\s\S]*?display:\s*none/,
  'pointer-only feedback must remain completely invisible',
);
assert.match(main, /transparent:\s*true/, 'Stage must remain a transparent full-display surface');
assert.match(main, /stageWindow\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/,
  'Stage must stay click-through outside real controls');

console.log('selection_visual_contract_test: all assertions passed');

'use strict';

// Pins the composer to the measured PromptRescue geometry.
// Source of the numbers: docs/design/VIDA_PROMPTRESCUE_MEASURED.md
// (1920x1080 frame at t=14.5s; pill 1739x202, radius 64, send circle 101,
//  right gap 32, glyph 38, glyph gap 50, left padding 53).
// Every assertion below is a ratio, because the reference video is a
// zoomed composition: absolute pixels are not comparable across its frames.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const REFERENCE = Object.freeze({
  width: 1739,
  height: 202,
  radius: 64,
  sendDiameter: 101,
  sendRightGap: 32,
  glyph: 38,
  glyphGap: 50,
  textLeftPad: 53,
});

const ratio = (value) => value / REFERENCE.height;
const close = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected.toFixed(4)} +/- ${tolerance}, got ${actual.toFixed(4)}`,
  );
};

// --- 1. Surface size keeps the measured aspect ratio ----------------------
const policySrc = read('electron/stage_surface_policy.ts');
const composerSize = /const COMPOSER_SIZE = Object\.freeze\(\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}\)/
  .exec(policySrc);
assert.ok(composerSize, 'stage_surface_policy must declare COMPOSER_SIZE as a frozen literal');
const composerWidth = Number(composerSize[1]);
const composerHeight = Number(composerSize[2]);

close(
  composerWidth / composerHeight,
  REFERENCE.width / REFERENCE.height,
  0.06,
  'composer aspect ratio (w/h) must match the PromptRescue pill',
);

// --- 2. CSS geometry, expressed against the composer height ---------------
const stageCss = read('electron/renderer/stage.css');
const composerCss = stageCss.slice(
  stageCss.indexOf('.stage-composer {'),
  stageCss.indexOf('.stage-brand {'),
);
assert.ok(composerCss.length > 0, '.stage-composer rule must exist before .stage-brand');

const radiusMatch = /border-radius:\s*(\d+(?:\.\d+)?)px/.exec(composerCss);
assert.ok(radiusMatch, '.stage-composer must declare a pixel border-radius');
close(
  Number(radiusMatch[1]) / composerHeight,
  ratio(REFERENCE.radius),
  0.02,
  'composer corner radius / height',
);

assert.match(
  composerCss,
  /background:\s*#[Ff]9[Ff]8[Ff][Bb]\b/,
  'the composer surface must be the measured #F9F8FB, not pure white',
);

// The pill is a single row: no stacked context/tools rows inside the composer.
assert.doesNotMatch(
  composerCss,
  /flex-direction:\s*column/,
  'the PromptRescue pill is one row; the composer must not stack rows',
);

// --- 3. Send button is a circle at half the composer height ---------------
const sendCss = stageCss.slice(
  stageCss.indexOf('.capsule-send {'),
  stageCss.indexOf('.capsule-send svg'),
);
assert.ok(sendCss.length > 0, '.capsule-send rule must exist');
const sendW = /width:\s*(\d+(?:\.\d+)?)px/.exec(sendCss);
const sendH = /height:\s*(\d+(?:\.\d+)?)px/.exec(sendCss);
assert.ok(sendW && sendH, '.capsule-send must declare an explicit pixel size');
assert.strictEqual(sendW[1], sendH[1], 'the send control must be a true circle');
close(
  Number(sendH[1]) / composerHeight,
  ratio(REFERENCE.sendDiameter),
  0.02,
  'send button diameter / composer height',
);
assert.match(
  sendCss,
  /background:\s*#191919\b/,
  'the send button fill must be the measured #191919',
);

// --- 4. Horizontal rhythm: left padding and right gap --------------------
const paddingMatch = /padding:\s*([^;]+);/.exec(composerCss);
assert.ok(paddingMatch, '.stage-composer must declare padding');
const paddingParts = paddingMatch[1].trim().split(/\s+/).map((p) => Number.parseFloat(p));
// shorthand: "v h" or "t r b l"; the right inset is index 1 either way
const padRight = paddingParts.length >= 2 ? paddingParts[1] : paddingParts[0];
const padLeft = paddingParts.length === 4 ? paddingParts[3] : padRight;
close(padLeft / composerHeight, ratio(REFERENCE.textLeftPad), 0.03, 'left padding / height');
close(padRight / composerHeight, ratio(REFERENCE.sendRightGap), 0.03, 'right padding / height');

// Pill body: reference ink span 61 over a 202 pill; a face whose ink is ~0.93em
// puts the size at 0.302h / 0.93.
// Anchor on the combined rule, not the first selector list that merely mentions
// .capsule-input (the voice/text mode toggles list it too, earlier in the file).
const inputRule = /\.capsule-input,\s*\.capsule-transcript\s*\{([^}]*)\}/s.exec(stageCss);
assert.ok(inputRule, '.capsule-input/.capsule-transcript rule must exist');
const inputSize = Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(inputRule[1])[1]);
close(
  inputSize / composerHeight,
  (61 / REFERENCE.height) / 0.93,
  0.03,
  'pill body font-size / pill height',
);

// --- 5. Approval card: one surface radius token, shared with the pill -----
const threadCss = stageCss.slice(
  stageCss.indexOf('.stage-thread {'),
  stageCss.indexOf('.thread-head {'),
);
assert.ok(threadCss.length > 0, '.stage-thread rule must exist');
const threadRadius = /border-radius:\s*(\d+(?:\.\d+)?)px/.exec(threadCss);
assert.ok(threadRadius, '.stage-thread must declare a pixel border-radius');
assert.strictEqual(
  Number(threadRadius[1]),
  Number(radiusMatch[1]),
  'pill and approval card must share one surface radius token, as in the reference',
);
assert.match(
  threadCss,
  /background:\s*#[Ff]9[Ff]8[Ff][Bb]\b/,
  'the approval card surface must be the measured #F9F8FB',
);

// --- 6. Footer rhythm, measured against the button height ----------------
// Reference (t=22.0s frame): button 208x111 and 250x111, radius 29,
// gap 42, right inset 47, footer band 197.
const BUTTON = Object.freeze({ height: 111, radius: 29, gap: 42, rightInset: 47, band: 197 });

const btnCss = stageCss.slice(
  stageCss.indexOf('.thread-btn {'),
  stageCss.indexOf('.thread-btn:hover'),
);
assert.ok(btnCss.length > 0, '.thread-btn rule must exist');
const btnHeight = Number(/height:\s*(\d+(?:\.\d+)?)px/.exec(btnCss)[1]);
const btnRadius = Number(/border-radius:\s*(\d+(?:\.\d+)?)px/.exec(btnCss)[1]);
close(
  btnRadius / btnHeight,
  BUTTON.radius / BUTTON.height,
  0.03,
  'approve/reject corner radius / button height',
);

const solidCss = stageCss.slice(
  stageCss.indexOf('.thread-btn.is-solid {'),
  stageCss.indexOf('.thread-btn.is-solid:hover'),
);
assert.match(
  solidCss,
  /background:\s*#191919\b/,
  'the solid Approve fill must be the same #191919 as the send control',
);

const consentCss = stageCss.slice(
  stageCss.indexOf('.capsule-consent {'),
  stageCss.indexOf('@keyframes consent-in'),
);
const consentGap = Number(/gap:\s*(\d+(?:\.\d+)?)px/.exec(consentCss)[1]);
close(
  consentGap / btnHeight,
  BUTTON.gap / BUTTON.height,
  0.05,
  'gap between Reject and Approve / button height',
);

const consentPad = /padding:\s*([^;]+);/.exec(consentCss)[1].trim().split(/\s+/).map(Number.parseFloat);
const [barPadTop, barPadRight, barPadBottom] = consentPad;
close(
  barPadRight / btnHeight,
  BUTTON.rightInset / BUTTON.height,
  0.05,
  'right inset of the footer / button height',
);
close(
  (barPadTop + btnHeight + barPadBottom) / btnHeight,
  BUTTON.band / BUTTON.height,
  0.06,
  'footer band height / button height',
);

// --- 7. Process card is portrait, and the body sets tight ----------------
// Reference (t=19.4s frame): card 804x973; body line pitch 38.7 over 29px of
// ascender-to-descender ink; paragraphs separated by one blank line.
const PROCESS = Object.freeze({ width: 804, height: 973, pitch: 38.7, ink: 29 });

const panelSize = /const WORK_PANEL_SIZE = Object\.freeze\(\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}\)/
  .exec(policySrc);
assert.ok(panelSize, 'stage_surface_policy must declare WORK_PANEL_SIZE as a frozen literal');
close(
  Number(panelSize[1]) / Number(panelSize[2]),
  PROCESS.width / PROCESS.height,
  0.02,
  'work panel aspect ratio must match the portrait reference process card',
);

const resultCss = stageCss.slice(
  stageCss.indexOf('.stage-result {'),
  stageCss.indexOf('.stage-result {') + 600,
);
const lineHeight = Number(/line-height:\s*([\d.]+)\s*;/.exec(resultCss)[1]);
// pitch / ink is 1.334; for a face whose ink spans ~0.93em that is ~1.25.
close(
  lineHeight,
  (PROCESS.pitch / PROCESS.ink) * 0.93,
  0.06,
  'card body line-height',
);

// --- 8. Evidence rows wrap; they are not truncated ----------------------
// In the reference each evidence entry is a wrapped 3-line paragraph. The part
// an ellipsis eats is the "-> so do X" half, which is the useful half.
const stepsCss = stageCss.slice(stageCss.indexOf('.stage-result .mcard-steps {'));
assert.match(
  stepsCss,
  /\.stage-result\s+\.mstep-label\s*\{[^}]*white-space:\s*normal/s,
  'stage evidence rows must wrap, not truncate with an ellipsis',
);
// The reference rows carry a green tick and nothing else: no vertical spine.
assert.match(
  stepsCss,
  /\.stage-result \.mcard-steps li:not\(:last-child\)::after \{\s*display:\s*none/,
  'evidence rows in the reference have no connecting spine',
);

// The reference sizes its `TASK FINISHED` eyebrow to match body text. Magic
// Pointer does not draw that eyebrow at all — the transcript already shows the
// evidence stream, the answer, or the failure card — so there is no geometry
// left to match here. What is pinned instead is that it stays out of layout.
const eyebrowCss = stageCss.slice(
  stageCss.indexOf('.thread-eyebrow {'),
  stageCss.indexOf('.thread-title {'),
);
assert.match(
  eyebrowCss,
  /clip-path:\s*inset\(50%\)/,
  'the status node is screen-reader only, not a visible header word',
);

console.log('vida promptrescue geometry test ok');

'use strict';


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

assert.doesNotMatch(
  composerCss,
  /flex-direction:\s*column/,
  'the PromptRescue pill is one row; the composer must not stack rows',
);

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

const paddingMatch = /padding:\s*([^;]+);/.exec(composerCss);
assert.ok(paddingMatch, '.stage-composer must declare padding');
const paddingParts = paddingMatch[1].trim().split(/\s+/).map((p) => Number.parseFloat(p));
const padRight = paddingParts.length >= 2 ? paddingParts[1] : paddingParts[0];
const padLeft = paddingParts.length === 4 ? paddingParts[3] : padRight;
close(padLeft / composerHeight, ratio(REFERENCE.textLeftPad), 0.03, 'left padding / height');
close(padRight / composerHeight, ratio(REFERENCE.sendRightGap), 0.03, 'right padding / height');

const inputRule = /\.capsule-input,\s*\.capsule-transcript\s*\{([^}]*)\}/s.exec(stageCss);
assert.ok(inputRule, '.capsule-input/.capsule-transcript rule must exist');
const inputSize = Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(inputRule[1])[1]);
close(
  inputSize / composerHeight,
  (61 / REFERENCE.height) / 0.93,
  0.03,
  'pill body font-size / pill height',
);

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
close(
  lineHeight,
  (PROCESS.pitch / PROCESS.ink) * 0.93,
  0.06,
  'card body line-height',
);

const stepsCss = stageCss.slice(stageCss.indexOf('.stage-result .mcard-steps {'));
assert.match(
  stepsCss,
  /\.stage-result\s+\.mstep-label\s*\{[^}]*white-space:\s*normal/s,
  'stage evidence rows must wrap, not truncate with an ellipsis',
);
assert.match(
  stepsCss,
  /\.stage-result \.mcard-steps li:not\(:last-child\)::after \{\s*display:\s*none/,
  'evidence rows in the reference have no connecting spine',
);

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

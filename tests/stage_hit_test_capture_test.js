'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/stage.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(source.includes('function hasInteractiveStageSurface()'),
  'mouse capture must be derived from currently visible interactive stage controls');
assert(source.includes('const hasInteractiveSurface ='),
  'syncHitRegions must derive whether the current stage exposes an interactive surface');
assert(/hitPolicy\.shouldCaptureMouse\(\{[\s\S]*?hasInteractiveSurface,[\s\S]*?pointer:\s*lastPointerPoint,[\s\S]*?interactiveRegions,/.test(source),
  'syncHitRegions must ask the hit-test policy with the live pointer and exact interactive regions');
assert(/name === 'capsule-text'.*!capsule\.hidden && !capsuleInput\.disabled/.test(source),
  'the text capsule must keep its input-focus capture contract');
assert(source.includes("querySelector('button:not([disabled])')"),
  'visible result actions must remain mouse-capturable');
assert(source.includes("if (name === 'result') return !resultCard.hidden;"),
  'a visible answer bubble must expose its body as a draggable surface');
assert(source.includes('elements.push(resultCard);'),
  'the native shaped window must include the draggable answer bubble body');
assert(source.includes("if (name === 'hidden' || name === 'dismissing') return false;"),
  'hidden or clearing stage states must release mouse capture before any fade completes');
assert(!source.includes("name === 'capsule-text' || name === 'result' || name === 'error' || chipsVisible"),
  'passive result/error surfaces must not intercept clicks across the transparent stage');
assert(
  main.indexOf('if (requestFocus) stageWindow.focus();')
    < main.indexOf('if (enabled && regions.length)'),
  'keyboard focus for the text capsule must not require full shaped-window mouse capture',
);

console.log('stage_hit_test_capture_test: all assertions passed');

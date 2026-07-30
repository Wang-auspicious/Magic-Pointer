'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const requestActivation = main.slice(
  main.indexOf('function requestActivation('),
  main.indexOf('function cleanupDictationStopFile('),
);
const submitHandler = main.slice(
  main.indexOf("ipcMain.on('stage:submit-selection-command'"),
  main.indexOf("ipcMain.on('stage:context-action'"),
);

assert.match(
  requestActivation,
  /interactionEpisodes\.active\(\)[\s\S]*?armSelectionGesture\(/,
  'a visible capsule in an active episode must continue drawing instead of dismissing the episode',
);
assert.match(
  submitHandler,
  /shouldContinueGestureEpisode[\s\S]*?armSelectionGesture/,
  'partial this/and-this commands must collapse and re-arm the next stroke',
);
assert.match(
  main,
  /GestureTraceV2|schemaVersion:\s*2/,
  'main must send a lossless v2 gesture trace instead of a shape-class semantic point',
);
assert.doesNotMatch(
  main.slice(main.indexOf('function completeSelectionGesture('), main.indexOf('function processPassThroughGestureSample(')),
  /semanticPoint/,
  'completed gesture grounding must not be controlled by a derived single point',
);

console.log('continuous gesture episode contract test ok');

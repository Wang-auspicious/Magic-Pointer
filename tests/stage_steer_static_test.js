'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stage = fs.readFileSync(path.join(root, 'electron/renderer/stage.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron/preload.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');

assert(
  stage.includes('steerSelectionCommand'),
  'processing must enqueue a steer instead of dropping the composer',
);
assert(
  !stage.includes('A turn is already running: SUBMIT is a machine no-op'),
  'a running turn must not make SUBMIT a machine no-op',
);
assert(
  preload.includes('steerSelectionCommand'),
  'the stage bridge must expose steer',
);
assert(
  preload.includes("stage:steer-selection-command"),
  'steer must be a distinct IPC from submit so it cannot start a second loop',
);
assert(
  main.includes("ipcMain.on('stage:steer-selection-command'"),
  'main must handle mid-run steer',
);
assert(
  main.includes('scripts/agent_session_bridge.py'),
  'steer must write the durable inbox the Python loop already claims',
);

console.log('stage steer static test ok');

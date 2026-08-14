const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');

assert(
  main.includes("ipcMain.handle('learning-candidates:request'"),
  'dashboard must expose the candidate review bridge',
);
assert(
  main.includes("'scripts/learning_candidates_bridge.py'"),
  'candidate requests must cross the isolated Python bridge',
);
assert(
  main.includes('isDashboardSender(event)') && main.includes('isCompanionSender(event)'),
  'candidate IPC must authenticate its renderer sender',
);
assert(
  preload.includes('learningCandidates:')
    && preload.includes("'learning-candidates:request'"),
  'preload must expose only the narrow candidate request capability',
);

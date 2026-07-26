const assert = require('assert');
const fs = require('fs');
const { isSurfaceSender } = require('../electron/ipc_surface_policy');

const overlayContents = { id: 11 };
const overlayWindow = {
  isDestroyed: () => false,
  webContents: overlayContents,
};
const resolveWindow = (surface) => surface === 'overlay' ? overlayWindow : null;

assert.strictEqual(isSurfaceSender({ sender: overlayContents }, 'overlay', resolveWindow), true);
assert.strictEqual(isSurfaceSender({ sender: { id: 11 } }, 'overlay', resolveWindow), false);
assert.strictEqual(isSurfaceSender({ sender: overlayContents }, 'panel', resolveWindow), false);
assert.strictEqual(isSurfaceSender(null, 'overlay', resolveWindow), false);

const main = fs.readFileSync('electron/main.js', 'utf8');
assert(main.includes("const { isSurfaceSender } = require('./ipc_surface_policy');"));
assert(main.includes("isSurfaceSender(event, 'overlay', resultTargetWindow)"));
assert(main.includes("isSurfaceSender(event, 'panel', resultTargetWindow)"));
assert(main.includes("isSurfaceSender(event, 'result', resultTargetWindow)"));
assert(main.includes("isSurfaceSender(event, 'reader', resultTargetWindow)"));
assert(main.includes('webContentsId'));
assert(main.includes('entry.surface !== surface'));

console.log('ipc surface policy test ok');

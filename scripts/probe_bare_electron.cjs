'use strict';

// A/B control for the startup paging storm.
//
// `npm run overlay` pins the disk for the first ten seconds of Electron
// startup. This runs the same Electron binary with a main process that opens
// one hidden window and does nothing else, so the storm can be attributed to
// the runtime itself rather than to Magic Pointer's startup work.
const { app, BrowserWindow } = require('electron');

if (process.argv.includes('--isolated')) {
  const os = require('node:os');
  const path = require('node:path');
  const dir = path.join(os.tmpdir(), `bare-electron-${process.pid}`);
  app.setPath('userData', dir);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false });
  win.loadURL('data:text/html,<title>bare</title>');
  setTimeout(() => app.quit(), 40000);
});

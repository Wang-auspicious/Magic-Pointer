'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const windows = [];
class Window {
  constructor() {
    this.shown = false;
    this.sent = [];
    this.webContents = {send: (...args) => this.sent.push(args)};
    windows.push(this);
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  loadFile() {}
  setIgnoreMouseEvents(...args) {
    this.ignore = args;
  }
  showInactive() {
    this.shown = true;
  }
  hide() {
    this.shown = false;
  }
  isDestroyed() {
    return Boolean(this.destroyed);
  }
  isVisible() {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return this.shown;
  }
  destroy() {
    this.destroyed = true;
  }
}
const moduleStub = {exports: {}};
let timers = 0;
const code = ts.transpileModule(
  fs.readFileSync('electron/agent_cursor_window.ts', 'utf8'),
  {
    compilerOptions: {module: ts.ModuleKind.CommonJS, esModuleInterop: true},
  },
).outputText;
vm.runInNewContext(code, {
  module: moduleStub,
  exports: moduleStub.exports,
  __dirname: process.cwd(),
  require: name =>
    name === 'electron'
      ? {BrowserWindow: Window, screen: {}}
      : name === './agent_cursor_policy'
        ? require('../electron/agent_cursor_policy')
        : require(name),
  setTimeout,
  clearTimeout,
  Date,
  setInterval: () => {
    timers++;
    return {unref() {}};
  },
  clearInterval: () => {
    timers--;
  },
});
const surfaces = new moduleStub.exports.AgentCursorSurfaces({
  rendererFile: 'index.html',
});
surfaces.sync([
  {id: 1, bounds: {x: 0, y: 0, width: 1920, height: 1080}, scaleFactor: 1},
]);
surfaces.startSampling();
assert.equal(
  windows[0].shown,
  false,
  'idle agent cursor must not leave a transparent cursor:none window above the desktop',
);
assert.deepEqual(
  windows[0].ignore,
  [true],
  'decorative surface must not forward native mouse moves; sampling already supplies coordinates',
);
assert.equal(timers, 0, 'no agent cursor means no 16ms polling');
surfaces.command({kind: 'approach', id: 'primary', x: 100, y: 200});
assert.equal(windows[0].shown, true);
assert.equal(timers, 1);
surfaces.command({kind: 'clear'});
assert.equal(windows[0].shown, false);
assert.equal(timers, 0);
windows[0].destroy();
assert.equal(
  surfaces.isVisible(),
  false,
  'a destroyed cursor window must not crash the resident visibility timer',
);
assert.doesNotThrow(() => surfaces.startSampling());
assert.equal(timers, 0);
surfaces.command({kind: 'approach', id: 'next', x: 110, y: 210});
assert.equal(
  windows.length,
  2,
  'a later cursor action recreates its destroyed surface',
);
assert.equal(surfaces.isVisible(), true);
surfaces.dispose();
console.log('agent cursor idle lifecycle ok');

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const panel = fs.readFileSync('electron/renderer/panel.js', 'utf8');
const result = fs.readFileSync('electron/renderer/result.js', 'utf8');

assert(fs.existsSync('electron/renderer/reader.html'), 'secondary reader HTML is missing');
assert(fs.existsSync('electron/renderer/reader.css'), 'secondary reader CSS is missing');
assert(fs.existsSync('electron/renderer/reader.js'), 'secondary reader renderer is missing');

const html = fs.readFileSync('electron/renderer/reader.html', 'utf8');
const css = fs.readFileSync('electron/renderer/reader.css', 'utf8');
const reader = fs.readFileSync('electron/renderer/reader.js', 'utf8');

assert(main.includes('function createReaderWindow()'));
assert(main.includes("ipcMain.on('panel:open-secondary'"));
assert(main.includes("ipcMain.on('result:expand'"));
assert(main.includes("resultTargetWindow(target)"));
assert(preload.includes("contextBridge.exposeInMainWorld('magicPointerReader'"));
assert(!panel.includes('window.magicPointerPanel?.openSecondaryResult'));
assert(result.includes('window.magicPointerResult?.expand'));
assert(html.includes('id="secondary-reader"'));
assert(html.includes('id="reader-content"'));
assert(!html.includes('id="command"'));
assert(css.includes('.secondary-reader'));
assert(reader.includes('renderSafeMarkdown'));
assert(reader.includes('window.magicPointerReader?.onShow'));
assert(reader.includes('window.magicPointerReader?.executeAction'));

console.log('reader static test ok');

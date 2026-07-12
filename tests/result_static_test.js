const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/result.html', 'utf8');
const css = fs.readFileSync('electron/renderer/result.css', 'utf8');
const js = fs.readFileSync('electron/renderer/result.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');
const panel = fs.readFileSync('electron/renderer/panel.js', 'utf8');

assert(html.includes('id="contextual-result"'));
assert(html.includes('id="result-close"'));
assert(html.includes('id="result-expand"'));
assert(html.includes('id="result-content"'));
assert(!html.includes('id="command"'));
assert(js.includes('window.magicPointerResult?.onShow'));
assert(js.includes('window.magicPointerResult?.hide'));
assert(js.includes('window.magicPointerResult?.expand'));
assert(js.includes('renderSafeMarkdown'));
assert(js.includes("event.key === 'Escape'"));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(css.includes('max-width: 440px'));
assert(css.includes('min-width: 280px'));
assert(css.includes('.result-content::-webkit-scrollbar'));
assert(css.includes('scrollbar-width: none'));
assert(preload.includes("contextBridge.exposeInMainWorld('magicPointerResult'"));
assert(main.includes('function createResultWindow()'));
assert(main.includes("ipcMain.on('panel:show-contextual-result'"));
assert(main.includes("ipcMain.on('result:ready'"));
assert(main.includes("ipcMain.on('result:hide'"));
assert(main.includes("ipcMain.on('result:expand'"));
assert(panel.includes('showContextualResult'));
assert(!panel.includes("setRailState('success', '结果已在侧边打开')"));

console.log('result static test ok');

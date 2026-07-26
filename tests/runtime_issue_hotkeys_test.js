const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const html = fs.readFileSync('electron/renderer/index.html', 'utf8');

assert(main.includes("globalShortcut.register('Control+Alt+M'"));
assert(main.includes("globalShortcut.register('Control+Alt+Enter'"));
assert(main.includes("globalShortcut.register('Control+Alt+Shift+M'"));
assert(main.includes("showRuntimeIssueOverlay('hotkey')"));
assert(main.includes("beginSelectionSession('runtime-delivery')"));
assert(main.includes("beginSelectionSession('legacy-native-selection')"));

assert(main.includes('function showRuntimeIssueOverlay('));
assert(main.includes('overlayWindow.setIgnoreMouseEvents(false)'));
assert(main.includes("workflow: 'runtime_issue'"));
assert(main.includes('observerMode: false'));
assert(main.includes('overlayWindow.show()'));
assert(main.includes('overlayWindow.focus()'));

assert(overlay.includes("let currentWorkflow = 'generic';"));
assert(overlay.includes('workflow: currentWorkflow'));
assert(overlay.includes("currentWorkflow = String(payload?.workflow || 'generic')"));
assert(overlay.includes("payload.intentKind === 'runtime_issue_recorded'"));
assert(overlay.includes('现场任务已准备'));
assert(overlay.includes('payload.autoDismissMs'));
assert(html.includes('描述问题或期望，不需要找源码'));

console.log('runtime issue hotkeys test ok');

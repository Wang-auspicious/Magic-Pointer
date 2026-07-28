const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const html = fs.readFileSync('electron/renderer/index.html', 'utf8');

assert(main.includes('function registerConfigurableHotkeys('));
assert(main.includes('fabricSettings.shortcuts?.wake'));
assert(main.includes("requestActivation('shortcut-wake')"));
assert(main.includes("requestActivation('shortcut-text')"));
assert(main.includes("requestActivation('shortcut-voice')"));
assert(main.includes("globalShortcut.register('Control+Alt+Enter'"));
assert(main.includes("globalShortcut.register('Control+Alt+Shift+M'"));
assert(main.includes("requestActivation('runtime-delivery')"));
assert(main.includes("requestActivation('legacy-native-selection')"));
assert(main.includes('const previousSettings = fabricSettings;'));
assert(main.includes('const failedHotkeys = Object.entries(parsed.hotkeys)'));
assert(main.includes('fabricSettingsStore.save(previousSettings)'));
assert(main.includes('parsed.ok = false'));
assert(main.includes('快捷键注册失败'));

assert(main.includes('function showRuntimeIssueOverlay('));
assert(main.includes('overlayWindow.setIgnoreMouseEvents(false)'));
assert(main.includes("workflow: 'runtime_issue'"));
assert(main.includes('observerMode: false'));
assert(main.includes('overlayWindow.show()'));
assert(main.includes('overlayWindow.focus()'));

assert(overlay.includes("let currentWorkflow = 'generic';"));
assert(overlay.includes('workflow: currentWorkflow'));
assert(overlay.includes("currentWorkflow = String(payload?.workflow || 'generic')"));

// Runtime-issue capture results route to the PointerStage, never back into
// the overlay (legacy in-overlay receipt retired with Task 5).
assert(main.includes("reason: 'runtime-issue'"));
assert(main.includes('stageEventFromBridge(parsed)'));
assert(!overlay.includes('runtime_issue_recorded'));
assert(!overlay.includes('autoDismissMs'));
assert(!html.includes('描述问题或期望，不需要找源码'));

console.log('runtime issue hotkeys test ok');
